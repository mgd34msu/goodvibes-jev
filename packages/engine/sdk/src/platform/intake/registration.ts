/**
 * Mechanical inbox registration over explicit host-supplied adapters.
 *
 * Adapted from the pinned daemon inbox/index.ts. Built-in provider construction
 * and semantic mapping/triage remain product concerns; there is deliberately no
 * empty adapter default or judgment call here. Accepting a preview for local
 * storage/display does not authorize sending it to a hosted reader.
 */
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import { HandlerError, registerCatalogHandler } from '../control-plane/host-handlers.js';
import { InboxCursorStore } from './cursor-store.js';
import { InboundPoller } from './poller.js';
import { aggregateInbox, normalizeInboxQuery, type InboxListInput, type InboxListOutput } from './aggregator.js';
import type { ImapUidCheckpoint, InboundProviderAdapter } from './provider-adapter.js';
import type { IntakeLogger } from './context.js';

export const INBOX_LIST_METHOD_ID = 'channels.inbox.list';

export interface InboxPollingControl {
  start(): Promise<void>;
  /** Await before transferring this provider's polling ownership. */
  stop(): Promise<void>;
}

export interface InboxSurfaceContext {
  readonly catalog: GatewayMethodCatalog;
  readonly workingDirectory: string;
  readonly logger: IntakeLogger;
}

export interface RegisterInboxSurfaceOptions {
  /** Required: the product supplies every configured or unavailable provider. */
  readonly adapters: ReadonlyMap<string, InboundProviderAdapter>;
  readonly storeFileName?: string;
  readonly skipInitialPoll?: boolean;
  /** Host registration may return its own awaitable unregister callback. */
  readonly gatePolling?: (providerId: string, control: InboxPollingControl) => void | (() => void | Promise<void>);
  /** Recheck a product-owned account/workspace scope around every mirror read. */
  readonly assertReadCurrent?: () => void | Promise<void>;
  /** Capture one account/mailbox generation across this exact mirror projection. */
  readonly acquireReadLease?: () => Promise<() => void | Promise<void>>;
}

export interface InboxSurfaceRegistration {
  /** Storage and any ungated initial seed must finish; failures reject. */
  readonly ready: Promise<void>;
  /** Current durable generation only; valid after ready, unavailable after close. */
  getImapCheckpoint?(providerId: string): ImapUidCheckpoint | null;
  close(): Promise<void>;
  /** Legacy initiation; new owners must await close(). */
  unregister(): void;
}

function stopped(): HandlerError {
  return new HandlerError('Inbox surface or provider startup has been stopped', 'INBOX_SURFACE_STOPPED', 409);
}
function startFailed(): HandlerError {
  return new HandlerError('Inbox surface initialization failed', 'INBOX_SURFACE_START_FAILED', 503);
}

