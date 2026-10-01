/**
 * capture.ts, the ONE browser microphone path, shared by both voice consumers.
 *
 * This is the web UI's implementation of the SDK's `AudioCaptureOpener`
 * (@goodvibes-jev/engine/sdk/platform/voice/capture): the SDK owns the frame
 * contract, the utterance policy and the WAV encoding; the surface owns opening
 * a device. Two consumers sit on this one opener and they must not each open
 * their own stream:
 *
 *   - push-to-talk dictation (MicButton -> useVoiceInput -> PushToTalkSession),
 *   - always-on wake-word detection (wake-host.ts -> WakeListener), which on a
 *     confirmed wake keeps the SAME stream and records the utterance that
 *     follows.
 *
 * Two concurrent getUserMedia streams on one device is the bug this file exists
 * to make impossible, so nothing here is exported as "open a second stream",
 * mic-arbiter.ts wraps this opener and is what the two consumers actually call.
 *
 * THE FRAME CONTRACT IS LOAD-BEARING AND ITS FAILURES ARE SILENT
 *
 * `onFrame` must deliver exactly `request.frameSamples` samples (1280 = 80 ms at
 * 16 kHz) of mono audio carrying int16 MAGNITUDES as floats (-32768..32767), not
 * the -1..1 range Web Audio hands out. That is the scale openWakeWord trained the
 * shipped classifier against: feeding it normalised audio produces scores that
 * never reach any threshold, which looks exactly like a microphone that is not
 * picking anything up. So every sample is multiplied by 32768 on the way through,
 * and the worklet's render quanta are re-cut by the SDK's `AudioFrameSlicer`
 * rather than assumed to be frame-sized (they are 128 samples).
 *
 * SAMPLE RATE IS ASKED FOR AND THEN VERIFIED
 *
 * `getUserMedia` is asked for 16 kHz mono and the AudioContext is constructed at
 * 16 kHz so the graph resamples deterministically, but a browser may ignore
 * either. `audioContext.sampleRate` is READ, and when it is not 16 kHz the frame
 * pump resamples to 16 kHz itself rather than handing the detector audio at the
 * wrong rate (which shifts the whole front end off the framing the classifier was
 * trained at, and again fails silently).
 *
 * Every failure is an `AudioCaptureError` with a named reason, so the surface can
 * render the specific honest state, the plain-http pointer, the blocked
 * permission, the device that is already held, instead of one dead button.
 */
import {
  AudioCaptureError,
  AudioFrameSlicer,
  CAPTURE_SAMPLE_RATE,
  PCM16_FULL_SCALE,
  type AudioCaptureHandlers,
  type AudioCaptureOpener,
  type AudioCaptureRequest,
  type AudioCaptureStream,
} from '@goodvibes-jev/engine/sdk/platform/voice/capture';

/**
 * Whether the microphone can be used here at all, decided before any capture is
 * attempted. Kept as this surface's own three-state posture (rather than the
 * SDK's wider failure enumeration) because it is what MicButton renders copy
 * for: 'insecure-context' is the actionable one, with an HTTPS pointer.
 */
export type MicSupport = 'ok' | 'insecure-context' | 'unsupported';

// ─── The minimal browser surface this module touches ─────────────────────────
// Structural interfaces rather than the DOM lib types, for the same reason the
// module they replaced used them: the unit tests drive a fake AudioContext and a
// fake mediaDevices, and a fake only has to satisfy what is actually called.

/** One audio track of a live stream. */
export interface CaptureTrack {
  stop(): void;
  readonly label?: string;
  getSettings?(): { deviceId?: string; sampleRate?: number; channelCount?: number };
}

/** A live MediaStream, as much of one as this module uses. */
export interface CaptureMediaStream {
  getTracks(): CaptureTrack[];
}

