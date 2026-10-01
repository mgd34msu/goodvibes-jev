// ---------------------------------------------------------------------------
// paste-flood-guard.ts
//
// A terminal WITHOUT bracketed paste delivers a pasted block as a burst of
// discrete 1-char 'text' tokens (isPasteToken stays false for every one of
// them, since that flag only fires for a single token whose value.length > 1).
//
// Wiring: every token that isn't consumed by a modal route or a global
// shortcut lands in the composer/command dispatch chain
// (handleIndicatorFocusToken -> handlePromptTextToken -> handleCommandModeToken
// -> handlePromptKeyToken, see handler-feed.ts). The burst becomes
// command/keybinding dispatch, so the guard gates that same chain in
// feedInputTokens: see handler-feed.ts's per-token loop, which calls
// trackPasteFloodGuard for every non-paste 'text' token BEFORE those routes
// run, using a persistent PasteBurstGuardState carried on InputFeedContext
// (context.burstGuard, mirrors how pasteRegistry is threaded as a stable,
// never-reallocated field; see feed-context-factory.ts).
//
// This module's own logic is UI-framework-agnostic (a pure sliding-window
// rate guard); only its callers carry any wiring.
//
// This is a RATE guard: more than PASTE_FLOOD_THRESHOLD qualifying
// tokens within the trailing PASTE_FLOOD_WINDOW_MS, evaluated with a
// real sliding window (old timestamps age out of `timestamps` every call). It
// is deliberately NOT a per-feed char-SUM burst heuristic: that shape summed
// one feed()'s character count with no timing signal at all, so two ordinary
// keystrokes landing in a single feed() (a real, common case) could be
// misread as a burst. This guard:
//   - is keyed on WALL-CLOCK TIMING, not a per-feed token count, so it
//     doesn't care how many tokens land in one feed() call, only how fast
//     they arrive relative to each other;
//   - is sticky once tripped (only a quiet gap, no qualifying token for a
//     full window, clears it) so it doesn't flap dispatch on/off as the
//     count oscillates near the threshold mid-flood.
//
// ~8 keys/120ms is far beyond sustained human typing (a fast typist peaks
// well under that inter-key rate over any real span) but is exactly the
// shape an unbracketed paste replay takes.
// ---------------------------------------------------------------------------

export const PASTE_FLOOD_WINDOW_MS = 120;
export const PASTE_FLOOD_THRESHOLD = 8;

/**
 * Guard state, a single persistent instance lives on the caller's
 * long-lived context (this agent's handler-feed.ts InputFeedContext, mirroring
 * how that object already owns `nextPasteId`/`mouseDownRow`/etc.) and is
 * MUTATED IN PLACE by trackPasteFloodGuard below, never replaced, so
 * callers never need to thread a return value back into their own state.
 */
export interface PasteBurstGuardState {
  timestamps: readonly number[];
  suspended: boolean;
  hintShown: boolean;
}

export interface PasteBurstGuardResult {
  /** False while suspended, the caller must drop this token, not dispatch it. */
  readonly dispatch: boolean;
  /** True exactly once per burst: the call that just tripped suspension. */
  readonly showHintNow: boolean;
}

/** Advance `guard` (mutated in place) by one qualifying token at time `now` (ms). */
export function trackPasteFloodGuard(guard: PasteBurstGuardState, now: number): PasteBurstGuardResult {
  const lastAt = guard.timestamps.length > 0 ? guard.timestamps[guard.timestamps.length - 1]! : -Infinity;
  const isQuietGap = now - lastAt > PASTE_FLOOD_WINDOW_MS;
  if (isQuietGap && guard.suspended) {
    // A silence at least as long as the window means whatever burst was
    // happening has ended, un-suspend so a LATER burst gets its own fresh
    // count and its own one-shot hint.
    guard.suspended = false;
    guard.hintShown = false;
  }
  guard.timestamps = isQuietGap
    ? [now]
    : [...guard.timestamps.filter((t) => t > now - PASTE_FLOOD_WINDOW_MS), now];
  if (guard.timestamps.length > PASTE_FLOOD_THRESHOLD) {
    guard.suspended = true;
  }
  let showHintNow = false;
  if (guard.suspended && !guard.hintShown) {
    guard.hintShown = true;
    showHintNow = true;
  }
  return { dispatch: !guard.suspended, showHintNow };
}
