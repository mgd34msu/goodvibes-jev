/**
 * mic-arbiter.ts, one device, two consumers, one policy for who holds it.
 *
 * Wake detection holds the microphone continuously for as long as the user has
 * it on. Push-to-talk dictation wants the same device, on a keypress, right now.
 * Without an arbiter both call `getUserMedia` and the tab ends up with two live
 * streams on one input: on some platforms the second open fails, on others it
 * succeeds and the two consumers fight over gain and device state. Either way
 * the user sees a microphone that "sometimes does not work".
 *
 * THE POLICY, stated once so it is not re-decided per call site:
 *
 *   Push-to-talk WINS, by suspending wake detection first.
 *
 * A deliberate press is the user asking for the microphone now, so dictation
 * takes it. The wake listener is stopped, really stopped, device released,
 * before the dictation stream is opened, and restarted when dictation finishes,
 * including when it fails. The alternative (dictation refusing while wake holds
 * the device) makes the headline affordance stop working the moment the always-on
 * feature is switched on, which is worse than a two-second gap in detection.
 *
 * Both consumers go through {@link MicArbiter.openCapture}, and it REFUSES a
 * second concurrent open with `device-unavailable` rather than allowing it. That
 * refusal is the invariant this file exists for: any future third consumer is
 * caught by it instead of quietly doubling the streams.
 */
import { AudioCaptureError } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import type {
  AudioCaptureHandlers,
  AudioCaptureOpener,
  AudioCaptureRequest,
  AudioCaptureStream,
} from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { createBrowserCaptureOpener } from './capture';

/** What the arbiter needs from the always-on consumer to stand it down. */
export interface WakeSuspendable {
  /** Stop listening and release the device. Must resolve once the device is free. */
  suspend(): Promise<void>;
  /** Start listening again. Failure to resume is the wake host's own state to report. */
  resume(): Promise<void>;
}

/** Released by the exclusive holder to hand the device back. Idempotent. */
export type MicLease = () => Promise<void>;

export class MicArbiter {
  readonly #opener: AudioCaptureOpener;
  #openStreams = 0;
  #wake: WakeSuspendable | null = null;
  /** Set while an exclusive holder has the device; serialises overlapping presses. */
  #exclusive: Promise<void> | null = null;

  constructor(opener: AudioCaptureOpener) {
    this.#opener = opener;
  }

  /** Live capture streams. The whole point of this class is that it is 0 or 1. */
  get openStreams(): number {
    return this.#openStreams;
  }

  /** True while a push-to-talk press holds the device and wake is stood down. */
  get exclusiveHeld(): boolean {
    return this.#exclusive !== null;
  }

  /**
   * Register the always-on consumer so it can be stood down for a press. Returns
   * the unregister function; the wake host calls it when it stops for good.
   */
  registerWake(wake: WakeSuspendable): () => void {
    this.#wake = wake;
    return () => {
      if (this.#wake === wake) this.#wake = null;
    };
  }

  /**
   * The opener both consumers use. Refuses a second concurrent stream instead of
   * opening one, the bug this class exists to prevent.
   */
  readonly openCapture: AudioCaptureOpener = async (
    request: AudioCaptureRequest,
    handlers: AudioCaptureHandlers,
  ): Promise<AudioCaptureStream> => {
    if (this.#openStreams > 0) {
      throw new AudioCaptureError(
        'device-unavailable',
        'The microphone is already open in this tab. One capture stream serves both dictation and wake-word '
        + 'detection; a second one is refused rather than opened.',
      );
    }
    const stream = await this.#opener(request, handlers);
    this.#openStreams += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#openStreams = Math.max(0, this.#openStreams - 1);
    };
    return {
      label: stream.label,
      deviceSelectable: stream.deviceSelectable,
      stop: async () => {
        try {
          await stream.stop();
        } finally {
          release();
        }
      },
    };
  };

  /**
   * Take the device for a deliberate press: stand wake detection down, wait for
   * the device to actually be free, and return the lease that resumes it.
   *
   * Overlapping calls are serialised, a second press waits for the first lease
   * to be released rather than suspending an already-suspended listener and
   * resuming it underneath the first holder.
   */
  async acquireExclusive(): Promise<MicLease> {
    while (this.#exclusive !== null) await this.#exclusive;

    let settle = (): void => undefined;
    this.#exclusive = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const wake = this.#wake;
    if (wake) {
      try {
        await wake.suspend();
      } catch {
        // A listener that cannot stand down cleanly has already released or never
        // held the device; the openCapture guard below is what actually protects
        // the invariant, so dictation proceeds rather than dying here.
      }
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.#exclusive = null;
      settle();
      if (wake && this.#wake === wake) {
        try {
          await wake.resume();
        } catch {
          // Resume failure is reported by the wake host's own state, which owns
          // the restart/latch policy, not swallowed into the dictation path.
        }
      }
    };
  }
}

/**
 * The tab's single arbiter. A module singleton for the same reason the TTS engine
 * is one: there is exactly one microphone and exactly one tab, so a per-component
 * instance would recreate the very race this arbitrates.
 */
export const micArbiter = new MicArbiter(createBrowserCaptureOpener());
