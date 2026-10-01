/**
 * wake-indicator.ts, the words the wake indicator shows, in one place.
 *
 * The statusline chip and the banner are two presentations of the SAME state, so
 * the label and the explanation live here rather than being written twice and
 * drifting. Every string is either about a microphone that IS open (so it must be
 * unmistakable) or a stated reason one is not, never a vague "unavailable".
 */
import type { WakeHostState } from '../../lib/voice/wake-host';

export interface WakeIndicatorCopy {
  /** Short label for a chip. */
  readonly label: string;
  /** The full explanation, for a title/tooltip and for the banner body. */
  readonly detail: string;
  /** True while the microphone is genuinely open. Drives the live styling. */
  readonly live: boolean;
  /** True when this state is a problem the user should act on. */
  readonly attention: boolean;
}

/**
 * True when the state should be shown at all. `indicator: 'off'` removes the
 * marker entirely (the row says so in writing), and a tab where wake detection was
 * never enabled has nothing to show.
 */
export function wakeIndicatorVisible(state: WakeHostState): boolean {
  return state.indicator !== 'off' && state.phase !== 'off';
}

export function wakeIndicatorCopy(state: WakeHostState): WakeIndicatorCopy {
  const device = state.deviceLabel ? ` Device: ${state.deviceLabel}.` : '';
  switch (state.phase) {
    case 'listening':
      return {
        label: 'Listening for wake word',
        detail: `The microphone is open in this tab and every frame is being scored for the wake phrase.${device}`,
        live: true,
        attention: false,
      };
    case 'capturing':
      return {
        label: 'Wake heard: recording',
        detail: `A wake was confirmed and the microphone is recording what follows.${device}`,
        live: true,
        attention: false,
      };
    case 'transcribing':
      return {
        label: 'Transcribing what you said',
        detail: 'The utterance after the wake word is at speech-to-text.',
        live: true,
        attention: false,
      };
    case 'loading':
      return {
        label: 'Preparing wake word',
        detail: 'Fetching and verifying the pinned wake-word models, then bringing the inference runtime up. '
          + 'The microphone is not open yet.',
        live: false,
        attention: false,
      };
    case 'restarting':
      return {
        label: 'Wake detection restarting',
        detail: state.error
          ? `Capture stopped and is being restarted: ${state.error}`
          : 'Capture stopped and is being restarted.',
        live: false,
        attention: true,
      };
    case 'latched':
      return {
        label: 'Wake detection stopped',
        detail: state.refusal?.detail
          ?? state.error
          ?? 'Wake detection stopped and will not restart on its own. Turn it off and on again to retry.',
        live: false,
        attention: true,
      };
    case 'suspended':
      return {
        label: 'Wake paused for dictation',
        detail: 'Dictation is holding the microphone. Wake detection resumes when it finishes.',
        live: true,
        attention: false,
      };
    case 'refused':
      return {
        label: 'Wake detection not running',
        detail: state.refusal?.detail ?? state.error ?? 'Wake detection is not running here.',
        live: false,
        attention: true,
      };
    case 'off':
      return {
        label: 'Wake detection off',
        detail: 'Wake detection is not enabled in this browser.',
        live: false,
        attention: false,
      };
  }
}
