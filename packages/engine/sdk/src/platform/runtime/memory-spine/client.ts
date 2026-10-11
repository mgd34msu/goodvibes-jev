/**
 * client.ts, the SDK memory-spine surface client (host-vs-client access mode).
 *
 * The daemon-owned memory service makes the daemon the SINGLE WRITER of its
 * canonical sql.js store. sql.js has no row locking and rewrites the whole file on
 * every save(), so two live processes writing the same file clobber each other,
 * a whole-file lost update that would DELETE memory. One process must own the
 * store; every other surface reaches it over the wire.
 *
 * This client is the surface-side switch that realizes that invariant, mirroring
 * the session-spine host-vs-client pattern:
 *
 *  - HOST / OFFLINE-EMBEDDED mode (transport NOT attached): the surface IS the only
 *    process touching its own store file, so it reads/writes the LOCAL embedded
 *    store directly. This is the offline fallback the agent and TUI keep, a daemon
 *    is not required for them to work.
 *  - CLIENT-OF-ADOPTED-DAEMON mode (transport attached): the daemon owns the store;
 *    the surface routes EVERY memory op through the injected wire transport and
 *    NEVER opens the file. Enforced structurally here, the active branch only ever
 *    touches `this.transport`, never `this.local`.
 *
 * FULL DETACH (SDK 1.2.0). The 1.1.0 wire family covered five verbs (add,
 * honestSearch, get, updateReview, delete). That was enough for a surface to store
 * and recall a fact over the wire, but NOT enough to fully detach every consumer
 * from the store file: the agent's `list`/`update`/semantic-search paths and the
 * TUI's `/recall` browse/link/queue/export paths still fell back to a local file.
 * This client now exposes the FULL read/write catalog those consumers need
 * (see MemoryExtendedAccess), so a wire client never opens the file for ANY of them.
 *
 * ONE-WRITER ENFORCEMENT RULING. The platform's convention (see canonical-memory.ts
 * and the session spine) is honest sequential/owned access plus stated posture, NOT
 * an OS advisory lock, sql.js exposes no lock and a cross-process flock would be a
 * new, unenforceable-on-every-OS mechanism the rest of the store does not rely on.
 * So the invariant is enforced two ways, both honest: (1) mode exclusivity, a
 * client in wire mode provably cannot reach the local file because the code routes
 * exclusively to the transport; (2) a documented single-writer contract for the
 * embedded case, the daemon host and an offline surface are each the sole process
 * for their own file. `mode()` reports the current posture so a surface can surface
 * it rather than guess.
 *
 * HONEST FAILURE. Unlike the fire-and-forget session mirror, memory reads/writes
 * return data, so this client is request/response. In client mode a transport
 * failure is SURFACED to the caller (the promise rejects); it is deliberately NOT
 * silently served from the local store, a wire client must not open the
 * daemon-owned file, and returning a divergent local copy as if it were canonical
 * would be the exact dishonest-recall failure this whole design exists to prevent.
 * A sustained daemon loss is handled by `deactivate()`, which returns the surface
 * to owned-local mode explicitly.
 *
 * VERSION TOLERANCE. The five CORE verbs are required of every transport. The
 * EXTENDED verbs are OPTIONAL on the transport (`MemoryTransport`) so a surface
 * pinned to an older SDK/daemon pair that predates a verb still satisfies the type.
 * When a client in wire mode calls an extended verb its adopted daemon does not
 * implement, the call REJECTS with a stated reason, it never silently reaches into
 * the local file, which would break the one-writer invariant and lie about which
 * store answered.
 */

import { captureMemoryOperation, awaitMemoryOperation, assertMemoryOperationCurrent, type MemoryOperationOptions } from '../../state/memory-operation.js';
export type { MemoryOperationOptions } from '../../state/memory-operation.js';

import { logger } from '../../utils/logger.js';
import type {
  MemoryAddOptions,
  MemoryBundle,
  MemoryDoctorReport,
  MemoryImportResult,
  MemoryLink,
  MemoryRecord,
  MemoryReviewPatch,
  MemoryScope,
  MemorySearchFilter,
  MemorySemanticSearchResult,
} from '../../state/memory-store.js';
import type { MemoryVectorStats } from '../../state/memory-vector-store.js';
import type { HonestMemorySearchOptions, HonestMemorySearchResult } from '../../state/memory-recall-contract.js';
import {
  buildRecallSnapshot,
  emptyRecallSnapshot,
  DEFAULT_RECALL_SNAPSHOT_STALE_AFTER_MS,
  type MemoryRecallSnapshot,
  type MemoryRecallRefreshOptions,
} from './recall-snapshot.js';
import { memoryVerbUnavailableError } from './wire-verb-availability.js';

