import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { AGENT_TEST_GROUPS, AGENT_HARNESS_GROUP_FILES, agentGroupTestArgs, agentGroupTestPlans, agentTestFiles, agentTestManifest, agentTestMatrix, groupAgentTestFiles } from '../scripts/agent-test-partitions.ts';
import { replayTestOwnerLogs } from '../scripts/test.ts';
import { sweepStaleTmpDirs } from '../scripts/stale-tmp-sweep.ts';
import { RUN_TMP_PREFIX, STALE_RUN_MS } from '../scripts/test-run-tmp.ts';
import { HEARTBEAT_PATH_ENV } from '../toolchain/src/test-runner/test-child-watchdog-env.ts';
import { NETWORK_VIOLATIONS_ENV } from '../toolchain/src/test-runner/test-isolation.ts';

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

function copyRunner(root: string): string {
  const scripts = join(root, 'packages/engine/scripts'); mkdirSync(scripts, { recursive: true });
  for (const file of ['agent-test-partitions.ts', 'test.ts', 'test-discovery.ts', 'test-partitions.ts', 'owned-test-child.ts', 'stale-tmp-sweep.ts',
    'test-run-tmp.ts', 'workspace-lock.ts', 'test-child-watchdog-env.ts', 'test-child-watchdog.ts',
    'test-isolation.ts', 'test-network-guard.ts', 'test-network-preload.ts']) {
    copyFileSync(resolve(import.meta.dir, '../scripts', file), join(scripts, file));
  }
  cpSync(resolve(import.meta.dir, '../toolchain/src/test-runner'), join(root, 'packages/engine/toolchain/src/test-runner'), { recursive: true });
  return scripts;
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
  const harness = new Set<string>(Object.values(AGENT_HARNESS_GROUP_FILES));
  expect(manifest.groups.filter(group => group.id === 'remaining' || group.id.startsWith('remaining-')).flatMap(group => group.files).sort())
    .toEqual(census.filter(file => !file.startsWith('src/test/e2e/') && ![headless, modelCatalog, modelReadiness].includes(file) && !harness.has(file)));
});

