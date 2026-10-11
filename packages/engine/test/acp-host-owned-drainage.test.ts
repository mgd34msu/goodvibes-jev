/** Fault injection retains ownership; the child and ACP handshake remain real. */
import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { AcpHostService } from '../sdk/src/platform/acp/host.ts';

test('ACP failed child drainage remains owned and repeat stop reports the original failure', async () => {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const host = new AcpHostService({ spawn(cmd, opts) {
    child = Bun.spawn(cmd, { ...opts, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    return child;
  } });
  const hosted = await host.spawnAgent({ agent: { id: 'owned-drain-failure', title: 'Local synthetic ACP peer',
    binaryPath: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-acp-agent.ts'), 'happy'] }, cwd: import.meta.dir });
  expect(hosted.state).toBe('idle');
  const ownedChild = child!;
  const forceKill = ownedChild.kill.bind(ownedChild);
  const kill = spyOn(ownedChild, 'kill').mockImplementation(() => { throw new Error('Synthetic child signal failure'); });
  let exited = false; void ownedChild.exited.then(() => { exited = true; });
  try {
    const failure = await host.stop(hosted.id).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: 'Hosted ACP child cleanup failed' });
    expect(exited).toBe(false);
    expect(host.dismiss(hosted.id)).toBe(false);
    expect(host.prompt(hosted.id, 'No post-shutdown work').queued).toBe(false);
    expect(await host.stop(hosted.id).then(() => undefined, (error: unknown) => error)).toBe(failure);
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  } finally {
    kill.mockRestore(); forceKill('SIGKILL'); await ownedChild.exited;
  }
}, 15_000);

test('abort callback reentering ACP stop shares drainage and closes permission scope once', async () => {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const host = new AcpHostService({ spawn(cmd, opts) {
    child = Bun.spawn(cmd, { ...opts, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }); return child;
  } });
  const hosted = await host.spawnAgent({ agent: { id: 'owned-reentrant-stop', title: 'Local synthetic ACP peer',
    binaryPath: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-acp-agent.ts'), 'happy'] }, cwd: import.meta.dir });
  const ownedChild = child!, forceKill = ownedChild.kill.bind(ownedChild);
  const record = (host as unknown as { records: Map<string, { lifetime: AbortController; permissionWire: { close(): void } }> }).records.get(hosted.id)!;
  const close = spyOn(record.permissionWire, 'close'), kill = spyOn(ownedChild, 'kill');
  let reentrant: Promise<boolean> | undefined;
  record.lifetime.signal.addEventListener('abort', () => { reentrant = host.stop(hosted.id); }, { once: true });
  try {
    const first = host.stop(hosted.id);
    expect(reentrant).toBeDefined();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await Promise.all([first, reentrant])).toEqual([true, false]);
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM']);
    expect(host.dismiss(hosted.id)).toBe(true);
  } finally {
    close.mockRestore(); kill.mockRestore(); forceKill('SIGKILL'); await ownedChild.exited;
  }
});

test('ACP rejected exit observation remains an owned failure even when its real child terminates', async () => {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let rejectExit!: (error: Error) => void;
  const observedExit = new Promise<number>((_resolve, reject) => { rejectExit = reject; });
  const host = new AcpHostService({ spawn(cmd, opts) {
    child = Bun.spawn(cmd, { ...opts, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    // Fault only the exit observation seam; stdio, signals and peer are real.
    return new Proxy(child, { get(target, property) {
      if (property === 'exited') return observedExit;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } });
  const hosted = await host.spawnAgent({ agent: { id: 'owned-exit-rejection', title: 'Local synthetic ACP peer',
    binaryPath: process.execPath, args: [join(import.meta.dir, 'fixtures/fake-acp-agent.ts'), 'happy'] }, cwd: import.meta.dir });
  const ownedChild = child!, forceKill = ownedChild.kill.bind(ownedChild);
  const kill = spyOn(ownedChild, 'kill');
  try {
    const stopping = host.stop(hosted.id);
    const observationError = new Error('Synthetic ACP exit observation rejection');
    rejectExit(observationError);
    const failure = await stopping.then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('Expected owned child drainage failure');
    expect(failure.errors).toEqual([observationError, observationError]);
    expect(await host.stop(hosted.id).then(() => undefined, (error: unknown) => error)).toBe(failure);
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    await ownedChild.exited;
    expect(host.dismiss(hosted.id)).toBe(false);
  } finally {
    kill.mockRestore(); forceKill('SIGKILL'); await ownedChild.exited;
  }
});
