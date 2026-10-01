import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function lockPath() { const root = mkdtempSync(join(tmpdir(), 'knowledge-strict-lock-')); roots.push(root); return join(root, '.lock'); }
const options = { strictOwnership: true, totalTimeoutMs: 40, initialBackoffMs: 5, maxBackoffMs: 10 } as const;

test('strict ownership never evicts a live process because its heartbeat is old', async () => {
  const file = lockPath();
  const bytes = JSON.stringify({ pid: process.pid, token: '1234567890abcdef', acquiredAt: Date.now() - 120000 });
  writeFileSync(file, bytes);
  utimesSync(file, new Date(0), new Date(0));
  await expect(acquireCrossProcessLock(file, { ...options, staleMs: 1 }).then(release => { release(); return 'acquired'; })).rejects.toThrow('timed out');
  expect(readFileSync(file, 'utf8')).toBe(bytes);
});

test.each(['', 'not-json', '{"pid":0}', '{"pid":-7}', '{"pid":99999999,"token":""}', '{"pid":99999999,"token":"1234567890abcdef","acquiredAt":"bad"}'])(
  'strict ownership does not turn corrupt metadata into write authority: %j', async bytes => {
    const file = lockPath(); writeFileSync(file, bytes);
    await expect(acquireCrossProcessLock(file, options).then(release => { release(); return 'acquired'; })).rejects.toThrow('timed out');
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  },
);

test('strict ownership recovers a real exited owner and releases only its own inode', async () => {
  const file = lockPath();
  const modulePath = new URL('../sdk/src/platform/workspace/checkpoint/cross-process-lock.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', new URL('../scripts/test-network-preload.ts', import.meta.url).pathname, '-e',
    `const { acquireCrossProcessLock } = await import(process.argv[1]); await acquireCrossProcessLock(process.argv[2], { strictOwnership: true }); console.log(process.pid); process.exit(0);`, modulePath, file,
  ], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  const [exit, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, errors }).toEqual({ exit: 0, errors: '' });
  const deadPid = Number(output.trim());
  expect(() => process.kill(deadPid, 0)).toThrow();
  const oldInode = statSync(file).ino;
  const release = await acquireCrossProcessLock(file, { ...options, totalTimeoutMs: 1000 });
  expect(statSync(file).ino).not.toBe(oldInode);
  expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid);
  release(); release();
  expect(existsSync(file)).toBe(false);
});

test('unsupported atomic publication fails closed, including after another caller enabled fallback', async () => {
  const file = lockPath();
  const modulePath = new URL('../sdk/src/platform/workspace/checkpoint/cross-process-lock.ts', import.meta.url).pathname;
  const script = `
    import { mock } from 'bun:test';
    const fs = await import('node:fs');
    const original = { ...fs };
    mock.module('node:fs', () => ({ ...original, linkSync() { throw Object.assign(new Error('fixture unsupported'), { code: 'EOPNOTSUPP' }); } }));
    const { acquireCrossProcessLock } = await import(process.argv[1]);
    const release = await acquireCrossProcessLock(process.argv[2] + '.legacy'); release();
    try { await acquireCrossProcessLock(process.argv[2], { strictOwnership: true }); console.log('wrongly acquired'); }
    catch (error) { console.log(error.message); }
  `;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', new URL('../scripts/test-network-preload.ts', import.meta.url).pathname, '-e', script, modulePath, file],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0);
  expect(output.trim()).toBe('cross-process-lock: strict ownership requires atomic populated lock creation');
  expect(existsSync(file)).toBe(false);
});
