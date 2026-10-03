/**
 * voice-capture-chip.ts, the live-microphone chip at the left end of the status line.
 *
 * A capture device held open with nothing on screen saying so is the one
 * state a voice feature must never be in, so the chip is never dropped for
 * lack of room. It is short on purpose; the full wording (device, restart
 * delay, latch reason) is voiceCaptureDescription's, shown by /voice status.
 */

import type { StatusChip } from './status-line.ts';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { GLYPHS } from './ui-primitives.ts';
import { activeTokens, activeUiTones } from './theme.ts';

const VOICE_CHIP_LABELS: Record<VoiceCaptureIndicatorState['kind'], string> = {
  'wake-listening': 'mic listening',
  'wake-capturing': 'mic recording',
  'wake-restarting': 'mic restarting',
  'wake-latched': 'wake stopped',
  'wake-starting': 'mic opening',
  'wake-no-audio': 'mic silent',
  'wake-no-microphone': 'no microphone',
};

const VOICE_CAPTURE_DESCRIPTIONS: Record<VoiceCaptureIndicatorState['kind'], string> = {
  'wake-listening': 'listening for the wake phrase',
  'wake-capturing': 'wake heard, recording what follows',
  'wake-restarting': 'capture stream ended, restarting',
  'wake-latched': 'wake detection stopped',
  'wake-starting': 'opening the microphone, not listening yet',
  'wake-no-audio': 'microphone open, but no audio is arriving',
  'wake-no-microphone': 'no microphone on this machine, nothing is listening',
};

/** The full wording for /status: state, device and any detail (a restart delay, a latch reason). */
export function voiceCaptureDescription(state: VoiceCaptureIndicatorState): string {
  const parts = [VOICE_CAPTURE_DESCRIPTIONS[state.kind]];
  if (state.deviceLabel !== null) parts.push(state.deviceLabel);
  if (state.detail !== undefined && state.detail.length > 0) parts.push(state.detail);
  return parts.join(' · ');
}

export function voiceCaptureChip(state: VoiceCaptureIndicatorState): StatusChip {
  const tones = activeUiTones();
  const marker = state.kind === 'wake-latched' ? GLYPHS.status.blocked : GLYPHS.status.active;
  const warn = state.kind === 'wake-latched' || state.kind === 'wake-restarting' || state.kind === 'wake-no-audio' || state.kind === 'wake-no-microphone';
  const fg = warn ? tones.chrome.warn : tones.accent.control;
  const text = `${marker} ${VOICE_CHIP_LABELS[state.kind]}`;
  // voice.wake.indicator: banner draws the wake chip filled, statusline plain.
  if (state.kind.startsWith('wake-') && state.indicator === 'banner') {
    return { text: ` ${text} `, fg: activeTokens().backgroundElement, bg: fg, bold: true, keep: true };
  }
  return { text, fg, bold: true, keep: true };
}
