/**
 * capture.ts, the browser capture primitive.
 *
 * Replaces stt-recorder.test.ts, which tested a MediaRecorder path that no longer
 * exists (nothing captures through MediaRecorder now; both consumers go through this
 * opener). Its support-detection matrix and its honest-failure-reason matrix are
 * carried over intact, because those behaviours did not change, only what happens
 * after the device opens did.
 *
 * The frame contract gets the most attention here because every way of getting it
 * wrong is SILENT: a frame of the wrong length, or normalised -1..1 samples instead
 * of int16 magnitudes, produces a detector that scores everything near zero and
 * looks exactly like a microphone that is not picking anything up.
 *
 * The fake context drives the ScriptProcessor tap rather than the AudioWorklet one.
 * That is a real product path (a deployment whose content policy refuses blob:
 * scripts, or a browser without the API falls back to it), and the conversions under
 * test, scale, resample, re-cut, are shared by both taps. The worklet path itself
 * is exercised in a real browser by the e2e run, which is the only place a genuine
 * AudioWorklet exists.
 */
import { describe, expect, test } from 'bun:test';
import { AudioCaptureError, PCM16_FULL_SCALE } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import type { AudioCaptureHandlers, AudioCaptureRequest } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import {
  CaptureFramePump,
  createBrowserCaptureOpener,
  detectMicSupport,
  scaleToPcm16Magnitudes,
  type CaptureEnv,
} from './capture';

const FRAME_SAMPLES = 1280;

const REQUEST: AudioCaptureRequest = {
  frameSamples: FRAME_SAMPLES,
  device: '',
  backend: 'auto',
  noiseSuppression: 'none',
};

// ─── Test doubles ────────────────────────────────────────────────────────────

interface FakeTrack {
  stop(): void;
  stopped: boolean;
  label: string;
  onended?: (() => void) | null;
}

function fakeTrack(label = 'Fake microphone'): FakeTrack {
  const track: FakeTrack = {
    stopped: false,
    label,
    onended: null,
    stop() {
      track.stopped = true;
    },
  };
  return track;
}

interface FakeProcessor {
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
  connect(destination: unknown): unknown;
  disconnect(): void;
  disconnected: boolean;
}

