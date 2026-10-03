/**
 * hosted-sessions.ts, the sessions THIS process is running, and whether one of
 * them is mid-turn.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Four call sites used to ask the persisting `SharedSessionBroker` a question
 * the agent could already answer about itself:
 *
 *   - inbound continuation dispatch: "which sessions should I poll for work?"
 *   - conversation rewind: "am I holding this session's conversation?"
 *   - the trigger family's `sessionIsLive`
 *   - memory consolidation and the periodic self-update: "is anything busy?"
 *
 * The broker answered them from a cross-surface register this process writes
 * into. As a client it does not own that register, the daemon does, and every
 * one of those questions is about THIS process. So they are answered from what
 * this process actually knows: the set of session ids it is running, and
 * whether a turn is in flight.
 *
 * ── Busy is turn-scoped, deliberately ─────────────────────────────────────
 *
 * `TURN_SUBMITTED` marks a session busy; `TURN_COMPLETED` / `TURN_ERROR` /
 * `TURN_CANCEL` mark it idle again. Those three terminal events are the same
 * set the SDK's own power work-signals use, so a cancelled or failed turn
 * releases the busy flag rather than pinning it until the next successful one.
 * A turn that never reports a terminal event would leave a session busy
 * forever, which errs toward "do not consolidate memory / do not restart the
 * binary", the safe direction for both consumers.
 */
import type { RuntimeEventBus, TurnEvent } from '@/runtime/index.ts';

export interface HostedSessionRegistry {
  /** Start counting this session id as hosted here. Idempotent. */
  adopt(sessionId: string): void;
  /** Stop counting it (session closed, or handed to another surface). Idempotent. */
  release(sessionId: string): void;
  /** The hosted set, for the inbound dispatch poller. */
  ids(): readonly string[];
  /** Whether this process is holding that session right now. */
  hosts(sessionId: string): boolean;
  /** How many hosted sessions have a turn in flight. */
  countBusySessions(): number;
  /** Stop listening to the runtime bus. Idempotent. */
  dispose(): void;
}

/** The narrow bus slice this registry subscribes to. */
type TurnBus = Pick<RuntimeEventBus, 'on'>;

/** The turn types that open and close a busy window. */
type TurnStart = Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>;
type TurnEnd = Extract<TurnEvent, { type: 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL' }>;

/**
 * Build the registry.
 *
 * `bus` is optional so a composition that has no runtime bus (a one-shot CLI
 * subcommand, a narrow test double) still gets a working hosted set, it simply
 * never reports anything busy, which is the honest answer for a process that
 * runs no turns.
 */
export function createHostedSessionRegistry(bus?: TurnBus | undefined): HostedSessionRegistry {
  const hosted = new Set<string>();
  const busy = new Set<string>();
  const unsubscribes: Array<() => void> = [];

  /**
   * The session a turn belongs to.
   *
   * The envelope carries the id when the emitter had one; a turn emitted before
   * the session id was final does not. In that case the turn belongs to
   * whichever session this process is holding, an agent process runs one
   * interactive session, so the single hosted id is used rather than the signal
   * being dropped.
   */
  const sessionForTurn = (envelopeSessionId: string | undefined): string | null => {
    if (typeof envelopeSessionId === 'string' && envelopeSessionId.length > 0) return envelopeSessionId;
    const only = hosted.size === 1 ? [...hosted][0] : undefined;
    return only ?? null;
  };

  if (bus) {
    unsubscribes.push(bus.on<TurnStart>('TURN_SUBMITTED', (envelope) => {
      const sessionId = sessionForTurn(envelope.sessionId);
      if (sessionId) busy.add(sessionId);
    }));
    for (const terminal of ['TURN_COMPLETED', 'TURN_ERROR', 'TURN_CANCEL'] as const) {
      unsubscribes.push(bus.on<TurnEnd>(terminal, (envelope) => {
        const sessionId = sessionForTurn(envelope.sessionId);
        if (sessionId) busy.delete(sessionId);
        // A terminal event this process could not attribute still ends A turn.
        // With nothing attributable left to end, clear the whole busy set
        // rather than leaving a stale id pinned busy for the process lifetime.
        else busy.clear();
      }));
    }
  }

  return {
    adopt(sessionId: string): void {
      if (sessionId) hosted.add(sessionId);
    },
    release(sessionId: string): void {
      hosted.delete(sessionId);
      busy.delete(sessionId);
    },
    ids(): readonly string[] {
      return [...hosted];
    },
    hosts(sessionId: string): boolean {
      return hosted.has(sessionId);
    },
    countBusySessions(): number {
      let count = 0;
      for (const sessionId of busy) if (hosted.has(sessionId)) count += 1;
      return count;
    },
    dispose(): void {
      while (unsubscribes.length > 0) {
        try {
          unsubscribes.pop()?.();
        } catch {
          // A bus already torn down is the normal shutdown ordering, not a fault.
        }
      }
    },
  };
}
