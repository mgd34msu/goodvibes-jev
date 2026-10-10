import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AGENT_TEST_GROUPS, agentGroupTestArgs, agentTestFiles, agentTestManifest, agentTestMatrix, groupAgentTestFiles } from '../scripts/agent-test-partitions.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const headless = 'src/test/cli/native-headless-entrypoint.test.ts';
const modelCatalog = 'src/test/tools/agent-model-catalog-search.test.ts';
const modelReadiness = 'src/test/tools/agent-model-readiness-judgment.test.ts';
const paths = ['src/test/e2e/a.test.ts', headless, modelCatalog, modelReadiness,
  'src/test/nested/src/test/e2e/a.test.ts', 'src/test/z.spec.mjs',
  `src/test/nested/${modelCatalog}`, `src/test/nested/${modelReadiness}`];
function write(root: string, path: string, content = ''): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function fixture(): { root: string; agent: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-partitions-')); roots.push(root);
  const agent = join(root, 'products/agent');
  for (const path of paths) write(agent, path);
  return { root, agent };
}

test('groups a complete canonical manifest deterministically without splitting files', () => {
  const groups = groupAgentTestFiles(paths);
  expect(groups.map((group) => group.id)).toEqual([...AGENT_TEST_GROUPS]);
  expect(groups.map((group) => group.files)).toEqual([[paths[0]!], [headless], [modelCatalog], [modelReadiness], paths.slice(4).sort()]);
  expect(groupAgentTestFiles([...paths].reverse())).toEqual(groups);
  expect(groups.flatMap((group) => group.files).sort()).toEqual([...paths].sort());
  for (const files of [[], ...paths.slice(0, 4).map(isolated => paths.filter(file => file !== isolated)),
    [...paths, paths[0]!], [...paths, 'src/test/../oops.test.ts'], [...paths, 'other/a.test.ts'], [...paths, 'src/test/not-a-test.ts']]) {
    expect(() => groupAgentTestFiles(files)).toThrow();
  }
});

test('actual Agent inventory is an independent complete disjoint census, with no E2E exclusions', () => {
  const agent = resolve(import.meta.dir, '../../../products/agent');
  const manifest = agentTestManifest(agent);
  const census = readdirSync(join(agent, 'src/test'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).slice(agent.length + 1).replaceAll('\\', '/'))
    .filter((file) => !file.split('/').some((part) => ['node_modules', '.git', 'dist'].includes(part))).sort();
  expect(manifest.files).toEqual(census);
  expect(manifest.files).toEqual(agentTestFiles(agent));
  const selected = agentTestMatrix(agent).include.flatMap((row) => {
    const args = agentGroupTestArgs(agent, [`--group=${row.group}`, `--manifest-sha256=${row['manifest-sha256']}`]);
    expect(args.slice(0, 2)).toEqual(['--cwd', '../../products/agent']);
    return args.slice(2).map((file) => { expect(file).toStartWith('./src/test/'); return file.slice(2); });
  });
  expect(selected.sort()).toEqual(census);
  expect(new Set(selected).size).toBe(census.length);
  expect(manifest.groups[0]!.files).toEqual(census.filter((file) => file.startsWith('src/test/e2e/')));
  expect(manifest.groups[1]!.files).toEqual([headless]);
  expect(manifest.groups[2]!.files).toEqual([modelCatalog]);
  expect(manifest.groups[3]!.files).toEqual([modelReadiness]);
  expect(manifest.groups[4]!.files).toEqual(census.filter(file => !file.startsWith('src/test/e2e/') && ![headless, modelCatalog, modelReadiness].includes(file)));
});

test('every new group rejects the old grouping digest even when the file inventory is unchanged', () => {
  const { agent } = fixture();
  const manifest = agentTestManifest(agent);
  const oldGroups = [
    { id: 'e2e', files: manifest.files.filter(file => file.startsWith('src/test/e2e/')) },
    { id: 'headless', files: [headless] },
    { id: 'remaining', files: manifest.files.filter(file => !file.startsWith('src/test/e2e/') && file !== headless) },
  ];
  const oldDigest = createHash('sha256').update(JSON.stringify({ files: manifest.files, groups: oldGroups })).digest('hex');
  expect(manifest.sha256).not.toBe(oldDigest);
  for (const group of AGENT_TEST_GROUPS) {
    expect(() => agentGroupTestArgs(agent, [`--group=${group}`, `--manifest-sha256=${oldDigest}`])).toThrow('differs');
  }
});

