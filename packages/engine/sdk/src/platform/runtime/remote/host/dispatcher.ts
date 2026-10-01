import { createHash } from 'node:crypto';
import type { RemoteHostLogger, RemoteHostCredentialStore } from './context.js';
import type { PeerRegistry, PeerRecord } from './peer-registry.js';
import {
  type Backend,
  type BackendContext,
  type DispatchPayload,
  BackendDispatchError,
  createBackends,
} from './backends/index.js';

/** SHA-256 of input, truncated to the first `hexChars` hex characters. */
function sha256First(input: string, hexChars: number): string {
  const digest = createHash('sha256').update(input, 'utf-8').digest('hex');
  return digest.slice(0, Math.max(0, hexChars));
}

// ---------------------------------------------------------------------------
// Work-item hook, long-running invocations are enqueued as work items visible
// in remote.work.list. The dispatcher does not own the distributed runtime; the
// integrator wires this hook to the DistributedRuntimeManager work queue.
// ---------------------------------------------------------------------------

export interface RemoteWorkItemInput {
  peerId: string;
  command: string;
  payload?: DispatchPayload;
  /** Echoed onto the work item so the runner can pick the right backend. */
  backendKind: PeerRecord['backendKind'];
  queuedBy: string;
}

export interface RemoteWorkEnqueuer {
  enqueue(item: RemoteWorkItemInput): Promise<{ workId: string }>;
}

// ---------------------------------------------------------------------------
// Invoke result, returned to the agent through remote.peers.invoke. Includes
// stdoutDigest (sha256 of FULL stdout, 64 hex chars) per the receipt contract.
// The agent may receive only a truncated stdout preview.
// ---------------------------------------------------------------------------

export const STDOUT_PREVIEW_LIMIT = 4_096;

export interface RemoteInvokeResult {
  peerId: string;
  backendKind: PeerRecord['backendKind'];
  /** Present for synchronous completion. */
  exitCode?: number;
  /** Present for async/long-running dispatch. */
  workId?: string;
  completed: boolean;
  stdout: string;
  stderr: string;
  /** SHA-256 of the full stdout, 64 hex chars. */
  stdoutDigest: string;
}

export interface RemoteDispatcherOptions {
  registry: PeerRegistry;
  credentials: RemoteHostCredentialStore;
  logger: RemoteHostLogger;
  homeDirectory: string;
  /** Optional hook for enqueuing long-running work items. */
  workEnqueuer?: RemoteWorkEnqueuer;
  /** Override the backend map (tests inject fakes). */
  backends?: Map<PeerRecord['backendKind'], Backend>;
}

export interface DispatchRequest {
  peerId: string;
  command: string;
  payload?: DispatchPayload;
  /** Principal that requested the dispatch (for work-item attribution). */
  principalId: string;
  /** When true (and a work enqueuer exists), run as an async work item. */
  async?: boolean;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Routes remote.peers.invoke commands to the correct execution backend.
 * Synchronous commands return an exitCode; long-running commands (async:true
 * with a configured work enqueuer) return a workId tracked via remote.work.list.
 */
export class RemoteDispatcher {
  private readonly registry: PeerRegistry;
  private readonly backends: Map<PeerRecord['backendKind'], Backend>;
  private readonly workEnqueuer?: RemoteWorkEnqueuer;
  private readonly logger: RemoteHostLogger;
  private readonly active = new Set<Promise<RemoteInvokeResult>>();
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(options: RemoteDispatcherOptions) {
    this.registry = options.registry;
    this.logger = options.logger;
    if (options.workEnqueuer) this.workEnqueuer = options.workEnqueuer;
    const backendContext: BackendContext = {
      credentials: options.credentials,
      logger: options.logger,
      homeDirectory: options.homeDirectory,
    };
    this.backends = options.backends ? new Map(options.backends) : createBackends(backendContext);
  }