/** The audio constraints this module asks for. */
export interface CaptureAudioConstraints {
  deviceId?: { exact: string };
  channelCount: number;
  sampleRate: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export interface CaptureMediaDevices {
  getUserMedia(constraints: { audio: CaptureAudioConstraints }): Promise<CaptureMediaStream>;
}

export interface CaptureAudioNode {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

export interface CaptureScriptProcessorNode extends CaptureAudioNode {
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
}

export interface CaptureWorkletNode extends CaptureAudioNode {
  readonly port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    close(): void;
  };
}

export interface CaptureAudioContext {
  readonly sampleRate: number;
  readonly destination: unknown;
  readonly audioWorklet?: { addModule(url: string): Promise<void> } | undefined;
  createMediaStreamSource(stream: CaptureMediaStream): CaptureAudioNode;
  createScriptProcessor?(bufferSize: number, inputChannels: number, outputChannels: number): CaptureScriptProcessorNode;
  createGain?(): CaptureAudioNode & { gain: { value: number } };
  resume?(): Promise<void>;
  close(): Promise<void>;
}

/** Builds an AudioWorkletNode for a context, or undefined where the API is absent. */
export type CaptureWorkletNodeFactory = (context: CaptureAudioContext, processorName: string) => CaptureWorkletNode;

/** Turns a source string into a URL an `audioWorklet.addModule` call accepts. */
export type CaptureModuleUrlFactory = (source: string) => { url: string; revoke: () => void };

export interface CaptureEnv {
  readonly isSecureContext: boolean;
  readonly mediaDevices: CaptureMediaDevices | undefined;
  /**
   * Builds an AudioContext at a requested rate. Returns undefined when the
   * browser has no Web Audio at all, and may return a context at a DIFFERENT
   * rate than requested, the caller reads `.sampleRate` and resamples.
   */
  readonly createAudioContext: ((options: { sampleRate: number }) => CaptureAudioContext) | undefined;
  readonly createWorkletNode: CaptureWorkletNodeFactory | undefined;
  readonly createModuleUrl: CaptureModuleUrlFactory | undefined;
}

// ─── Support detection ───────────────────────────────────────────────────────

interface BrowserWindowShape {
  isSecureContext?: boolean;
  AudioContext?: new (options?: { sampleRate?: number }) => CaptureAudioContext;
  webkitAudioContext?: new (options?: { sampleRate?: number }) => CaptureAudioContext;
  AudioWorkletNode?: new (context: unknown, name: string) => CaptureWorkletNode;
  URL?: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
}

/** The live browser environment. Split out so tests never need a real device. */
export function browserCaptureEnv(): CaptureEnv {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return {
      isSecureContext: false,
      mediaDevices: undefined,
      createAudioContext: undefined,
      createWorkletNode: undefined,
      createModuleUrl: undefined,
    };
  }
  const w = window as unknown as BrowserWindowShape;
  const nav = navigator as unknown as { mediaDevices?: CaptureMediaDevices };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  const WorkletNode = w.AudioWorkletNode;
  const urlApi = w.URL;
  return {
    // Browsers treat localhost as a secure context even over plain http.
    isSecureContext: w.isSecureContext === true,
    mediaDevices: nav.mediaDevices,
    createAudioContext: Ctor ? (options) => new Ctor(options) : undefined,
    createWorkletNode: WorkletNode ? (context, name) => new WorkletNode(context, name) : undefined,
    createModuleUrl: urlApi
      ? (source) => {
        const url = urlApi.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        return { url, revoke: () => urlApi.revokeObjectURL(url) };
      }
      : undefined,
  };
}

/**
 * Classify whether the mic can be used here, before any capture is attempted.
 *
 * A page served over plain HTTP to a non-localhost host has `mediaDevices`
 * undefined entirely, which is reported as 'insecure-context' (the actionable
 * state, with an HTTPS pointer) rather than a bare 'unsupported'.
 */
export function detectMicSupport(env: CaptureEnv = browserCaptureEnv()): MicSupport {
  const hasCapture = Boolean(env.mediaDevices) && typeof env.mediaDevices?.getUserMedia === 'function';
  if (!hasCapture || !env.createAudioContext) {
    if (!env.isSecureContext) return 'insecure-context';
    return 'unsupported';
  }
  if (!env.isSecureContext) return 'insecure-context';
  return 'ok';
}

// ─── The frame pump: Web Audio floats in, contract frames out ────────────────

/** Web Audio quanta pushed per worklet message. 8 x 128 keeps messages to ~43/s. */
export const CAPTURE_WORKLET_BATCH_QUANTA = 8;

/** The registered name of the capture processor inside the worklet module. */
export const CAPTURE_WORKLET_PROCESSOR = 'goodvibes-capture';

