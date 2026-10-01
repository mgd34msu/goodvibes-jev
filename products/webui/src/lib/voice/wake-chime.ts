/**
 * wake-chime.ts, the sound a confirmed wake makes.
 *
 * Audible confirmation is how a user knows the microphone acted; a silent wake is
 * the behaviour people distrust, which is why `voice.wake.activationSound`
 * defaults to "chime" rather than "none". A tab cannot read
 * `voice.wake.activationSoundPath` off the user's disk, so the settings resolver
 * has already downgraded a "custom" choice to "chime" and recorded that as a
 * limitation, this module only ever plays the built-in one.
 *
 * Synthesised with two short oscillator notes rather than shipped as an audio
 * asset: it is 200 ms of two sine tones, and a bundled file would be a network
 * fetch in front of the one piece of feedback that has to be immediate.
 */

/** The two notes, in Hz, and the shape of each. A rising pair reads as "listening". */
const CHIME_NOTES: readonly { readonly hz: number; readonly startsAt: number; readonly lastsFor: number }[] = [
  { hz: 660, startsAt: 0, lastsFor: 0.09 },
  { hz: 990, startsAt: 0.085, lastsFor: 0.12 },
];

const PEAK_GAIN = 0.14;

/** The minimum of Web Audio this module drives, so a test needs no real context. */
export interface ChimeAudioContext {
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): {
    type: string;
    frequency: { value: number };
    connect(destination: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): {
    gain: {
      value: number;
      setValueAtTime?(value: number, when: number): void;
      linearRampToValueAtTime?(value: number, when: number): void;
    };
    connect(destination: unknown): unknown;
  };
  resume?(): Promise<void>;
  close?(): Promise<void>;
}

export type ChimeContextFactory = () => ChimeAudioContext | undefined;

/** The browser's AudioContext, or undefined where Web Audio is unavailable. */
export function browserChimeContext(): ChimeAudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    AudioContext?: new () => ChimeAudioContext;
    webkitAudioContext?: new () => ChimeAudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return undefined;
  try {
    return new Ctor();
  } catch {
    return undefined;
  }
}

/**
 * Play the activation chime. Returns true when it was actually scheduled, so the
 * wake host can report "no sound available here" instead of assuming one played.
 *
 * A fresh context per chime, closed on the way out: holding one open for the life
 * of the tab keeps an audio device warm for a sound that plays for a fifth of a
 * second, and a tab that has never had a user gesture cannot resume a stale one
 * anyway.
 */
export function playWakeChime(createContext: ChimeContextFactory = browserChimeContext): boolean {
  const context = createContext();
  if (!context) return false;
  try {
    void context.resume?.();
    const startedAt = context.currentTime;
    let endsAt = startedAt;
    for (const note of CHIME_NOTES) {
      const gain = context.createGain();
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.hz;
      const noteStart = startedAt + note.startsAt;
      const noteEnd = noteStart + note.lastsFor;
      // A ramped envelope, because an abrupt oscillator start and stop is an
      // audible click on top of the note.
      if (gain.gain.setValueAtTime && gain.gain.linearRampToValueAtTime) {
        gain.gain.setValueAtTime(0, noteStart);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN, noteStart + 0.012);
        gain.gain.linearRampToValueAtTime(0, noteEnd);
      } else {
        gain.gain.value = PEAK_GAIN;
      }
      gain.connect(context.destination);
      oscillator.connect(gain);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd);
      endsAt = Math.max(endsAt, noteEnd);
    }
    const closeAfterMs = Math.max(0, (endsAt - startedAt) * 1000) + 250;
    setTimeout(() => {
      void context.close?.();
    }, closeAfterMs);
    return true;
  } catch {
    return false;
  }
}
