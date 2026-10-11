import { getOperatorContract } from '@goodvibes-jev/engine/contracts';
import { firstJsonSchemaFailureAsync } from '@goodvibes-jev/engine/transport-http';
import type { WorkLedgerReadEvent } from './types.js';
import type { WorkLedgerReadClient, WorkLedgerReadSnapshot } from './read-client.js';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';

interface HistoryPage {
  readonly projectId: string;
  readonly afterSequence: number;
  readonly cursor: number;
  readonly throughSequence: number;
  readonly hasMore: boolean;
  readonly provenance?: 'available' | 'requires_read_knowledge';
  readonly events: readonly WorkLedgerReadEvent[];
}
const MAX_PAGE_BYTES = 1_048_576;
const MAX_HISTORY_BYTES = 8 * MAX_PAGE_BYTES;
const MAX_HISTORY_EVENTS = 10_000;
const MAX_PAGE_EVENTS = 100;

export interface OperatorWorkLedgerReadOptions {
  /** Best-effort authenticated observation; no event-stream scope is needed. */
  readonly pollIntervalMs?: number;
  /** Bound a stalled read without changing or replacing the operator transport. */
  readonly requestTimeoutMs?: number;
  /** Observation failures; a later successful explicit read may recover. */
  readonly onUnavailable?: (error: Error) => void;
}
function error(message: string): Error { return new Error(`Native work ledger: ${message}`); }
function validCursor(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function notifyObserver(callback: () => unknown): void {
  try {
    const returned: unknown = callback();
    void Promise.resolve(returned).catch(() => {});
  } catch { /* Observers, including hostile thenables, cannot affect reads. */ }
}
function statusOf(value: unknown): number | undefined {
  try {
    const status: unknown = value !== null && typeof value === 'object' && 'status' in value ? value.status : undefined;
    return typeof status === 'number' ? status : undefined;
  } catch { return undefined; }
}

/** Reuses the selected operator client's existing authenticated transport. Opens no store. */
export function createOperatorWorkLedgerReadClient(
  client: Pick<OperatorRemoteClient, 'invoke'>,
  projectId: string,
  options: OperatorWorkLedgerReadOptions = {},
): WorkLedgerReadClient {
  if (!projectId || projectId.length > 200) throw error('invalid project identity');
  const interval = options.pollIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000) throw error('invalid polling interval');
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw error('invalid read timeout');
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollController: AbortController | undefined;
  let generation = 0;
  let failures = 0;
  let observedCursor = -1;
  let requestSequence = 0;
  let projectionSequence = 0;
  let projection: 'available' | 'requires_read_knowledge' = 'requires_read_knowledge';
  let lastSnapshot: WorkLedgerReadSnapshot | undefined;
  function observeProjection(value: WorkLedgerReadSnapshot | HistoryPage, sequence: number): void {
    const next = value.provenance ?? 'requires_read_knowledge';
    // A restriction is authoritative even when its request started earlier but
    // was evaluated later. Fence every already-launched upgrade, not only the
    // request that happened to reveal the downgrade.
    if (next === 'available' && (sequence < projectionSequence || (projection !== 'available' && sequence <= projectionSequence))) return;
    projectionSequence = next === 'requires_read_knowledge' ? Math.max(projectionSequence, requestSequence) : sequence;
    const changed = next !== projection;
    projection = next;
    if (changed && lastSnapshot) {
      lastSnapshot = { ...lastSnapshot, provenance: projection };
      for (const listener of [...listeners.values()]) {
        if (disposed) break;
        notifyObserver(() => listener(structuredClone(lastSnapshot!)));
      }
    }
  }
  function protect(events: readonly WorkLedgerReadEvent[]): WorkLedgerReadEvent[] {
    return events.map(event => event.type === 'import_legacy' && projection !== 'available'
      ? { type: event.type, sequence: event.sequence, actorId: event.actorId, requestId: event.requestId, at: event.at,
        works: event.works, manifest: null, provenance: 'requires_read_knowledge' } : event);
  }
  const requests = new Set<AbortController>();
  const listeners = new Map<symbol, (snapshot: WorkLedgerReadSnapshot) => void>();
  function active(): void { if (disposed) throw error('reader is disposed'); }
  async function validate(method: string, value: unknown, signal: AbortSignal): Promise<void> {
    const schema = getOperatorContract().operator.methods.find(item => item.id === method)?.outputSchema;
    if (!schema || await firstJsonSchemaFailureAsync(schema, value, { signal, assertCurrent: active })) throw error('invalid read response');
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PAGE_BYTES) throw error('response exceeds the read limit');
  }
  async function invoke<T>(method: string, input: Record<string, unknown>, controller = new AbortController()): Promise<{ value: T; sequence: number }> {
    active();
    const sequence = ++requestSequence;
    if (requests.size >= 16) throw error('too many concurrent reads');
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    let cancel = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(error(disposed ? 'reader is disposed' : 'read was cancelled or timed out'));
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    try {
      const value = await Promise.race([client.invoke<T>(method, input, { signal: controller.signal }), cancelled]);
      active();
      if (controller.signal.aborted) throw error('read was cancelled');
      await validate(method, value, controller.signal);
      return { value, sequence };
    } finally {
      clearTimeout(timeout); controller.signal.removeEventListener('abort', cancel); requests.delete(controller);
    }
  }
  async function snapshot(controller?: AbortController): Promise<WorkLedgerReadSnapshot> {
    const { value, sequence } = await invoke<WorkLedgerReadSnapshot>('workLedger.snapshot', { projectId }, controller);
    active();
    if (value.projectId !== projectId || !validCursor(value.cursor) || value.revision !== value.cursor) throw error('host project or cursor mismatch');
    observeProjection(value, sequence);
    const projected = { ...value, provenance: projection };
    if (!lastSnapshot || value.cursor >= lastSnapshot.cursor) lastSnapshot = projected;
    return projected;
  }
  function stopObservation(): void {
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pollController?.abort(); pollController = undefined;
  }
  function schedule(delay: number, epoch: number): void {
    if (disposed || epoch !== generation || listeners.size === 0) return;
    timer = setTimeout(() => { timer = undefined; void poll(epoch); }, delay);
    timer.unref?.();
  }
  async function poll(epoch: number): Promise<void> {
    if (disposed || epoch !== generation || listeners.size === 0) return;
    const controller = new AbortController(); pollController = controller;
    let nextDelay = interval;
    try {
      const value = await snapshot(controller);
      if (disposed || epoch !== generation) return;
      if (value.cursor < observedCursor) throw error('host cursor regressed');
      failures = 0;
      if (value.cursor > observedCursor) {
        observedCursor = value.cursor;
        for (const listener of [...listeners.values()]) {
          if (disposed || epoch !== generation) break;
          notifyObserver(() => listener(structuredClone(value)));
        }
      }
    } catch (cause) {
      // Unsubscribe/dispose advance the observation epoch before aborting.
      // A request timeout aborts only this request and must report/retry.
      if (disposed || epoch !== generation) return;
      // Capture admission state before handing an error to an observer.
      const status = statusOf(cause);
      notifyObserver(() => options.onUnavailable?.(cause instanceof Error ? cause : error('read unavailable')));
      // Permanent admission failures need a new host/session binding; never keep an old grant alive.
      if (status === 401 || status === 403 || status === 404 || status === 410) { stopObservation(); return; }
      failures = Math.min(failures + 1, 6);
      nextDelay = Math.min(60_000, interval * 2 ** failures);
    } finally { if (pollController === controller) pollController = undefined; }
    schedule(nextDelay, epoch);
  }
  return {
    projectId,
    readSnapshot: () => snapshot(),
    async history(afterSequence) {
      active();
      if (!validCursor(afterSequence)) throw error('invalid history cursor');
      let current = afterSequence;
      let throughSequence: number | undefined;
      let bytes = 0;
      let pages = 0;
      const events: WorkLedgerReadEvent[] = [];
      do {
        if (++pages > 128) throw error('history catch-up exceeds the page limit; read a fresh snapshot');
        const { value: page, sequence } = await invoke<HistoryPage>('workLedger.history', {
          projectId, afterSequence: current, ...(throughSequence === undefined ? {} : { throughSequence }),
        });
        active();
        if (page.projectId !== projectId || page.afterSequence !== current
          || !validCursor(page.cursor) || !validCursor(page.throughSequence)
          || page.cursor < current || page.throughSequence < page.cursor
          || (throughSequence !== undefined && page.throughSequence !== throughSequence)
          || page.events.length > MAX_PAGE_EVENTS || page.hasMore !== (page.cursor < page.throughSequence)) throw error('invalid history page');
        observeProjection(page, sequence);
        throughSequence = page.throughSequence;
        for (const event of page.events) {
          if (event.sequence !== current + 1) throw error('history contains a cursor gap');
          current = event.sequence;
        }
        if (current !== page.cursor || (page.hasMore && page.events.length === 0)) throw error('history cursor did not advance');
        bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
        if (events.length + page.events.length > MAX_HISTORY_EVENTS || bytes > MAX_HISTORY_BYTES) {
          throw error('history catch-up exceeds the bounded read limit; read a fresh snapshot');
        }
        events.push(...page.events);
        if (!page.hasMore) return protect(events);
      } while (true);
    },
    subscribe(listener) {
      active();
      const subscription = Symbol();
      listeners.set(subscription, listener);
      if (listeners.size === 1) { observedCursor = -1; failures = 0; schedule(0, generation); }
      let attached = true;
      return () => {
        if (!attached) return; attached = false;
        listeners.delete(subscription);
        if (listeners.size === 0) stopObservation();
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true; stopObservation(); listeners.clear();
      for (const controller of requests) controller.abort();
      requests.clear();
    },
  };
}
