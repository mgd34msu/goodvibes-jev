import { expect, spyOn, test } from 'bun:test';
import { ProcessManager, type BgCommandResult } from '../sdk/src/platform/tools/shared/process-manager.ts';
import * as policyCheck from '../sdk/src/platform/gate/execute-policy-check.ts';

async function startEcho(manager: ProcessManager): Promise<string> {
  const result = await manager.spawnArgv('/bin/cat', [], undefined, undefined, {
    stdin: 'pipe', sigterm_grace_ms: 0,
    credentialEnvScrub: { enabled: false, allowlist: new Set() },
  });
  if (!result.process_id) throw new Error('Missing native echo process id');
  return result.process_id;
}

async function waitForOutput(manager: ProcessManager, id: string, expected: string): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (manager.getOutput(id)?.stdout !== expected) {
    if (performance.now() >= deadline) throw new Error('Native echo output did not arrive');
    await Bun.sleep(5);
  }
}

test('typed stdin writes reach the real managed child and keep its pipe open', async () => {
  const manager = new ProcessManager();
  try {
    const id = await startEcho(manager);
    let checks = 0;
    const first = 'private fixture input ☺\n';
    expect(await manager.writeInput(id, first, { assertCurrent: () => { checks++; } })).toBe(Buffer.byteLength(first));
    await waitForOutput(manager, id, first);
    expect(checks).toBeGreaterThan(2);
    const second = 'second private fixture line\n';
    expect(await manager.writeInput(id, second)).toBe(Buffer.byteLength(second));
    await waitForOutput(manager, id, first + second);
    expect(manager.getStatus(id)?.done).toBe(false);
  } finally { await manager.close(); }
});

test.each(['cancelled', 'revoked', 'replaced-process'] as const)('pending input sends no bytes when its owner is %s before native write', async state => {
  const manager = new ProcessManager();
  try {
    const id = await startEcho(manager);
    const entry = manager.getStatus(id);
    if (!entry) throw new Error('Missing echo process');
    const controller = new AbortController();
    let current = true;
    const pending = manager.writeInput(id, 'denied private input\n', {
      signal: controller.signal,
      assertCurrent: () => { if (!current) throw new Error('Input owner revoked'); },
    });
    const result = pending.then(() => undefined, (error: unknown) => error);
    if (state === 'cancelled') controller.abort(new Error('Input cancelled'));
    if (state === 'revoked') current = false;
    if (state === 'replaced-process') Object.defineProperty(manager, '_processes', {
      value: new Map([[id, { ...entry }]]),
    });
    expect(await result).toBeInstanceOf(Error);
    if (state === 'replaced-process') Object.defineProperty(manager, '_processes', { value: new Map([[id, entry]]) });
    expect(await manager.writeInput(id, 'accepted marker\n')).toBe(Buffer.byteLength('accepted marker\n'));
    await waitForOutput(manager, id, 'accepted marker\n');
  } finally { await manager.close(); }
});

test.each(['signal', 'callback'] as const)('a replaced %s cannot remove the captured input restriction', async field => {
  const manager = new ProcessManager();
  try {
    const id = await startEcho(manager);
    const controller = new AbortController();
    let current = true;
    const options: { signal?: AbortSignal; assertCurrent?: () => void } = {
      signal: controller.signal,
      assertCurrent: () => { if (!current) throw new Error('Captured owner revoked'); },
    };
    const pending = manager.writeInput(id, 'denied private input\n', options);
    const result = pending.then(() => undefined, (error: unknown) => error);
    if (field === 'signal') { controller.abort(new Error('Captured signal cancelled')); options.signal = new AbortController().signal; }
    else { current = false; options.assertCurrent = () => {}; }
    expect(await result).toBeInstanceOf(Error);
    await manager.writeInput(id, 'accepted marker\n');
    await waitForOutput(manager, id, 'accepted marker\n');
  } finally { await manager.close(); }
});

test.each(['id', 'pid', 'cmd', 'startTime', 'done'] as const)('a changed managed process %s refuses pending input before native write', async field => {
  const manager = new ProcessManager();
  try {
    const id = await startEcho(manager);
    const entry = manager.getStatus(id);
    if (!entry) throw new Error('Missing echo process');
    const original = { id: entry.id, pid: entry.pid, cmd: entry.cmd, startTime: entry.startTime, done: entry.done };
    const pending = manager.writeInput(id, 'denied private input\n');
    const result = pending.then(() => undefined, (error: unknown) => error);
    if (field === 'id') entry.id = 'another-process';
    if (field === 'pid') entry.pid++;
    if (field === 'cmd') entry.cmd = 'another command';
    if (field === 'startTime') entry.startTime++;
    if (field === 'done') entry.done = true;
    expect(await result).toBeInstanceOf(Error);
    Object.assign(entry, original);
    await manager.writeInput(id, 'accepted marker\n');
    await waitForOutput(manager, id, 'accepted marker\n');
  } finally { await manager.close(); }
});