/**
 * Converts an arbitrary stream of Web Audio samples into the frames the SDK
 * contract describes: exactly `frameSamples` samples, 16 kHz, int16 magnitudes.
 *
 * Exported (rather than hidden inside the opener) because these three
 * conversions are the whole silent-failure surface of browser capture, scale,
 * rate, framing, and they are worth testing directly with no audio hardware,
 * fake or otherwise, in the picture.
 */
export class CaptureFramePump {
  readonly #slicer: AudioFrameSlicer;
  readonly #onFrame: (frame: Float32Array) => void;
  readonly #step: number;
  /** Unconsumed input samples, already scaled; index 0 is the interpolation base. */
  #pending: Float32Array = new Float32Array(0);
  /** Fractional read position within #pending. */
  #position = 0;

  constructor(options: {
    readonly frameSamples: number;
    readonly inputSampleRate: number;
    readonly onFrame: (frame: Float32Array) => void;
  }) {
    this.#slicer = new AudioFrameSlicer(options.frameSamples);
    this.#onFrame = options.onFrame;
    this.#step = options.inputSampleRate / CAPTURE_SAMPLE_RATE;
  }

  /** True when the input rate differs from 16 kHz and samples are interpolated. */
  get resampling(): boolean {
    return this.#step !== 1;
  }

  /** Samples held back because they do not yet complete a frame. */
  get pendingFrameSamples(): number {
    return this.#slicer.pendingSamples;
  }

  /** Drop everything carried. Called when a stream restarts. */
  reset(): void {
    this.#slicer.reset();
    this.#pending = new Float32Array(0);
    this.#position = 0;
  }

  /** Push one buffer of Web Audio samples (nominally -1..1, mono). */
  push(input: Float32Array): void {
    if (input.length === 0) return;
    const scaled = scaleToPcm16Magnitudes(input);
    const at16k = this.resampling ? this.#resample(scaled) : scaled;
    for (const frame of this.#slicer.push(at16k)) this.#onFrame(frame);
  }

  /**
   * Linear interpolation to 16 kHz, continuous across buffers: the tail the next
   * output sample interpolates from is CARRIED, so a resampled stream has no
   * discontinuity at every buffer boundary (which would read as a periodic click
   * to the mel front end).
   */
  #resample(scaled: Float32Array): Float32Array {
    const pending = concat(this.#pending, scaled);
    // The last output sample needs pending[i] and pending[i + 1], so the highest
    // usable position is length - 1 exclusive of the final index.
    const limit = pending.length - 1;
    const out: number[] = [];
    let position = this.#position;
    while (position < limit) {
      const index = Math.floor(position);
      const t = position - index;
      const a = pending[index] ?? 0;
      const b = pending[index + 1] ?? a;
      out.push(a + (b - a) * t);
      position += this.#step;
    }
    const consumed = Math.floor(position);
    this.#pending = pending.subarray(Math.min(consumed, pending.length)).slice();
    this.#position = position - consumed;
    return new Float32Array(out);
  }
}

function concat(head: Float32Array, tail: Float32Array): Float32Array {
  if (head.length === 0) return tail;
  const merged = new Float32Array(head.length + tail.length);
  merged.set(head, 0);
  merged.set(tail, head.length);
  return merged;
}

/**
 * Web Audio's -1..1 floats to int16 magnitudes, clamped to the int16 range so
 * the "carries int16 magnitudes" claim stays true for a hot input that Web Audio
 * allows to exceed 1.0.
 */
export function scaleToPcm16Magnitudes(input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const scaled = (input[i] ?? 0) * PCM16_FULL_SCALE;
    out[i] = scaled > PCM16_FULL_SCALE - 1
      ? PCM16_FULL_SCALE - 1
      : scaled < -PCM16_FULL_SCALE ? -PCM16_FULL_SCALE : scaled;
  }
  return out;
}

// ─── The worklet module ──────────────────────────────────────────────────────

/**
 * The AudioWorklet processor source, inlined and loaded through a blob URL.
 *
 * Inline rather than a separate asset because it is three lines of glue whose
 * only contract is with this file, and a separate emitted asset would put a
 * build-output path between the two. It batches render quanta before posting so
 * the main thread receives ~43 messages a second rather than ~344; the SDK's
 * slicer re-cuts whatever arrives, so the batch size is free to be a
 * performance choice.
 */
