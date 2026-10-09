/** One owned schedule submission. Escape/session changes/shutdown revoke it. */
export class ScheduleReadingLifetime {
  private active: { key: string; controller: AbortController } | undefined;
  private disposed = false;
  constructor(private readonly sessionId: () => string, private readonly isActive: () => boolean) {}

  begin(key: string) {
    if (this.disposed || !this.isActive() || this.active?.key === key) return undefined;
    this.cancel();
    const active = { key, controller: new AbortController() };
    const sessionId = this.sessionId();
    this.active = active;
    const current = () => {
      if (this.active !== active || this.disposed || !this.isActive() || this.sessionId() !== sessionId) active.controller.abort();
      return !active.controller.signal.aborted;
    };
    return {
      signal: active.controller.signal,
      current,
      assertCurrent: () => { current(); active.controller.signal.throwIfAborted(); },
      finish: () => { if (this.active === active) this.active = undefined; },
    };
  }

  cancel(): boolean {
    const active = this.active;
    this.active = undefined;
    active?.controller.abort();
    return active !== undefined;
  }

  /** Compose with the existing key action without changing its recovery/SDK abort semantics. */
  withCancellation(cancelTurn: () => boolean): () => boolean {
    return () => { const cancelled = this.cancel(); return cancelTurn() || cancelled; };
  }

  dispose(): void { this.disposed = true; this.cancel(); }
}
