/**
 * WakeBanner, the `voice.wake.indicator: "banner"` marker.
 *
 * The more prominent of the two indicators: a persistent strip across the top of
 * the shell while wake detection runs. There was no banner component for this, and
 * a transient toast was deliberately NOT reused, a toast dismisses itself, and an
 * indicator that disappears while the microphone is still open is the exact failure
 * the indicator row exists to prevent. So this is its own small persistent element,
 * following RelayOverflowBanner's `.banner` shape.
 *
 * Renders nothing when the indicator row is 'statusline' or 'off', or when wake
 * detection was never enabled in this browser.
 */
import { Ear, MicOff } from 'lucide-react';
import { useWakeState } from '../../lib/voice/useWake';
import { wakeIndicatorCopy, wakeIndicatorVisible } from './wake-indicator';
import '../../styles/components/voice.css';

export function WakeBanner() {
  const state = useWakeState();
  if (!wakeIndicatorVisible(state) || state.indicator !== 'banner') return null;

  const copy = wakeIndicatorCopy(state);
  const tone = copy.live ? 'info' : copy.attention ? 'warning' : 'info';

  return (
    <div
      className={`banner ${tone} wake-banner${copy.live ? ' is-live' : ''}`}
      role="status"
      data-testid="wake-banner"
      data-wake-phase={state.phase}
    >
      {copy.live
        ? <Ear size={16} aria-hidden="true" />
        : <MicOff size={16} aria-hidden="true" />}
      <span className="wake-banner__label">{copy.label}</span>
      <span className="wake-banner__detail">{copy.detail}</span>
    </div>
  );
}
