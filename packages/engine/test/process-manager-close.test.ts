import { expect, spyOn, test } from 'bun:test';
import * as credentialEnv from '../sdk/src/platform/tools/exec/credential-env.js';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.js';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { waitFor } from './_helpers/test-timeout.js';

useToolReadings([['', { credential: true }]]);
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('close shares completion, reaps owned children, and refuses both spawn entrypoints', async () => {
  const manager = new ProcessManager();
  const child = await manager.spawnArgv('/bin/sleep', ['10'], '/tmp', undefined, { sigterm_grace_ms: 20 });
  try {
    const closing = manager.close();
    expect(manager.close()).toBe(closing);
    await closing;
    expect(alive(child.pid!)).toBe(false);
    expect(manager.getStatus(child.process_id!)?.done).toBe(true);
    await expect(manager.spawn('echo unexpected', '/tmp', undefined)).rejects.toThrow('ProcessManager is closed');
    await expect(manager.spawnArgv('/bin/echo', ['unexpected'], '/tmp', undefined)).rejects.toThrow('ProcessManager is closed');
  } finally { await manager.close(); }
});

test.each([0, 20])('close reaps a previously stopped child that ignores SIGTERM with %dms grace', async (grace) => {
  const manager = new ProcessManager();
  const child = await manager.spawnArgv(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'], '/tmp', undefined,
    { timeout_ms: 12_000, sigterm_grace_ms: grace });
  const id = child.process_id!;
  try {
    await waitFor(() => manager.getOutput(id)?.stdout.includes('ready') === true);
    const status = manager.getStatus(id)!;
    const wallClock = spyOn(Date, 'now').mockReturnValue(0);
    try {
      expect(manager.stop(id)).toBe(true);
      expect(manager.getStatus(id)).toBeUndefined();
      await manager.close();
      expect(alive(child.pid!)).toBe(false);
      expect(status.done).toBe(true);
      expect(status.signal).toBe('SIGKILL');
    } finally { wallClock.mockRestore(); }
  } finally { await manager.close(); }
});

test('close preserves opted-out lifetimes and never stops a different manager child', async () => {
  const manager = new ProcessManager(); const other = new ProcessManager();
  const legacy = await manager.spawnArgv('/bin/sleep', ['10'], '/tmp', undefined, { kill_on_timeout: false, sigterm_grace_ms: 20 });
  const explicit = await manager.spawnArgv('/bin/sleep', ['10'], '/tmp', undefined, { kill_on_close: false, sigterm_grace_ms: 20 });
  const owned = await manager.spawnArgv('/bin/sleep', ['10'], '/tmp', undefined, { sigterm_grace_ms: 20 });
  const unrelated = await other.spawnArgv('/bin/sleep', ['10'], '/tmp', undefined, { sigterm_grace_ms: 20 });
  try {
    await manager.close();
    expect(alive(owned.pid!)).toBe(false);
    for (const child of [legacy, explicit, unrelated]) expect(alive(child.pid!)).toBe(true);
  } finally {
    manager.stop(legacy.process_id!); manager.stop(explicit.process_id!);
    await other.close();
    await waitFor(() => !alive(legacy.pid!) && !alive(explicit.pid!) && !alive(unrelated.pid!));
  }
});

test('explicit close ownership can override timeout lifetime opt-out', async () => {
  const manager = new ProcessManager();
  const child = await manager.spawnArgv('/bin/sleep', ['10'], '/tmp', undefined,
    { kill_on_timeout: false, kill_on_close: true, sigterm_grace_ms: 20 });
  try {
    await manager.close();
    expect(alive(child.pid!)).toBe(false);
    expect(manager.getStatus(child.process_id!)?.done).toBe(true);
  } finally { await manager.close(); }
});

test('close terminates existing children while draining credential resolution without a late spawn', async () => {
  let enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = new ProcessManager();
  const existing = await manager.spawnArgv('/bin/sleep', ['10'], '/tmp', undefined, { sigterm_grace_ms: 10 });
  const scrub = spyOn(credentialEnv, 'scrubCredentialEnv').mockImplementation(async () => {
    enter(); await gate; return { env: {}, withheld: [] };
  });
  const launching = manager.spawnArgv('/bin/sleep', ['10'], '/tmp', undefined);
  const outcome = launching.then(() => undefined, (error: unknown) => error);
  try {
    await entered;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await waitFor(() => !alive(existing.pid!));
    expect(closed).toBe(false);
    release(); expect(await outcome).toMatchObject({ message: 'ProcessManager is closed' }); await closing;
    expect(manager.list()).toHaveLength(1);
    expect(manager.getStatus(existing.process_id!)?.done).toBe(true);
  } finally { release(); await Promise.allSettled([launching, manager.close()]); scrub.mockRestore(); }
});

for (const field of ['timeout_ms', 'sigterm_grace_ms'] as const) {
  test.each([NaN, Infinity, -1, 2_147_483_648])(`invalid ${field}=%d is rejected before spawning`, async (value) => {
    const manager = new ProcessManager();
    const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('unexpected fixture spawn'); });
    try {
      await expect(manager.spawnArgv('/bin/echo', ['fixture'], '/tmp', undefined, { [field]: value })).rejects.toThrow(`${field} must be a finite number`);
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); await manager.close(); }
  });
}
