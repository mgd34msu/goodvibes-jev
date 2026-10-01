/**
 * Pure builder for the "setup not finished" hint shown once at startup
 * when the user has started but not completed onboarding.
 *
 * No side effects, no imports from the runtime or shell, testable in isolation.
 */

import type { OnboardingState } from '../runtime/onboarding/onboarding-state.ts';

export interface SetupIncompleteHintResult {
  readonly lines: string[];
}

/**
 * Build a plain-language hint reminding the user that setup isn't finished
 * and pointing them at /agent.
 *
 * Returns null when:
 * - phase === 'complete' , setup is done, no nag needed
 * - phase === 'fresh'    , first-run users get the full workspace, not a nag
 *
 * Only phase === 'in-progress' produces a hint (the user has opened /agent
 * at least once but hasn't finished).
 *
 * @param state     The current OnboardingState (from deriveOnboardingState).
 * @param hostReady True = assistant service is reachable; false = not yet running;
 *                  null/undefined = unknown (omit the host line entirely).
 */
export function buildSetupIncompleteHint(
  state: OnboardingState,
  hostReady?: boolean | null,
): SetupIncompleteHintResult | null {
  if (state.phase !== 'in-progress') return null;

  const lines: string[] = [];

  // ── Line 1: readiness / chat availability ────────────────────────────────
  if (!state.readyToChat) {
    // Model not configured, that's the most urgent thing.
    lines.push('Pick a model to start, run /agent to continue setup.');
  } else {
    // Chat works but setup isn't done.
    // NOTE: progressLabel is intentionally omitted here, the hint's plan may be
    // a reduced subset of the full setup plan, so any 'N of M' count would
    // misrepresent real progress and mislead the user.
    const nextStep = pickNextStep(state);
    if (nextStep) {
      lines.push(
        `You can chat now. Still finishing setup, ${nextStep}, run /agent to complete it.`,
      );
    } else {
      lines.push(
        'You can chat now. Some background features still need setup, run /agent to finish.',
      );
    }
  }

  // ── Line 2 (optional): assistant service / background work status ─────────
  // Only append when the caller has a reliable live signal. Never fabricate.
  if (hostReady === true) {
    lines.push('Background work (reminders, schedules) is active.');
  } else if (hostReady === false) {
    lines.push('Background work (reminders, schedules) is not running yet.');
  }
  // hostReady === null or undefined → omit line entirely.

  return { lines };
}

/**
 * Pick the single most actionable next-step phrase from the state.
 * Prefers the first autonomy-blocking step, then the first non-ready step.
 * Returns undefined when no useful step hint is available.
 */
function pickNextStep(state: OnboardingState): string | undefined {
  const step =
    state.blockers[0] ??
    state.steps.find((s) => s.status !== 'ready');

  if (!step) return undefined;

  // Use the step's nextLabel if it reads like plain language (no slash syntax).
  // Fall back to the step's label.
  const label = step.nextLabel && !step.nextLabel.startsWith('/') && !step.nextLabel.includes('action:')
    ? step.nextLabel
    : step.label;

  // Truncate to keep the hint compact (max ~60 chars for the next-step phrase).
  return label.length > 60 ? `${label.slice(0, 58)}…` : label;
}
