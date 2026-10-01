/**
 * WakeChip, the `voice.wake.indicator: "statusline"` marker.
 *
 * A persistent chip in the StatusStrip footer for as long as wake detection is
 * running, not a flash at the moment of a wake: an always-on microphone must never
 * be invisible, which is what that row's description promises and why 'off' is not
 * its default. Absent entirely when the indicator row is 'off' or wake detection
 * was never enabled in this browser, so it never pads the strip with a dead segment.
 *
 * Follows PowerChip's shape exactly, conditionally rendered, aria-label plus title
 * carrying the full reason, an icon beside a text label so colour is never the sole
 * signal, and it feeds the StatusStrip's single visually-hidden aria-live region
 * through that strip's own live text rather than announcing on its own, so a live
 * microphone is announced once instead of on every state tick.
 */
import { Ear, MicOff } from 'lucide-react';
import { useWakeState } from '../../lib/voice/useWake';
import { wakeIndicatorCopy, wakeIndicatorVisible } from './wake-indicator';

export function WakeChip() {
  const state = useWakeState();
  if (!wakeIndicatorVisible(state) || state.indicator !== 'statusline') return null;

  const copy = wakeIndicatorCopy(state);
  const modifier = copy.live ? 'live' : copy.attention ? 'attention' : 'idle';

  return (
    <div
      className={`status-strip__segment status-strip__segment--wake status-strip__segment--wake-${modifier}`}
      aria-label={`Wake word: ${copy.label}. ${copy.detail}`}
      title={copy.detail}
      data-testid="wake-chip"
      data-wake-phase={state.phase}
    >
      {copy.live
        ? <Ear className="status-strip__icon" aria-hidden="true" size={11} />
        : <MicOff className="status-strip__icon" aria-hidden="true" size={11} />}
      <span className="status-strip__label">{copy.label}</span>
    </div>
  );
}
