/**
 * Mechanical inbox registration over explicit host-supplied adapters.
 *
 * Adapted from the pinned daemon inbox/index.ts. Built-in provider construction
 * and semantic mapping/triage remain product concerns; there is deliberately no
 * empty adapter default or judgment call here. Accepting a preview for local
 * storage/display does not authorize sending it to a hosted reader.
 */
import { types } from 'node:util';
import type { GatewayMethodCatalog } from '../control-plane/method-catalog.js';
import { HandlerError, registerCatalogHandler } from '../control-plane/host-handlers.js';
import { InboxCursorStore } from './cursor-store.js';
import { InboundPoller } from './poller.js';
import { aggregateInbox, normalizeInboxQuery, type InboxListInput, type InboxListOutput } from './aggregator.js';
import type { ImapUidCheckpoint, InboundProviderAdapter } from './provider-adapter.js';
import type { IntakeLogger } from './context.js';
import { composeInboxReads, type InboxReadSource } from './composite.js';

export const INBOX_LIST_METHOD_ID = 'channels.inbox.list';

// Detect a gate awaiting its enclosing legacy wrapper as well as its source.
const enclosingRetirements = new WeakMap<() => Promise<void>, Promise<void>>();

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
  /** Default true. Cluster gates may heartbeat once the owned seed is admitted. */
  readonly awaitInitialPoll?: boolean;
  /** Host registration may return its own awaitable unregister callback. */
  readonly gatePolling?: (providerId: string, control: InboxPollingControl) => void | (() => void | Promise<void>);
  /** Recheck a product-owned account/workspace scope around every mirror read. */
  readonly assertReadCurrent?: () => void | Promise<void>;
  /** Capture one account/mailbox generation across this exact mirror projection. */
  readonly acquireReadLease?: () => Promise<OwnedInboxReadLease>;
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

/** Callable legacy validator with an optional synchronous final generation fence. */
export interface OwnedInboxReadLease {
  (): void | Promise<void>;
  readonly assertCurrent?: () => void;
}

export interface OwnedInboxRead extends InboxReadSource {
  validate(): Promise<void>;
  assertCurrent(): void;
  release(): void;
}

/** One independent account store/poller lifetime; never owns a catalog binding. */
export interface OwnedInboxSource extends InboxSurfaceRegistration {
  readonly providerIds: readonly string[];
  acquireRead(requireFinalProof?: boolean): Promise<OwnedInboxRead>;
}

function scopeUnavailable(): HandlerError {
  return new HandlerError('Inbox account scope is unavailable', 'INBOX_SCOPE_UNAVAILABLE', 503);
}

function stopped(): HandlerError {
  return new HandlerError('Inbox surface or provider startup has been stopped', 'INBOX_SURFACE_STOPPED', 409);
}
function startFailed(): HandlerError {
  return new HandlerError('Inbox surface initialization failed', 'INBOX_SURFACE_START_FAILED', 503);
}

