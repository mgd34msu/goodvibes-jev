import { join } from 'node:path';
import type { DistributedRuntimeRouteService } from '@goodvibes-jev/engine/daemon-sdk/remote-routes';
import { DistributedRuntimeManager } from '../distributed-runtime-manager.js';
import type { BackendContext } from './backends/types.js';
import { BackendDispatchError } from './backends/types.js';
import { PeerRegistry } from './peer-registry.js';
import { RemoteDispatcher, type RemoteWorkEnqueuer } from './dispatcher.js';
import { HostDistributedRuntime } from './service.js';

/** Only the host dependencies this surface actually consumes. */
export interface RemoteSurfaceContext extends BackendContext {
  readonly workingDirectory: string;
}

export interface RemoteInvokeAdapter {
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

export interface RemoteSurfaceRegistration {
  /** Rejects with REMOTE_SURFACE_START_FAILED (or CLOSED when stopped early). */
  readonly ready: Promise<void>;
  readonly service: DistributedRuntimeRouteService;
  readonly dispatch: RemoteInvokeAdapter;
  /**
   * Waits for accepted operations, backend cleanup and owned store writes.
   * Backend cleanup errors retain best-effort dispatcher logging. Other cleanup
   * failures reject with REMOTE_SURFACE_CLEANUP_FAILED after closing the registry.
   */
  close(): Promise<void>;
  /** Synchronous compatibility wrapper; starts close and observes rejection. */
  unregister(): void;
}

export interface RegisterRemoteSurfaceOptions {
  /** Borrowed manager: its creator owns startup, writes and final disposal. */
  readonly manager?: DistributedRuntimeManager;
  /** Optional explicit readiness for a borrowed manager; does not start it. */
  readonly managerReady?: Promise<void>;
}

function closedError(): BackendDispatchError {
  return new BackendDispatchError('Remote surface has been closed.', 'REMOTE_SURFACE_CLOSED');
}

/**
 * Compose the pinned daemon remote surface without duplicating route schemas.
 * The historical `tui` store path is preserved until an explicit migration.
 * Callers await ready before exposing synchronous route reads, and close during
 * shutdown. Synchronous unregister is retained for older composition roots.
 * Failed initialization remains failed; callers construct a fresh registration
 * to retry. External/borrowed managers are never started or drained here.
 */
export function registerRemoteSurface(
  ctx: RemoteSurfaceContext,
  options: RegisterRemoteSurfaceOptions = {},
): RemoteSurfaceRegistration {
  if (options.managerReady && !options.manager) {
    throw new BackendDispatchError('managerReady requires an injected manager.', 'REMOTE_SURFACE_BAD_OPTIONS');
  }
  const registry = new PeerRegistry(ctx.workingDirectory);
  const ownsManager = options.manager === undefined;
  const manager = options.manager ?? new DistributedRuntimeManager(
    join(ctx.workingDirectory, '.goodvibes', 'tui', 'remote', 'distributed-runtime.json'),
  );
  const workEnqueuer: RemoteWorkEnqueuer = {
    async enqueue(item) {
      // The manager queue has no backendKind field. Preserve the pinned queue
      // contract; backend registration and paired peers remain separate stores.
      const work = await manager.enqueueWork({
        peerId: item.peerId, command: item.command, actor: item.queuedBy,
        ...(item.payload !== undefined ? { payload: item.payload } : {}),
      });
      return { workId: work.id };
    },
  };
  const dispatcher = new RemoteDispatcher({ registry, ...ctx, workEnqueuer });
  const host = new HostDistributedRuntime(manager, dispatcher);
  const active = new Set<Promise<unknown>>();
  let closed = false;
  let initialized = false;
  let startupError: BackendDispatchError | undefined;
  let closing: Promise<void> | undefined;
  const log = (message: string) => { try { ctx.logger.error(message); } catch {} };

  // Wait for BOTH actual initializers even when one fails, so close cannot
  // release a store and then have the other background initializer reopen it.
  const initialization = Promise.resolve().then(async () => {
    if (closed) throw closedError();
    const outcomes = await Promise.allSettled([
      registry.init(),
      ownsManager ? manager.start() : options.managerReady ?? Promise.resolve(),
    ]);
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      startupError = new BackendDispatchError('Remote surface initialization failed.', 'REMOTE_SURFACE_START_FAILED');
      throw startupError;
    }
    if (closed) throw closedError();
    initialized = true;
  });
  void initialization.catch(() => { if (!closed) log('remote surface initialization failed'); });

  function read<T>(operation: () => T): T {
    if (closed) throw closedError();
    if (startupError) throw startupError;
    if (!initialized) throw new BackendDispatchError('Remote surface is not ready.', 'REMOTE_SURFACE_NOT_READY');
    return operation();
  }
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(async () => {
      if (closed) throw closedError();
      await initialization;
      return read(operation);
    });
    active.add(pending);
    void pending.then(() => { active.delete(pending); }, () => { active.delete(pending); });
    return pending;
  }

  const service: DistributedRuntimeRouteService = {
    listPairRequests: () => read(() => host.listPairRequests()),
    listPeers: () => read(() => host.listPeers()),
    listWork: () => read(() => host.listWork()),
    getNodeHostContract: () => read(() => host.getNodeHostContract()),
    requestPairing: (input) => run(() => host.requestPairing(input)),
    approvePairRequest: (id, input) => run(() => host.approvePairRequest(id, input)),
    rejectPairRequest: (id, input) => run(() => host.rejectPairRequest(id, input)),
    verifyPairRequest: (id, challenge, input) => run(() => host.verifyPairRequest(id, challenge, input)),
    rotatePeerToken: (id, input) => run(() => host.rotatePeerToken(id, input)),
    revokePeerToken: (id, input) => run(() => host.revokePeerToken(id, input)),
    disconnectPeer: (id, input) => run(() => host.disconnectPeer(id, input)),
    heartbeatPeer: (auth, input) => run(() => host.heartbeatPeer(auth, input)),
    claimWork: (auth, input) => run(() => host.claimWork(auth, input)),
    completeWork: (auth, id, input) => run(() => host.completeWork(auth, id, input)),
    cancelWork: (id, input) => run(() => host.cancelWork(id, input)),
    invokePeer: (input) => run(() => host.invokePeer(input)),
  };

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    // Store before any user-supplied backend/logger callback could reenter.
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([initialization, ...active, dispatcher.teardown()]);
      try {
        if (ownsManager) await manager.writes.drain();
      } finally { registry.close(); }
    }).catch(() => {
      throw new BackendDispatchError('Remote surface cleanup failed.', 'REMOTE_SURFACE_CLEANUP_FAILED');
    });
    return closing;
  }

  return {
    ready: initialization, service, dispatch: { invoke: (input) => service.invokePeer(input) }, close,
    unregister() { void close().catch(() => { log('remote surface cleanup failed'); }); },
  };
}
