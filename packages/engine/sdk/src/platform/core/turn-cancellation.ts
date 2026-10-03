/** A cancellation request is acceptance, never proof of turn settlement. */
export interface TurnCancellationResult {
  readonly status: 'cancellation-requested' | 'already-ended' | 'stale-turn' | 'turn-not-found';
  readonly activeTurnId?: string;
}

/** Process-local identity fence; bounded history is diagnostic, not durable truth. */
export class TurnCancellationFence {
  private active: { id: string; abort: () => void; requested: boolean } | null = null;
  private readonly ended = new Set<string>();

  begin(id: string, abort: () => void): void {
    this.active = { id, abort, requested: false };
  }

  end(id: string): void {
    if (this.active?.id !== id) return;
    this.active = null;
    this.ended.add(id);
    if (this.ended.size > 128) this.ended.delete(this.ended.values().next().value!);
  }

  cancel(expectedTurnId: string): TurnCancellationResult {
    const active = this.active;
    if (active?.id === expectedTurnId) {
      // Publish acceptance before invoking synchronous abort listeners, which
      // may themselves issue a duplicate request. Never await between check
      // and abort, and never retain a request to apply to a subsequent turn.
      if (!active.requested) {
        active.requested = true;
        active.abort();
      }
      return { status: 'cancellation-requested', activeTurnId: active.id };
    }
    if (this.ended.has(expectedTurnId)) return { status: 'already-ended', ...(active ? { activeTurnId: active.id } : {}) };
    return active ? { status: 'stale-turn', activeTurnId: active.id } : { status: 'turn-not-found' };
  }
}

/** Preserve the existing event while allowing an owning turn to defer publication. */
export function publishTurnTerminal(publish: () => void, defer?: ((publish: () => void) => void) | undefined): void {
  if (defer) defer(publish);
  else publish();
}
