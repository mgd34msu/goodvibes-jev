import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { PeerRegistry, type PeerRecord } from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';
import { RemoteDispatcher, type RemoteDispatcherOptions } from '../sdk/src/platform/runtime/remote/host/dispatcher.ts';
import { createBackends, type Backend, type BackendDispatchResult } from '../sdk/src/platform/runtime/remote/host/backends/index.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const result: BackendDispatchResult = { exitCode: 0, stdout: 'fixture', stderr: '' };
const peer: PeerRecord = { peerId: 'fixture', displayName: 'Fixture', backendKind: 'local-process', backendConfig: { kind: 'local-process' } };
const request = { peerId: peer.peerId, command: 'fixture-command', principalId: 'operator' };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(options: Partial<RemoteDispatcherOptions> = {}) {
  const registry = new PeerRegistry(makeProjectTempDir('remote-dispatch-lifecycle'));
  cleanup.push(() => registry.close());
  const backend: Backend = { kind: 'local-process', dispatch: async () => result };
  const dispatcher = new RemoteDispatcher({
    registry, homeDirectory: makeProjectTempDir('remote-dispatch-home'),
    credentials: { resolveRef: async () => null }, logger: { info() {}, warn() {}, error() {} },
    backends: new Map([[backend.kind, backend]]), ...options,
  });
  cleanup.push(() => dispatcher.teardown());
  return { registry, dispatcher };
}

async function seed(registry: PeerRegistry) {
  await registry.init();
  await registry.register({ ...peer, backendConfig: { kind: 'local-process' } });
}

