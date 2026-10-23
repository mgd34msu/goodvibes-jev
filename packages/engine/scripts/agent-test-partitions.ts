import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const AGENT_TEST_GROUPS = ['e2e', 'headless', 'model-catalog', 'model-readiness', 'remaining'] as const;
/** Complete native feature suites get independent, unchanged runner deadlines. */
export const AGENT_HARNESS_GROUP_FILES = {
  'harness-core': 'src/test/tools/agent-harness-core.test.ts',
  'harness-orchestration': 'src/test/tools/agent-harness-orchestration.test.ts',
  'harness-setup': 'src/test/tools/agent-harness-setup.test.ts',
  'harness-personal-ops': 'src/test/tools/agent-harness-personal-ops.test.ts',
  'harness-memory': 'src/test/tools/agent-harness-memory.test.ts',
  'harness-connectors': 'src/test/tools/agent-harness-connectors.test.ts',
  'harness-autonomy-runtime': 'src/test/tools/agent-harness-autonomy-runtime.test.ts',
  'harness-knowledge-learning': 'src/test/tools/agent-harness-knowledge-learning.test.ts',
  'harness-integrations': 'src/test/tools/agent-harness-integrations.test.ts',
  'harness-workspace-interface': 'src/test/tools/agent-harness-workspace-interface.test.ts',
  'harness-workspace-surfaces': 'src/test/tools/agent-harness-workspace-surfaces.test.ts',
  'harness-settings-actions': 'src/test/tools/agent-harness-settings-actions.test.ts',
  'harness-stateful-catalogs': 'src/test/tools/agent-harness-stateful-catalogs.test.ts',
  'routing-engine-integration': 'src/test/tools/agent-route-engine-integration.test.ts',
  'harness-routing-engine-integration': 'src/test/tools/agent-harness-route-engine-integration.test.ts',
  'routing-personal-ops': 'src/test/tools/agent-route-tool.test.ts',
  'routing-research-media': 'src/test/tools/agent-route-research-media.test.ts',
  'routing-provider-channel-policy': 'src/test/tools/agent-route-provider-channel-policy.test.ts',
  'routing-local-work': 'src/test/tools/agent-route-local-work.test.ts',
} as const;
export type AgentTestGroup = typeof AGENT_TEST_GROUPS[number] | keyof typeof AGENT_HARNESS_GROUP_FILES | `remaining-${number}`;
const HEADLESS = 'src/test/cli/native-headless-entrypoint.test.ts';
// Keep the expensive full-source model suites intact on independent hosts.
// All other/future files remain in the recursively discovered remaining group.
const MODEL_CATALOG = 'src/test/tools/agent-model-catalog-search.test.ts';
const MODEL_READINESS = 'src/test/tools/agent-model-readiness-judgment.test.ts';
const REMAINING_NATIVE_CATALOGS = [
  'src/test/tools/agent-harness-tool.test.ts',
  'src/test/tools/agent-harness-semantic-record-catalogs.test.ts',
] as const;
const REMAINING_FILES_PER_GROUP = 240;
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
  const groups: Array<{ id: AgentTestGroup; files: string[] }> = AGENT_TEST_GROUPS.map((id) => ({ id, files: [] }));
  const harness = new Map<string, AgentTestGroup>();
  for (const [id, file] of Object.entries(AGENT_HARNESS_GROUP_FILES)) {
    if (!files.includes(file)) continue;
    harness.set(file, id as keyof typeof AGENT_HARNESS_GROUP_FILES);
    groups.push({ id: id as keyof typeof AGENT_HARNESS_GROUP_FILES, files: [] });
  }
  for (const file of [...files].sort()) {
    const dedicated = harness.get(file);
    if (dedicated) { groups.find(group => group.id === dedicated)!.files.push(file); continue; }
    const index = file.startsWith('src/test/e2e/') ? 0 : file === HEADLESS ? 1
      : file === MODEL_CATALOG ? 2 : file === MODEL_READINESS ? 3 : 4;
    groups[index]!.files.push(file);
  }
  const remaining = groups[4]!;
  if (remaining.files.length > REMAINING_FILES_PER_GROUP) {
    const catalogs = remaining.files.filter(file => REMAINING_NATIVE_CATALOGS.some(owned => owned === file));
    const others = remaining.files.filter(file => !catalogs.includes(file));
    const count = Math.ceil(others.length / REMAINING_FILES_PER_GROUP);
    const partitions = Array.from({ length: count }, () => [] as string[]);
    others.forEach((file, index) => partitions[index % count]!.push(file));
    // Each complete partition gets its own CI host and the existing deadline.
    // Keep the two catalog fixtures together, isolated from unrelated globals.
    remaining.files = catalogs.length ? catalogs : partitions.shift()!;
    for (const selected of partitions) {
      groups.push({ id: `remaining-${groups.filter(group => group.id === 'remaining' || group.id.startsWith('remaining-')).length + 1}`, files: selected });
    }
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
  const plans = [...(owned.length ? [owned] : []), ...(others.length ? [others] : [])];
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