/** Own storage, polling and host gates independently from the canonical method. */
export function createOwnedInboxSource(
  ctx: Omit<InboxSurfaceContext, 'catalog'>,
  options: RegisterInboxSurfaceOptions,
): OwnedInboxSource {
  if (!options || options.adapters == null) {
    throw new HandlerError('Inbox adapters must be supplied explicitly', 'INBOX_ADAPTERS_REQUIRED', 500);
  }
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
          if (!options.skipInitialPoll) {
            const seed = poller.pollProviderOnce(providerId);
            if (options.awaitInitialPoll === false) {
              // The canonical poller still owns and drains this accepted seed.
              // Content screening cannot delay a cluster holder's heartbeat.
              void seed.catch(() => report('warn', 'inbox provider seed failed'));
            } else await seed;
          }
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

  const checkRead = async (): Promise<void> => {
    try { await options.assertReadCurrent?.(); }
    catch { throw scopeUnavailable(); }
  };
  const providerIds = Object.freeze([...adapters.keys()]);
  const acquireRead = async (requireFinalProof = false): Promise<OwnedInboxRead> => {
    if (closed) throw stopped();
    // Admission is synchronous and remains pinned through the composite's last
    // validation, even while another owner's acquisition is still pending.
    let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    active.add(held);
    let released = false;
    const retire = (): void => {
      if (released) return;
      released = true; active.delete(held); release();
    };
    try {
      await ready;
      if (closed) throw stopped();
      await checkRead();
      let lease: OwnedInboxReadLease | undefined;
      try {
        lease = await options.acquireReadLease?.();
        if (options.acquireReadLease && typeof lease !== 'function') throw new Error();
        if (requireFinalProof && (options.assertReadCurrent || options.acquireReadLease)
          && typeof lease?.assertCurrent !== 'function') throw new Error();
      } catch { throw scopeUnavailable(); }
      const assertCurrent = (): void => {
        if (closed || released) throw stopped();
        try {
          const result: unknown = lease?.assertCurrent?.();
          if (types.isPromise(result)) void result.catch(() => {});
          if (result !== undefined) throw new Error('Read fence must be synchronous');
        } catch { throw scopeUnavailable(); }
        if (requireFinalProof && store.hasInvalidItemNamespaces(providerIds)) {
          throw new HandlerError('Inbox item IDs must belong to their provider namespace', 'INBOX_ITEM_NAMESPACE_INVALID', 503);
        }
      };
      assertCurrent();
      return { providerIds, sources: { store, poller }, release: retire, assertCurrent,
        async validate() {
          if (closed || released) throw stopped();
          await checkRead();
          try { await lease?.(); } catch { throw scopeUnavailable(); }
          assertCurrent();
        },
      };
    } catch (error) { retire(); throw error; }
  };

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
      let stopPolls: Promise<void>;
      try { stopPolls = poller.stop(); } catch (error) { errors.push(error); stopPolls = Promise.resolve(); }
      const gates = gateCleanups.reverse().map(async (retire) => {
        const retiring = retire();
        const enclosing = enclosingRetirements.get(close);
        if (retiring === result || (enclosing !== undefined && retiring === enclosing)) throw new Error('Inbox gate cleanup cannot await its own surface close');
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
  return { ready, close, providerIds, acquireRead, getImapCheckpoint: (providerId) => store.getImapCheckpoint(providerId), unregister: () => { void close(); } };
}

/**
 * Bind one canonical projection over independently owned sources. Closing this
 * binding drains reads but does not retire sources borrowed from their owners.
 */
export function registerCompositeInboxSurface(
  ctx: InboxSurfaceContext,
  sources: readonly OwnedInboxSource[],
  options: { readonly requireFinalProof?: boolean } = {},
): InboxSurfaceRegistration {
  const descriptor = ctx.catalog.get(INBOX_LIST_METHOD_ID);
  if (!descriptor) throw new HandlerError(`Unknown gateway method: ${INBOX_LIST_METHOD_ID}`, 'METHOD_NOT_FOUND', 404);
  if (ctx.catalog.hasHandler(INBOX_LIST_METHOD_ID)) throw new HandlerError('Inbox read method already has an owner', 'INBOX_SURFACE_ALREADY_REGISTERED', 409);
  const owned = [...sources];
  const providers = new Set<string>();
  for (const source of owned) for (const id of source.providerIds) {
    if ((owned.length > 1 || options.requireFinalProof !== false) && (!id || id.includes(':'))) throw new HandlerError('Inbox provider IDs must be nonempty namespaces', 'INBOX_PROVIDER_NAMESPACE_INVALID', 500);
    if (providers.has(id)) throw new HandlerError('Inbox provider IDs must have exactly one owner', 'INBOX_DUPLICATE_PROVIDER', 500);
    providers.add(id);
  }
  const requireFinalProof = owned.length > 1 || options.requireFinalProof !== false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const ready = Promise.all(owned.map(source => source.ready)).then(() => {});
  void ready.catch(() => {});
  const unregister = registerCatalogHandler<InboxListInput, InboxListOutput>(ctx.catalog, INBOX_LIST_METHOD_ID, invocation => {
    if (closed) return Promise.reject(stopped());
    const work = (async () => {
      await ready;
      if (closed) throw stopped();
      const query = normalizeInboxQuery(invocation.body, invocation.query);
      const included = !requireFinalProof ? owned : owned.filter(source =>
        !query.providers?.length || source.providerIds.some(id => query.providers!.includes(id)));
      const reads: OwnedInboxRead[] = [];
      try {
        for (const source of included) reads.push(await source.acquireRead(requireFinalProof));
        for (const read of reads) read.assertCurrent();
        const result = await aggregateInbox(!requireFinalProof && reads.length === 1 ? reads[0]!.sources : composeInboxReads(reads), query);
        const validations = await Promise.allSettled(reads.map(read => read.validate()));
        for (const validation of validations) if (validation.status === 'rejected') throw validation.reason;
        if (closed) throw stopped();
        // No await between the all-owner fence, detached wire result and return.
        for (const read of reads) read.assertCurrent();
        return result;
      } finally { for (const read of reads) read.release(); }
    })();
    active.add(work);
    void work.then(() => active.delete(work), () => active.delete(work));
    return work;
  });
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closing.catch(() => {});
    const errors: unknown[] = [];
    try { unregister(); } catch (error) { errors.push(error); }
    try { ctx.catalog.register(descriptor, undefined, { replace: true }); } catch (error) { errors.push(error); }
    void Promise.allSettled([ready, ...active]).then(() => {
      if (errors.length) reject(new AggregateError(errors, 'Inbox surface did not close cleanly')); else resolve();
    });
    return closing;
  };
  return { ready, close, unregister: () => { void close(); } };
}

/** Backward-compatible single-store owner and canonical binding. */
export function registerInboxSurface(ctx: InboxSurfaceContext, options: RegisterInboxSurfaceOptions): InboxSurfaceRegistration {
  if (!options || options.adapters == null) throw new HandlerError('Inbox adapters must be supplied explicitly', 'INBOX_ADAPTERS_REQUIRED', 500);
  if (!ctx.catalog.get(INBOX_LIST_METHOD_ID)) throw new HandlerError(`Unknown gateway method: ${INBOX_LIST_METHOD_ID}`, 'METHOD_NOT_FOUND', 404);
  const source = createOwnedInboxSource(ctx, options);
  let binding: InboxSurfaceRegistration;
  try { binding = registerCompositeInboxSurface(ctx, [source], { requireFinalProof: false }); }
  catch {
    void source.close().catch(() => {});
    const ready = Promise.reject<void>(startFailed()); void ready.catch(() => {});
    binding = { ready, close: async () => {}, unregister() {} };
  }
  const ready = Promise.all([source.ready, binding.ready]).then(() => {});
  void ready.catch(() => {});
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Initiate source stop synchronously, before waiting on any accepted read.
    enclosingRetirements.set(source.close, closing);
    const retiring = [binding.close(), source.close()];
    void Promise.allSettled(retiring).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) reject(new AggregateError(errors, 'Inbox surface did not close cleanly')); else resolve();
    });
    void closing.catch(() => {});
    return closing;
  };
  return { ready, close, getImapCheckpoint: id => source.getImapCheckpoint!(id), unregister: () => { void close(); } };
}
