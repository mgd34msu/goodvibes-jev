import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { registerRemoteSurface, type RemoteSurfaceContext, type RemoteSurfaceRegistration, type RegisterRemoteSurfaceOptions } from '../sdk/src/platform/runtime/remote/host/surface.ts';
import { PeerRegistry } from '../sdk/src/platform/runtime/remote/host/peer-registry.ts';
import { DistributedRuntimeManager } from '../sdk/src/platform/runtime/remote/distributed-runtime-manager.ts';
import { StoreWriteQueue } from '../sdk/src/platform/state/store-write-queue.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function context(): RemoteSurfaceContext {
  const dir = makeProjectTempDir('remote-surface-lifecycle');
  return { workingDirectory: dir, homeDirectory: dir, credentials: { resolveRef: async () => null }, logger: { info() {}, warn() {}, error() {} } };
}
function track(registration: RemoteSurfaceRegistration) { cleanups.push(() => registration.close()); return registration; }
function borrowed(fake: Record<string, unknown>): NonNullable<RegisterRemoteSurfaceOptions['manager']> {
  return fake as unknown as NonNullable<RegisterRemoteSurfaceOptions['manager']>;
}
const storePath = (ctx: RemoteSurfaceContext) => join(ctx.workingDirectory, '.goodvibes', 'tui', 'remote', 'distributed-runtime.json');
async function seedBackend(ctx: RemoteSurfaceContext, allowedCommands: string[] = []) {
  const registry = new PeerRegistry(ctx.workingDirectory);
  try {
    await registry.init();
    await registry.register({ peerId: 'fixture', displayName: 'Fixture', backendKind: 'local-process', backendConfig: { allowedCommands } });
  } finally { registry.close(); }
}