/**
 * Patch shape accepted by an editable-field update
 * (scope/summary/detail/tags + the temporal validity window).
 *
 * For validFrom/validUntil the three states are distinct and all reachable over
 * the wire: omitted (`undefined`) leaves the bound unchanged, a number sets it,
 * and `null` clears it. This is what lets a memory-projection proposal that
 * changes ONLY the temporal window be applied, without these fields the patch
 * carried no window and such a proposal could not round-trip.
 */
export interface MemoryUpdatePatch {
  readonly scope?: MemoryScope | undefined;
  readonly summary?: string | undefined;
  readonly detail?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly validFrom?: number | null | undefined;
  readonly validUntil?: number | null | undefined;
}

/**
 * The five CORE verbs, shipped in 1.1.0. Every transport must implement all five,
 * they are the minimum that lets a surface store and recall a fact over the wire.
 */
export interface MemoryCoreAccess {
  add(opts: MemoryAddOptions, operation?: MemoryOperationOptions): Promise<MemoryRecord>;
  honestSearch(filter: MemorySearchFilter, options?: HonestMemorySearchOptions, operation?: MemoryOperationOptions): Promise<HonestMemorySearchResult>;
  get(id: string, operation?: MemoryOperationOptions): Promise<MemoryRecord | null>;
  updateReview(id: string, patch: MemoryReviewPatch, operation?: MemoryOperationOptions): Promise<MemoryRecord | null>;
  delete(id: string, operation?: MemoryOperationOptions): Promise<boolean>;
}

/**
 * The EXTENDED verbs added in 1.2.0 so a wire client can fully detach from the file.
 * Each maps to a MemoryRegistry read/write the consumers were still doing locally:
 *  - `list`         , bulk read (getAll / literal browse): knowledge injection + agent `list`.
 *  - `searchSemantic`: scored semantic recall: agent semantic path + TUI `/recall --semantic`.
 *  - `update`       , edit scope/summary/detail/tags (a scope edit is how a record is "promoted" project→team).
 *  - `link`/`linksFor`, relate records / read a record's links.
 *  - `reviewQueue`  , records prioritised for review (the curator/queue surface).
 *  - `exportBundle`/`importBundle`, the no-loss bundle seam over the wire.
 *  - `vectorStats`/`doctor`, read the daemon's canonical index diagnostics.
 *
 * DELIBERATELY NOT HERE (host-only, ruled in the full-detach decision record):
 * `rebuildVectors`/`rebuildVectorsAsync`. Rebuilding the vector index is maintenance
 * a store performs on its OWN index; the daemon keeps its canonical index current on
 * every add/import and exposes an admin `POST /api/memory/vector/rebuild` for a forced
 * rebuild. A wire client owns no index to rebuild, so a client-initiated rebuild is an
 * admin/diagnostic action against a store it does not own, it stays out of band, not
 * a per-record detach need.
 */
export interface MemoryExtendedAccess {
  list(filter?: MemorySearchFilter, operation?: MemoryOperationOptions): Promise<readonly MemoryRecord[]>;
  searchSemantic(filter?: MemorySearchFilter, operation?: MemoryOperationOptions): Promise<readonly MemorySemanticSearchResult[]>;
  update(id: string, patch: MemoryUpdatePatch, operation?: MemoryOperationOptions): Promise<MemoryRecord | null>;
  link(fromId: string, toId: string, relation: string, operation?: MemoryOperationOptions): Promise<MemoryLink | null>;
  linksFor(id: string, operation?: MemoryOperationOptions): Promise<readonly MemoryLink[]>;
  reviewQueue(limit?: number, scope?: MemoryScope, operation?: MemoryOperationOptions): Promise<readonly MemoryRecord[]>;
  exportBundle(filter?: MemorySearchFilter, operation?: MemoryOperationOptions): Promise<MemoryBundle>;
  importBundle(bundle: MemoryBundle, operation?: MemoryOperationOptions): Promise<MemoryImportResult>;
  vectorStats(operation?: MemoryOperationOptions): Promise<MemoryVectorStats>;
  doctor(operation?: MemoryOperationOptions): Promise<MemoryDoctorReport>;
}

