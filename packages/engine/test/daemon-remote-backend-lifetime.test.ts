import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { BackendLifetime } from '../sdk/src/platform/runtime/remote/host/backends/backend-lifetime.ts';
import { runProcess } from '../sdk/src/platform/runtime/remote/host/backends/process-runner.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { (Bun.spawn as unknown as { mockRestore?: () => void }).mockRestore?.(); });

describe('backend lifetime', () => {
  test('late credential lookup cannot resume dispatch after close', async () => {
    const lifetime = new BackendLifetime();
    const lookup = deferred<string>();
    const entered = deferred<void>();
    let resumed = false;
    let cleaned = false;
    const dispatch = lifetime.run(async () => {
      await lifetime.waitFor(() => { entered.resolve(); return lookup.promise; });
      resumed = true;
    });
    await entered.promise;
    await lifetime.close(async () => { cleaned = true; });
    await expect(dispatch).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CLOSED' });
    lookup.resolve('fixture credential');
    await Promise.resolve();
    expect(resumed).toBe(false);
    expect(cleaned).toBe(true);
  });

  test('close waits for owned filesystem operations before cleanup', async () => {
    const lifetime = new BackendLifetime();
    const write = deferred<void>();
    const entered = deferred<void>();
    let cleaned = false;
    const pending = lifetime.run(async () => { entered.resolve(); await write.promise; });
    await entered.promise;
    const closing = lifetime.close(async () => { cleaned = true; });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    write.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CLOSED' });
    await closing;
    expect(cleaned).toBe(true);
  });

  test('close is idempotent even when called reentrantly from the abort event', async () => {
    const lifetime = new BackendLifetime();
    let nested: Promise<void> | undefined;
    let cleanups = 0;
    lifetime.signal.addEventListener('abort', () => {
      nested = lifetime.close(async () => { cleanups += 100; });
    });
    const closing = lifetime.close(async () => { cleanups += 1; });
    expect(nested).toBe(closing);
    await closing;
    expect(cleanups).toBe(1);
  });

  test('new work and lookups refuse after close', async () => {
    const lifetime = new BackendLifetime();
    await lifetime.close(async () => {});
    let ran = false;
    await expect(lifetime.run(async () => { ran = true; })).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CLOSED' });
    expect(() => lifetime.waitFor(async () => { ran = true; })).toThrow('closed');
    expect(ran).toBe(false);
  });

  test('cleanup failures remain visible and are not retried blindly', async () => {
    const lifetime = new BackendLifetime();
    let calls = 0;
    const closing = lifetime.close(async () => { calls += 1; throw new Error('fixture cleanup failed'); });
    await expect(closing).rejects.toThrow('fixture cleanup failed');
    expect(lifetime.close(async () => {})).toBe(closing);
    expect(calls).toBe(1);
  });
});

describe('owned runner cancellation', () => {
  test('an already-aborted invocation never spawns', async () => {
    const spawn = spyOn(Bun, 'spawn');
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess({ args: ['fixture'], timeoutMs: 1000, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('abort stops and reaps an active child without waiting for the deadline', async () => {
    const exited = deferred<number>();
    let kills = 0;
    spyOn(Bun, 'spawn').mockImplementation((() => ({
      stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), stdin: null,
      exited: exited.promise, kill() { kills += 1; exited.resolve(137); },
    })) as unknown as typeof Bun.spawn);
    const controller = new AbortController();
    const pending = runProcess({ args: ['fixture'], timeoutMs: 10000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(kills).toBe(1);
  });

  test('success removes the abort listener', async () => {
    spyOn(Bun, 'spawn').mockImplementation((() => ({
      stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), stdin: null,
      exited: Promise.resolve(0), kill() {},
    })) as unknown as typeof Bun.spawn);
    const controller = new AbortController();
    const remove = spyOn(controller.signal, 'removeEventListener');
    try {
      await runProcess({ args: ['fixture'], timeoutMs: 1000, signal: controller.signal });
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally { remove.mockRestore(); }
  });
});
