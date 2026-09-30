import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { createDockerBackend } from '../sdk/src/platform/runtime/remote/host/backends/docker.ts';
import { createLocalProcessBackend } from '../sdk/src/platform/runtime/remote/host/backends/local-process.ts';
import type { Backend, BackendContext } from '../sdk/src/platform/runtime/remote/host/backends/types.ts';
import type { PeerRecord } from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const localPeer: PeerRecord = { peerId: 'local', displayName: 'Local', backendKind: 'local-process', backendConfig: { kind: 'local-process' } };
const dockerPeer: PeerRecord = { peerId: 'docker', displayName: 'Docker', backendKind: 'docker', backendConfig: { kind: 'docker', containerName: 'fixture', dockerHost: 'goodvibes://secrets/goodvibes/HOST' } };
function context(resolveRef: BackendContext['credentials']['resolveRef'] = async () => 'fixture-credential'): BackendContext {
  return { homeDirectory: makeProjectTempDir('remote-basic-lifecycle'), credentials: { resolveRef }, logger: { info() {}, warn() {}, error() {} } };
}
function track(backend: Backend) { cleanup.push(async () => { await backend.teardown?.(); }); return backend; }
function mockSpawn(implementation: (...args: unknown[]) => unknown) {
  const mock = spyOn(Bun, 'spawn').mockImplementation(implementation as typeof Bun.spawn);
  cleanup.push(() => mock.mockRestore());
  return mock;
}

describe('local and Docker owned lifetimes', () => {
  test.each([
    ['local-process', createLocalProcessBackend, localPeer],
    ['docker', createDockerBackend, dockerPeer],
  ] as const)('%s teardown kills and awaits the active child, then refuses new work', async (_kind, factory, peer) => {
    const spawned = deferred<void>();
    let killed = false;
    const exit = deferred<number>();
    const spawn = mockSpawn(() => {
      spawned.resolve();
      return { stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), stdin: null, exited: exit.promise, kill() { killed = true; } };
    });
    const backend = track(factory(context()));
    const pending = backend.dispatch(peer, 'fixture-command').then(() => 'ran', (error: { code?: string }) => error.code);
    await spawned.promise;
    let closed = false;
    const closing = backend.teardown?.().then(() => { closed = true; });
    // Existing unowned adapters have no teardown. Release the fixture anyway.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedBeforeExit = closed;
    exit.resolve(137);
    await closing;
    expect(await pending).toBe('REMOTE_BACKEND_CLOSED');
    expect(closedBeforeExit).toBe(false);
    expect(killed).toBe(true);
    await expect(backend.dispatch(peer, 'fixture-command')).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CLOSED' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('closing during a pending Docker credential lookup prevents late spawn', async () => {
    const started = deferred<void>();
    const credential = deferred<string | null>();
    const spawn = mockSpawn(() => { throw new Error('must not execute Docker'); });
    const backend = track(createDockerBackend(context(async () => { started.resolve(); return credential.promise; })));
    const pending = backend.dispatch(dockerPeer, 'fixture-command').then(() => 'ran', (error: { code?: string }) => error.code);
    await started.promise;
    await backend.teardown?.();
    expect(await pending).toBe('REMOTE_BACKEND_CLOSED');
    credential.resolve('late-fixture-value');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawn).not.toHaveBeenCalled();
  });

  test('closed adapters do not resolve credentials or spawn', async () => {
    let reads = 0;
    const spawn = mockSpawn(() => { throw new Error('must not spawn'); });
    const backend = track(createDockerBackend(context(async () => { reads += 1; return 'fixture'; })));
    await backend.teardown?.();
    await expect(backend.dispatch(dockerPeer, 'fixture-command')).rejects.toMatchObject({ code: 'REMOTE_BACKEND_CLOSED' });
    expect(reads).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('credential lookup errors are typed without exposing resolver text', async () => {
    const spawn = mockSpawn(() => { throw new Error('must not spawn'); });
    const backend = track(createDockerBackend(context(async () => { throw new Error('fixture-credential-do-not-expose'); })));
    const error = await backend.dispatch(dockerPeer, 'fixture-command').catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'REMOTE_BACKEND_CREDENTIAL_FAILED' });
    expect(String(error)).not.toContain('fixture-credential-do-not-expose');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('resolved host bytes are omitted from returned child output', async () => {
    mockSpawn(() => ({ stdout: new Blob(['out fixture-credential']).stream(), stderr: new Blob(['err fixture-credential']).stream(), stdin: null, exited: Promise.resolve(0), kill() {} }));
    const backend = track(createDockerBackend(context()));
    const result = await backend.dispatch(dockerPeer, 'fixture-command');
    expect(result.stdout).toBe('out [credential omitted]');
    expect(result.stderr).toBe('err [credential omitted]');
  });

  test('child execution errors do not disclose known host values', async () => {
    mockSpawn(() => { throw new Error('fixture-credential'); });
    const backend = track(createDockerBackend(context()));
    const error = await backend.dispatch(dockerPeer, 'fixture-command').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('fixture-credential');
  });
});