test('future nested tests are discovered once; stale, malformed, duplicate and mixed selectors fail closed', () => {
  const { agent } = fixture();
  const before = agentTestManifest(agent);
  for (const path of ['src/test/e2e/future/new.test.cts', 'src/test/future/deeper/new.spec.tsx']) write(agent, path);
  write(agent, 'src/test/node_modules/ignored.test.ts');
  write(agent, 'src/test/dist/ignored.test.ts');
  const after = agentTestManifest(agent);
  expect(after.files).toHaveLength(paths.length + 2);
  expect(new Set(after.groups.flatMap((group) => group.files)).size).toBe(after.files.length);
  expect(after.sha256).not.toBe(before.sha256);
  expect(() => agentGroupTestArgs(agent, ['--group=e2e', `--manifest-sha256=${before.sha256}`])).toThrow('differs');
  const digest = `--manifest-sha256=${after.sha256}`;
  for (const args of [[], ['--group=e2e'], [digest], ['--group=bad', digest], ['--group=e2e', '--manifest-sha256=bad'],
    ['--group=e2e', digest, '--group=headless'], ['--group=e2e', digest, digest],
    ['--group=e2e', digest, '--cwd', '.'], ['--group=e2e', digest, '--timeout=1'],
    ['--group=e2e', digest, '--test-name-pattern=x'], ['--group=e2e', digest, 'src/test'],
  ]) expect(() => agentGroupTestArgs(agent, args), JSON.stringify(args)).toThrow();
});

test('real grouped runner preserves preload, isolation, skip/TODO, owned tmp cleanup and child failure', () => {
  const { root, agent } = fixture();
  const scripts = join(root, 'packages/engine/scripts'); mkdirSync(scripts, { recursive: true });
  for (const file of ['agent-test-partitions.ts', 'test.ts', 'test-discovery.ts', 'test-partitions.ts', 'owned-test-child.ts', 'stale-tmp-sweep.ts',
    'test-run-tmp.ts', 'workspace-lock.ts', 'test-child-watchdog-env.ts', 'test-child-watchdog.ts',
    'test-isolation.ts', 'test-network-guard.ts', 'test-network-preload.ts']) {
    copyFileSync(resolve(import.meta.dir, '../scripts', file), join(scripts, file));
  }
  cpSync(resolve(import.meta.dir, '../toolchain/src/test-runner'), join(root, 'packages/engine/toolchain/src/test-runner'), { recursive: true });
  const receipt = join(root, 'executed.jsonl');
  write(agent, 'bunfig.toml', '[test]\npreload = ["./preload.ts"]\n');
  write(agent, 'preload.ts', "process.env.TZ = 'UTC'; process.env.AGENT_FIXTURE_PRELOADED = 'yes';");
  for (const path of paths) write(agent, path, `
    import { test, expect } from 'bun:test';
    import { appendFileSync, mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    test(${JSON.stringify(path)}, () => {
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(process.env.AGENT_FIXTURE_PRELOADED).toBe('yes');
      expect(process.env.TZ).toBe('UTC');
      const leaked = mkdtempSync(join(tmpdir(), 'owned-leftover-'));
      appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ file: ${JSON.stringify(path)}, leaked }) + '\\n');
    });
    test.skip('existing optional fixture', () => { throw new Error('skip changed'); });
    test.todo('existing planned fixture');
  `);
  const manifest = agentTestManifest(agent);
  const run = (group: string) => {
    const child = Bun.spawnSync({ cmd: [process.execPath, join(scripts, 'agent-test-partitions.ts'), 'run', `--group=${group}`, `--manifest-sha256=${manifest.sha256}`], cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: root, OPENAI_API_KEY: 'synthetic-must-not-inherit' }, timeout: 20_000, stdout: 'pipe', stderr: 'pipe' });
    return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
  };
  for (const group of AGENT_TEST_GROUPS) {
    const result = run(group);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('skip');
    expect(result.output).toContain('todo');
  }
  const receipts = readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { file: string; leaked: string });
  expect(receipts.map((entry) => entry.file).sort()).toEqual([...paths].sort());
  for (const receipt of receipts) expect(existsSync(receipt.leaked)).toBe(false);
  write(agent, headless, "import { test, expect } from 'bun:test'; test('failure reaches group gate', () => expect(false).toBe(true));");
  const failed = run('headless');
  expect(failed.code, failed.output).not.toBe(0);
  expect(failed.output).toContain('failure reaches group gate');
  expect(failed.output).toContain('bun test exited with code 1');
}, 60_000);

