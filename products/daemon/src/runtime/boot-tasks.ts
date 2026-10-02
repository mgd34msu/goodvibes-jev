/** Awaited ownership for the product-only work started after the server opens. */
import { createDisposalScope } from './disposal-wiring.js';

export type DaemonBootStep = 'memory-fold' | 'provider-watch' | 'webhooks' | 'notifier' | 'configured-services' | 'plugins';
export type DaemonBootStepState = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';

/** An acquired notification owner, before any runtime-bus attachment. */
export interface DaemonBootAttachment {
  attach(): void | Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Concrete product operations are supplied by the composition root. Every
 * operation is required: missing production wiring cannot become a successful
 * empty boot step. Tests supply explicit owned fixtures through this seam.
 */
export interface DaemonBootOperations {
  foldMemory(): Promise<void>;
  startProviderWatch(): void;
  stopProviderWatch(): void;
  createWebhooks(): DaemonBootAttachment | Promise<DaemonBootAttachment>;
  createNotifier(): DaemonBootAttachment | Promise<DaemonBootAttachment>;
  synchronizeServices(): Promise<void>;
  initializePlugins(): Promise<void>;
  closePlugins(): Promise<void>;
  /** Generic step-only reporting; deliberately omits potentially private rejection details. */
  reportFailure(step: DaemonBootStep): void | Promise<void>;
}

export interface DaemonBootSnapshot {
  readonly state: 'idle' | 'starting' | 'ready' | 'degraded' | 'closing' | 'closed' | 'failed';
  readonly steps: readonly { readonly name: DaemonBootStep; readonly state: DaemonBootStepState }[];
}

export interface DaemonBootController {
  /** Call only after the server has initialized its memory store. */
  start(): Promise<DaemonBootSnapshot>;
  /** Fence new steps, retire current owners, then drain admitted acquisition. */
  close(): Promise<void>;
  snapshot(): DaemonBootSnapshot;
}

const STEPS: readonly DaemonBootStep[] = [
  'memory-fold', 'provider-watch', 'webhooks', 'notifier', 'configured-services', 'plugins',
];

// Identity comparison cannot invoke getters/prototype traps on arbitrary
// rejected values, unlike instanceof or error-shape inspection.
const BOOT_INTERRUPTED = Symbol('daemon boot interrupted');

/**
 * close() starts existing-owner cleanup immediately, even if a credential read
 * is holding a later factory. A late resource is owned and closed before start
 * settles, and it is never attached after shutdown began. The second scope
 * drain includes cleanup registered after the first drain already settled.
 *
 * Uncancellable work keeps close pending and remains visible in snapshot().
 * No timer or detached promise is treated as evidence that it was cancelled.
 */
export function createDaemonBootController(operations: DaemonBootOperations): DaemonBootController {
  const scope = createDisposalScope('Daemon boot tasks');
  const steps = new Map<DaemonBootStep, DaemonBootStepState>(STEPS.map((name) => [name, 'pending']));
  let state: DaemonBootSnapshot['state'] = 'idle';
  let closed = false;
  let starting: Promise<DaemonBootSnapshot> | undefined;
  let closing: Promise<void> | undefined;

  const snapshot = (): DaemonBootSnapshot => ({
    state,
    steps: STEPS.map((name) => ({ name, state: steps.get(name)! })),
  });

  async function runStep(name: DaemonBootStep, action: () => void | Promise<void>): Promise<void> {
    if (closed) { steps.set(name, 'skipped'); return; }
    steps.set(name, 'running');
    try {
      await action();
      steps.set(name, 'ready');
    } catch (error) {
      if (error === BOOT_INTERRUPTED) { steps.set(name, 'skipped'); return; }
      steps.set(name, 'failed');
      try { await operations.reportFailure(name); }
      catch { /* A reporting failure cannot strand later boot steps or cleanup. */ }
    }
  }

  async function attach(name: 'webhooks' | 'notifier', acquire: () => DaemonBootAttachment | Promise<DaemonBootAttachment>): Promise<void> {
    const resource = await acquire();
    let cleanup: Promise<void> | undefined;
    const closeResource = (): Promise<void> => {
      if (cleanup) return cleanup;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      cleanup = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // Own reentrant cleanup before calling the resource's synchronous fence.
      try { void Promise.resolve(resource.close()).then(resolve, reject); }
      catch (error) { reject(error); }
      return cleanup;
    };
    scope.registry.add(name, closeResource);
    if (closed) throw BOOT_INTERRUPTED;
    try { await resource.attach(); }
    catch (error) {
      try { await closeResource(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `${name} attachment and cleanup failed`); }
      throw error;
    }
    // An attachment may synchronously reenter close or finish after it.
    if (closed) await closeResource();
  }

  async function run(): Promise<DaemonBootSnapshot> {
    await runStep('memory-fold', () => operations.foldMemory());
    await runStep('provider-watch', async () => {
      scope.registry.add('provider watch', () => operations.stopProviderWatch());
      try { operations.startProviderWatch(); }
      finally { if (closed) operations.stopProviderWatch(); }
    });
    await runStep('webhooks', () => attach('webhooks', () => operations.createWebhooks()));
    await runStep('notifier', () => attach('notifier', () => operations.createNotifier()));
    await runStep('configured-services', () => operations.synchronizeServices());
    await runStep('plugins', async () => {
      scope.registry.add('plugins', () => operations.closePlugins());
      await operations.initializePlugins();
    });
    if (!closed) state = [...steps.values()].includes('failed') ? 'degraded' : 'ready';
    return snapshot();
  }

  function start(): Promise<DaemonBootSnapshot> {
    if (closed) return Promise.reject(new Error('Daemon boot controller is closed'));
    if (starting) return starting;
    state = 'starting';
    // Own the promise before a callback can synchronously request shutdown.
    starting = Promise.resolve().then(run);
    return starting;
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    state = 'closing';
    for (const name of STEPS) if (steps.get(name) === 'pending') steps.set(name, 'skipped');
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const initial = scope.close();
    // Observe the first drain while waiting for late acquisition. Its failures
    // remain recorded by the scope and are returned by the final drain.
    void initial.catch(() => {});
    void (async () => {
      await Promise.allSettled([starting, initial]);
      await scope.close();
    })().then(() => { state = 'closed'; resolve(); }, (error: unknown) => { state = 'failed'; reject(error); });
    return closing;
  }

  return { start, close, snapshot };
}
