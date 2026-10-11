import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Copying the actual helper outside Git isolates every test from the live build lock.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-lock-lifecycle-')); roots.push(root);
  mkdirSync(join(root, 'scripts'));
  const helper = join(root, 'scripts', 'workspace-lock.ts');
  copyFileSync(new URL('../scripts/workspace-lock.ts', import.meta.url), helper);
  const api = await import(pathToFileURL(helper).href) as typeof import('../scripts/workspace-lock.ts');
  return { root, helper, lock: join(root, '.tmp', 'workspace.lock'), ...api };
}

async function killedHolder(helper: string): Promise<number> {
  const child = Bun.spawn([process.execPath, '--eval',
    `import { withWorkspaceLock } from ${JSON.stringify(helper)}; await withWorkspaceLock('killed holder', async () => { console.log('acquired'); await new Promise(() => { setInterval(() => {}, 1000); }); });`,
  ], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('acquired');
    } finally { reader.releaseLock(); }
    child.kill('SIGKILL'); await child.exited;
    return child.pid;
  } finally { child.kill(); await child.exited; }
}

test('a live holder older than fifteen minutes excludes both acquisition and release waiters', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holder = f.withWorkspaceLock('live aged owner', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    const path = join(f.lock, 'owner.json');
    const info: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!info || typeof info !== 'object') throw new Error('Missing lock owner');
    writeFileSync(path, JSON.stringify({ ...info, startedAt: Date.now() - 16 * 60_000 }));
    let enteredSecond = false;
    await expect(f.withWorkspaceLock('contender', () => { enteredSecond = true; }, 1)).rejects.toThrow('Timed out');
    expect(enteredSecond).toBe(false);
    await expect(f.waitForWorkspaceLockRelease('release waiter', 1)).rejects.toThrow('Timed out');
    expect(existsSync(f.lock)).toBe(true);
  } finally { release.resolve(); await holder; }
  expect(existsSync(f.lock)).toBe(false);
});

test('a displaced holder cannot release a successor generation', async () => {
  const f = await fixture();
  const firstEntered = Promise.withResolvers<void>(), firstRelease = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>(), secondRelease = Promise.withResolvers<void>();
  const first = f.withWorkspaceLock('predecessor', async () => { firstEntered.resolve(); await firstRelease.promise; });
  await firstEntered.promise;
  renameSync(f.lock, join(f.root, 'displaced-generation'));
  const second = f.withWorkspaceLock('successor', async () => { secondEntered.resolve(); await secondRelease.promise; });
  await secondEntered.promise;
  try {
    firstRelease.resolve(); await first;
    expect(existsSync(f.lock)).toBe(true);
    let thirdEntered = false;
    await expect(f.withWorkspaceLock('third owner', () => { thirdEntered = true; }, 1)).rejects.toThrow('Timed out');
    expect(thirdEntered).toBe(false);
  } finally { firstRelease.resolve(); secondRelease.resolve(); await Promise.all([first, second]); }
  expect(existsSync(f.lock)).toBe(false);
});

test('a newly created ownerless directory is not stolen during owner publication', async () => {
  const f = await fixture(); mkdirSync(f.lock, { recursive: true });
  let entered = false;
  await expect(f.withWorkspaceLock('publication contender', () => { entered = true; }, 1)).rejects.toThrow('Timed out');
  expect(entered).toBe(false); expect(existsSync(f.lock)).toBe(true);
});

test('a killed owner can be reclaimed without waiting for age expiry', async () => {
  const f = await fixture();
  await killedHolder(f.helper);
  let acquired = false;
  await f.withWorkspaceLock('reclaimer', () => { acquired = true; }, 1_000);
  expect(acquired).toBe(true); expect(existsSync(f.lock)).toBe(false);
});

