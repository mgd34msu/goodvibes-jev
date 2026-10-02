/**
 * paste-flood-guard.ts unit tests. The module is UI-framework-agnostic (a pure
 * sliding-window rate guard); these tests exercise trackPasteFloodGuard
 * directly, independent of dispatch wiring (feedInputTokens wires it, see
 * handler-feed-paste-flood.test.ts for that integration-level coverage).
 */
import { describe, expect, test } from 'bun:test';
import {
  PASTE_FLOOD_THRESHOLD,
  PASTE_FLOOD_WINDOW_MS,
  trackPasteFloodGuard,
  type PasteBurstGuardState,
} from '../../input/paste-flood-guard.ts';

function freshGuard(): PasteBurstGuardState {
  return { timestamps: [], suspended: false, hintShown: false };
}

describe('trackPasteFloodGuard', () => {
  test('a burst of more than 8 qualifying tokens inside the window trips suspension exactly once', () => {
    const guard = freshGuard();
    const t0 = 1_000_000;
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(trackPasteFloodGuard(guard, t0 + i));
    }
    const dispatchedCount = results.filter((r) => r.dispatch).length;
    const hintCount = results.filter((r) => r.showHintNow).length;
    expect(dispatchedCount).toBe(PASTE_FLOOD_THRESHOLD);
    expect(hintCount).toBe(1); // one-shot hint, not re-shown for the remaining suppressed tokens
    expect(guard.suspended).toBe(true);
  });

  test('6 rapid tokens under the threshold all dispatch: human typing is unaffected', () => {
    const guard = freshGuard();
    const t0 = 2_000_000;
    for (let i = 0; i < 6; i++) {
      const result = trackPasteFloodGuard(guard, t0 + i);
      expect(result.dispatch).toBe(true);
      expect(result.showHintNow).toBe(false);
    }
    expect(guard.suspended).toBe(false);
  });

  test('suspension is sticky (does not flap) but lifts after a genuine quiet gap, re-arming the one-shot hint for a later burst', () => {
    const guard = freshGuard();
    const t0 = 3_000_000;
    // Trip the guard: 12 calls 1ms apart (trips at the 9th). Last timestamp lands at t0+11.
    for (let i = 0; i < 12; i++) trackPasteFloodGuard(guard, t0 + i);
    expect(guard.suspended).toBe(true);

    // Still within the window (5ms after the last token), stays suspended, no new hint.
    const lastBurstAt = t0 + 11;
    const stillFlooding = trackPasteFloodGuard(guard, lastBurstAt + 5);
    expect(stillFlooding.dispatch).toBe(false);
    expect(stillFlooding.showHintNow).toBe(false);

    // A silence strictly greater than PASTE_FLOOD_WINDOW_MS since THIS call
    // (lastBurstAt + 5) clears suspension.
    const quietGapStart = lastBurstAt + 5;
    const afterQuietGap = trackPasteFloodGuard(guard, quietGapStart + PASTE_FLOOD_WINDOW_MS + 1);
    expect(afterQuietGap.dispatch).toBe(true);
    expect(guard.suspended).toBe(false);

    // A later burst re-trips and shows its own one-shot hint again.
    const laterBurstStart = quietGapStart + PASTE_FLOOD_WINDOW_MS + 1;
    let laterHintCount = 0;
    for (let i = 1; i <= 12; i++) {
      const r = trackPasteFloodGuard(guard, laterBurstStart + i);
      if (r.showHintNow) laterHintCount++;
    }
    expect(laterHintCount).toBe(1);
  });
});
