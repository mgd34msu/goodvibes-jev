import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTempDirRegistry, drainTempDirsUntilSettled } from '../toolchain/src/test-runner/temp-registry.ts';
import { withRunTmpDir } from '../toolchain/src/test-runner/test-run-tmp.ts';
import { runOwnedTestChild } from '../toolchain/src/test-runner/owned-test-child.ts';
const roots: string[] = [];
function scratch(): string { const p = mkdtempSync(join(tmpdir(), 'cleanup-proof-')); roots.push(p); return p; }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

test('registry deduplicates, unregisters and tolerates already deleted paths', () => {
  const root = scratch(); const registry = createTempDirRegistry(root);
  const tracked = mkdtempSync(join(root, 'tracked-')); const untracked = mkdtempSync(join(root, 'foreign-'));
  registry.register(tracked); registry.register(tracked); registry.register(untracked); registry.unregister(untracked);
  expect(registry.entries()).toEqual([tracked]); rmSync(tracked, { recursive: true });
  expect(registry.cleanup()).toEqual([tracked]); expect(registry.entries()).toEqual([]); expect(existsSync(untracked)).toBe(true);
});
test('registry removes an existing registered directory and preserves an unregistered sibling', () => {
  const root = scratch(); const registry = createTempDirRegistry(root);
  const dropped = mkdtempSync(join(root, 'registered-')); const kept = mkdtempSync(join(root, 'unregistered-'));
  registry.register(dropped); registry.register(kept); registry.unregister(kept);
  expect(registry.entries()).toContain(dropped); expect(existsSync(dropped)).toBe(true);
  const removed = registry.cleanup();
  expect(removed).toContain(dropped); expect(removed).not.toContain(kept);
  expect(existsSync(dropped)).toBe(false); expect(existsSync(kept)).toBe(true);
  expect(registry.entries()).not.toContain(dropped);
});
test('registry rejects outside roots, roots themselves and symlink escapes', () => {
  const root = scratch(); const foreign = scratch(); const registry = createTempDirRegistry(root);
  expect(() => registry.register(foreign)).toThrow('unowned'); expect(() => registry.register(root)).toThrow('unowned');
  symlinkSync(foreign, join(root, 'link')); expect(() => registry.register(join(root, 'link', 'child'))).toThrow('unowned');
});
test('registry refuses path replaced with a foreign link', () => {
  const root = scratch(); const foreign = scratch(); writeFileSync(join(foreign, 'keep'), 'keep');
  const registry = createTempDirRegistry(root); const path = mkdtempSync(join(root, 'tracked-')); registry.register(path);
  rmSync(path, { recursive: true }); symlinkSync(foreign, path);
  expect(registry.cleanup()).toEqual([]); expect(lstatSync(path).isSymbolicLink()).toBe(true); expect(existsSync(join(foreign, 'keep'))).toBe(true);
});
test('registry refuses replaced owner root', () => {
  const parent = scratch(); const root = join(parent, 'owned'); mkdirSync(root);
  const path = join(root, 'tracked'); mkdirSync(path); const registry = createTempDirRegistry(root); registry.register(path);
  renameSync(root, join(parent, 'old')); mkdirSync(root); mkdirSync(path);
  expect(registry.cleanup()).toEqual([]); expect(existsSync(path)).toBe(true);
});
test('bounded drain observes late writes after an initially clean pause', async () => {
  const root = scratch(); const path = join(root, 'tracked'); mkdirSync(path); const registry = createTempDirRegistry(root); registry.register(path);
  let ticks = 0;
  const result = await drainTempDirsUntilSettled({ registry, backoffMs: [0, 0, 0], sleep: async () => { if (++ticks === 2) mkdirSync(path, { recursive: true }); } });
  expect(ticks).toBe(4); expect(result.survivors).toEqual([]); expect(result.removed).toEqual([path]); expect(result.passes).toBe(4);
});
test('bounded drain honestly reports continuous late writers and late registrations', async () => {
  const root = scratch(); const path = join(root, 'tracked'); mkdirSync(path); const registry = createTempDirRegistry(root); registry.register(path);
  const late = join(root, 'late'); let ticks = 0;
  const result = await drainTempDirsUntilSettled({ registry, backoffMs: [0, 0], sleep: async () => {
    mkdirSync(path, { recursive: true }); if (++ticks === 3) { mkdirSync(late); registry.register(late); }
  } });
  expect(result.survivors.sort()).toEqual([late, path].sort()); expect(result.passes).toBe(3);
});
test('parent root creation refuses existing/escaping names without deletion', async () => {
  const root = scratch(); mkdirSync(join(root, 'foreign')); writeFileSync(join(root, 'foreign', 'keep'), 'keep');
  await expect(withRunTmpDir(root, () => {}, 'foreign')).rejects.toThrow();
  await expect(withRunTmpDir(root, () => {}, '../escape')).rejects.toThrow();
  expect(existsSync(join(root, 'foreign', 'keep'))).toBe(true);
});
test('parent cleanup rejects a replaced path', async () => {
  const root = scratch();
  await expect(withRunTmpDir(root, (owned) => { renameSync(owned, `${owned}-old`); mkdirSync(owned); writeFileSync(join(owned, 'keep'), 'keep'); }, 'owned')).rejects.toThrow('replaced');
  expect(existsSync(join(root, 'owned', 'keep'))).toBe(true);
});