test('CI-only product discovery removes only Agent while local catalog remains complete', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const run = (mode: string, extra: string[] = []) => Bun.spawnSync({
    cmd: [process.execPath, 'packages/engine/scripts/product-workspaces.ts', mode, ...extra],
    cwd: repo, stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  });
  const full = run('matrix');
  const others = run('matrix-without-agent');
  expect(full.exitCode, full.stderr.toString()).toBe(0);
  expect(others.exitCode, others.stderr.toString()).toBe(0);
  const products = JSON.parse(full.stdout.toString()) as string[];
  expect(products).toContain('agent');
  expect(JSON.parse(others.stdout.toString())).toEqual(products.filter((product) => product !== 'agent'));
  expect(run('matrix-without-agent', ['tui']).exitCode).not.toBe(0);
}, 60_000);

test('CI keeps exact artifacts, complete gates, other product commands and unchanged runner deadlines', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const agent = workflow.split('\n  agent-tests:\n')[1]!.split('\n  agent-tests-complete:')[0]!;
  expect(agent).toContain('fail-fast: false');
  expect(agent).toContain('timeout-minutes: 15');
  for (const prerequisite of ['workspace-build-output', 'ci-artifact.ts verify "$GITHUB_SHA"', 'goodvibes-agent-linux-x64 --version', 'GOODVIBES_E2E_BINARY=', 'install --no-install-recommends -y tmux', 'git config --global user.email', 'git config --global user.name']) expect(agent).toContain(prerequisite);
  expect(agent).not.toContain('run-tests.ts');
  expect(agent).not.toContain('GOODVIBES_TEST_CEILING_MS');
  const aggregate = workflow.split('\n  agent-tests-complete:\n')[1]!.split('\n  # Exact TUI')[0]!;
  expect(aggregate).toContain('name: Product tests (agent)');
  expect(aggregate).toContain('if: always()');
  expect(aggregate).toContain('needs: [build, agent-tests]');
  const command = aggregate.match(/run: (test .*)/)![1]!;
  for (const build of ['success', 'failure', 'cancelled', 'skipped']) for (const groups of ['success', 'failure', 'cancelled', 'skipped']) {
    const result = Bun.spawnSync({ cmd: ['sh', '-c', command], env: { BUILD_RESULT: build, AGENT_RESULT: groups } });
    expect(result.exitCode === 0).toBe(build === 'success' && groups === 'success');
  }
  const release = workflow.split('\n  auto-release:')[1]!;
  for (const dependency of ['product-tests', 'agent-tests', 'agent-tests-complete']) expect(release).toContain(`      - ${dependency}\n`);
  expect(workflow).toContain('run: bun run products:test "$PRODUCT"');
  expect(JSON.parse(readFileSync(join(repo, 'products/agent/package.json'), 'utf8')).scripts.test).toBe('bun ../../packages/engine/scripts/test.ts --cwd ../../products/agent src/test');
  const owned = readFileSync(join(repo, 'packages/engine/toolchain/src/test-runner/owned-test-child.ts'), 'utf8');
  expect(owned).toContain('const DEFAULT_STALL_MS = 180_000');
  expect(owned).toContain('const DEFAULT_CEILING_MS = 720_000');
  expect(readFileSync(join(repo, 'packages/engine/scripts/test.ts'), 'utf8')).toContain('return 60_000');
});
