import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const AGENT_TEST_GROUPS = ['e2e', 'headless', 'remaining'] as const;
export type AgentTestGroup = typeof AGENT_TEST_GROUPS[number];
const HEADLESS = 'src/test/cli/native-headless-entrypoint.test.ts';
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Complete canonical Agent src/test discovery, including E2E and future nested files. */
export function agentTestFiles(agentRoot: string): readonly string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(resolve(agentRoot, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) visit(child);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(child);
    }
  };
  visit('src/test');
  return files.sort();
}

export function groupAgentTestFiles(files: readonly string[]) {
  if (new Set(files).size !== files.length) throw new Error('Agent test manifest contains duplicate files');
  for (const file of files) {
    if (!file.startsWith('src/test/') || file.split('/').some((part) => part === '..' || part === '.' || !part || IGNORED_DIRECTORIES.has(part)) || !TEST_FILE.test(file)) {
      throw new Error(`Invalid canonical Agent test path: ${file}`);
    }
  }
  const groups = AGENT_TEST_GROUPS.map((id) => ({ id, files: [] as string[] }));
  for (const file of [...files].sort()) {
    const index = file.startsWith('src/test/e2e/') ? 0 : file === HEADLESS ? 1 : 2;
    groups[index]!.files.push(file);
  }
  if (groups.some((group) => group.files.length === 0)) throw new Error('Agent test groups must be nonempty');
  return groups;
}

export function agentTestManifest(agentRoot: string) {
  const files = agentTestFiles(agentRoot);
  const groups = groupAgentTestFiles(files);
  // Bind both inventory and grouping, so even a changed grouping rule fails closed.
  const sha256 = createHash('sha256').update(JSON.stringify({ files, groups })).digest('hex');
  return { version: 1, sha256, files, groups };
}

/** Explicit paths prevent Bun's substring filters from selecting another group's file. */
export function agentGroupTestArgs(agentRoot: string, args: readonly string[]): readonly string[] {
  if (args.length !== 2 || !args[0]?.startsWith('--group=') || !/^--manifest-sha256=[a-f0-9]{64}$/.test(args[1] ?? '')) {
    throw new Error('Use --group=GROUP --manifest-sha256=HASH with no other test arguments');
  }
  const manifest = agentTestManifest(agentRoot);
  const group = manifest.groups.find((entry) => args[0] === `--group=${entry.id}`);
  if (!group) throw new Error('Unknown Agent test group');
  if (args[1] !== `--manifest-sha256=${manifest.sha256}`) throw new Error('Agent test manifest differs from the CI build discovery');
  console.log(`[agent-tests] group ${group.id}: ${group.files.length}/${manifest.files.length} files; manifest ${manifest.sha256}`);
  return ['--cwd', '../../products/agent', ...group.files.map((file) => `./${file}`)];
}

export function agentTestMatrix(agentRoot: string) {
  const manifest = agentTestManifest(agentRoot);
  return { include: manifest.groups.map((group) => ({ group: group.id, 'manifest-sha256': manifest.sha256 })) };
}

if (import.meta.main) {
  const agentRoot = resolve(import.meta.dir, '../../../products/agent');
  const [mode, ...args] = process.argv.slice(2);
  if ((mode === 'matrix' || mode === 'manifest') && args.length === 0) {
    console.log(JSON.stringify(mode === 'matrix' ? agentTestMatrix(agentRoot) : agentTestManifest(agentRoot)));
  } else if (mode === 'run') {
    // Import the existing runner in this very process: no new synchronous parent,
    // no alternate lifecycle, preload, timeout, isolation, lock or cleanup path.
    process.argv = [process.execPath, join(import.meta.dir, 'test.ts'), ...agentGroupTestArgs(agentRoot, args)];
    await import('./test.ts');
  } else throw new Error('Usage: agent-test-partitions.ts matrix|manifest|run --group=GROUP --manifest-sha256=HASH');
}