class FakeAudioContext {
  readonly sampleRate: number;
  readonly destination = { kind: 'destination' };
  /** Undefined so the opener takes the ScriptProcessor tap. */
  readonly audioWorklet = undefined;
  processor: FakeProcessor | null = null;
  closed = false;
  resumed = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }

  createScriptProcessor(): FakeProcessor {
    const processor: FakeProcessor = {
      onaudioprocess: null,
      disconnected: false,
      connect: () => undefined,
      disconnect: () => {
        processor.disconnected = true;
      },
    };
    this.processor = processor;
    return processor;
  }

  createGain() {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  }

  async resume(): Promise<void> {
    this.resumed += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface Harness {
  env: CaptureEnv;
  tracks: FakeTrack[];
  contexts: FakeAudioContext[];
  constraints: unknown[];
}

function harness(options: {
  contextRate?: number;
  getUserMedia?: () => Promise<{ getTracks(): FakeTrack[] }>;
  secure?: boolean;
  trackCount?: number;
} = {}): Harness {
  const tracks: FakeTrack[] = [];
  for (let i = 0; i < (options.trackCount ?? 1); i += 1) tracks.push(fakeTrack(`Fake microphone ${i}`));
  const contexts: FakeAudioContext[] = [];
  const constraints: unknown[] = [];
  const env: CaptureEnv = {
    isSecureContext: options.secure ?? true,
    mediaDevices: {
      getUserMedia: options.getUserMedia
        ? options.getUserMedia
        : (given) => {
          constraints.push(given);
          return Promise.resolve({ getTracks: () => tracks });
        },
    },
    createAudioContext: () => {
      const context = new FakeAudioContext(options.contextRate ?? 16_000);
      contexts.push(context);
      return context;
    },
    createWorkletNode: undefined,
    createModuleUrl: undefined,
  };
  return { env, tracks, contexts, constraints };
}

function collectFrames(): { handlers: AudioCaptureHandlers; frames: Float32Array[]; stops: unknown[] } {
  const frames: Float32Array[] = [];
  const stops: unknown[] = [];
  return {
    frames,
    stops,
    handlers: {
      onFrame: (frame) => frames.push(frame),
      onStopped: (reason, error) => stops.push({ reason, error }),
    },
  };
}

/** A loud sine, in the -1..1 range Web Audio actually delivers. */
function webAudioTone(length: number, hz = 440, rate = 16_000): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

// ─── The frame contract ──────────────────────────────────────────────────────

describe('the frame contract', () => {
  test('scaling produces int16 magnitudes, never normalised values', () => {
    const scaled = scaleToPcm16Magnitudes(new Float32Array([0, 0.5, -0.5, 1, -1]));
    expect([...scaled]).toEqual([0, 16_384, -16_384, PCM16_FULL_SCALE - 1, -PCM16_FULL_SCALE]);
  });

  test('a hot input is clamped to the int16 range rather than overflowing it', () => {
    const scaled = scaleToPcm16Magnitudes(new Float32Array([2.5, -2.5]));
    expect(scaled[0]).toBe(PCM16_FULL_SCALE - 1);
    expect(scaled[1]).toBe(-PCM16_FULL_SCALE);
  });

  test('render quanta are re-cut into frames of exactly 1280 samples', () => {
    const frames: Float32Array[] = [];
    const pump = new CaptureFramePump({
      frameSamples: FRAME_SAMPLES,
      inputSampleRate: 16_000,
      onFrame: (frame) => frames.push(frame),
    });
    // 128-sample quanta, which is what a worklet actually delivers: ten of them
    // complete one frame and nothing before that does.
    for (let i = 0; i < 10; i += 1) {
      pump.push(webAudioTone(128));
      if (i < 9) expect(frames).toHaveLength(0);
    }
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBe(FRAME_SAMPLES);
  });

  test('the remainder is carried, never dropped and never padded', () => {
    const frames: Float32Array[] = [];
    const pump = new CaptureFramePump({
      frameSamples: FRAME_SAMPLES,
      inputSampleRate: 16_000,
      onFrame: (frame) => frames.push(frame),
    });
    // 700 does not divide 1280, so every frame boundary falls mid-buffer.
    for (let i = 0; i < 20; i += 1) pump.push(webAudioTone(700));
    expect(frames).toHaveLength(Math.floor((700 * 20) / FRAME_SAMPLES));
    for (const frame of frames) expect(frame.length).toBe(FRAME_SAMPLES);
    expect(pump.pendingFrameSamples).toBe((700 * 20) % FRAME_SAMPLES);
  });

  test('frames carry magnitudes on the int16 scale, not the Web Audio scale', () => {
    const frames: Float32Array[] = [];
    const pump = new CaptureFramePump({
      frameSamples: FRAME_SAMPLES,
      inputSampleRate: 16_000,
      onFrame: (frame) => frames.push(frame),
    });
    pump.push(webAudioTone(FRAME_SAMPLES));
    const peak = Math.max(...[...frames[0]].map(Math.abs));
    // A 0.5-amplitude tone is ~16384 on the int16 scale. Anything at or below 1 is
    // normalised audio, which is the failure this assertion exists to catch.
    expect(peak).toBeGreaterThan(10_000);
    expect(peak).toBeLessThanOrEqual(PCM16_FULL_SCALE);
  });

  test('a context that ignored the 16 kHz request is resampled, not passed through', () => {
    const frames: Float32Array[] = [];
    const pump = new CaptureFramePump({
      frameSamples: FRAME_SAMPLES,
      inputSampleRate: 48_000,
      onFrame: (frame) => frames.push(frame),
    });
    expect(pump.resampling).toBe(true);
    // Three seconds of 48 kHz audio is three seconds of 16 kHz audio: 37.5 frames.
    pump.push(webAudioTone(48_000 * 3, 440, 48_000));
    expect(frames.length).toBe(37);
    for (const frame of frames) expect(frame.length).toBe(FRAME_SAMPLES);
    // And it is still real audio, not silence produced by a broken interpolation.
    const peak = Math.max(...[...frames[0]].map(Math.abs));
    expect(peak).toBeGreaterThan(10_000);
  });

  test('resampling stays continuous across buffers', () => {
    const frames: Float32Array[] = [];
    const pump = new CaptureFramePump({
      frameSamples: FRAME_SAMPLES,
      inputSampleRate: 44_100,
      onFrame: (frame) => frames.push(frame),
    });
    // Ten one-second buffers at 44.1 kHz is ten seconds of 16 kHz audio: 125 frames.
    // A pump that dropped or duplicated its carry at each boundary would drift off
    // this count.
    for (let i = 0; i < 10; i += 1) pump.push(webAudioTone(44_100, 440, 44_100));
    expect(frames.length).toBe(125);
  });
});

// ─── Support detection (carried over from stt-recorder.test.ts) ──────────────

describe('detectMicSupport', () => {
  test('a secure context with mic APIs is ok', () => {
    expect(detectMicSupport(harness().env)).toBe('ok');
  });

  test('an insecure context (plain-HTTP LAN) reports insecure-context', () => {
    expect(detectMicSupport(harness({ secure: false }).env)).toBe('insecure-context');
  });

  test('missing mic APIs over insecure http still points at the secure-context fix', () => {
    const base = harness({ secure: false }).env;
    expect(detectMicSupport({ ...base, mediaDevices: undefined })).toBe('insecure-context');
  });

  test('a secure context without Web Audio is unsupported', () => {
    const base = harness().env;
    expect(detectMicSupport({ ...base, createAudioContext: undefined })).toBe('unsupported');
  });

  test('a secure context without getUserMedia is unsupported', () => {
    const base = harness().env;
    expect(detectMicSupport({ ...base, mediaDevices: undefined })).toBe('unsupported');
  });
});

// ─── Honest failure reasons (carried over, remapped to the SDK's enumeration) ─

describe('the opener refuses honestly', () => {
  test('an insecure origin is refused with reason insecure-origin', async () => {
    const opener = createBrowserCaptureOpener(harness({ secure: false }).env);
    const error = await opener(REQUEST, collectFrames().handlers).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AudioCaptureError);
    expect((error as AudioCaptureError).reason).toBe('insecure-origin');
  });

  test('a browser with no Web Audio is refused with reason unsupported', async () => {
    const base = harness().env;
    const opener = createBrowserCaptureOpener({ ...base, createAudioContext: undefined });
    const error = await opener(REQUEST, collectFrames().handlers).catch((e: unknown) => e);
    expect((error as AudioCaptureError).reason).toBe('unsupported');
  });

  test('a blocked permission maps to reason permission-denied', async () => {
    const opener = createBrowserCaptureOpener(harness({
      getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
    }).env);
    const error = await opener(REQUEST, collectFrames().handlers).catch((e: unknown) => e);
    expect((error as AudioCaptureError).reason).toBe('permission-denied');
  });

  test('a missing or busy device maps to reason device-unavailable', async () => {
    const opener = createBrowserCaptureOpener(harness({
      getUserMedia: () => Promise.reject(Object.assign(new Error('gone'), { name: 'NotFoundError' })),
    }).env);
    const error = await opener(REQUEST, collectFrames().handlers).catch((e: unknown) => e);
    expect((error as AudioCaptureError).reason).toBe('device-unavailable');
  });

  test('speex reaching the BARE opener is refused: the stage runs one layer up', async () => {
    const test1 = harness();
    const opener = createBrowserCaptureOpener(test1.env);
    const error = await opener({ ...REQUEST, noiseSuppression: 'speex' }, collectFrames().handlers)
      .catch((e: unknown) => e);
    expect((error as AudioCaptureError).reason).toBe('noise-suppression-unavailable');
    // And nothing was opened, so no permission prompt was produced either.
    expect(test1.constraints).toHaveLength(0);
  });
});