export const CAPTURE_WORKLET_SOURCE = `
class GoodVibesCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._batch = [];
    this._batched = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this._batch.push(channel.slice(0));
      this._batched += channel.length;
      if (this._batch.length >= ${String(CAPTURE_WORKLET_BATCH_QUANTA)}) {
        const merged = new Float32Array(this._batched);
        let at = 0;
        for (const part of this._batch) { merged.set(part, at); at += part.length; }
        this._batch = [];
        this._batched = 0;
        this.port.postMessage(merged, [merged.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('${CAPTURE_WORKLET_PROCESSOR}', GoodVibesCaptureProcessor);
`;

// ─── The opener ──────────────────────────────────────────────────────────────

/** Buffer size for the ScriptProcessor fallback. 2048 frames ~ 128 ms at 16 kHz. */
const SCRIPT_PROCESSOR_BUFFER = 2048;

function classifyGetUserMediaError(error: unknown): AudioCaptureError {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new AudioCaptureError('permission-denied', 'Microphone access was blocked.');
  }
  // NotFoundError / NotReadableError / OverconstrainedError / TrackStartError all
  // mean the same thing to a user: the device asked for is not available to this
  // page right now, either it does not exist or something else holds it.
  return new AudioCaptureError(
    'device-unavailable',
    'The microphone could not be opened. It may not exist, or another program may be using it.',
  );
}

/**
 * Build the browser's `AudioCaptureOpener`.
 *
 * `request.backend` is ignored: it names a host recorder subprocess and a
 * browser tab has none, which the `voice.wake.captureCommand` row says in
 * writing.
 *
 * `request.noiseSuppression: 'speex'` reaching THIS opener is refused, and that is
 * not a statement about the platform: the speexdsp filter is a WebAssembly module
 * the SDK carries and it runs perfectly well in a tab, one layer up, inside
 * `createNoiseSuppressingOpener`, which WakeListener and PushToTalkSession apply
 * and which asks this opener for raw frames. So a `speex` request arriving here
 * means the wrapper was bypassed, and passing it through would hand back
 * unfiltered audio under a filter the user configured.
 */