  dispatch(request: DispatchRequest): Promise<RemoteInvokeResult> {
    const pending = Promise.resolve().then(() => this.performDispatch(request));
    this.active.add(pending);
    void pending.then(() => { this.active.delete(pending); }, () => { this.active.delete(pending); });
    return pending;
  }

  private assertOpen(): void {
    if (this.closed) throw new BackendDispatchError('Remote dispatcher has been closed.', 'REMOTE_DISPATCHER_CLOSED');
  }

  private async performDispatch(request: DispatchRequest): Promise<RemoteInvokeResult> {
    this.assertOpen();
    const peerId = typeof request.peerId === 'string' ? request.peerId.trim() : '';
    if (peerId.length === 0) {
      throw new BackendDispatchError('peerId is required.', 'REMOTE_PEER_ID_REQUIRED');
    }
    const command = typeof request.command === 'string' ? request.command : '';
    if (command.trim().length === 0) {
      throw new BackendDispatchError('command is required.', 'REMOTE_COMMAND_REQUIRED');
    }
    // Surface construction may still be opening the persisted registry. Never
    // treat cold initialization as a missing peer or choose a fallback backend.
    await this.registry.init();
    this.assertOpen();
    const peer = this.registry.get(peerId);
    if (!peer) {
      throw new BackendDispatchError(
        `No registered peer with id '${peerId}'.`,
        'REMOTE_PEER_NOT_FOUND',
      );
    }
    const backend = this.backends.get(peer.backendKind);
    if (!backend) {
      throw new BackendDispatchError(
        `No backend available for kind '${peer.backendKind}'.`,
        'REMOTE_BACKEND_UNAVAILABLE',
      );
    }

    // Async path: enqueue a work item and return its id immediately.
    if (request.async === true && this.workEnqueuer) {
      const { workId } = await this.workEnqueuer.enqueue({
        peerId: peer.peerId,
        command,
        backendKind: peer.backendKind,
        queuedBy: request.principalId,
        ...(request.payload !== undefined ? { payload: request.payload } : {}),
      });
      this.logger.info('remote invoke enqueued', { peerId: peer.peerId, workId });
      return {
        peerId: peer.peerId,
        backendKind: peer.backendKind,
        workId,
        completed: false,
        stdout: '',
        stderr: '',
        stdoutDigest: sha256First('', 64),
      };
    }

    // Synchronous path: run on the backend and capture output.
    const result = await backend.dispatch(peer, command, request.payload);
    const fullStdout = result.stdout ?? '';
    return {
      peerId: peer.peerId,
      backendKind: peer.backendKind,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.workId !== undefined ? { workId: result.workId } : {}),
      completed: result.workId === undefined,
      stdout: truncate(fullStdout, STDOUT_PREVIEW_LIMIT),
      stderr: truncate(result.stderr ?? '', STDOUT_PREVIEW_LIMIT),
      stdoutDigest: sha256First(fullStdout, 64),
    };
  }

  /**
   * Close admission, stop every owned backend, and await accepted dispatches.
   * Backend cleanup failures are reported without exception/credential text;
   * shutdown remains best-effort and never closes the caller-owned registry.
   * An already accepted enqueue may still create durable work: await its result
   * rather than claiming to cancel a queue that this dispatcher does not own.
   */
  teardown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Store the promise before invoking teardown hooks, which may be reentrant.
    this.closing = Promise.resolve().then(async () => {
      const stops = [...this.backends.values()].map(async (backend) => {
        try { await backend.teardown?.(); }
        catch {
          try { this.logger.warn('remote backend cleanup failed', { backendKind: backend.kind }); }
          catch { /* Logging must not interrupt other owned cleanup. */ }
        }
      });
      // Start stops first: an active child may need its backend's abort signal
      // before dispatch can settle. Include enqueue and cold-init operations.
      await Promise.allSettled([...stops, ...this.active]);
    });
    return this.closing;
  }
}
