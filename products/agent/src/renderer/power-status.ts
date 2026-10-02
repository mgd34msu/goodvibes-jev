import type { PowerState } from '@goodvibes-jev/engine/sdk/platform/power';

/**
 * The composer power chip (see shell-surface.ts): it renders on the
 * composer's inner row beside the auto-approve warning, each its own chip
 * that is never dropped for lack of room, since both are safety-relevant and
 * must stay visible at once. Priority order for WHICH power note text to show: the owner
 * keep-awake toggle first (an ALWAYS-ON override the user set explicitly, and
 * per the SDK's own PowerManager doc comment the chip, not a timer, is the
 * safety mechanism while it's on), then the automatic work-hold ("held
 * because X"), real state names, never invented. Returns null when neither
 * applies (nothing to show).
 */
export function describePowerStatus(state: Pick<PowerState, 'work' | 'keepAwake'>): string | null {
  if (state.keepAwake.enabled) {
    const base = 'sleep disabled';
    return state.keepAwake.note ? `${base}, ${state.keepAwake.note}` : `${base} (keep-awake)`;
  }
  if (state.work.held && state.work.reasons.length > 0) {
    return `held: ${state.work.reasons.join('; ')}`;
  }
  return null;
}