/**
 * The full memory read/write surface a caller uses without caring whether it
 * resolves locally or over the wire. Every method is async so a local (sync store)
 * and a wire (async) backend present the SAME shape.
 */
export interface MemoryAccess extends MemoryCoreAccess, MemoryExtendedAccess {
  /** Optional backend-incarnation restriction for a prepared operation. */
  captureOperationScope?(): () => void;
}

/**
 * The injected wire transport. A consumer builds a thin adapter over the daemon's
 * memory.records.* routes. The five CORE verbs are required; the EXTENDED verbs are
 * optional so a surface pinned to an older SDK/daemon still satisfies the type, a
 * client calling an extended verb the adopted daemon lacks gets an honest rejection,
 * never a silent local-file read.
 */
export type MemoryTransport = MemoryCoreAccess & Partial<MemoryExtendedAccess> & Pick<MemoryAccess, 'captureOperationScope'>;

/**
 * The local embedded store surface. The SDK's `MemoryRegistry` satisfies this
 * structurally (its methods are a mix of synchronous and async; the facade
 * normalizes them to promises). Kept minimal so the client stays decoupled from the concrete class.
 */
export interface LocalMemoryStore {
  captureOperationScope?(): () => void;
  add(opts: MemoryAddOptions, operation?: MemoryOperationOptions): Promise<MemoryRecord> | MemoryRecord;
  honestSearch(filter: MemorySearchFilter, options?: HonestMemorySearchOptions, operation?: MemoryOperationOptions): Promise<HonestMemorySearchResult> | HonestMemorySearchResult;
  get(id: string, operation?: MemoryOperationOptions): MemoryRecord | null;
  review(id: string, patch: MemoryReviewPatch, operation?: MemoryOperationOptions): MemoryRecord | null;
  delete(id: string, operation?: MemoryOperationOptions): boolean;
  // Extended (sync or async on the registry; the facade normalizes to promises).
  search(filter?: MemorySearchFilter, operation?: MemoryOperationOptions): Promise<MemoryRecord[]> | MemoryRecord[];
  searchSemantic(filter?: MemorySearchFilter, operation?: MemoryOperationOptions): Promise<MemorySemanticSearchResult[]> | MemorySemanticSearchResult[];
  update(id: string, patch: MemoryUpdatePatch, operation?: MemoryOperationOptions): MemoryRecord | null;
  link(fromId: string, toId: string, relation: string, operation?: MemoryOperationOptions): Promise<MemoryLink | null> | MemoryLink | null;
  linksFor(id: string, operation?: MemoryOperationOptions): MemoryLink[];
  reviewQueue(limit?: number, scope?: MemoryScope, operation?: MemoryOperationOptions): Promise<MemoryRecord[]> | MemoryRecord[];
  exportBundle(filter?: MemorySearchFilter, operation?: MemoryOperationOptions): MemoryBundle;
  importBundle(bundle: MemoryBundle, operation?: MemoryOperationOptions): Promise<MemoryImportResult> | MemoryImportResult;
  vectorStats(operation?: MemoryOperationOptions): MemoryVectorStats;
  doctor(operation?: MemoryOperationOptions): Promise<MemoryDoctorReport> | MemoryDoctorReport;
}