describe('remote dispatcher lifecycle', () => {
  test('first dispatch loads a persisted cold registry', async () => {
    const { registry, dispatcher } = fixture();
    await seed(registry);
    registry.close();
    expect((await dispatcher.dispatch(request)).stdout).toBe('fixture');
    await dispatcher.teardown();
    expect(registry.get(peer.peerId)?.peerId).toBe(peer.peerId); // caller owns the registry
  });

  test('invalid inputs refuse without opening the registry', async () => {
    const { registry, dispatcher } = fixture();
    const init = spyOn(registry, 'init');
    await expect(dispatcher.dispatch({ ...request, peerId: '' })).rejects.toMatchObject({ code: 'REMOTE_PEER_ID_REQUIRED' });
    await expect(dispatcher.dispatch({ ...request, command: '' })).rejects.toMatchObject({ code: 'REMOTE_COMMAND_REQUIRED' });
    expect(init).not.toHaveBeenCalled();
    init.mockRestore();
  });

  test('failed initialization does not execute and can be retried', async () => {
    const { registry, dispatcher } = fixture();
    await seed(registry);
    const init = spyOn(registry, 'init').mockRejectedValueOnce(new Error('fixture init failed'));
    try {
      await expect(dispatcher.dispatch(request)).rejects.toThrow('fixture init failed');
      expect((await dispatcher.dispatch(request)).exitCode).toBe(0);
    } finally { init.mockRestore(); }
  });

  test('teardown refuses future dispatch and is idempotent under a reentrant callback', async () => {
    let stops = 0;
    let dispatcher!: RemoteDispatcher;
    const backend: Backend = {
      kind: 'local-process', dispatch: async () => result,
      async teardown() { stops += 1; if (stops === 1) void dispatcher.teardown(); },
    };
    const setup = fixture({ backends: new Map([[backend.kind, backend]]) });
    dispatcher = setup.dispatcher;
    await seed(setup.registry);
    const first = dispatcher.teardown();
    const second = dispatcher.teardown();
    await Promise.all([first, second]);
    expect(stops).toBe(1);
    await expect(dispatcher.dispatch(request)).rejects.toMatchObject({ code: 'REMOTE_DISPATCHER_CLOSED' });
  });

  test('synchronous teardown failure cannot skip later backends or leak error text', async () => {
    const calls: string[] = [];
    const warnings: unknown[] = [];
    const backends = new Map<PeerRecord['backendKind'], Backend>([
      ['ssh', { kind: 'ssh', dispatch: async () => result, teardown() { calls.push('ssh'); throw new Error('fixture-secret-do-not-log'); } }],
      ['docker', { kind: 'docker', dispatch: async () => result, async teardown() { calls.push('docker'); } }],
    ]);
    const { dispatcher } = fixture({ backends, logger: { info() {}, error() {}, warn(...args) { warnings.push(args); } } });
    await expect(dispatcher.teardown()).resolves.toBeUndefined();
    expect(calls).toEqual(['ssh', 'docker']);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('fixture-secret-do-not-log');
  });

  test('stops backends before waiting for accepted work, and waits for that work to settle', async () => {
    const started = deferred<void>();
    const released = deferred<BackendDispatchResult>();
    const stopped = deferred<void>();
    const backend: Backend = {
      kind: 'local-process', async dispatch() { started.resolve(); return released.promise; },
      async teardown() { stopped.resolve(); },
    };
    const { registry, dispatcher } = fixture({ backends: new Map([[backend.kind, backend]]) });
    await seed(registry);
    const pending = dispatcher.dispatch(request);
    await started.promise;
    let closed = false;
    const closing = dispatcher.teardown().then(() => { closed = true; });
    await stopped.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedBeforeRelease = closed;
    released.resolve(result);
    await Promise.all([pending, closing]);
    expect(closedBeforeRelease).toBe(false);
  });

  test('waits for an accepted enqueue without pretending to cancel durable work', async () => {
    const started = deferred<void>();
    const released = deferred<{ workId: string }>();
    const { registry, dispatcher } = fixture({ workEnqueuer: { async enqueue() { started.resolve(); return released.promise; } } });
    await seed(registry);
    const pending = dispatcher.dispatch({ ...request, async: true });
    await started.promise;
    let closed = false;
    const closing = dispatcher.teardown().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedBeforeRelease = closed;
    released.resolve({ workId: 'fixture-work' });
    expect((await pending).workId).toBe('fixture-work');
    await closing;
    expect(closedBeforeRelease).toBe(false);
  });

  test('close during registry initialization never starts a backend', async () => {
    const started = deferred<void>();
    const released = deferred<void>();
    let runs = 0;
    const backend: Backend = { kind: 'local-process', async dispatch() { runs += 1; return result; } };
    const { registry, dispatcher } = fixture({ backends: new Map([[backend.kind, backend]]) });
    await seed(registry);
    const init = spyOn(registry, 'init').mockImplementation(async () => { started.resolve(); await released.promise; });
    const pending = dispatcher.dispatch(request).then(() => 'ran', (error: { code?: string }) => error.code);
    // On the old implementation init is never called, so do not await started.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = dispatcher.teardown();
    released.resolve();
    await closing;
    expect(await pending).toBe('REMOTE_DISPATCHER_CLOSED');
    expect(runs).toBe(0);
    init.mockRestore();
  });

  test('missing backend is a typed refusal and no fallback runs', async () => {
    const { registry, dispatcher } = fixture({ backends: new Map() });
    await seed(registry);
    await expect(dispatcher.dispatch(request)).rejects.toMatchObject({ code: 'REMOTE_BACKEND_UNAVAILABLE' });
  });

  test('factory supplies all four kinds without credential reads or child execution', async () => {
    let reads = 0;
    const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('must not spawn'); });
    const backends = createBackends({
      homeDirectory: makeProjectTempDir('remote-factory-home'),
      credentials: { async resolveRef() { reads += 1; return null; } },
      logger: { info() {}, warn() {}, error() {} },
    });
    try {
      expect([...backends.keys()]).toEqual(['local-process', 'docker', 'ssh', 'cloud-terminal']);
      await Promise.all([...backends.values()].map((backend) => backend.teardown?.()));
      expect(reads).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });
});
