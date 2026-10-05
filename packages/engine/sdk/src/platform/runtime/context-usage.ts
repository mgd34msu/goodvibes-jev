/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * The single derivation of context-window usage from a token count and a
 * window size, so the in-process read model (ui-read-models-core.ts) and the
 * operator-wire verb (control-plane/routes/session-runtime.ts) can never drift
 * on how a percentage / remaining figure is computed.
 *
 * HONESTY: `usedTokens` is the runtime's current ESTIMATE, not a guaranteed
 * fresh preflight count. Callers that surface these values must
 * label them as estimates, this helper only does the arithmetic.
 */
export interface ContextUsageDerived {
  /** Context usage as a 0–100 percentage, or null when capacity is unknown. */
  readonly contextUsagePct: number | null;
  /** Tokens remaining before the window is full, or null when capacity is unknown. */
  readonly contextRemainingTokens: number | null;
}

export function deriveContextUsage(usedTokens: number, window: number | null): ContextUsageDerived {
  if (window === null || !Number.isFinite(window) || window <= 0) {
    return { contextUsagePct: null, contextRemainingTokens: null };
  }
  return {
    contextUsagePct: Math.min(100, Math.round((usedTokens / window) * 100)),
    contextRemainingTokens: Math.max(0, window - usedTokens),
  };
}