// ─── The device is always released ───────────────────────────────────────────

describe('the device is released on every path out', () => {
  test('stop() releases every track and closes the context', async () => {
    const test1 = harness({ trackCount: 3 });
    const sink = collectFrames();
    const stream = await createBrowserCaptureOpener(test1.env)(REQUEST, sink.handlers);
    expect(test1.tracks.every((track) => track.stopped)).toBe(false);

    await stream.stop();

    expect(test1.tracks.every((track) => track.stopped)).toBe(true);
    expect(test1.contexts[0].closed).toBe(true);
    expect(test1.contexts[0].processor?.disconnected).toBe(true);
    expect(sink.stops).toEqual([{ reason: 'requested', error: undefined }]);
  });

  test('stop() is idempotent and reports the stop exactly once', async () => {
    const test1 = harness();
    const sink = collectFrames();
    const stream = await createBrowserCaptureOpener(test1.env)(REQUEST, sink.handlers);
    await stream.stop();
    await stream.stop();
    expect(sink.stops).toHaveLength(1);
  });

  test('a failure AFTER getUserMedia succeeded still releases the device', async () => {
    const test1 = harness();
    // No worklet and no ScriptProcessor: the graph cannot be built, which is the
    // failure that used to leave a live microphone behind.
    let closed = false;
    const env: CaptureEnv = {
      ...test1.env,
      createAudioContext: () => ({
        sampleRate: 16_000,
        destination: {},
        audioWorklet: undefined,
        createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
        resume: () => Promise.resolve(),
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      }),
    };
    const error = await createBrowserCaptureOpener(env)(REQUEST, collectFrames().handlers)
      .catch((e: unknown) => e);
    expect((error as AudioCaptureError).reason).toBe('unsupported');
    expect(test1.tracks.every((track) => track.stopped)).toBe(true);
    expect(closed).toBe(true);
  });

  test('a track ending on its own is reported as stream-ended and releases the rest', async () => {
    const test1 = harness({ trackCount: 2 });
    const sink = collectFrames();
    await createBrowserCaptureOpener(test1.env)(REQUEST, sink.handlers);
    test1.tracks[0].onended?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(test1.tracks.every((track) => track.stopped)).toBe(true);
    expect((sink.stops[0] as { reason: string }).reason).toBe('stream-ended');
  });

  test('no frame is delivered after stop', async () => {
    const test1 = harness();
    const sink = collectFrames();
    const stream = await createBrowserCaptureOpener(test1.env)(REQUEST, sink.handlers);
    const processor = test1.contexts[0].processor;
    const tone = webAudioTone(FRAME_SAMPLES);
    processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => tone } });
    expect(sink.frames).toHaveLength(1);
    await stream.stop();
    processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => tone } });
    expect(sink.frames).toHaveLength(1);
  });
});