/** Wrap a local embedded store (e.g. a MemoryRegistry) as a full MemoryAccess. */
export function createLocalMemoryAccess(store: LocalMemoryStore): MemoryAccess {
  const run = <T>(options: MemoryOperationOptions | undefined, invoke: (operation: MemoryOperationOptions) => T | PromiseLike<T>) => {
    const operation = captureMemoryOperation(options);
    return awaitMemoryOperation(() => invoke(operation), operation);
  };
  return {
    captureOperationScope: () => {
      const capture = store.captureOperationScope, current = capture?.call(store);
      const names = ['add', 'honestSearch', 'get', 'review', 'delete', 'search', 'searchSemantic',
        'update', 'link', 'linksFor', 'reviewQueue', 'exportBundle', 'importBundle', 'vectorStats', 'doctor'] as const;
      const methods = names.map(name => store[name]);
      return () => {
        if (store.captureOperationScope !== capture || names.some((name, index) => store[name] !== methods[index])) {
          throw new Error('Memory operation local backend changed');
        }
        current?.();
      };
    },
    add: (opts, operation) => run(operation, owned => store.add(opts, owned)),
    honestSearch: (filter, options, operation) => run(operation, owned => store.honestSearch(filter, options, owned)),
    get: (id, operation) => run(operation, owned => store.get(id, owned)),
    updateReview: (id, patch, operation) => run(operation, owned => store.review(id, patch, owned)),
    delete: (id, operation) => run(operation, owned => store.delete(id, owned)),
    list: (filter, operation) => run(operation, owned => store.search(filter ?? {}, owned)),
    searchSemantic: (filter, operation) => run(operation, owned => store.searchSemantic(filter ?? {}, owned)),
    update: (id, patch, operation) => run(operation, owned => store.update(id, patch, owned)),
    link: (fromId, toId, relation, operation) => run(operation, owned => store.link(fromId, toId, relation, owned)),
    linksFor: (id, operation) => run(operation, owned => store.linksFor(id, owned)),
    reviewQueue: (limit, scope, operation) => run(operation, owned => store.reviewQueue(limit, scope, owned)),
    exportBundle: (filter, operation) => run(operation, owned => store.exportBundle(filter ?? {}, owned)),
    importBundle: (bundle, operation) => run(operation, owned => store.importBundle(bundle, owned)),
    vectorStats: (operation) => run(operation, owned => store.vectorStats(owned)),
    doctor: (operation) => run(operation, owned => store.doctor(owned)),
  };
}

/** Current access posture, honest, reportable, never guessed. */
export type MemoryAccessMode = 'local' | 'client';

type SpineLogger = Pick<typeof logger, 'debug' | 'info'>;

export interface MemorySpineClientOptions {
  /** The local embedded store, always present as the offline/host backend. */
  readonly local: MemoryAccess;
  /**
   * Attach a wire transport at construction for CLIENT mode immediately (a surface
   * that boots already adopted to a daemon). Omit for LOCAL mode until `activate()`
   * (a surface that adopts a daemon later, or runs offline forever).
   */
  readonly transport?: MemoryTransport | undefined;
  /**
   * How long a recall snapshot stays "fresh" before `recallSnapshot()` reports it
   * stale. Defaults to {@link DEFAULT_RECALL_SNAPSHOT_STALE_AFTER_MS}.
   */
  readonly recallSnapshotStaleAfterMs?: number | undefined;
  readonly log?: SpineLogger;
}

export type { MemoryRecallSnapshot, MemoryRecallRefreshOptions } from './recall-snapshot.js';

/**
 * Routes memory access to the LOCAL embedded store or, when a daemon has been
 * adopted, THROUGH the wire, never both. Implements {@link MemoryAccess} so a
 * caller uses one object regardless of mode.
 */
export class MemorySpineClient implements MemoryAccess {
  private readonly local: MemoryAccess;
  private transport: MemoryTransport | null;
  private operationEpoch = 0;
  private readonly log: SpineLogger;
  private readonly staleAfterMs: number;

  /** Last recall snapshot captured by refreshRecallSnapshot(); null until first refresh. */
  private snapshot: MemoryRecallSnapshot | null = null;

  constructor(options: MemorySpineClientOptions) {
    this.local = options.local;
    this.transport = options.transport ?? null;
    this.log = options.log ?? logger;
    this.staleAfterMs = options.recallSnapshotStaleAfterMs ?? DEFAULT_RECALL_SNAPSHOT_STALE_AFTER_MS;
  }

  /** The current posture: 'client' when routing over the wire, 'local' otherwise. */
  mode(): MemoryAccessMode {
    return this.transport ? 'client' : 'local';
  }

  /** Whether a wire transport is attached (client-of-adopted-daemon mode). */
  get active(): boolean {
    return this.transport !== null;
  }

  /**
   * Adopt a daemon: route every memory op through the wire from now on. The local
   * store is left untouched for the lifetime of client mode, the daemon is the
   * single writer.
   */
  activate(transport: MemoryTransport): void {
    this.operationEpoch++;
    this.transport = transport;
    this.log.info('memory spine activated, routing memory through the adopted external daemon (single writer)', {});
  }