const helper = resolve(import.meta.dir, '_helpers/project-temp.ts');
async function fixture(body: string, options: { interrupt?: boolean; ceiling?: number; unregistered?: boolean } = {}) {
  const root = scratch(); const record = join(root, 'record.json'); const file = join(root, 'fixture.test.ts');
  mkdirSync(join(root, '.test-tmp')); writeFileSync(join(root, '.test-tmp', 'keep'), 'keep');
  const allocation = options.unregistered
    ? `mkdtempSync(${JSON.stringify(join(root, '.test-tmp', 'unregistered-'))})`
    : "makeProjectTempDir('owned')";
  writeFileSync(file, `import {test,expect} from 'bun:test'; import {existsSync,mkdtempSync,writeFileSync,mkdirSync} from 'node:fs'; import {makeProjectTempDir} from ${JSON.stringify(helper)}; const dir=${allocation}; writeFileSync(${JSON.stringify(record)},JSON.stringify({dir,pid:process.pid,existedDuring:existsSync(dir)})); ${body}`);
  let timer: ReturnType<typeof setInterval> | undefined;
  let observedWhileAlive = false;
  timer = setInterval(() => {
    if (!existsSync(record)) return;
    const data = JSON.parse(readFileSync(record, 'utf8'));
    if (options.interrupt) { options.interrupt = false; process.kill(process.pid, 'SIGTERM'); }
    try { process.kill(data.pid, 0); if (!existsSync(data.dir)) observedWhileAlive = true; } catch { /* Child exited. */ }
  }, 5);
  try {
    const result = await runOwnedTestChild({ ownProcessGroup: process.platform !== 'win32', argv: [file], cwd: root, env: process.env, ceilingMs: options.ceiling ?? 8000, killGraceMs: 100, outputDrainGraceMs: 1000 });
    const data = JSON.parse(readFileSync(record, 'utf8'));
    expect(data.existedDuring).toBe(true);
    // The exact same observation must report a survivor when this fixture
    // deliberately writes outside the owned root without registration.
    expect(existsSync(data.dir)).toBe(options.unregistered ?? false);
    expect(existsSync(join(data.dir, '..'))).toBe(options.unregistered ?? false);
    expect(existsSync(join(root, '.test-tmp', 'keep'))).toBe(true);
    if (process.platform === 'linux' && existsSync(join(root, 'descendant.pid'))) {
      const descendant = Number(readFileSync(join(root, 'descendant.pid'), 'utf8'));
      let live = false;
      try { live = !/\) Z /.test(readFileSync(`/proc/${descendant}/stat`, 'utf8')); } catch { /* Gone. */ }
      expect(live, 'ordinary descendant must be dead before fixture cleanup').toBe(false);
    }
    return { result, observedWhileAlive, root };
  } finally {
    clearInterval(timer);
    try { process.kill(Number(readFileSync(join(root, 'descendant.pid'), 'utf8')), 'SIGKILL'); } catch { /* Only our recorded fixture child. */ }
  }
}
test('real preload deletes registered paths while child is alive; parent removes its root', async () => {
  const { result, observedWhileAlive } = await fixture("test('pass',()=>expect(true).toBe(true));");
  expect(result.exitCode).toBe(0); expect(observedWhileAlive).toBe(true);
}, 15000);
test('the same real-child measurement reports an unregistered outside-root survivor', async () => {
  const { result } = await fixture("test('unregistered directory exists',()=>expect(existsSync(dir)).toBe(true));", { unregistered: true });
  expect(result.exitCode).toBe(0);
}, 15000);
test('failure and abrupt child exit both clean their owned root', async () => {
  expect((await fixture("test('fail',()=>expect(true).toBe(false));")).result.exitCode).toBe(1);
  expect((await fixture("process.exit(7);")).result.exitCode).toBe(7);
}, 15000);
test('runner interruption kills and cleans its child', async () => {
  const { result } = await fixture("test('waiting',async()=>await Bun.sleep(10000));", { interrupt: true });
  expect(result.stopped).toBe('interrupted');
}, 15000);
test('ordinary POSIX descendant is stopped before root removal', async () => {
  if (process.platform === 'win32') return;
  const { result, root } = await fixture(`const child=Bun.spawn([process.execPath,'-e', 'setInterval(()=>{},100)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});writeFileSync('descendant.pid',String(child.pid));test('spawn',()=>{});`);
  expect(result.exitCode).toBe(0);
  const pid = Number(readFileSync(join(root, 'descendant.pid'), 'utf8'));
  let live = false;
  try { process.kill(pid, 0); const status = readFileSync(`/proc/${pid}/stat`, 'utf8'); live = !/\) Z /.test(status); } catch { /* Dead/reaped. */ }
  expect(live).toBe(false);
}, 15000);