test.each([false, true])('a crashed cleanup claimant is recoverable after owner removal=%s', async removeOwner => {
  const f = await fixture();
  const deadPid = await killedHolder(f.helper);
  const directory = readlinkSync(f.lock);
  const marker = readdirSync(directory).find(name => name.startsWith('ownership.'));
  if (!marker) throw new Error('Missing generation ownership marker');
  const token = marker.slice('ownership.'.length, -'.json'.length);
  renameSync(join(directory, marker), join(directory, `cleanup-${token}--${deadPid}--00000000-0000-0000-0000-000000000000.json`));
  if (removeOwner) unlinkSync(join(directory, 'owner.json'));
  let acquired = false;
  await f.withWorkspaceLock('cleanup reclaimer', () => { acquired = true; }, 1_000);
  expect(acquired).toBe(true); expect(existsSync(f.lock)).toBe(false); expect(existsSync(directory)).toBe(false);
});

test('an aged empty publication orphan can be reclaimed', async () => {
  const f = await fixture(); mkdirSync(f.lock, { recursive: true });
  const old = new Date(Date.now() - 60_000); utimesSync(f.lock, old, old);
  let acquired = false;
  await f.withWorkspaceLock('empty orphan reclaimer', () => { acquired = true; }, 1_000);
  expect(acquired).toBe(true); expect(existsSync(f.lock)).toBe(false);
});

test('a dead legacy directory holder remains reclaimable', async () => {
  const f = await fixture();
  const deadPid = await killedHolder(f.helper);
  const abandoned = readlinkSync(f.lock); unlinkSync(f.lock); rmSync(abandoned, { recursive: true });
  mkdirSync(f.lock); writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: deadPid, label: 'legacy', startedAt: Date.now() }));
  let acquired = false;
  await f.withWorkspaceLock('legacy reclaimer', () => { acquired = true; }, 1_000);
  expect(acquired).toBe(true); expect(existsSync(f.lock)).toBe(false);
});

test('legacy cleanup retains a recoverable claim until its lease files are removed', async () => {
  const f = await fixture();
  const deadPid = await killedHolder(f.helper);
  const abandoned = readlinkSync(f.lock); unlinkSync(f.lock); rmSync(abandoned, { recursive: true });
  mkdirSync(f.lock); writeFileSync(join(f.lock, 'owner.json'), JSON.stringify({ pid: deadPid, label: 'legacy', startedAt: Date.now() }));
  // Crash the actual helper at the filesystem boundary immediately before lease removal.
  const script = `import { mock } from 'bun:test'; import * as fs from 'node:fs'; import { dirname } from 'node:path';
    const actualUnlink = fs.unlinkSync, actualRead = fs.readdirSync;
    mock.module('node:fs', () => ({ ...fs, unlinkSync(path) {
      if (String(path).includes('legacy-cleanup.')) {
        console.log(JSON.stringify({ claimPresent: actualRead(dirname(String(path))).some(name => name.startsWith('cleanup-')) }));
        process.kill(process.pid, 'SIGKILL');
      }
      actualUnlink(path);
    } }));
    const { withWorkspaceLock } = await import(${JSON.stringify(f.helper)});
    await withWorkspaceLock('crashing legacy cleaner', () => {}, 1000);`;
  const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  try {
    await child.exited;
    expect(await new Response(child.stdout).text()).toContain('"claimPresent":true');
    expect(await new Response(child.stderr).text()).toBe('');
    let acquired = false;
    await f.withWorkspaceLock('legacy crash reclaimer', () => { acquired = true; }, 1_000);
    expect(acquired).toBe(true); expect(existsSync(f.lock)).toBe(false);
  } finally { child.kill(); await child.exited; }
});

test('independent processes never overlap their protected callbacks', async () => {
  const f = await fixture();
  const occupied = join(f.root, 'protected-callback');
  const script = `import { withWorkspaceLock } from ${JSON.stringify(f.helper)};
    import { mkdirSync, rmdirSync } from 'node:fs';
    await withWorkspaceLock('concurrent contender', async () => {
      mkdirSync(${JSON.stringify(occupied)});
      await Bun.sleep(20);
      rmdirSync(${JSON.stringify(occupied)});
    }, 5000);`;
  const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    const results = await Promise.all(children.map(async child => ({ code: await child.exited, error: await new Response(child.stderr).text() })));
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, error: '' })));
    expect(existsSync(f.lock)).toBe(false);
  } finally { for (const child of children) child.kill(); await Promise.all(children.map(child => child.exited)); }
}, 10_000);