describe('remote surface readiness and ownership', () => {
  test('preserves the historical manager path and refuses sync reads until ready', async () => {
    const ctx = context();
    const surface = track(registerRemoteSurface(ctx));
    expect(() => surface.service.listPeers()).toThrow('not ready');
    await surface.ready;
    expect(surface.service.listPeers()).toEqual([]);
    expect(existsSync(storePath(ctx))).toBe(true);
    await surface.close();
    expect(() => surface.service.listPeers()).toThrow('closed');
    await expect(surface.service.requestPairing({ label: 'fixture' })).rejects.toMatchObject({ code: 'REMOTE_SURFACE_CLOSED' });
  });

  test('waits for borrowed-manager readiness without starting or draining it', async () => {
    const ready = deferred<void>();
    let starts = 0; let drains = 0; let calls = 0;
    const manager = borrowed({ start: async () => { starts += 1; }, writes: { drain: async () => { drains += 1; } }, listPeers: () => [{ id: 'fixture' }], requestPairing: async () => { calls += 1; return { fixture: true }; } });
    const surface = track(registerRemoteSurface(context(), { manager, managerReady: ready.promise }));
    const request = surface.service.requestPairing({ label: 'fixture' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(0);
    ready.resolve();
    await surface.ready;
    expect(await request).toEqual({ fixture: true });
    await surface.close();
    expect(starts).toBe(0);
    expect(drains).toBe(0);
    expect(manager.listPeers().map((peer) => peer.id)).toEqual(['fixture']); // caller's manager stays usable
  });

  test('close waits for accepted manager work and refuses further calls', async () => {
    const started = deferred<void>();
    const result = deferred<unknown>();
    const manager = borrowed({ requestPairing: async () => { started.resolve(); return result.promise; } });
    const surface = track(registerRemoteSurface(context(), { manager }));
    await surface.ready;
    const request = surface.service.requestPairing({ label: 'fixture' });
    await started.promise;
    let closed = false;
    const closing = surface.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedBeforeResult = closed;
    result.resolve({ fixture: true });
    await Promise.all([request, closing]);
    expect(closedBeforeResult).toBe(false);
    await expect(surface.dispatch.invoke({ peerId: 'fixture', command: 'fixture' })).rejects.toMatchObject({ code: 'REMOTE_SURFACE_CLOSED' });
  });

  test('close before first initializer runs prevents store creation and unhandled rejection', async () => {
    const ctx = context();
    const surface = track(registerRemoteSurface(ctx));
    surface.unregister();
    expect(surface.close()).toBe(surface.close());
    await surface.close();
    await expect(surface.ready).rejects.toMatchObject({ code: 'REMOTE_SURFACE_CLOSED' });
    expect(existsSync(storePath(ctx))).toBe(false);
  });

  test('failed startup waits for the other initializer and leaves no post-close open registry', async () => {
    const ready = deferred<void>();
    const init = spyOn(PeerRegistry.prototype, 'init').mockRejectedValue(new Error('fixture-sensitive-startup-error'));
    const closeRegistry = spyOn(PeerRegistry.prototype, 'close');
    cleanups.push(() => { init.mockRestore(); closeRegistry.mockRestore(); });
    const ctx = context();
    const errors: string[] = [];
    ctx.logger.error = (message) => { errors.push(message); };
    const surface = track(registerRemoteSurface(ctx, { manager: borrowed({}), managerReady: ready.promise }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    let closed = false;
    const closing = surface.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    expect(closeRegistry).not.toHaveBeenCalled();
    ready.resolve();
    await closing;
    await expect(surface.ready).rejects.toMatchObject({ code: 'REMOTE_SURFACE_START_FAILED' });
    expect(closeRegistry).toHaveBeenCalledTimes(1);
    expect(errors.join(' ')).not.toContain('fixture-sensitive-startup-error');
  });

  test('reports failed readiness explicitly and never executes a queued command', async () => {
    const ctx = context();
    mkdirSync(dirname(storePath(ctx)), { recursive: true });
    writeFileSync(storePath(ctx), 'fixture invalid json');
    const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('must not execute'); });
    cleanups.push(() => spawn.mockRestore());
    const messages: string[] = [];
    ctx.logger.error = (message) => { messages.push(message); };
    const surface = track(registerRemoteSurface(ctx));
    const request = surface.dispatch.invoke({ peerId: 'fixture', command: 'fixture' }).catch((error: unknown) => error);
    await expect(surface.ready).rejects.toMatchObject({ code: 'REMOTE_SURFACE_START_FAILED' });
    expect(await request).toMatchObject({ code: 'REMOTE_SURFACE_START_FAILED' });
    expect(() => surface.service.listPeers()).toThrow('initialization failed');
    expect(spawn).not.toHaveBeenCalled();
    expect(messages).toEqual(['remote surface initialization failed']);
    expect(readFileSync(storePath(ctx), 'utf8')).toBe('fixture invalid json');
  });

  test('owned manager write drain finishes before close resolves', async () => {
    const draining = deferred<void>();
    const release = deferred<void>();
    const drain = spyOn(StoreWriteQueue.prototype, 'drain').mockImplementation(async () => { draining.resolve(); await release.promise; });
    cleanups.push(() => drain.mockRestore());
    const surface = track(registerRemoteSurface(context()));
    await surface.ready;
    let closed = false;
    const closing = surface.close().then(() => { closed = true; });
    await draining.promise;
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    expect(closed).toBe(true);
  });

  test('synchronous unregister observes cleanup rejection while awaitable close exposes it', async () => {
    const drain = spyOn(StoreWriteQueue.prototype, 'drain').mockRejectedValue(new Error('fixture-sensitive-cleanup-error'));
    const closeRegistry = spyOn(PeerRegistry.prototype, 'close');
    cleanups.push(() => { drain.mockRestore(); closeRegistry.mockRestore(); });
    const ctx = context();
    const messages: string[] = [];
    ctx.logger.error = (message) => { messages.push(message); };
    const surface = registerRemoteSurface(ctx);
    await surface.ready;
    surface.unregister();
    await expect(surface.close()).rejects.toMatchObject({ code: 'REMOTE_SURFACE_CLEANUP_FAILED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeRegistry).toHaveBeenCalledTimes(1);
    expect(messages).toEqual(['remote surface cleanup failed']);
  });

  test('close cancels an active default-backend child and waits for actual exit', async () => {
    const ctx = context();
    await seedBackend(ctx, ['fixture-command']);
    const spawned = deferred<void>();
    const exit = deferred<number>();
    let killed = false;
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => {
      spawned.resolve();
      return { stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), stdin: null, exited: exit.promise, kill() { killed = true; } };
    }) as unknown as typeof Bun.spawn);
    cleanups.push(() => spawn.mockRestore());
    const surface = track(registerRemoteSurface(ctx));
    const pending = surface.dispatch.invoke({ peerId: 'fixture', command: 'fixture-command' }).catch((error: unknown) => error);
    await spawned.promise;
    let closed = false;
    const closing = surface.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedBeforeExit = closed;
    exit.resolve(137);
    await closing;
    expect(await pending).toMatchObject({ code: 'REMOTE_BACKEND_CLOSED' });
    expect(killed).toBe(true);
    expect(closedBeforeExit).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('a manager readiness promise without its manager is rejected before startup', () => {
    expect(() => registerRemoteSurface(context(), { managerReady: Promise.resolve() })).toThrow('requires an injected manager');
  });

  test('the real manager still refuses host-only async peers rather than inventing a paired record', async () => {
    const ctx = context();
    await seedBackend(ctx);
    const surface = track(registerRemoteSurface(ctx));
    await expect(surface.dispatch.invoke({ peerId: 'fixture', command: 'fixture', async: true })).rejects.toThrow('Unknown distributed peer');
    expect(surface.service.listPeers()).toEqual([]);
    expect(surface.service.listWork()).toEqual([]);
  });

  test('fixture peers present in both stores enqueue through the real manager and survive restart', async () => {
    const ctx = context();
    await seedBackend(ctx);
    mkdirSync(dirname(storePath(ctx)), { recursive: true });
    // Explicit fixture data, not a production registration route or credentials.
    writeFileSync(storePath(ctx), JSON.stringify({ pairRequests: [], peers: [{ id: 'fixture', kind: 'node', label: 'Fixture', pairedAt: Date.now(), tokens: [], metadata: {} }], work: [], audit: [] }));
    const surface = track(registerRemoteSurface(ctx));
    const queued = await surface.dispatch.invoke({ peerId: 'fixture', command: 'fixture', async: true, actor: 'operator' }) as { workId: string };
    expect(queued.workId).toStartWith('rwork-');
    await surface.close();
    const reopened = new DistributedRuntimeManager(storePath(ctx));
    await reopened.start();
    const work = reopened.listWork();
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ id: queued.workId, peerId: 'fixture', command: 'fixture', queuedBy: 'operator', status: 'queued' });
    await reopened.writes.drain();
  });
});
