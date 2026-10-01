/**
 * relay-stream-overflow.ts, honest accounting of live events dropped over the relay tunnel.
 *
 * When the webui is connected to the daemon over the relay, live event streams are tunnelled
 * through the relay's bounded send buffer (see the SDK's relay-transport). If that buffer
 * overflows, the daemon does NOT silently drop frames, it emits an honest `relay-overflow`
 * SSE event carrying the count of chunks dropped since the last notice. Every stream consumer
 * (session updates, control-plane invalidation, chat turns) routes that event here.
 *
 * This tiny module-level store accumulates the dropped count and notifies React subscribers,
 * so the UI can show a persistent, non-dismissing-until-resolved notice: "live events were
 * dropped, the view may be stale, resync". A resync (refetching every query) is the honest
 * recovery: the missed events were only ever invalidation triggers, so a full refetch restores
 * the true state. acknowledgeRelayOverflow() clears the notice once the operator resyncs.
 */

/** The SSE event name the relay transport emits on a tunnel send-buffer overflow. */
export const RELAY_OVERFLOW_EVENT = 'relay-overflow';

export interface RelayOverflowSnapshot {
  /** Total live events dropped over the relay since the last acknowledge. */
  readonly totalDropped: number;
  /** Epoch ms of the most recent overflow notice, or 0 when none is outstanding. */
  readonly lastAt: number;
  /** Bumped on every change so useSyncExternalStore sees a fresh reference. */
  readonly epoch: number;
}

let snapshot: RelayOverflowSnapshot = { totalDropped: 0, lastAt: 0, epoch: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Parse the `dropped` count from a relay-overflow SSE payload (`{ dropped: N }`). */
export function readDroppedCount(payload: unknown): number {
  if (payload && typeof payload === 'object' && 'dropped' in payload) {
    const value = (payload as { dropped: unknown }).dropped;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/** Record an overflow notice. A non-positive count still bumps the notice (events were dropped). */
export function noteRelayOverflow(dropped: number): void {
  const add = Number.isFinite(dropped) && dropped > 0 ? Math.floor(dropped) : 0;
  snapshot = {
    totalDropped: snapshot.totalDropped + add,
    lastAt: Date.now(),
    epoch: snapshot.epoch + 1,
  };
  emit();
}

/** Clear the outstanding overflow notice (call after a successful resync). */
export function acknowledgeRelayOverflow(): void {
  if (snapshot.totalDropped === 0 && snapshot.lastAt === 0) return;
  snapshot = { totalDropped: 0, lastAt: 0, epoch: snapshot.epoch + 1 };
  emit();
}

export function subscribeRelayOverflow(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRelayOverflowSnapshot(): RelayOverflowSnapshot {
  return snapshot;
}