  /** Release the daemon (mode lost / daemon stopped): return to owned-local access. */
  deactivate(reason: string): void {
    if (this.transport === null) return;
    this.operationEpoch++;
    this.transport = null;
    this.log.info('memory spine deactivated, reverting to owned-local memory access', { reason });
  }

  /** Bind one prepared caller to its original route, including adoption ABA. */
  captureOperationScope(): () => void {
    const transport = this.transport, epoch = this.operationEpoch;
    const route = transport ?? this.local;
    const names = ['add', 'honestSearch', 'get', 'updateReview', 'delete', 'list', 'searchSemantic',
      'update', 'link', 'linksFor', 'reviewQueue', 'exportBundle', 'importBundle', 'vectorStats', 'doctor'] as const;
    const methods = names.map(name => route[name]);
    const capture = route.captureOperationScope;
    const routeCurrent = capture?.call(route);
    return () => {
      if (this.transport !== transport || this.operationEpoch !== epoch
        || names.some((name, index) => route[name] !== methods[index])
        || route.captureOperationScope !== capture) {
        throw new Error('Memory operation route changed');
      }
      routeCurrent?.();
    };
  }

  private operation(options?: MemoryOperationOptions): MemoryOperationOptions {
    const current = captureMemoryOperation(options), scope = this.captureOperationScope();
    return captureMemoryOperation({ signal: current.signal, assertCurrent: () => {
      scope(); assertMemoryOperationCurrent(current);
    } });
  }

  add(opts: MemoryAddOptions, options?: MemoryOperationOptions): Promise<MemoryRecord> {
    const operation = this.operation(options), route = this.route();
    return awaitMemoryOperation(() => route.add(opts, operation), operation);
  }

  honestSearch(filter: MemorySearchFilter, options?: HonestMemorySearchOptions, lifecycle?: MemoryOperationOptions): Promise<HonestMemorySearchResult> {
    const operation = this.operation(lifecycle), route = this.route();
    return awaitMemoryOperation(() => route.honestSearch(filter, options, operation), operation);
  }

  get(id: string, options?: MemoryOperationOptions): Promise<MemoryRecord | null> {
    const operation = this.operation(options), route = this.route();
    return awaitMemoryOperation(() => route.get(id, operation), operation);
  }

  updateReview(id: string, patch: MemoryReviewPatch, options?: MemoryOperationOptions): Promise<MemoryRecord | null> {
    const operation = this.operation(options), route = this.route();
    return awaitMemoryOperation(() => route.updateReview(id, patch, operation), operation);
  }

  delete(id: string, options?: MemoryOperationOptions): Promise<boolean> {
    const operation = this.operation(options), route = this.route();
    return awaitMemoryOperation(() => route.delete(id, operation), operation);
  }