test('stale sweep requires dead known ownership and preserves evidence, links and live roots', async () => {
  const { sweepStaleTmpDirs } = await import('../toolchain/src/test-runner/stale-tmp-sweep.ts');
  const { utimesSync } = await import('node:fs');
  const root = scratch(); const prefix = 'goodvibes-sdk-testrun-';
  const make = (name: string, pid?: number): string => {
    const path = join(root, prefix + name); mkdirSync(path); const stat = lstatSync(path);
    if (pid !== undefined) writeFileSync(join(path, '.goodvibes-test-owner.json'), JSON.stringify({ version: 1, pid, dev: stat.dev, ino: stat.ino }));
    utimesSync(path, 1, 1); return path;
  };
  const dead = make('dead', 2147483647); const live = make('live', process.pid); const unknown = make('unknown');
  const evidence = make('evidence', 2147483647); writeFileSync(join(evidence, '.keep-proof-output'), 'keep'); utimesSync(evidence, 1, 1);
  const worktree = make('worktree', 2147483647); writeFileSync(join(worktree, '.git'), 'gitdir: external'); utimesSync(worktree, 1, 1);
  const link = join(root, prefix + 'link'); symlinkSync(unknown, link);
  sweepStaleTmpDirs(root, prefix, 1000);
  expect(existsSync(dead)).toBe(false);
  for (const path of [live, unknown, evidence, worktree, link]) expect(existsSync(path)).toBe(true);
});

