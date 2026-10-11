import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const AGENT_TEST_GROUPS = ['e2e', 'headless', 'model-catalog', 'model-readiness', 'remaining'] as const;
export type AgentTestGroup = typeof AGENT_TEST_GROUPS[number];
const HEADLESS = 'src/test/cli/native-headless-entrypoint.test.ts';
// Keep the expensive full-source model suites intact on independent hosts.
// All other/future files remain in the recursively discovered remaining group.
const MODEL_CATALOG = 'src/test/tools/agent-model-catalog-search.test.ts';
const MODEL_READINESS = 'src/test/tools/agent-model-readiness-judgment.test.ts';
const REMAINING_NATIVE_CATALOGS = [
  'src/test/tools/agent-harness-tool.test.ts',
  'src/test/tools/agent-harness-semantic-record-catalogs.test.ts',
] as const;
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
    const index = file.startsWith('src/test/e2e/') ? 0 : file === HEADLESS ? 1
      : file === MODEL_CATALOG ? 2 : file === MODEL_READINESS ? 3 : 4;
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
function selectedAgentGroup(agentRoot: string, args: readonly string[]) {
  if (args.length !== 2 || !args[0]?.startsWith('--group=') || !/^--manifest-sha256=[a-f0-9]{64}$/.test(args[1] ?? '')) {
    throw new Error('Use --group=GROUP --manifest-sha256=HASH with no other test arguments');
  }
  const manifest = agentTestManifest(agentRoot);
  const group = manifest.groups.find((entry) => args[0] === `--group=${entry.id}`);
  if (!group) throw new Error('Unknown Agent test group');
  if (args[1] !== `--manifest-sha256=${manifest.sha256}`) throw new Error('Agent test manifest differs from the CI build discovery');
  console.log(`[agent-tests] group ${group.id}: ${group.files.length}/${manifest.files.length} files; manifest ${manifest.sha256}`);
  return group;
}

export function agentGroupTestArgs(agentRoot: string, args: readonly string[]): readonly string[] {
  const group = selectedAgentGroup(agentRoot, args);
  return ['--cwd', '../../products/agent', ...group.files.map((file) => `./${file}`)];
}

/** Separate global fixtures under one runner deadline, without splitting files or CI groups. */
export function agentGroupTestPlans(agentRoot: string, args: readonly string[]): readonly (readonly string[])[] {
  const group = selectedAgentGroup(agentRoot, args);
  const owned = group.id === 'remaining' ? REMAINING_NATIVE_CATALOGS.filter(file => group.files.includes(file)) : [];
  const others = group.files.filter(file => !owned.some(selected => selected === file));
  const plans = owned.length > 0 && others.length > 0 ? [owned, others] : [group.files];
  const census = plans.flat().sort();
  if (census.length !== group.files.length || new Set(census).size !== census.length
    || census.some((file, index) => file !== group.files[index])) throw new Error('Agent child plans differ from the complete selected group');
  return plans.map(files => ['--cwd', '../../products/agent', ...files.map(file => `./${file}`)]);
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
    const { runTests } = await import('./test.ts');
    await runTests(() => agentGroupTestPlans(agentRoot, args), join(agentRoot, '.test-tmp'));
  } else throw new Error('Usage: agent-test-partitions.ts matrix|manifest|run --group=GROUP --manifest-sha256=HASH');
}
