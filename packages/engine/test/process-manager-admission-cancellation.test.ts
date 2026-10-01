import { expect, mock, spyOn, test } from 'bun:test';
import { ProcessManager, type SpawnOptions } from '../sdk/src/platform/tools/shared/process-manager.ts';
import * as credentialEnv from '../sdk/src/platform/tools/exec/credential-env.ts';

const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([
  promise, Bun.sleep(500).then(() => { throw new Error('Admission fixture wait timed out'); }),
]);

function deferredScrub() {
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const scrub = spyOn(credentialEnv, 'scrubCredentialEnv').mockImplementation(async () => {
    begin(); await held; return { env: {}, withheld: [] };
  });
  return { started, release, scrub };
}

test.each(['removed', 'replaced'])('a pending caller cannot escape its captured signal when options are %s', async (mutation) => {
  const fixture = deferredScrub();
  const manager = new ProcessManager();
  const controller = new AbortController();
  const options: SpawnOptions = { signal: controller.signal };
  const launches = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Intercepted synthetic launch'); });
  const reason = new Error('admission cancelled');
  const pending = manager.spawnArgv('synthetic-command', [], '/tmp', undefined, options);
  const result = pending.then(() => undefined, (error: unknown) => error);
  try {
    await fixture.started;
    controller.abort(reason);
    options.signal = mutation === 'removed' ? undefined : new AbortController().signal;
    expect(await bounded(result)).toBe(reason);
    fixture.release();
    await Bun.sleep(0);
    expect(launches).not.toHaveBeenCalled();
    expect(manager.list()).toEqual([]);
  } finally {
    fixture.release(); await manager.close();
    launches.mockRestore(); fixture.scrub.mockRestore();
  }
});

test('cancelled admission stays in the close drain until its shared credential reading settles', async () => {
  const fixture = deferredScrub();
  const manager = new ProcessManager();
  const controller = new AbortController();
  const launches = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Intercepted synthetic launch'); });
  const pending = manager.spawnArgv('synthetic-command', [], '/tmp', undefined, { signal: controller.signal });
  const result = pending.then(() => undefined, (error: unknown) => error);
  try {
    await fixture.started;
    controller.abort(new Error('fixture stopped'));
    expect(await bounded(result)).toBe(controller.signal.reason);
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await Bun.sleep(0);
    expect(closed).toBe(false);
    fixture.release();
    await closing;
    expect(closed).toBe(true);
    expect(launches).not.toHaveBeenCalled();
  } finally {
    fixture.release(); await manager.close();
    launches.mockRestore(); fixture.scrub.mockRestore();
  }
});

test.each(['env', 'stdin'])('a reentrant %s getter can cancel before the final spawn boundary', async (field) => {
  const manager = new ProcessManager();
  const controller = new AbortController();
  const launches = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Intercepted synthetic launch'); });
  const env: Record<string, string> = {};
  const options: SpawnOptions = { signal: controller.signal, credentialEnvScrub: { enabled: false, allowlist: new Set() } };
  const abort = () => { controller.abort(new Error('cancelled by getter')); };
  if (field === 'env') Object.defineProperty(env, 'FIXTURE', { enumerable: true, get() { abort(); return 'synthetic'; } });
  else Object.defineProperty(options, 'stdin', { get() { abort(); return 'ignore'; } });
  try {
    await expect(manager.spawnArgv('synthetic-command', [], '/tmp', env, options)).rejects.toThrow('cancelled by getter');
    await Bun.sleep(0);
    expect(launches).not.toHaveBeenCalled();
    expect(manager.list()).toEqual([]);
  } finally { await manager.close(); launches.mockRestore(); }
});

test('a pre-aborted admission reaches neither credential resolution nor spawn', async () => {
  const manager = new ProcessManager();
  const controller = new AbortController(); controller.abort(new Error('already cancelled'));
  const scrub = spyOn(credentialEnv, 'scrubCredentialEnv');
  const launches = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Intercepted synthetic launch'); });
  try {
    await expect(manager.spawn('synthetic-command', '/tmp', undefined, { signal: controller.signal })).rejects.toThrow('already cancelled');
    await expect(manager.spawnArgv('synthetic-command', [], '/tmp', undefined, { signal: controller.signal })).rejects.toThrow('already cancelled');
    expect(scrub).not.toHaveBeenCalled();
    expect(launches).not.toHaveBeenCalled();
  } finally { await manager.close(); launches.mockRestore(); scrub.mockRestore(); }
});

test('after successful spawn the admission signal leaves the detached lifetime alone', async () => {
  const manager = new ProcessManager();
  const controller = new AbortController();
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const kill = mock(() => { finish(0); });
  const pipe = () => new ReadableStream<Uint8Array>({ start(stream) { stream.close(); } });
  const child = { pid: 424242, exitCode: null, signalCode: null, stdout: pipe(), stderr: pipe(), exited, kill };
  const launches = spyOn(Bun, 'spawn').mockImplementation(() => child as unknown as ReturnType<typeof Bun.spawn>);
  try {
    const result = await manager.spawnArgv('synthetic-command', [], '/tmp', undefined, {
      signal: controller.signal, kill_on_timeout: false, kill_on_close: false,
      credentialEnvScrub: { enabled: false, allowlist: new Set() },
    });
    controller.abort(new Error('caller ended after launch'));
    await Bun.sleep(0);
    expect(result.success).toBe(true);
    expect(manager.getStatus(result.process_id!)?.done).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    await manager.close();
    expect(kill).not.toHaveBeenCalled();
    finish(0);
    await Bun.sleep(0);
    expect(manager.getStatus(result.process_id!)?.done).toBe(true);
  } finally { finish(0); await manager.close(); launches.mockRestore(); }
});