test('hard-killed parent is detected by child watchdog; ordinary group dies and stale owned tree is reclaimable', async () => {
  if (process.platform !== 'linux') return;
  const root = scratch(); const record = join(root, 'record.json');
  const runnerSource = resolve(import.meta.dir, '../toolchain/src/test-runner/owned-test-child.ts');
  writeFileSync(join(root, 'orphan.test.ts'), `import {test} from 'bun:test';import {writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},100)'],{stdout:'ignore',stderr:'ignore',stdin:'ignore'});writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,descendant:child.pid,tmp:tmpdir()}));test('alive',async()=>await Bun.sleep(20000));`);
  writeFileSync(join(root, 'runner.ts'), `import {runOwnedTestChild} from ${JSON.stringify(runnerSource)};await runOwnedTestChild({ownProcessGroup:true,argv:['./orphan.test.ts'],cwd:import.meta.dir,env:process.env});`);
  const owner = Bun.spawn([process.execPath, join(root, 'runner.ts')], { cwd: root, env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, stdout: 'ignore', stderr: 'ignore' });
  let data: {pid:number;descendant:number;tmp:string} | undefined;
  const live = (pid: number): boolean => { try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
  try {
    const ready = Date.now() + 5000;
    while (!existsSync(record) && Date.now() < ready) await Bun.sleep(10);
    expect(existsSync(record)).toBe(true); data = JSON.parse(readFileSync(record, 'utf8'));
    owner.kill('SIGKILL'); await owner.exited;
    const deadline = Date.now() + 5000;
    while ((live(data!.pid) || live(data!.descendant)) && Date.now() < deadline) await Bun.sleep(20);
    expect(live(data!.pid)).toBe(false); expect(live(data!.descendant)).toBe(false);
    expect(existsSync(data!.tmp)).toBe(true);
    const { utimesSync } = await import('node:fs'); utimesSync(data!.tmp, 1, 1);
    const { sweepStaleTmpDirs } = await import('../toolchain/src/test-runner/stale-tmp-sweep.ts');
    sweepStaleTmpDirs(root, 'goodvibes-sdk-testrun-', 1000);
    expect(existsSync(data!.tmp)).toBe(false);
  } finally {
    owner.kill('SIGKILL'); await owner.exited;
    if (data) for (const pid of [data.pid, data.descendant]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}, 15000);

test('late-writing ordinary descendant cannot recreate the parent tree after teardown', async () => {
  if (process.platform !== 'linux') return;
  const { result, root } = await fixture(`
    const source='const fs=require("node:fs");const path='+JSON.stringify(dir)+';process.on("SIGTERM",()=>{});setInterval(()=>fs.mkdirSync(path,{recursive:true}),5);';
    const child=Bun.spawn([process.execPath,'-e',source],{stdout:'ignore',stderr:'ignore',stdin:'ignore'});
    writeFileSync('descendant.pid',String(child.pid));
    test('late writer',()=>{});
  `);
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(readFileSync(join(root, 'record.json'), 'utf8'));
  await Bun.sleep(100);
  expect(existsSync(data.dir)).toBe(false); expect(existsSync(join(data.dir, '..'))).toBe(false);
});

test('an independent registry cannot adopt an arbitrary root outside the official owner', () => {
  const registry = createTempDirRegistry(resolve(tmpdir(), '..'));
  expect(() => registry.register(tmpdir())).toThrow('outside the official owned test tree');
});

test('an independent registry rejects an intermediate link escaping the official tree', () => {
  const root = scratch(); symlinkSync(resolve(import.meta.dir, '..'), join(root, 'linked-engine'));
  const registry = createTempDirRegistry(join(root, 'linked-engine', 'test'));
  // Registration alone must refuse; never attempt cleanup of source paths.
  expect(() => registry.register(join(import.meta.dir, '_helpers'))).toThrow('escapes the official owned test tree');
});

test('public runner startup reclaims only its stale known run roots', async () => {
  const root = scratch(); const stale = join(root, 'goodvibes-sdk-testrun-stale'); const unknown = join(root, 'goodvibes-sdk-testrun-legacy');
  mkdirSync(stale); mkdirSync(unknown); const identity = lstatSync(stale);
  writeFileSync(join(stale, '.goodvibes-test-owner.json'), JSON.stringify({ version: 1, pid: 2147483647, dev: identity.dev, ino: identity.ino }));
  const { utimesSync } = await import('node:fs'); utimesSync(stale, 1, 1); utimesSync(unknown, 1, 1);
  const file = join(root, 'pass.test.ts'); writeFileSync(file, "import {test} from 'bun:test';test('pass',()=>{});");
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  try {
    process.env.TMPDIR = root; process.env.TMP = root; process.env.TEMP = root;
    const result = await runOwnedTestChild({ argv: [file], cwd: root, env: process.env, ceilingMs: 5000 });
    expect(result.exitCode).toBe(0); expect(existsSync(stale)).toBe(false); expect(existsSync(unknown)).toBe(true);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}, 10000);

test.each(['EPERM', 'unknown', 'alive'] as const)('parent-death probe keeps an unproven or live owner alive: %s', async (mode) => {
  const { result } = await fixture(`
    const originalKill = process.kill.bind(process);
    const parent = Number(process.env.GOODVIBES_TEST_PARENT_PID);
    let probes = 0;
    process.kill = (pid, signal) => {
      if (pid === parent && signal === 0) {
        probes++;
        ${mode === 'EPERM' ? "throw Object.assign(new Error('authored permission-probe failure'), { code: 'EPERM' });" : mode === 'unknown' ? "throw new Error('authored unknown probe failure');" : 'return originalKill(pid, signal);'}
      }
      return originalKill(pid, signal);
    };
    test('observe the real watchdog poll', async () => {
      await Bun.sleep(1500);
      expect(probes).toBeGreaterThan(0);
    });
  `);
  expect(result.exitCode).toBe(0); expect(result.stopped).toBeNull(); expect(result.signalCode).toBeNull();
}, 15000);

test.each(['EPERM', 'unknown'] as const)('unknown group observation retains marked roots and reaps the direct child: %s', async (mode) => {
  const root = scratch(); const record = join(root, 'group-observation.json'); const file = join(root, 'group-observation.test.ts');
  writeFileSync(file, `import {test} from 'bun:test';import {writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,root:tmpdir()}));test('exit normally',()=>{});`);
  const ownerMarker = join(process.env.GOODVIBES_TEST_OWNED_TMP_ROOT!, '.keep-proof-output');
  const markerWasPresent = existsSync(ownerMarker);
  const previousKill = process.kill; const originalKill = previousKill.bind(process); let probes = 0;
  let owned: {pid:number;root:string} | undefined;
  try {
    process.kill = ((pid, signal) => {
      if (pid < 0 && signal === 0) {
        probes++;
        if (mode === 'EPERM') throw Object.assign(new Error('authored denied group observation'), {code:'EPERM'});
        throw new Error('authored unknown group observation');
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    await expect(runOwnedTestChild({argv:[file],cwd:root,env:process.env,ownProcessGroup:true,killGraceMs:100,ceilingMs:5000})).rejects.toThrow('retaining test root');
    process.kill = previousKill;
    owned = JSON.parse(readFileSync(record, 'utf8'));
    expect(probes).toBeGreaterThan(0);
    expect(existsSync(owned!.root)).toBe(true);
    expect(existsSync(join(owned!.root, '.keep-proof-output'))).toBe(true);
    expect(existsSync(ownerMarker), 'an ancestor owner must not delete the retained nested root').toBe(true);
    expect(() => originalKill(owned!.pid, 0)).toThrow();
  } finally {
    process.kill = previousKill;
    // These fixtures have no descendants. Reap verification above precedes
    // cleanup; retain evidence if the recorded direct child is still alive.
    if (owned) {
      let dead = false;
      try { originalKill(owned.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (dead) {
        rmSync(owned.root, {recursive:true,force:true});
        if (!markerWasPresent) rmSync(ownerMarker, {force:true});
      }
    }
  }
}, 10000);


test('legacy manifested foreign paths confer no deletion authority while owned child scratch is removed', async () => {
  const root = scratch();
  const foreign = join(root, 'foreign'); mkdirSync(foreign);
  const keep = join(foreign, 'keep'); writeFileSync(keep, 'foreign evidence');
  const manifest = join(root, 'legacy-manifest.json');
  const contents = JSON.stringify([foreign]); writeFileSync(manifest, contents);
  const record = join(root, 'allocated.json'); const file = join(root, 'legacy-manifest.test.ts');
  writeFileSync(file, `import {test,expect} from 'bun:test'; import {writeFileSync,existsSync} from 'node:fs'; import {makeProjectTempDir} from ${JSON.stringify(helper)}; const dir=makeProjectTempDir('manifest-successor'); writeFileSync(${JSON.stringify(record)}, JSON.stringify({dir})); test('owns scratch',()=>expect(existsSync(dir)).toBe(true));`);
  const result = await runOwnedTestChild({ argv: [file], cwd: root,
    env: { ...process.env, GOODVIBES_TEST_TEMP_MANIFEST: manifest }, ceilingMs: 8000 });
  const allocated = JSON.parse(readFileSync(record, 'utf8')) as { dir: string };
  expect(result.exitCode).toBe(0);
  expect(existsSync(allocated.dir)).toBe(false);
  expect(existsSync(join(allocated.dir, '..'))).toBe(false);
  expect(readFileSync(keep, 'utf8')).toBe('foreign evidence');
  expect(readFileSync(manifest, 'utf8')).toBe(contents);
}, 15000);