// ─── What is actually asked of the browser ───────────────────────────────────

describe('the constraints asked for', () => {
  test('16 kHz mono is requested, with the browser DSP off', async () => {
    const test1 = harness();
    await createBrowserCaptureOpener(test1.env)(REQUEST, collectFrames().handlers);
    expect(test1.constraints[0]).toEqual({
      audio: {
        channelCount: 1,
        sampleRate: 16_000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  });

  test('a configured device is asked for exactly, and reported as selectable', async () => {
    const test1 = harness();
    const stream = await createBrowserCaptureOpener(test1.env)(
      { ...REQUEST, device: 'usb-mic-id' },
      collectFrames().handlers,
    );
    expect(test1.constraints[0]).toMatchObject({ audio: { deviceId: { exact: 'usb-mic-id' } } });
    expect(stream.deviceSelectable).toBe(true);
  });

  test('frames flow end to end at exactly the requested frame size', async () => {
    const test1 = harness();
    const sink = collectFrames();
    await createBrowserCaptureOpener(test1.env)(REQUEST, sink.handlers);
    const processor = test1.contexts[0].processor;
    // Twenty 2048-sample buffers, the ScriptProcessor size: 40960 samples is 32
    // whole frames of 1280 with nothing left over.
    for (let i = 0; i < 20; i += 1) {
      const buffer = webAudioTone(2048);
      processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => buffer } });
    }
    expect(sink.frames).toHaveLength(32);
    for (const frame of sink.frames) expect(frame.length).toBe(FRAME_SAMPLES);
  });
});
