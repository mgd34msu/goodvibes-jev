/** Explicit account-owned scoring and lease-held enrichment; never a polling hook. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { types } from 'node:util';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { HandlerError } from '../../control-plane/host-handlers.js';
import { acquireCrossProcessLock } from '../../state/durable-file-io.js';
import { aggregateInbox, normalizeInboxQuery, type ChannelInboxItem, type InboxListInput } from '../aggregator.js';
import { createOwnedInboxSource, registerCompositeInboxSurface, type InboxSurfaceContext,
  type OwnedInboxSource, type RegisterInboxSurfaceOptions, type InboxTriageOverlay } from '../registration.js';
import { captureTriageInputs, triageBinding } from './evidence.js';
import { readTriageMetadataBatch, runInboxTriage } from './pipeline.js';
import { TRIAGE_MODEL } from './battery.js';
import { SqliteTriageStore } from './store.js';
import type { TriageInput, TriageReceipt } from './types.js';

/**
 * Constructor-only host grant, never decoded from message/configuration data.
 * The trusted host attests that this exact port is bound to the named destination
 * and authorized to read this account's protected previews with no retention.
 * A destination string alone establishes no permission. No production grant is
 * established by this module. Both revocation and a live synchronous proof are required.
 */
export interface InboxTriageAuthority {
  readonly accountScopeId: string;
  readonly providerId: string;
  readonly destinationId: string;
  readonly retention: 'ephemeral-no-log';
  readonly port: JudgmentPort;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface OwnedTriagedInboxOptions extends Omit<RegisterInboxSurfaceOptions, 'storeFileName' | 'enrichTriage' | 'acquireReadLease'> {
  readonly providerId: string;
  readonly accountScopeId: string;
  readonly acquireReadLease: NonNullable<RegisterInboxSurfaceOptions['acquireReadLease']>;
  readonly authority?: InboxTriageAuthority;
}
export interface OwnedInboxTriageResult {
  readonly receipts: readonly TriageReceipt[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}
export interface OwnedTriagedInboxSource extends OwnedInboxSource {
  /** Explicit bounded mirror selection, maximum 100 rows per call; never automatic. */
  runInboxTriage(query?: InboxListInput, operation?: { readonly signal?: AbortSignal; readonly dryRun?: boolean }): Promise<OwnedInboxTriageResult>;
}
function unavailable(): HandlerError {
  return new HandlerError('Inbox triage authority is unavailable', 'INBOX_TRIAGE_AUTHORITY_UNAVAILABLE', 503);
}
function synchronous(proof: () => void): void {
  const result: unknown = proof();
  if (types.isPromise(result)) void result.catch(() => {});
  if (result !== undefined) throw unavailable();
}
/** One representation for scoring and receipt matching. No sender or metadata. */
function inputs(rows: readonly Readonly<ChannelInboxItem>[]): readonly TriageInput[] {
  return rows.map(row => ({ id: row.id, surface: row.provider, subject: row.subject ?? '', snippet: row.bodyPreview,
    ...(row.kind === 'dm' ? { conversationKind: 'direct' as const }
      : row.kind === 'thread' ? { conversationKind: 'thread' as const } : {}), unread: row.unread }));
}

/** Own one independent account, its mirror, semantic work, receipts and storage lock. */
export function createOwnedTriagedInboxSource(
  ctx: Omit<InboxSurfaceContext, 'catalog'>, options: OwnedTriagedInboxOptions,
): Promise<OwnedTriagedInboxSource> { return createTriagedSource(ctx, options); }

async function createTriagedSource(
  ctx: Omit<InboxSurfaceContext, 'catalog'>, options: OwnedTriagedInboxOptions,
  enclosingClosing?: () => Promise<void> | undefined,
): Promise<OwnedTriagedInboxSource> {
  const { providerId, accountScopeId } = options;
  if (!providerId || providerId.includes(':') || !accountScopeId || accountScopeId.length > 500
    || options.adapters.size !== 1 || !options.adapters.has(providerId) || typeof options.acquireReadLease !== 'function') {
    throw new TypeError('Triaged inbox requires one explicitly scoped account and read lease');
  }
  // Capture membership and authority at construction; later option mutation grants nothing.
  const authority = options.authority;
  const port = authority?.port, authoritySignal = authority?.signal;
  const gatePolling = options.gatePolling;
  const proof = authority ? authority.assertCurrent.bind(authority) : undefined;
  const authorizedBinding = authority?.accountScopeId === accountScopeId && authority.providerId === providerId
    && typeof authority.destinationId === 'string' && authority.destinationId.length > 0
    && authority.retention === 'ephemeral-no-log' && !!authoritySignal && typeof proof === 'function';
  const owner = new AbortController();
  let closed = false, closing: Promise<void> | undefined, store: SqliteTriageStore | undefined;
  const active = new Set<Promise<unknown>>();
  let scoreTail: Promise<unknown> = Promise.resolve();
  const scope = createHash('sha256').update(JSON.stringify(['owned-inbox-triage-v1', providerId, accountScopeId])).digest('hex');
  const fileName = `inbox-triage-${scope}.sqlite`;
  const releaseLock = await acquireCrossProcessLock(join(ctx.workingDirectory, '.goodvibes', 'tui', 'operator', `${fileName}.owner.lock`),
    { strictOwnership: true, totalTimeoutMs: 100 });
  const assertAuthority = (): void => {
    if (closed || owner.signal.aborted || !authorizedBinding || !port || authoritySignal?.aborted || !proof) throw unavailable();
    try { synchronous(proof); } catch { throw unavailable(); }
  };
  const optionalAuthority = (): boolean => {
    if (closed) throw unavailable();
    if (!authority) return false;
    assertAuthority(); return true;
  };
  const getStore = (): SqliteTriageStore => store ??= new SqliteTriageStore(ctx.workingDirectory, fileName);
  let source: OwnedInboxSource;
  try {
    source = createOwnedInboxSource(ctx, { ...options, adapters: new Map(options.adapters), storeFileName: `inbox-owned-${scope}.sqlite`,
      ...(gatePolling ? { gatePolling: (provider: string, control: Parameters<NonNullable<RegisterInboxSurfaceOptions['gatePolling']>>[1]) => {
        const retire = gatePolling(provider, control);
        if (typeof retire !== 'function') return;
        return () => {
          const result = retire();
          if (result !== undefined && (result === closing || result === enclosingClosing?.())) {
            throw new Error('Inbox gate cleanup cannot await its own triage close');
          }
          return result;
        };
      } } : {}),
      async enrichTriage(rows) {
        const out = new Map<string, InboxTriageOverlay>();
        if (!optionalAuthority() || !rows.length) return out;
        for (let offset = 0; offset < rows.length; offset += 100) {
          assertAuthority();
          const batch = inputs(rows.slice(offset, offset + 100));
          // Input/privacy rejection is not an optional database failure.
          captureTriageInputs(batch);
          try {
            const evidence = await readTriageMetadataBatch(batch, getStore());
            for (const [id, row] of evidence) out.set(id, { triageScore: row.score, triageLabel: row.label, triageTags: row.tags });
          } catch {
            assertAuthority();
            try { ctx.logger.warn('Inbox triage metadata unavailable'); } catch { /* fixed diagnostic only */ }
            // A corrupt optional image cannot leave a partially enriched page.
            out.clear(); return out;
          }
          assertAuthority();
        }
        return out;
      },
    });
  } catch (error) { releaseLock(); throw error; }
  const score: OwnedTriagedInboxSource['runInboxTriage'] = (query = {}, operation = {}) => {
    if (closed) return Promise.reject(unavailable());
    // Normalize and capture before admission; no later caller mutation is observed.
    let selected: ReturnType<typeof normalizeInboxQuery>;
    try {
      selected = normalizeInboxQuery(query);
      if (selected.limit > 100) throw new TypeError('Explicit inbox triage is limited to 100 selected rows');
      if (selected.providers?.some(provider => provider !== providerId)) throw unavailable();
      selected = { ...selected, providers: [providerId] };
    } catch (error) { return Promise.reject(error); }
    const dryRun = operation.dryRun === true;
    const signals = [owner.signal, ...(authoritySignal ? [authoritySignal] : []), ...(operation.signal ? [operation.signal] : [])];
    const signal = AbortSignal.any(signals);
    const work = scoreTail.then(async (): Promise<OwnedInboxTriageResult> => {
      assertAuthority(); signal.throwIfAborted();
      const read = await source.acquireRead(true);
      try {
        assertAuthority(); signal.throwIfAborted();
        const page = aggregateInbox(read.sources, selected);
        const batch = inputs(page.items);
        const captured = captureTriageInputs(batch);
        const expected = JSON.stringify(captured.map(triageBinding));
        const assertCurrent = (): void => {
          signal.throwIfAborted(); assertAuthority(); read.assertCurrent();
          const current = inputs(aggregateInbox(read.sources, selected).items);
          if (JSON.stringify(captureTriageInputs(current).map(triageBinding)) !== expected) {
            throw new HandlerError('Inbox triage selection changed', 'INBOX_TRIAGE_SELECTION_CHANGED', 409);
          }
        };
        assertCurrent();
        // Recheck at the actual outbound call, rather than only before fan-out.
        const guardedPort: JudgmentPort = { model: TRIAGE_MODEL, async ask(request) { assertCurrent(); return port!.ask({ ...request, beforeAttempt: assertCurrent }); } };
        const receipts = await runInboxTriage(batch, { port: guardedPort, signal, dryRun,
          // This seam is not caller-injectable. The canonical store enforces the
          // exact proof immediately before rename, with no intervening await.
          store: { readBatch: ids => getStore().readBatch(ids), close: async () => {},
            commit: (rows, abort) => getStore().commit(rows, abort, assertCurrent) },
        });
        await read.validate(); assertCurrent();
        return { receipts, total: page.total, hasMore: page.hasMore, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      } finally { read.release(); }
    });
    scoreTail = work.catch(() => {});
    active.add(work); void work.then(() => active.delete(work), () => active.delete(work)); return work;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closing.catch(() => {});
    owner.abort();
    const retiring = source.close();
    void (async () => {
      const outcomes = await Promise.allSettled([retiring, ...active]);
      // Scoring refusals are operation outcomes, not failed retirement.
      await store?.close();
      if (outcomes[0]?.status === 'rejected') throw new Error('Triaged inbox source did not retire');
      releaseLock();
    })().then(resolve, reject);
    return closing;
  };
  return { ...source, runInboxTriage: score, close, unregister() { void close(); },
    async acquireRead(_requireFinalProof = true) {
      const read = await source.acquireRead(true);
      const assertCurrent = (): void => { read.assertCurrent(); optionalAuthority(); };
      try { assertCurrent(); } catch (error) { read.release(); throw error; }
      return { ...read, assertCurrent, async validate() { await read.validate(); assertCurrent(); } };
    },
  };
}

/** Compatibility-shaped registrar; adds no catalog methods, tagger or activation. */
export async function registerTriagedInbox(ctx: InboxSurfaceContext, options: OwnedTriagedInboxOptions): Promise<OwnedTriagedInboxSource> {
  let closing: Promise<void> | undefined;
  const source = await createTriagedSource(ctx, options, () => closing);
  let binding: ReturnType<typeof registerCompositeInboxSurface>;
  try { binding = registerCompositeInboxSurface(ctx, [source]); }
  catch (error) { await source.close(); throw error; }
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closing.catch(() => {});
    void Promise.allSettled([binding.close(), source.close()]).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) reject(new AggregateError(failures.map(result => result.reason), 'Triaged inbox did not retire'));
      else resolve();
    });
    return closing;
  };
  return { ...source, ready: Promise.all([source.ready, binding.ready]).then(() => {}), close, unregister() { void close(); } };
}
