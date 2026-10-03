/**
 * voice-capture-status.ts, what the shell shows while the microphone is open.
 *
 * A capture indicator is not decoration. Wake detection holds a capture device
 * open for as long as the feature is on, and nothing else on this screen would
 * say so: a user who cannot tell whether their microphone is live has no way to
 * make that judgement from the outside. `voice.wake.indicator` governs how
 * prominent the row is, and `off` removes it, which is a choice the user makes,
 * not a default.
 *
 * Only the wake states exist here. This surface has no push-to-talk voice input
 * (no key opens a microphone on the Agent), so there is no "recording because
 * you pressed a key" state to model. The TUI has both, and its version of this
 * file carries both; inventing the missing half here would be a row that never
 * renders.
 *
 * The shape lives in core rather than in the renderer or in src/audio so both
 * can use it: the audio layer must not reach into shell UI, and the renderer
 * must not own capture state.
 */

/** What a voice-capture row is reporting. */
export type VoiceCaptureIndicatorKind =
  /** Wake detection is listening and scoring frames. */
  | 'wake-listening'
  /** A wake confirmed; the utterance that followed it is being captured. */
  | 'wake-capturing'
  /** The detector's stream died and a restart is scheduled. */
  | 'wake-restarting'
  /** The supervisor gave up; the detector is off until the feature is toggled. */
  | 'wake-latched'
  /**
   * Opening the device. NOT listening, and it used to render as if it were.
   *
   * `starting` was mapped straight onto the listening row, so a start that hung
   * showed "listening for the wake phrase" through an entire boot on a machine
   * with no capture stream at all. Its own state, with its own words.
   */
  | 'wake-starting'
  /** The device is open and no audio is coming through it. */
  | 'wake-no-audio'
  /** This host has no microphone, no input sources, or only output monitors. */
  | 'wake-no-microphone';

/** One live capture row. Absent (null) means no microphone is open and no row renders. */
export interface VoiceCaptureIndicatorState {
  readonly kind: VoiceCaptureIndicatorKind;
  /** What opened the device, e.g. `parecord`; null before anything is open. */
  readonly deviceLabel: string | null;
  /**
   * Prominence, from `voice.wake.indicator`. `off` suppresses the row entirely,
   * which is why it is not the shipped default.
   */
  readonly indicator: 'off' | 'statusline' | 'banner';
  /** Extra words for the row, a restart delay, a latch reason. */
  readonly detail?: string | undefined;
}

/** True when this state should produce a footer row at all. */
export function voiceCaptureRowVisible(state: VoiceCaptureIndicatorState | null): boolean {
  if (state === null) return false;
  return state.indicator !== 'off';
}