test('native harness groups retain whole files and leave nested names in the complete remaining inventory', () => {
  const { agent } = fixture();
  for (const file of Object.values(AGENT_HARNESS_GROUP_FILES)) write(agent, file);
  const nested = 'src/test/nested/agent-harness-orchestration.test.ts'; write(agent, nested);
  const manifest = agentTestManifest(agent);
  for (const [id, file] of Object.entries(AGENT_HARNESS_GROUP_FILES)) {
    expect(manifest.groups.find(group => group.id === id)?.files).toEqual([file]);
    expect(agentGroupTestPlans(agent, [`--group=${id}`, `--manifest-sha256=${manifest.sha256}`]))
      .toEqual([['--cwd', '../../products/agent', `./${file}`]]);
  }
  expect(manifest.groups.find(group => group.id === 'remaining')?.files).toContain(nested);
  expect(manifest.groups.flatMap(group => group.files).sort()).toEqual([...manifest.files]);
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

test('two owned remaining plans preserve every complete file and all future source owners', () => {
  const { agent } = fixture();
  const catalogs = ['src/test/tools/agent-harness-tool.test.ts', 'src/test/tools/agent-harness-semantic-record-catalogs.test.ts'];
  const future = 'src/test/future/agent-harness-tool.test.ts';
  for (const file of [...catalogs, future]) write(agent, file);
  const manifest = agentTestManifest(agent);
  const args = ['--group=remaining', `--manifest-sha256=${manifest.sha256}`];
  const plans = agentGroupTestPlans(agent, args);
  expect(plans).toHaveLength(2);
  expect(plans[0]).toEqual(['--cwd', '../../products/agent', ...catalogs.map(file => `./${file}`)]);
  expect(plans[1]).toContain(`./${future}`);
  const all = plans.flatMap(plan => {
    expect(plan.slice(0, 2)).toEqual(['--cwd', '../../products/agent']);
    return plan.slice(2).map(file => file.slice(2));
  });
  expect(all.sort()).toEqual(manifest.groups[4]!.files);
  expect(new Set(all).size).toBe(all.length);
  for (const group of manifest.groups.slice(0, 4)) {
    expect(agentGroupTestPlans(agent, [`--group=${group.id}`, args[1]!])).toEqual([agentGroupTestArgs(agent, [`--group=${group.id}`, args[1]!])]);
  }
  write(agent, 'src/test/future/new-worker.spec.ts');
  expect(() => agentGroupTestPlans(agent, args)).toThrow('differs');
});

test('complete remaining CI partitions preserve every file and isolate the native catalogs', () => {
  const agent = resolve(import.meta.dir, '../../../products/agent');
  const manifest = agentTestManifest(agent);
  const groups = manifest.groups.filter(group => group.id === 'remaining' || group.id.startsWith('remaining-'));
  const selected = groups.flatMap(group => {
    const plans = agentGroupTestPlans(agent, [`--group=${group.id}`, `--manifest-sha256=${manifest.sha256}`]);
    const files = plans.flatMap(plan => plan.slice(2).map(file => file.slice(2)));
    expect(files.sort()).toEqual(group.files);
    return files;
  });
  expect(new Set(selected).size).toBe(selected.length);
  expect(groups[0]!.files).toEqual([
    'src/test/tools/agent-harness-semantic-record-catalogs.test.ts', 'src/test/tools/agent-harness-tool.test.ts',
  ]);
  const sizes = groups.slice(1).map(group => group.files.length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(240);
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
  const scripts = copyRunner(root);
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

test('CI Agent completion gate refuses unsuccessful build and test-group results', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const workflow = Bun.YAML.parse(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps: { run?: string }[] }>
  };
  const command = workflow.jobs['agent-tests-complete']!.steps.find(step => step.run)?.run;
  if (!command) throw new Error('Agent completion gate has no executable step');
  for (const build of ['success', 'failure', 'cancelled', 'skipped']) for (const groups of ['success', 'failure', 'cancelled', 'skipped']) {
    const result = Bun.spawnSync({ cmd: ['sh', '-c', command], env: { BUILD_RESULT: build, AGENT_RESULT: groups } });
    expect(result.exitCode === 0).toBe(build === 'success' && groups === 'success');
  }
});

test('owner-log replay drains complete logs or reports bounded truncation and interruption', async () => {
  const { root } = fixture(), logs = [join(root, 'first.log'), join(root, 'second.log')];
  writeFileSync(logs[0]!, 'first complete tail\n'); writeFileSync(logs[1]!, 'second complete tail\n');
  const files = logs.map(path => { const { dev, ino } = lstatSync(path); return { path, dev, ino }; });
  const chunks: Buffer[] = [];
  const delivered = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  expect(await replayTestOwnerLogs(files, Date.now() + 1000, delivered)).toEqual({ outputTruncated: false, stopReason: null });
  expect(Buffer.concat(chunks).toString()).toBe('[test-owner 1/2]\nfirst complete tail\n[test-owner 2/2]\nsecond complete tail\n');
  delivered.destroy();
  const blocked = new Writable({ write() { /* Actual sink accepts bytes but never acknowledges delivery. */ } });
  const started = Date.now();
  const truncated = await replayTestOwnerLogs(files, started + 200, blocked);
  expect(truncated.outputTruncated).toBe(true); expect(truncated.stopReason).toContain('shared absolute deadline');
  expect(Date.now() - started).toBeLessThan(2000); blocked.destroy();
  const interrupted = new Writable({ write() { /* Cancellation must also end a pending sink callback. */ } });
  const listeners = process.listenerCount('SIGTERM');
  const interruption = new AbortController();
  const pending = replayTestOwnerLogs(files, Date.now() + 10000, interrupted, interruption.signal);
  setTimeout(() => interruption.abort(), 20);
  expect((await pending).outputTruncated).toBe(true); interrupted.destroy();
  expect(process.listenerCount('SIGTERM')).toBe(listeners);
  expect(readFileSync(logs[0]!, 'utf8')).toBe('first complete tail\n');
  expect(readFileSync(logs[1]!, 'utf8')).toBe('second complete tail\n');
});

test('bare Bun removes only its own unchanged fallback root and preserves late replacements', () => {
  for (const replace of [false, true]) {
    const { root, agent } = fixture(), helpers = join(agent, 'src/test/helpers');
    mkdirSync(helpers, { recursive: true });
    for (const file of ['preload.ts', 'project-temp.ts', 'temp-registry.ts']) copyFileSync(resolve(import.meta.dir, '../../../products/agent/src/test/helpers', file), join(helpers, file));
    write(agent, 'bunfig.toml', '[test]\npreload = ["./src/test/helpers/preload.ts"]\n');
    const receipt = join(root, 'fallback.json'), peer = join(agent, '.test-tmp', 'unrelated-peer');
    mkdirSync(peer, { recursive: true }); writeFileSync(join(peer, 'keep'), 'Unrelated bare-Bun peer');
    write(agent, 'src/test/fallback.test.ts', `
      import {test,expect} from 'bun:test';
      import {renameSync,mkdirSync,writeFileSync} from 'node:fs';
      import {basename,join} from 'node:path';
      import {makeProjectTempDir,makeLongLivedProjectTempDir,projectTestTmpRoot} from './helpers/project-temp.ts';
      test('actual fallback ownership',()=>{
        const owned=projectTestTmpRoot(), leaf=makeProjectTempDir('short'), long=makeLongLivedProjectTempDir('long');
        ${replace ? `renameSync(owned,owned+'.displaced');mkdirSync(owned);
          for(const path of [leaf,long]){mkdirSync(path);writeFileSync(join(path,'keep'),'Bare replacement survives');}
          expect(()=>makeProjectTempDir('late')).toThrow('replaced Agent project test root');` : ''}
        writeFileSync(${JSON.stringify(receipt)},JSON.stringify({owned,leaf,long}));
      });
    `);
    const result = Bun.spawnSync([process.execPath, '--no-env-file', 'test', './src/test/fallback.test.ts'], {
      cwd: agent, env: { PATH: process.env.PATH ?? '', HOME: root }, stdout: 'pipe', stderr: 'pipe', timeout: 10000,
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode === 0, output).toBe(!replace);
    const native: unknown = JSON.parse(readFileSync(receipt, 'utf8'));
    if (!native || typeof native !== 'object' || !('owned' in native) || typeof native.owned !== 'string'
      || !('leaf' in native) || typeof native.leaf !== 'string' || !('long' in native) || typeof native.long !== 'string') throw new Error('Expected bare-Bun physical ownership receipt');
    expect(existsSync(native.owned)).toBe(replace);
    if (replace) {
      expect(output).toContain('replaced Agent project test root');
      for (const path of [native.leaf, native.long]) expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('Bare replacement survives');
      expect(existsSync(native.owned + '.displaced')).toBe(true);
    }
    expect(readFileSync(join(peer, 'keep'), 'utf8')).toBe('Unrelated bare-Bun peer');
  }
}, 60000);

for (const outcome of ['pass', 'failure', 'ceiling', 'cancel', 'force-kill', 'parent-death', 'root-replacement', 'root-removal'] as const) {
  test(`actual remaining owners preserve separate state, complete logs and cleanup on ${outcome}`, async () => {
    const { root, agent } = fixture(), scripts = copyRunner(root);
    const catalogs = ['src/test/tools/agent-harness-tool.test.ts', 'src/test/tools/agent-harness-semantic-record-catalogs.test.ts'];
    for (const file of catalogs) write(agent, file);
    const helpers = join(agent, 'src/test/helpers'); mkdirSync(helpers, { recursive: true });
    for (const file of ['preload.ts', 'project-temp.ts', 'temp-registry.ts']) copyFileSync(resolve(import.meta.dir, '../../../products/agent/src/test/helpers', file), join(helpers, file));
    write(agent, 'bunfig.toml', '[test]\npreload = ["./src/test/helpers/preload.ts"]\n');
    const manifest = agentTestManifest(agent), files = manifest.groups[4]!.files;
    const receipt = join(root, 'owners.jsonl'), refused = join(root, 'sigterm-refused.jsonl'), replaced = join(root, 'replacement.json'), peer = join(agent, '.test-tmp', 'unrelated-peer');
    mkdirSync(peer, { recursive: true }); writeFileSync(join(peer, 'keep'), 'Unrelated owned fixture');
    const old = new Date(Date.now() - 600000); utimesSync(peer, old, old);
    for (const file of files) write(agent, file, `
      import {test,expect} from 'bun:test';
      import {appendFileSync,readFileSync,existsSync,renameSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
      import {basename,join} from 'node:path';
      import {makeProjectTempDir,makeLongLivedProjectTempDir,projectTestTmpRoot} from ${JSON.stringify(join(helpers, 'project-temp.ts'))};
      ${outcome === 'force-kill' ? `process.on('SIGTERM',()=>appendFileSync(${JSON.stringify(refused)},String(process.pid)+'\\n'));` : ''}
      test(${JSON.stringify(file)}, async () => {
        expect(process.env.OPENAI_API_KEY).toBeUndefined();
        const leaf=makeProjectTempDir('actual-child');
        const lock=JSON.parse(readFileSync(${JSON.stringify(join(root, 'packages/engine/.tmp/workspace.lock/owner.json'))},'utf8'));
        expect(lock.pid).toBe(process.ppid);
        appendFileSync(${JSON.stringify(receipt)},JSON.stringify({file:${JSON.stringify(file)},pid:process.pid,
          home:process.env.HOME,heartbeat:process.env[${JSON.stringify(HEARTBEAT_PATH_ENV)}],
          violations:process.env[${JSON.stringify(NETWORK_VIOLATIONS_ENV)}],projectRoot:projectTestTmpRoot(),leaf})+'\\n');
        expect(existsSync(${JSON.stringify(join(peer, 'keep'))})).toBe(true);
        ${outcome === 'root-replacement' && file === catalogs[0] ? `
          const original=projectTestTmpRoot(), long=makeLongLivedProjectTempDir('late-registry');
          renameSync(original,original+'.displaced'); mkdirSync(original);
          const shortReplacement=join(original,basename(leaf)), longReplacement=join(original,basename(long));
          for(const path of [shortReplacement,longReplacement]) {mkdirSync(path);writeFileSync(join(path,'keep'),'Replacement must survive cleanup');}
          writeFileSync(${JSON.stringify(replaced)},JSON.stringify({original,shortReplacement,longReplacement}));
          expect(()=>makeProjectTempDir('late-allocation')).toThrow('replaced Agent project test root');
        ` : ''}
        ${outcome === 'root-removal' && file === catalogs[0] ? `
          const original=projectTestTmpRoot();
          rmSync(original,{recursive:true,force:true});
          expect(()=>makeProjectTempDir('lost-allocation')).toThrow('no longer exists');
        ` : ''}
        await Bun.sleep(${['ceiling', 'cancel', 'force-kill', 'parent-death'].includes(outcome) ? 10000 : 25});
        expect(${outcome === 'failure' && file === catalogs[0] ? 'false' : 'true'}).toBe(true);
      });
    `);
    const log = join(root, 'run.stdout.log'), errors = join(root, 'run.stderr.log'), githubOutput = join(root, 'github-output');
    writeFileSync(githubOutput, '');
    const parent = Bun.spawn([process.execPath, join(scripts, 'agent-test-partitions.ts'), 'run', '--group=remaining', `--manifest-sha256=${manifest.sha256}`], {
      cwd: root, stdout: Bun.file(log), stderr: Bun.file(errors),
      env: { PATH: process.env.PATH ?? '', HOME: root, GITHUB_OUTPUT: githubOutput, OPENAI_API_KEY: 'Synthetic-must-not-inherit', ...(outcome === 'ceiling' ? { GOODVIBES_TEST_CEILING_MS: '1000' } : {}) },
    });
    try {
      if (outcome === 'cancel' || outcome === 'force-kill' || outcome === 'parent-death') {
        const deadline = Date.now() + 10000;
        while ((!existsSync(receipt) || new Set(readFileSync(receipt, 'utf8').trim().split('\n').map(line => {
          const row: unknown = JSON.parse(line);
          return row && typeof row === 'object' && 'pid' in row ? row.pid : undefined;
        })).size < 2) && Date.now() < deadline) await Bun.sleep(20);
        expect(existsSync(receipt)).toBe(true);
        if (outcome === 'parent-death') {
          const beforeDeath = readFileSync(receipt, 'utf8').trim().split('\n').map(line => {
            const row: unknown = JSON.parse(line);
            if (!row || typeof row !== 'object' || !('projectRoot' in row) || typeof row.projectRoot !== 'string') throw new Error('Expected owned checkout root');
            return { projectRoot: row.projectRoot };
          });
          const expired = new Date(Date.now() - STALE_RUN_MS - 1000);
          for (const record of beforeDeath) utimesSync(record.projectRoot, expired, expired);
          sweepStaleTmpDirs(join(agent, '.test-tmp'), RUN_TMP_PREFIX, STALE_RUN_MS);
          for (const record of beforeDeath) expect(existsSync(record.projectRoot)).toBe(true);
          parent.kill('SIGKILL');
        } else parent.kill('SIGTERM');
      }
      const code = await parent.exited, output = readFileSync(log, 'utf8') + readFileSync(errors, 'utf8');
      expect(code === 0, output).toBe(outcome === 'pass');
      if (outcome === 'pass' || outcome === 'failure') {
        expect(output).toContain('[test-owner 1/2]'); expect(output).toContain('[test-owner 2/2]');
      }
      if (outcome === 'ceiling') expect(output).toContain('shared absolute deadline');
      if (outcome === 'root-removal') expect(output).toContain('The owned Agent project test root no longer exists');
      if (outcome !== 'parent-death') {
        const finiteLine = /^goodvibes: test owner results (.+)$/m.exec(output)?.[1];
        if (!finiteLine) throw new Error('Expected both settled native owner summaries before any first-owner failure');
        const finite: unknown = JSON.parse(finiteLine);
        if (!Array.isArray(finite)) throw new Error('Expected finite native owner result array');
        expect(finite).toHaveLength(2);
        for (let index = 0; index < finite.length; index++) {
          const result: unknown = finite[index];
          if (!result || typeof result !== 'object' || !('owner' in result) || !('status' in result)) throw new Error('Expected exact native result metadata');
          expect(result.owner).toBe(index + 1);
          expect(Object.keys(result).sort()).toEqual(result.status === 'fulfilled'
            ? ['exitCode', 'outputTruncated', 'owner', 'signalCode', 'status', 'stopped'] : ['owner', 'status']);
        }
        const exported = readFileSync(githubOutput, 'utf8').trim().split('\n');
        expect(exported[0]).toBe(`owner_evidence<<GOODVIBES_OWNER_EVIDENCE_${parent.pid}`);
        expect(exported.at(-1)).toBe(`GOODVIBES_OWNER_EVIDENCE_${parent.pid}`);
        expect(exported).toHaveLength(5);
        const retained = /^goodvibes: test owner evidence retained at (.+)$/m.exec(output)?.[1];
        if (!retained) throw new Error('Expected retained complete private owner logs');
        expect(exported.slice(1, -1)).toEqual([join(retained, 'owner-1.log'), join(retained, 'owner-2.log'), join(retained, 'owner-results.json')]);
        const nativeOwner: unknown = JSON.parse(readFileSync(join(retained, '.goodvibes-test-owner.json'), 'utf8'));
        expect(nativeOwner).toEqual({ version: 1, pid: parent.pid, dev: lstatSync(retained).dev, ino: lstatSync(retained).ino });
        for (const path of exported.slice(1, -1)) { expect(lstatSync(path).isFile()).toBe(true); expect(lstatSync(path).isSymbolicLink()).toBe(false); }
        const summary: unknown = JSON.parse(readFileSync(join(retained, 'owner-results.json'), 'utf8'));
        if (!summary || typeof summary !== 'object' || !('results' in summary) || !Array.isArray(summary.results)
          || !('plans' in summary) || !Array.isArray(summary.plans)) throw new Error('Expected complete native result and selection manifest');
        expect(summary.results).toHaveLength(2); expect(summary.plans).toHaveLength(2);
        expect(finite).toEqual(summary.results.map((result, index) => result.status === 'fulfilled'
          ? { owner: index + 1, status: result.status, exitCode: result.value.exitCode, signalCode: result.value.signalCode, stopped: result.value.stopped, outputTruncated: result.value.outputTruncated }
          : { owner: index + 1, status: result.status }));
        if (outcome === 'failure') {
          expect(summary.results.map(result => result.value.exitCode)).toEqual([1, 0]);
          expect(output.indexOf('goodvibes: test owner results ')).toBeLessThan(output.indexOf('bun test exited with code 1'));
        }
        for (let index = 1; index <= 2; index++) expect(readFileSync(join(retained, `owner-${index}.log`), 'utf8')).toContain('bun test');
        if (outcome === 'force-kill') {
          expect(readFileSync(refused, 'utf8').trim().split('\n')).toHaveLength(2);
          for (const result of summary.results) expect(result.value.signalCode).toBe('SIGKILL');
        }
        if (outcome === 'ceiling' || outcome === 'cancel' || outcome === 'force-kill') {
          expect('replay' in summary && summary.replay && typeof summary.replay === 'object' && 'outputTruncated' in summary.replay && summary.replay.outputTruncated).toBe(true);
        }
      }
      if (outcome === 'parent-death') expect(readFileSync(githubOutput, 'utf8')).toBe('');
      const records = readFileSync(receipt, 'utf8').trim().split('\n').map(line => {
        const row: unknown = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Expected actual child receipt');
        return Object.fromEntries(Object.entries(row));
      });
      expect(new Set(records.map(row => row.pid)).size).toBe(2);
      for (const field of ['home', 'heartbeat', 'violations', 'projectRoot']) expect(new Set(records.map(row => row[field])).size).toBe(2);
      if (outcome === 'pass' || outcome === 'failure') expect(records.map(row => row.file).sort()).toEqual(files);
      const owned = records.map(row => {
        if (typeof row.pid !== 'number' || typeof row.projectRoot !== 'string' || typeof row.leaf !== 'string') throw new Error('Invalid native child ownership receipt');
        return { pid: row.pid, projectRoot: row.projectRoot, leaf: row.leaf };
      });
      for (const row of owned) {
        const stoppedBy = Date.now() + 10000;
        let alive = true;
        do { try { process.kill(row.pid, 0); } catch { alive = false; }
          if (alive) await Bun.sleep(20);
        } while (alive && Date.now() < stoppedBy);
        expect(alive).toBe(false);
        if (outcome === 'parent-death') expect(existsSync(row.projectRoot)).toBe(true);
      }
      if (outcome === 'parent-death') sweepStaleTmpDirs(join(agent, '.test-tmp'), RUN_TMP_PREFIX, STALE_RUN_MS);
      let replacement: { original: string; shortReplacement: string; longReplacement: string } | undefined;
      if (outcome === 'root-replacement') {
        const native: unknown = JSON.parse(readFileSync(replaced, 'utf8'));
        if (!native || typeof native !== 'object' || !('original' in native) || typeof native.original !== 'string'
          || !('shortReplacement' in native) || typeof native.shortReplacement !== 'string'
          || !('longReplacement' in native) || typeof native.longReplacement !== 'string') throw new Error('Expected actual replacement receipt');
        replacement = { original: native.original, shortReplacement: native.shortReplacement, longReplacement: native.longReplacement };
        expect(output).toContain('replaced Agent project test root');
        for (const path of [replacement.shortReplacement, replacement.longReplacement]) expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('Replacement must survive cleanup');
        expect(existsSync(replacement.original + '.displaced')).toBe(true);
      }
      for (const row of owned) {
        const preserved = row.projectRoot === replacement?.original;
        expect(existsSync(row.projectRoot)).toBe(preserved); expect(existsSync(row.leaf)).toBe(preserved);
      }
      expect(readFileSync(join(peer, 'keep'), 'utf8')).toBe('Unrelated owned fixture');
      expect(existsSync(join(root, 'packages/engine/.tmp/workspace.lock'))).toBe(outcome === 'parent-death');
    } finally {
      try { parent.kill('SIGKILL'); } catch { /* already exited */ }
      await parent.exited;
    }
  }, 60_000);
}

test('settled owner diagnostics refuse a replaced native log before replay or artifact export', async () => {
  const { root, agent } = fixture(), scripts = copyRunner(root);
  const catalogs = ['src/test/tools/agent-harness-tool.test.ts', 'src/test/tools/agent-harness-semantic-record-catalogs.test.ts'];
  for (const file of catalogs) write(agent, file);
  const files = agentTestManifest(agent).groups[4]!.files;
  const peer = join(root, 'unrelated-private-log'), githubOutput = join(root, 'github-output'), nativeTmpParent = join(root, 'native-tmp');
  mkdirSync(nativeTmpParent);
  writeFileSync(peer, 'Unrelated private log must never be relayed or uploaded');
  writeFileSync(githubOutput, '');
  for (const file of files) write(agent, file, `
    import {test,expect} from 'bun:test';
    import {existsSync,readdirSync,renameSync,symlinkSync} from 'node:fs';
    import {join} from 'node:path';
    test(${JSON.stringify(file)},()=>{
      expect(process.env.GITHUB_OUTPUT).toBeUndefined();
      ${file === catalogs[0] ? `const names=readdirSync(${JSON.stringify(nativeTmpParent)}).filter(name=>name.startsWith('goodvibes-sdk-testrun-'+process.ppid+'-')&&existsSync(join(${JSON.stringify(nativeTmpParent)},name,'owner-1.log')));
        expect(names).toHaveLength(1);const path=join(${JSON.stringify(nativeTmpParent)},names[0]!,'owner-1.log');renameSync(path,path+'.original');symlinkSync(${JSON.stringify(peer)},path);` : ''}
    });
  `);
  const manifest = agentTestManifest(agent);
  const parent = Bun.spawn([process.execPath, join(scripts, 'agent-test-partitions.ts'), 'run', '--group=remaining', `--manifest-sha256=${manifest.sha256}`], {
    cwd: root, env: { PATH: process.env.PATH ?? '', HOME: root, GITHUB_OUTPUT: githubOutput, TMPDIR: nativeTmpParent, TMP: nativeTmpParent, TEMP: nativeTmpParent }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([parent.exited, new Response(parent.stdout).text(), new Response(parent.stderr).text()]);
  const output = stdout + stderr;
  expect(code).not.toBe(0);
  expect(output).toContain('goodvibes: test owner results ');
  expect(output).toContain('Test owner log ownership changed');
  expect(output).not.toContain('Unrelated private log must never be relayed or uploaded');
  expect(readFileSync(githubOutput, 'utf8')).toBe('');
  expect(readFileSync(peer, 'utf8')).toBe('Unrelated private log must never be relayed or uploaded');
}, 60_000);

test('owner-log replay pins original files across awaited headers and closes every descriptor on replacement', async () => {
  for (const replacement of ['symlink', 'regular'] as const) {
    const { root } = fixture(), scripts = copyRunner(root), nativeTmp = join(root, 'native-tmp');
    mkdirSync(nativeTmp);
    const peer = join(root, 'unrelated-peer.log'), githubOutput = join(root, 'github-output');
    const observation = join(root, 'replay-observation.json'), children = join(root, 'children');
    const marker = 'Unrelated synthetic file bytes must never enter owner replay';
    writeFileSync(peer, marker); writeFileSync(githubOutput, '');
    for (const file of ['first.test.ts', 'second.test.ts']) writeFileSync(join(scripts, '..', file), `
      import {test,expect} from 'bun:test';import {appendFileSync} from 'node:fs';
      test('owned ordinary output',()=>{appendFileSync(${JSON.stringify(children)},process.pid+'\\n');expect(true).toBe(true);});
    `);
    const wrapper = join(root, 'run.mjs');
    writeFileSync(wrapper, `
      import {runTests} from './packages/engine/scripts/test.ts';
      import {existsSync,readdirSync,readlinkSync,renameSync,symlinkSync,writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      const originalWrite=process.stdout.write.bind(process.stdout);let replaced=false;
      process.stdout.write=(...args)=>{
        if(!replaced&&(typeof args[0]==='string'?args[0]:new TextDecoder().decode(args[0])).includes('[test-owner 1/2]')){
          const names=readdirSync(${JSON.stringify(nativeTmp)}).filter(name=>name.startsWith('goodvibes-sdk-testrun-'+process.pid+'-')&&existsSync(join(${JSON.stringify(nativeTmp)},name,'owner-2.log')));
          if(names.length!==1)throw new Error('Expected one actual parent-owned log root');
          const path=join(${JSON.stringify(nativeTmp)},names[0],'owner-2.log');
          renameSync(path,path+'.original');
          ${replacement === 'symlink' ? `symlinkSync(${JSON.stringify(peer)},path);` : `writeFileSync(path,${JSON.stringify(marker)});`}
          replaced=true;
        }
        return originalWrite(...args);
      };
      try{await runTests(()=>[['./first.test.ts'],['./second.test.ts']]);}
      catch{process.exitCode=1;}
      finally{
        process.stdout.write=originalWrite;
        const openLogs=existsSync('/proc/self/fd')?readdirSync('/proc/self/fd').flatMap(fd=>{
          try{const target=readlinkSync('/proc/self/fd/'+fd);return target.startsWith(${JSON.stringify(nativeTmp)})&&/owner-[12]\\.log/.test(target)?[target]:[];}catch{return [];}
        }):null;
        writeFileSync(${JSON.stringify(observation)},JSON.stringify({replaced,openLogs}));
      }
    `);
    const parent = Bun.spawn([process.execPath, wrapper], {
      cwd: root, env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: nativeTmp, TMP: nativeTmp, TEMP: nativeTmp, GITHUB_OUTPUT: githubOutput }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const [code, stdout, stderr] = await Promise.all([parent.exited, new Response(parent.stdout).text(), new Response(parent.stderr).text()]);
      const native: unknown = JSON.parse(readFileSync(observation, 'utf8'));
      if (!native || typeof native !== 'object' || !('replaced' in native) || !('openLogs' in native)) throw new Error('Expected actual replay replacement observation');
      expect(native.replaced).toBe(true);
      if (process.platform === 'linux') expect(native.openLogs).toEqual([]);
      expect(code).not.toBe(0); expect(stderr).toContain('goodvibes: test owner results ');
      expect(stdout).not.toContain(marker); expect(stdout).not.toContain('[test-owner 2/2]');
      expect(readFileSync(githubOutput, 'utf8')).toBe(''); expect(readFileSync(peer, 'utf8')).toBe(marker);
      const pids = readFileSync(children, 'utf8').trim().split('\n').map(Number);
      expect(new Set(pids).size).toBe(2);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (parent.exitCode === null) { parent.kill('SIGKILL'); await parent.exited; }
    }
  }
}, 60_000);


test('owner-log replay refuses borrowed callback replacement of original native capture records', async () => {
  const { root } = fixture(), owned = join(root, 'owned-logs');
  mkdirSync(owned);
  const first = join(owned, 'first.log'), second = join(owned, 'second.log'), peer = join(root, 'peer.log');
  const marker = 'Foreign synthetic peer bytes must not replace the native selection';
  writeFileSync(first, 'Original first owner bytes\n'); writeFileSync(second, 'Original second owner bytes\n'); writeFileSync(peer, marker);
  const files = [first, second].map(path => { const { dev, ino } = lstatSync(path); return { path, dev, ino }; });
  const rootIdentity = lstatSync(owned);
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  let changed = false;
  try {
    const result = await replayTestOwnerLogs(files, Date.now() + 1000, sink, undefined, () => {
      const current = lstatSync(owned);
      if (!current.isDirectory() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) throw new Error('Native log root retired');
      if (!changed) {
        const replacement = lstatSync(peer), selected = files[1];
        if (!selected) throw new Error('Missing original selected native log');
        selected.path = peer; selected.dev = replacement.dev; selected.ino = replacement.ino;
        changed = true;
      }
    });
    expect(changed).toBe(true);
    expect(result.outputTruncated).toBe(true);
    expect(result.stopReason).toContain('Owner-log replay failed');
    expect(Buffer.concat(chunks).toString()).not.toContain(marker);
    expect(readFileSync(peer, 'utf8')).toBe(marker);
    expect(readFileSync(first, 'utf8')).toBe('Original first owner bytes\n');
    expect(readFileSync(second, 'utf8')).toBe('Original second owner bytes\n');
    if (process.platform === 'linux') {
      const openLogs = readdirSync('/proc/self/fd').flatMap(fd => {
        try { const path = readlinkSync(`/proc/self/fd/${fd}`); return path.startsWith(root) ? [path] : []; }
        catch { return []; }
      });
      expect(openLogs).toEqual([]);
    }
  } finally { sink.destroy(); }
});