  list(filter?: MemorySearchFilter, options?: MemoryOperationOptions): Promise<readonly MemoryRecord[]> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('list', a => a.list(filter, operation), t => t.list?.(filter, operation)), operation);
  }

  searchSemantic(filter?: MemorySearchFilter, options?: MemoryOperationOptions): Promise<readonly MemorySemanticSearchResult[]> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('searchSemantic', a => a.searchSemantic(filter, operation), t => t.searchSemantic?.(filter, operation)), operation);
  }

  update(id: string, patch: MemoryUpdatePatch, options?: MemoryOperationOptions): Promise<MemoryRecord | null> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('update', a => a.update(id, patch, operation), t => t.update?.(id, patch, operation)), operation);
  }

  link(fromId: string, toId: string, relation: string, options?: MemoryOperationOptions): Promise<MemoryLink | null> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('link', a => a.link(fromId, toId, relation, operation), t => t.link?.(fromId, toId, relation, operation)), operation);
  }

  linksFor(id: string, options?: MemoryOperationOptions): Promise<readonly MemoryLink[]> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('linksFor', a => a.linksFor(id, operation), t => t.linksFor?.(id, operation)), operation);
  }

  reviewQueue(limit?: number, scope?: MemoryScope, options?: MemoryOperationOptions): Promise<readonly MemoryRecord[]> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('reviewQueue', a => a.reviewQueue(limit, scope, operation), t => t.reviewQueue?.(limit, scope, operation)), operation);
  }

  exportBundle(filter?: MemorySearchFilter, options?: MemoryOperationOptions): Promise<MemoryBundle> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('exportBundle', a => a.exportBundle(filter, operation), t => t.exportBundle?.(filter, operation)), operation);
  }

  importBundle(bundle: MemoryBundle, options?: MemoryOperationOptions): Promise<MemoryImportResult> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('importBundle', a => a.importBundle(bundle, operation), t => t.importBundle?.(bundle, operation)), operation);
  }

  vectorStats(options?: MemoryOperationOptions): Promise<MemoryVectorStats> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('vectorStats', a => a.vectorStats(operation), t => t.vectorStats?.(operation)), operation);
  }

  doctor(options?: MemoryOperationOptions): Promise<MemoryDoctorReport> {
    const operation = this.operation(options);
    return awaitMemoryOperation(() => this.routeExtended('doctor', a => a.doctor(operation), t => t.doctor?.(operation)), operation);
  }

  // ── The sync-recall seam ──────────────────────────────────────────────────────

  /**
   * Refresh the cached recall snapshot ASYNCHRONOUSLY over the CURRENT route (wire
   * when adopted, local otherwise). Call this from an async pre-turn hook so a
   * SYNCHRONOUS prompt builder can read the result via {@link recallSnapshot}
   * without awaiting the wire. Runs the honest recall search (recall-injection
   * contract ON by default), stamps the capture time and mode, and stores it.
   */
  async refreshRecallSnapshot(
    filter: MemorySearchFilter = {},
    options: MemoryRecallRefreshOptions = {},
  ): Promise<MemoryRecallSnapshot> {
    const recall = options.recall ?? true;
    const operation = this.operation(), mode = this.mode(), route = this.route();
    const result = await awaitMemoryOperation(() => route.honestSearch(filter, { recall }, operation), operation);
    assertMemoryOperationCurrent(operation);
    this.snapshot = buildRecallSnapshot(result, mode, Date.now(), this.staleAfterMs);
    return this.snapshot;
  }

  /**
   * Read the last recall snapshot SYNCHRONOUSLY (for a sync prompt builder). Never
   * opens the file and never awaits: it returns whatever the last async refresh
   * captured, with a freshly-computed age, a `stale` flag, and an HONEST `note`. If
   * no refresh has happened yet it returns an EMPTY snapshot whose note says exactly
   * that, never a silent empty that reads as "nothing was ever stored."
   */
  recallSnapshot(now: number = Date.now()): MemoryRecallSnapshot {
    const cached = this.snapshot;
    if (cached === null || cached.search === null || cached.capturedAt === null) return emptyRecallSnapshot(this.mode());
    return buildRecallSnapshot(cached.search, cached.mode, cached.capturedAt, this.staleAfterMs, now);
  }

  /**
   * The single choke point that realizes the one-writer invariant: in client mode
   * EVERY op resolves through the transport and the local store is never reached.
   */
  private route(): MemoryCoreAccess {
    return this.transport ?? this.local;
  }

  /**
   * Route an extended verb. Local mode → the local store. Client mode → the
   * transport's verb if it implements it, otherwise an HONEST rejection stating the
   * adopted daemon does not support it (never a silent local-file read, which would
   * break the single-writer invariant and misreport which store answered).
   *
   * TWO honesty layers, both landing on the same {@link memoryVerbUnavailableError}
   * message:
   *  1. COMPILE-TIME omission (here): a transport object that literally does not
   *     implement the verb (`call === undefined`), a surface pinned to an adapter
   *     that predates the verb. Rejects immediately.
   *  2. RUNTIME signal (the transports): a transport that DOES implement the verb but
   *     whose adopted daemon route answers a route-not-found 404 folds that 404
   *     through `foldMemoryWireExtendedError` in its own catch and rejects with the
   *     same message. That path, not this one, is what a live older daemon
   *     actually produces; this branch alone never sees it, because a real transport
   *     supplies a concrete function for every verb.
   */
  private routeExtended<T>(
    verb: keyof MemoryExtendedAccess,
    local: (access: MemoryAccess) => Promise<T>,
    wire: (transport: MemoryTransport) => Promise<T> | undefined,
  ): Promise<T> {
    if (this.transport === null) return local(this.local);
    const call = wire(this.transport);
    if (call === undefined) {
      return Promise.reject(memoryVerbUnavailableError(verb));
    }
    return call;
  }
}