test.each(['cancelled', 'revoked', 'replaced-process'] as const)('input refuses a successful receipt when its owner becomes %s after native handoff', async state => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalCheck = policyCheck.executePolicyCheck;
  let held = false;
  const wait = spyOn(policyCheck, 'executePolicyCheck').mockImplementation(async <T>(check: () => T | Promise<T>, signal?: AbortSignal): Promise<T> => {
    const value = await originalCheck(check, signal);
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return value;
  });
  const manager = new ProcessManager();
  try {
    const id = await startEcho(manager);
    const entry = manager.getStatus(id);
    if (!entry) throw new Error('Missing echo process');
    const controller = new AbortController();
    let current = true;
    const pending = manager.writeInput(id, 'admitted native input\n', {
      signal: controller.signal,
      assertCurrent: () => { if (!current) throw new Error('Input owner revoked'); },
    });
    const result = pending.then(() => undefined, (error: unknown) => error);
    await Promise.race([
      entered.promise,
      result.then(error => { throw error instanceof Error ? error : new Error('Input settled before native handoff'); }),
    ]);
    if (state === 'cancelled') controller.abort(new Error('Input cancelled after handoff'));
    if (state === 'revoked') current = false;
    if (state === 'replaced-process') Object.defineProperty(manager, '_processes', { value: new Map([[id, { ...entry }]]) });
    release.resolve();
    expect(await result).toBeInstanceOf(Error);
    if (state === 'replaced-process') Object.defineProperty(manager, '_processes', { value: new Map([[id, entry]]) });
    await manager.writeInput(id, 'accepted marker\n');
    await waitForOutput(manager, id, 'admitted native input\naccepted marker\n');
  } finally { release.resolve(); wait.mockRestore(); await manager.close(); }
});

test('asynchronous currentness cannot authorize native input', async () => {
  const manager = new ProcessManager();
  try {
    const id = await startEcho(manager);
    await expect(manager.writeInput(id, 'denied private input\n', { assertCurrent: async () => {} })).rejects.toThrow('must be synchronous');
    await manager.writeInput(id, 'accepted marker\n');
    await waitForOutput(manager, id, 'accepted marker\n');
  } finally { await manager.close(); }
});

test('native pipe writes reject unknown, stopped, completed, and closed processes', async () => {
  const manager = new ProcessManager();
  try {
    await expect(manager.writeInput('unknown', 'private input')).rejects.toThrow('Unknown process');
    const stopped = await startEcho(manager);
    manager.stop(stopped);
    await expect(manager.writeInput(stopped, 'private input')).rejects.toThrow('Unknown process');
    const completed = await manager.spawnArgv('/bin/true', [], undefined, undefined, {
      stdin: 'pipe', sigterm_grace_ms: 0,
      credentialEnvScrub: { enabled: false, allowlist: new Set() },
    });
    if (!completed.process_id) throw new Error('Missing completed process id');
    const deadline = performance.now() + 1_000;
    while (!manager.getStatus(completed.process_id)?.done) {
      if (performance.now() >= deadline) throw new Error('Native process did not finish');
      await Bun.sleep(5);
    }
    await expect(manager.writeInput(completed.process_id, 'private input')).rejects.toThrow('unavailable');
    const closing = await startEcho(manager);
    await manager.close();
    await expect(manager.writeInput(closing, 'private input')).rejects.toThrow();
  } finally { await manager.close(); }
});

test('ignored stdin and adopted executions cannot acquire a native pipe from a caller guard', async () => {
  const manager = new ProcessManager();
  const finish = Promise.withResolvers<BgCommandResult>();
  const output: BgCommandResult = { cmd: 'adopted fixture', stdout: '', stderr: '', exit_code: null, success: true };
  try {
    const ignored = await manager.spawnArgv('/bin/sleep', ['5'], undefined, undefined, {
      stdin: 'ignore', sigterm_grace_ms: 0,
      credentialEnvScrub: { enabled: false, allowlist: new Set() },
    });
    if (!ignored.process_id) throw new Error('Missing ignored-stdin process id');
    await expect(manager.writeInput(ignored.process_id, 'private input', { assertCurrent: () => {} })).rejects.toThrow('unavailable');
    const adopted = await manager.trackOwnedBoundary({
      owner: {}, cmd: output.cmd, started: Promise.resolve({ pid: 1234 }), completion: finish.promise,
      readOutput: async () => output, stop: async () => { finish.resolve({ ...output, exit_code: 0 }); },
    });
    if (!adopted.process_id) throw new Error('Missing adopted process id');
    await expect(manager.writeInput(adopted.process_id, 'private input', { assertCurrent: () => {} })).rejects.toThrow('unavailable');
  } finally { finish.resolve({ ...output, exit_code: 0 }); await manager.close(); }
});