export function createBrowserCaptureOpener(env: CaptureEnv = browserCaptureEnv()): AudioCaptureOpener {
  return async (request: AudioCaptureRequest, handlers: AudioCaptureHandlers): Promise<AudioCaptureStream> => {
    const support = detectMicSupport(env);
    if (support === 'insecure-context') {
      throw new AudioCaptureError(
        'insecure-origin',
        'The microphone needs a secure (HTTPS) connection. This page is served over plain http.',
      );
    }
    if (support === 'unsupported' || !env.mediaDevices || !env.createAudioContext) {
      throw new AudioCaptureError('unsupported', 'This browser cannot capture the microphone.');
    }
    if (request.noiseSuppression === 'speex') {
      throw new AudioCaptureError(
        'noise-suppression-unavailable',
        'This opener produces raw microphone frames and does not filter them. The platform\'s speexdsp stage runs '
        + 'one layer up, in createNoiseSuppressingOpener, which the wake listener and the push-to-talk session '
        + 'already apply: so this request reached the wrong layer. Refusing rather than returning unfiltered audio '
        + 'under a filter you configured.',
      );
    }

    let stream: CaptureMediaStream;
    try {
      stream = await env.mediaDevices.getUserMedia({
        audio: {
          ...(request.device ? { deviceId: { exact: request.device } } : {}),
          channelCount: 1,
          sampleRate: CAPTURE_SAMPLE_RATE,
          // The browser's own DSP is off on purpose: the classifier was trained
          // on unprocessed PCM, and the host recorder path applies none of it
          // either, so leaving it on would make the two surfaces score the same
          // room differently.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (error) {
      throw classifyGetUserMediaError(error);
    }

    const tracks = stream.getTracks();
    const releaseDevice = () => {
      for (const track of tracks) {
        try {
          track.stop();
        } catch {
          /* a track that refuses to stop must not block the rest */
        }
      }
    };

    let context: CaptureAudioContext;
    try {
      // Asking for 16 kHz makes the graph resample deterministically. Some
      // browsers ignore it and some throw on it; both are handled, the rate is
      // read back below either way.
      context = env.createAudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    } catch {
      releaseDevice();
      throw new AudioCaptureError('unsupported', 'This browser could not open an audio graph for the microphone.');
    }

    let stopped = false;
    const pump = new CaptureFramePump({
      frameSamples: request.frameSamples,
      inputSampleRate: context.sampleRate,
      onFrame: (frame) => {
        if (!stopped) handlers.onFrame(frame);
      },
    });

    const teardown: (() => void)[] = [];
    const finish = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      for (const step of teardown.reverse()) {
        try {
          step();
        } catch {
          /* teardown is best-effort; the device release below is not optional */
        }
      }
      releaseDevice();
      try {
        await context.close();
      } catch {
        /* a context that refuses to close does not keep the device open */
      }
    };

    try {
      const source = context.createMediaStreamSource(stream);
      teardown.push(() => source.disconnect());

      const attached = await attachTap(env, context, source, (samples) => pump.push(samples));
      teardown.push(attached.detach);

      // A context created inside a user gesture is usually already running; a
      // resume is harmless and fixes the suspended case.
      await context.resume?.();

      // Track-level end (the user revoking the permission mid-session, a USB
      // microphone unplugged) is a stream that ended on its own, not a stop we
      // asked for, the listener's supervisor decides what to do about it.
      for (const track of tracks) {
        const endable = track as CaptureTrack & { onended?: (() => void) | null };
        endable.onended = () => {
          if (stopped) return;
          void finish().then(() => {
            handlers.onStopped('stream-ended', new AudioCaptureError('stream-ended', 'The microphone stream ended.'));
          });
        };
      }

      const deviceLabel = tracks[0]?.label?.trim();
      return {
        label: attached.label + (deviceLabel ? ` (${deviceLabel})` : ''),
        // A browser CAN target a specific input: deviceId is a real constraint.
        deviceSelectable: true,
        stop: async () => {
          const wasStopped = stopped;
          await finish();
          if (!wasStopped) handlers.onStopped('requested');
        },
      };
    } catch (error) {
      await finish();
      if (error instanceof AudioCaptureError) throw error;
      // Carry the cause. "No audio graph could read it" on its own is a message
      // nobody can act on, the reason is whatever the graph actually threw.
      throw new AudioCaptureError(
        'unsupported',
        `The microphone opened but no audio graph could read it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

interface AttachedTap {
  readonly label: string;
  readonly detach: () => void;
}

/**
 * Attach the thing that actually reads samples: an AudioWorklet where one is
 * available (audio work off the main thread), a ScriptProcessorNode where the
 * worklet module cannot be loaded, a deployment whose content policy refuses
 * blob: scripts, or a browser without the API. The fallback is deprecated, not
 * broken, and a working microphone beats a correct-but-dead one.
 */
async function attachTap(
  env: CaptureEnv,
  context: CaptureAudioContext,
  source: CaptureAudioNode,
  onSamples: (samples: Float32Array) => void,
): Promise<AttachedTap> {
  if (context.audioWorklet && env.createWorkletNode && env.createModuleUrl) {
    const module = env.createModuleUrl(CAPTURE_WORKLET_SOURCE);
    try {
      await context.audioWorklet.addModule(module.url);
      const node = env.createWorkletNode(context, CAPTURE_WORKLET_PROCESSOR);
      node.port.onmessage = (event) => {
        if (event.data instanceof Float32Array) onSamples(event.data);
      };
      source.connect(node);
      return {
        label: 'getUserMedia (AudioWorklet)',
        detach: () => {
          node.port.onmessage = null;
          node.port.close();
          node.disconnect();
        },
      };
    } catch {
      /* fall through to the ScriptProcessor path below */
    } finally {
      module.revoke();
    }
  }

  if (typeof context.createScriptProcessor === 'function') {
    const processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    processor.onaudioprocess = (event) => {
      onSamples(event.inputBuffer.getChannelData(0));
    };
    source.connect(processor);
    // A ScriptProcessorNode only pumps while it is connected onward, so it goes
    // through a silent gain rather than straight at the speakers.
    const sink = typeof context.createGain === 'function' ? context.createGain() : null;
    if (sink) {
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(context.destination);
    } else {
      processor.connect(context.destination);
    }
    return {
      label: 'getUserMedia (ScriptProcessor)',
      detach: () => {
        processor.onaudioprocess = null;
        processor.disconnect();
        sink?.disconnect();
      },
    };
  }

  throw new AudioCaptureError('unsupported', 'This browser has no way to read samples from the microphone.');
}