/** Bind the canonical read method and own storage, polling and host gate cleanup. */
export function registerInboxSurface(
  ctx: InboxSurfaceContext,
  options: RegisterInboxSurfaceOptions,
): InboxSurfaceRegistration {
  if (!options || options.adapters == null) {
    throw new HandlerError('Inbox adapters must be supplied explicitly', 'INBOX_ADAPTERS_REQUIRED', 500);
  }
  const descriptor = ctx.catalog.get(INBOX_LIST_METHOD_ID);
  if (!descriptor) throw new HandlerError(`Unknown gateway method: ${INBOX_LIST_METHOD_ID}`, 'METHOD_NOT_FOUND', 404);
  // Copy explicit membership before starting anything; later map mutation must
  // not silently add a provider outside this registration's owned lifetime.
  const adapters = new Map(options.adapters);
  const report = (level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void => {
    try { ctx.logger[level](message, meta); } catch { /* Reporting cannot change lifecycle outcomes. */ }
  };
  const store = new InboxCursorStore(ctx.workingDirectory, options.storeFileName, {
    onSweep: ({ expired, capped, remaining }) => report('info', 'inbox retention sweep reclaimed items', { expired, capped, remaining }),
    onSweepError: () => report('warn', 'inbox retention sweep failed'),
  });
  const poller = new InboundPoller({ adapters, store, logger: ctx.logger });
  let closed = false;
  let closing: Promise<void> | undefined;
  let setupFailed = false;
  const active = new Set<Promise<unknown>>();
  const gateCleanups: Array<() => void | Promise<void>> = [];
  const own = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(stopped());
    const work = Promise.resolve().then(operation);
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  };

  const ready = Promise.resolve().then(async () => {
    if (setupFailed) throw startFailed();
    if (closed) throw stopped();
    try { await store.init(); } catch { throw startFailed(); }
    if (closed) throw stopped();
    if (options.gatePolling) return;
    if (!options.skipInitialPoll) await poller.pollOnce();
    if (closed) throw stopped();
    poller.start();
  });
  void ready.catch(() => { if (!closed) report('error', 'inbox surface bootstrap failed'); });

  const controlFor = (providerId: string): InboxPollingControl => {
    let epoch = 0;
    let starting: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    return {
      start() {
        if (closed || stopping) return Promise.reject(stopped());
        if (starting) return starting;
        if (poller.isProviderRunning(providerId)) return Promise.resolve();
        const current = epoch;
        const work = own(async () => {
          await ready;
          if (closed || current !== epoch) throw stopped();
          // startProvider also resumes a paused generation. Arm it before the
          // seed so reacquiring leadership does not silently skip that poll;
          // the poller coalesces interval ticks with an in-flight seed.
          poller.startProvider(providerId);
          if (!options.skipInitialPoll) await poller.pollProviderOnce(providerId);
          if (closed || current !== epoch) throw stopped();
        });
        starting = work;
        void work.then(
          () => { if (starting === work) starting = undefined; },
          () => { if (starting === work) starting = undefined; },
        );
        return work;
      },
      stop() {
        if (stopping) return stopping;
        epoch += 1;
        const previous = starting;
        starting = undefined;
        const work = Promise.resolve().then(async () => {
          const stopPoll = poller.stopProvider(providerId);
          await Promise.allSettled([previous, stopPoll]);
          await stopPoll;
        });
        stopping = work;
        void work.then(
          () => { if (stopping === work) stopping = undefined; },
          () => { if (stopping === work) stopping = undefined; },
        );
        return work;
      },
    };
  };

  try {
    if (options.gatePolling) for (const providerId of poller.providerIds()) {
      const cleanup = options.gatePolling(providerId, controlFor(providerId));
      if (typeof cleanup === 'function') gateCleanups.push(cleanup);
    }
  } catch { setupFailed = true; }

  let unregisterMethod: (() => void) | undefined;
  const assertReadCurrent = options.assertReadCurrent;
  const checkRead = async (): Promise<void> => {
    try { await assertReadCurrent?.(); }
    catch { throw new HandlerError('Inbox account scope is unavailable', 'INBOX_SCOPE_UNAVAILABLE', 503); }
  };
  try {
    unregisterMethod = registerCatalogHandler<InboxListInput, InboxListOutput>(ctx.catalog, INBOX_LIST_METHOD_ID,
      (invocation) => own(async () => {
        await ready;
        await checkRead();
        let validateLease: (() => void | Promise<void>) | undefined;
        try {
          validateLease = await options.acquireReadLease?.();
          if (options.acquireReadLease && typeof validateLease !== 'function') throw new Error();
        } catch { throw new HandlerError('Inbox account scope is unavailable', 'INBOX_SCOPE_UNAVAILABLE', 503); }
        const result = await aggregateInbox({ store, poller }, normalizeInboxQuery(invocation.body, invocation.query));
        await checkRead();
        try { await validateLease?.(); }
        catch { throw new HandlerError('Inbox account scope is unavailable', 'INBOX_SCOPE_UNAVAILABLE', 503); }
        return result;
      }));
  } catch { setupFailed = true; }

  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    // Publish the shared promise before retiring a host gate or aborting an
    // adapter: either callback can synchronously reenter close().
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const result = closing;
    const admitted = [...active];
    void result.catch(() => { report('warn', 'Inbox surface did not close cleanly'); });
    const cleanup = async (): Promise<void> => {
      const errors: unknown[] = [];
      try { unregisterMethod?.(); } catch (error) { errors.push(error); }
      try { ctx.catalog.register(descriptor, undefined, { replace: true }); } catch (error) { errors.push(error); }
      let stopPolls: Promise<void>;
      try { stopPolls = poller.stop(); } catch (error) { errors.push(error); stopPolls = Promise.resolve(); }
      const gates = gateCleanups.reverse().map(async (retire) => {
        const retiring = retire();
        if (retiring === result) throw new Error('Inbox gate cleanup cannot await its own surface close');
        await retiring;
      });
      const [, cleanupOutcomes] = await Promise.all([
        Promise.allSettled([ready, ...admitted]),
        Promise.allSettled([stopPolls, ...gates]),
      ]);
      for (const outcome of cleanupOutcomes) if (outcome.status === 'rejected') errors.push(outcome.reason);
      try { await store.close(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, 'Inbox surface did not close cleanly');
    };
    void cleanup().then(resolve, reject);
    return result;
  };
  return { ready, close, getImapCheckpoint: (providerId) => store.getImapCheckpoint(providerId), unregister: () => { void close(); } };
}
