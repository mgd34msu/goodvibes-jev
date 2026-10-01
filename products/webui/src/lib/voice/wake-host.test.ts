/**
 * wake-host.ts, the tab as a wake-word surface, end to end.
 *
 * These tests drive the REAL SDK engine, the REAL WakeListener, the REAL feature
 * pipeline and the REAL browser capture opener. The only things stubbed are the two
 * things a browser genuinely supplies from outside: the onnxruntime sessions (scripted
 * scores, so a wake can be made to happen on a chosen frame) and the daemon calls.
 *
 * Two properties matter most and both are asserted against a getUserMedia SPY rather
 * than a bookkeeping flag, because "the tab did not ask for the microphone" is a fact
 * about the browser API and nothing else:
 *
 *   1. DISABLED MEANS NO getUserMedia AT ALL, separately for `voice.wake.enabled`
 *      false and for `voice.wake.surfaces.webui` false. No permission prompt, no
 *      model download.
 *   2. A confirmed wake runs the whole chain: chime, utterance, `voice.stt` with a WAV
 *      artifact, transcript to the composer, or submitted, per `voice.wake.autoSubmit`.
 *   3. BOTH `voice.wake.browserBackend` values initialise against ONE engine binary.
 *      The runtime loader is the only place a wasm binary is named, and shipping a
 *      second one to serve the other setting put 38 MB in the built assets for a tab
 *      that fetches at most one. The import is injected here, since a test process has
 *      neither a WebGPU adapter nor 24 MB of engine to load.
 */
import { describe, expect, test } from 'bun:test';
import {
  CAPTURE_SAMPLE_RATE,
  type NoiseSuppressionFactory,
} from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import type { UtteranceAudioArtifact } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import type {
  WakeInferenceSession,
  WakeRuntimeSettings,
} from '@goodvibes-jev/engine/sdk/platform/voice/wake/runtime';
import { createBrowserCaptureOpener, type CaptureEnv } from './capture';
import { MicArbiter } from './mic-arbiter';
import { resolveWebuiWakeSettings } from './wake-config';
import { createWakeHost, PINNED_WAKE_MODEL_ID, type WakeModelSet } from './wake-host';
import { loadWakeRuntime, type OrtModule } from './wake-runtime';

const FRAME_SAMPLES = 1280;
/** How many frames the SDK front end needs before it produces any features. */
const WARMUP_FRAMES = 16;

// ─── A getUserMedia spy behind the real opener ────────────────────────────────

interface CaptureSpy {
  env: CaptureEnv;
  getUserMediaCalls: number;
  tracksStopped: () => boolean;
  /** Deliver one buffer of Web Audio samples into the live graph. */
  pump: (samples: Float32Array) => void;
  contextsClosed: () => number;
}

function captureSpy(): CaptureSpy {
  const tracks: { stopped: boolean; stop(): void; label: string }[] = [];
  const processors: { onaudioprocess: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null }[] = [];
  let closed = 0;
  const spy: CaptureSpy = {
    getUserMediaCalls: 0,
    tracksStopped: () => tracks.length > 0 && tracks.every((track) => track.stopped),
    contextsClosed: () => closed,
    pump: (samples) => {
      for (const processor of processors) {
        processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
      }
    },
    env: {
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: () => {
          spy.getUserMediaCalls += 1;
          const track = { stopped: false, label: 'Spy microphone', stop(): void { track.stopped = true; } };
          tracks.push(track);
          return Promise.resolve({ getTracks: () => [track] });
        },
      },
      createAudioContext: () => ({
        sampleRate: CAPTURE_SAMPLE_RATE,
        destination: {},
        audioWorklet: undefined,
        createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
        createScriptProcessor: () => {
          const processor = {
            onaudioprocess: null as ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null,
            connect: () => undefined,
            disconnect: () => undefined,
          };
          processors.push(processor);
          return processor;
        },
        createGain: () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }),
        resume: () => Promise.resolve(),
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      }),
      createWorkletNode: undefined,
      createModuleUrl: undefined,
    },
  };
  return spy;
}

// ─── Stub inference sessions ─────────────────────────────────────────────────

/** An embedding backbone that emits a fixed 96-dim vector, so scores are the test's. */
function stubEmbedding(): WakeInferenceSession {
  const output = new Float32Array(96).fill(0.25);
  return {
    inputNames: ['input_1'],
    outputNames: ['embedding'],
    run: () => Promise.resolve({ embedding: { data: output, dims: [1, 1, 1, 96] } }),
  };
}

/** A classifier whose per-frame score is read off a script. */
function scriptedClassifier(scores: readonly number[]): WakeInferenceSession & { calls: number } {
  const session = {
    calls: 0,
    inputNames: ['input'],
    outputNames: ['score'],
    run: () => {
      const value = scores[session.calls] ?? 0;
      session.calls += 1;
      return Promise.resolve({ score: { data: new Float32Array([value]), dims: [1, 1] } });
    },
  };
  return session;
}

/** A speech gate that reports one probability and counts consultations. */
function countingVad(probability: number): { session: WakeInferenceSession; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    session: {
      inputNames: ['input'],
      outputNames: ['output'],
      run: () => {
        calls += 1;
        return Promise.resolve({ output: { data: new Float32Array([probability]), dims: [1, 1] } });
      },
    },
  };
}

/** A suppression stage stand-in: counts what reaches it, filters nothing. */
function countingSuppression(): {
  create: NoiseSuppressionFactory;
  created: () => number;
  processed: () => number;
  requests: { frameSamples: number; sampleRate: number }[];
} {
  let created = 0;
  let processed = 0;
  const requests: { frameSamples: number; sampleRate: number }[] = [];
  return {
    created: () => created,
    processed: () => processed,
    requests,
    create: (request) => {
      requests.push({ frameSamples: request.frameSamples, sampleRate: request.sampleRate });
      created += 1;
      return Promise.resolve({
        label: 'test-filter',
        blockSamples: 320,
        suppressionDb: -15,
        process: (frame: Float32Array) => {
          processed += 1;
          return new Float32Array(frame);
        },
        close: () => undefined,
      });
    },
  };
}

function modelSet(
  classifier: WakeInferenceSession,
  released?: { count: number },
  vad?: { session: WakeInferenceSession; threshold: number },
): WakeModelSet {
  return {
    embedding: stubEmbedding(),
    models: [{ id: PINNED_WAKE_MODEL_ID, session: classifier }],
    ...(vad !== undefined ? { vad } : {}),
    backend: 'wasm',
    fallbackReason: null,
    limitations: [],
    release: () => {
      if (released) released.count += 1;
      return Promise.resolve();
    },
  };
}

// ─── Audio ───────────────────────────────────────────────────────────────────

/** Speech-level audio in the Web Audio -1..1 range (~16000 on the int16 scale). */
function loudFrame(): Float32Array {
  const out = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) out[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / CAPTURE_SAMPLE_RATE);
  return out;
}

/** Below the SDK's silence floor (180 on the int16 scale). */
function quietFrame(): Float32Array {
  return new Float32Array(FRAME_SAMPLES).fill(0.001);
}

/** Let the listener's promise chain settle: two inference awaits per frame. */
async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

// ─── Settings ────────────────────────────────────────────────────────────────

function settingsFor(overrides: Record<string, unknown> = {}, vadReady = false): WakeRuntimeSettings {
  return resolveWebuiWakeSettings({
    voice: {
      wake: {
        enabled: true,
        models: PINNED_WAKE_MODEL_ID,
        threshold: 0.9,
        patienceFrames: 2,
        cooldownMs: 2_000,
        preRollMs: 500,
        captureMaxSeconds: 10,
        silenceStopMs: 300,
        autoSubmit: false,
        indicator: 'statusline',
        surfaces: { webui: true },
        ...overrides,
      },
    },
  }, vadReady);
}

interface HostHarness {
  spy: CaptureSpy;
  host: ReturnType<typeof createWakeHost>;
  chimes: number[];
  sttRequests: UtteranceAudioArtifact[];
  sink: { text: string; autoSubmit: boolean }[];
  warnings: string[];
  released: { count: number };
  loadCalls: number;
}

function hostHarness(options: {
  classifier: WakeInferenceSession;
  transcript?: string;
  transcribeError?: Error;
  arbiter?: MicArbiter;
  /** A speech gate in the model set, as a provisioned tab would have. */
  vad?: { session: WakeInferenceSession; threshold: number };
  suppression?: ReturnType<typeof countingSuppression>;
}): HostHarness {
  const spy = captureSpy();
  const chimes: number[] = [];
  const sttRequests: UtteranceAudioArtifact[] = [];
  const sink: { text: string; autoSubmit: boolean }[] = [];
  const warnings: string[] = [];
  const released = { count: 0 };
  const opener = createBrowserCaptureOpener(spy.env);
  const arbiter = options.arbiter ?? new MicArbiter(opener);
  const harness: HostHarness = {
    spy,
    chimes,
    sttRequests,
    sink,
    warnings,
    released,
    loadCalls: 0,
    host: createWakeHost({
      openCapture: arbiter.openCapture,
      loadModelSet: () => {
        harness.loadCalls += 1;
        return Promise.resolve(modelSet(options.classifier, released, options.vad));
      },
      ...(options.suppression !== undefined ? { createNoiseSuppression: options.suppression.create } : {}),
      transcribe: (artifact) => {
        sttRequests.push(artifact);
        if (options.transcribeError) return Promise.reject(options.transcribeError);
        return Promise.resolve(options.transcript ?? 'open the fleet view');
      },
      chime: () => {
        chimes.push(Date.now());
        return true;
      },
      arbiter,
      warn: (message) => warnings.push(message),
    }),
  };
  harness.host.setTranscriptSink((text, { autoSubmit }) => sink.push({ text, autoSubmit }));
  return harness;
}

// ─── Disabled means the device is never touched ──────────────────────────────

describe('disabled means no getUserMedia at all', () => {
  test('voice.wake.enabled false: the microphone is never requested and no model is loaded', async () => {
    const harness = hostHarness({ classifier: scriptedClassifier([]) });
    await harness.host.applySettings(settingsFor({ enabled: false }));

    expect(harness.spy.getUserMediaCalls).toBe(0);
    expect(harness.loadCalls).toBe(0);
    const state = harness.host.getState();
    expect(state.phase).toBe('off');
    expect(state.refusal?.kind).toBe('disabled');
    // Nothing to show: the user did not ask for this here.
    expect(state.indicator).toBe('off');
  });

  test('voice.wake.surfaces.webui false: still no getUserMedia, with the per-origin reason', async () => {
    const harness = hostHarness({ classifier: scriptedClassifier([]) });
    await harness.host.applySettings(settingsFor({ surfaces: { webui: false } }));

    expect(harness.spy.getUserMediaCalls).toBe(0);
    expect(harness.loadCalls).toBe(0);
    const state = harness.host.getState();
    expect(state.phase).toBe('off');
    expect(state.refusal?.kind).toBe('surface-disabled');
  });

  test('the shipped default (an empty config tree) opens nothing', async () => {
    const harness = hostHarness({ classifier: scriptedClassifier([]) });
    await harness.host.applySettings(resolveWebuiWakeSettings({}));
    expect(harness.spy.getUserMediaCalls).toBe(0);
    expect(harness.host.getState().phase).toBe('off');
  });

  test('a blocked row refuses without opening the device, and still shows the reason', async () => {
    const harness = hostHarness({ classifier: scriptedClassifier([]) });
    // The speech gate is its own pinned artifact, so asking for a voice-activity
    // floor this tab has not loaded BLOCKS: frames would otherwise reach the
    // classifier unscreened while the row says they are being screened.
    await harness.host.applySettings(settingsFor({ vadThreshold: 0.5 }));

    expect(harness.spy.getUserMediaCalls).toBe(0);
    const state = harness.host.getState();
    expect(state.phase).toBe('refused');
    expect(state.refusal?.kind).toBe('blocked');
    // Asked for HERE, so the indicator carries the reason rather than vanishing.
    expect(state.indicator).toBe('statusline');
  });

  test('turning it off after it was running releases the device', async () => {
    const harness = hostHarness({ classifier: scriptedClassifier([]) });
    await harness.host.applySettings(settingsFor());
    expect(harness.spy.getUserMediaCalls).toBe(1);

    await harness.host.applySettings(settingsFor({ surfaces: { webui: false } }));
    expect(harness.spy.tracksStopped()).toBe(true);
    expect(harness.released.count).toBe(1);
    expect(harness.host.getState().deviceLabel).toBeNull();
  });
});

// ─── Starting ────────────────────────────────────────────────────────────────

describe('starting', () => {
  test('an active configuration opens exactly one stream and reports listening', async () => {
    const harness = hostHarness({ classifier: scriptedClassifier([]) });
    await harness.host.applySettings(settingsFor());
    const state = harness.host.getState();
    expect(harness.spy.getUserMediaCalls).toBe(1);
    expect(state.phase).toBe('listening');
    expect(state.deviceLabel).not.toBeNull();
    expect(state.backend).toBe('wasm');
    expect(state.modelIds).toEqual([PINNED_WAKE_MODEL_ID]);
    expect(state.indicator).toBe('statusline');
  });

  test('an identical configuration applied again does not reopen the device', async () => {
    const harness = hostHarness({ classifier: scriptedClassifier([]) });
    await harness.host.applySettings(settingsFor());
    await harness.host.applySettings(settingsFor());
    await harness.host.applySettings(settingsFor());
    expect(harness.spy.getUserMediaCalls).toBe(1);
    expect(harness.loadCalls).toBe(1);
  });

  test('models that cannot be loaded refuse honestly and leave the device closed', async () => {
    const spy = captureSpy();
    const arbiter = new MicArbiter(createBrowserCaptureOpener(spy.env));
    const host = createWakeHost({
      openCapture: arbiter.openCapture,
      loadModelSet: () => Promise.reject(new Error('sha256 did not match the pin')),
      transcribe: () => Promise.resolve(''),
      chime: () => true,
      arbiter,
      warn: () => undefined,
    });
    await host.applySettings(settingsFor());
    expect(spy.getUserMediaCalls).toBe(0);
    expect(host.getState().phase).toBe('refused');
    expect(host.getState().refusal?.kind).toBe('model-unavailable');
    expect(host.getState().error).toBeTruthy();
  });
});

// ─── The detection chain ─────────────────────────────────────────────────────

/**
 * Push frames through the live capture graph, one at a time, letting the listener's
 * scoring chain drain between them (it drops frames beyond four queued, so a test
 * that fired them all at once would be testing the drop path).
 */
async function pushFrames(harness: HostHarness, frame: Float32Array, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    harness.spy.pump(frame);
    await settle();
  }
}

describe('a confirmed wake runs the whole chain', () => {
  test('chime, utterance, voice.stt with a wav artifact, transcript into the composer', async () => {
    // 16 warm-up frames produce no scores at all; then two frames above 0.9 confirm
    // (patienceFrames: 2) and everything after that is the utterance.
    const classifier = scriptedClassifier([0.1, 0.2, 0.95, 0.97, ...Array(40).fill(0.1) as number[]]);
    const harness = hostHarness({ classifier, transcript: 'open the fleet view' });
    await harness.host.applySettings(settingsFor());

    // Warm the front end, then the two low frames, then the two that fire.
    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 4);

    expect(harness.chimes).toHaveLength(1);
    expect(harness.host.getState().lastWakeAt).not.toBeNull();
    expect(harness.host.getState().phase).toBe('capturing');

    // The utterance that FOLLOWS: speech, then enough silence to end it
    // (silenceStopMs 300 = four 80 ms frames).
    await pushFrames(harness, loudFrame(), 6);
    await pushFrames(harness, quietFrame(), 6);
    await settle(40);

    expect(harness.sttRequests).toHaveLength(1);
    const artifact = harness.sttRequests[0];
    expect(artifact.mimeType).toBe('audio/wav');
    expect(artifact.format).toBe('wav');
    expect(artifact.sampleRateHz).toBe(CAPTURE_SAMPLE_RATE);
    expect(artifact.dataBase64.length).toBeGreaterThan(0);
    // Pre-roll is prepended, so the clip is longer than the frames pushed after
    // the wake alone.
    expect(artifact.durationMs).toBeGreaterThan(12 * 80);

    expect(harness.sink).toEqual([{ text: 'open the fleet view', autoSubmit: false }]);
    expect(harness.host.getState().lastTranscript).toBe('open the fleet view');
    // And the device was never reopened for the utterance, same stream throughout.
    expect(harness.spy.getUserMediaCalls).toBe(1);
    expect(harness.host.getState().phase).toBe('listening');
  });

  test('voice.wake.autoSubmit true asks the composer to submit rather than draft', async () => {
    const classifier = scriptedClassifier([0.1, 0.2, 0.95, 0.97, ...Array(40).fill(0.1) as number[]]);
    const harness = hostHarness({ classifier, transcript: 'run the tests' });
    await harness.host.applySettings(settingsFor({ autoSubmit: true }));

    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 4);
    await pushFrames(harness, loudFrame(), 4);
    await pushFrames(harness, quietFrame(), 6);
    await settle(40);

    expect(harness.sink).toEqual([{ text: 'run the tests', autoSubmit: true }]);
  });

  test('a wake with nothing said after it sends no speech-to-text request', async () => {
    const classifier = scriptedClassifier([0.1, 0.2, 0.95, 0.97, ...Array(40).fill(0.1) as number[]]);
    const harness = hostHarness({ classifier });
    await harness.host.applySettings(settingsFor({ preRollMs: 0 }));

    // Exactly the frame the wake confirms on and no more, so nothing loud reaches
    // the recorder: scoring starts on frame 16 and 0.95/0.97 land on 18 and 19.
    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 3);
    expect(harness.chimes).toHaveLength(1);
    // Only silence follows: the ceiling ends it, and nothing above the floor was
    // ever heard. Billing a provider to transcribe a quiet room is not a service.
    await pushFrames(harness, quietFrame(), 130);
    await settle(40);

    expect(harness.sttRequests).toHaveLength(0);
    expect(harness.sink).toHaveLength(0);
    expect(harness.host.getState().error).toBeTruthy();
  });

  test('a failed transcription is reported, not swallowed, and listening continues', async () => {
    const classifier = scriptedClassifier([0.1, 0.2, 0.95, 0.97, ...Array(40).fill(0.1) as number[]]);
    const harness = hostHarness({ classifier, transcribeError: new Error('no stt provider configured') });
    await harness.host.applySettings(settingsFor());

    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 4);
    await pushFrames(harness, loudFrame(), 4);
    await pushFrames(harness, quietFrame(), 6);
    await settle(40);

    expect(harness.sink).toHaveLength(0);
    expect(harness.host.getState().error).toContain('no stt provider configured');
    expect(harness.host.getState().phase).toBe('listening');
  });

  test('scores below the threshold never fire, however many arrive', async () => {
    const classifier = scriptedClassifier(Array(80).fill(0.85) as number[]);
    const harness = hostHarness({ classifier });
    await harness.host.applySettings(settingsFor());
    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 30);
    expect(harness.chimes).toHaveLength(0);
    expect(harness.sttRequests).toHaveLength(0);
    expect(harness.host.getState().phase).toBe('listening');
  });

  test('one frame above the threshold is not enough when patience is two', async () => {
    const classifier = scriptedClassifier([0.95, 0.1, 0.95, 0.2, 0.95, ...Array(40).fill(0.1) as number[]]);
    const harness = hostHarness({ classifier });
    await harness.host.applySettings(settingsFor());
    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 5);
    expect(harness.chimes).toHaveLength(0);
  });
});

// ─── The arbiter, from the host's side ───────────────────────────────────────

describe('push-to-talk and the wake listener share one device', () => {
  test('an exclusive acquire stands the listener down; releasing it starts listening again', async () => {
    const spy = captureSpy();
    const arbiter = new MicArbiter(createBrowserCaptureOpener(spy.env));
    const harness = hostHarness({ classifier: scriptedClassifier([]), arbiter });
    await harness.host.applySettings(settingsFor());
    expect(spy.getUserMediaCalls).toBe(1);
    expect(harness.host.getState().phase).toBe('listening');

    const lease = await arbiter.acquireExclusive();
    expect(harness.host.getState().phase).toBe('suspended');
    // The listener really let go: a press can open the ONLY stream.
    expect(arbiter.openStreams).toBe(0);
    const press = await arbiter.openCapture(
      { frameSamples: FRAME_SAMPLES, device: '', backend: 'auto', noiseSuppression: 'none' },
      { onFrame: () => undefined, onStopped: () => undefined },
    );
    expect(spy.getUserMediaCalls).toBe(2);

    await press.stop();
    await lease();
    await settle(20);

    expect(harness.host.getState().phase).toBe('listening');
    expect(spy.getUserMediaCalls).toBe(3);
    expect(arbiter.openStreams).toBe(1);
  });

  test('a press while wake is listening never produces two concurrent streams', async () => {
    const spy = captureSpy();
    const arbiter = new MicArbiter(createBrowserCaptureOpener(spy.env));
    const harness = hostHarness({ classifier: scriptedClassifier([]), arbiter });
    await harness.host.applySettings(settingsFor());

    const lease = await arbiter.acquireExclusive();
    const press = await arbiter.openCapture(
      { frameSamples: FRAME_SAMPLES, device: '', backend: 'auto', noiseSuppression: 'none' },
      { onFrame: () => undefined, onStopped: () => undefined },
    );
    // At no point above did the arbiter hold more than one stream.
    expect(arbiter.openStreams).toBe(1);
    await press.stop();
    await lease();
  });

  test('a stopped host no longer gets stood down by a press', async () => {
    const spy = captureSpy();
    const arbiter = new MicArbiter(createBrowserCaptureOpener(spy.env));
    const harness = hostHarness({ classifier: scriptedClassifier([]), arbiter });
    await harness.host.applySettings(settingsFor());
    await harness.host.stop();

    const lease = await arbiter.acquireExclusive();
    await lease();
    await settle(10);
    // Two opens total: the listener's original one, and nothing resumed after it
    // was deliberately stopped.
    expect(spy.getUserMediaCalls).toBe(1);
    expect(harness.host.getState().phase).toBe('off');
  });
});


describe('both browserBackend values run on one engine binary', () => {
  /**
   * A stand-in for onnxruntime-web that records what it was asked for. The URL it
   * reports is the one the real loader sets from its single `?url` import, so
   * "both settings resolved to the same binary" is checked as one fact rather
   * than inferred from two code paths.
   */
  function fakeOrt(): { module: OrtModule; providers: string[][] } {
    const providers: string[][] = [];
    const module: OrtModule = {
      env: { wasm: { wasmPaths: { wasm: '/assets/ort-wasm-simd-threaded.asyncify-HASH.wasm' } } },
      InferenceSession: {
        create: async (_bytes, options) => {
          providers.push([...options.executionProviders]);
          return {
            inputNames: ['in'],
            outputNames: ['out'],
            run: async () => ({ out: { data: new Float32Array([0]), dims: [1, 1] } }),
            release: async () => undefined,
          };
        },
      },
      Tensor: class {
        readonly data: unknown;
        readonly dims: readonly number[];
        constructor(_type: 'float32', data: Float32Array, dims: readonly number[]) {
          this.data = data;
          this.dims = dims;
        }
      } as unknown as OrtModule['Tensor'],
    };
    return { module, providers };
  }

  function loaderFor(fake: { module: OrtModule }, gpu: boolean) {
    let imports = 0;
    return {
      deps: {
        importModule: async () => { imports += 1; return fake.module; },
        gpuAvailable: () => gpu,
      },
      importCount: () => imports,
    };
  }

  test('the "wasm" setting loads the one binary and runs the CPU provider inside it', async () => {
    const fake = fakeOrt();
    const loader = loaderFor(fake, false);
    const runtime = await loadWakeRuntime('wasm', loader.deps);
    await runtime.createSession(new Uint8Array([1, 2, 3]));

    expect(loader.importCount()).toBe(1);
    expect(runtime.backend).toBe('wasm');
    expect(runtime.fallbackReason).toBeNull();
    expect(fake.providers[0]).toEqual(['wasm']);
  });

  test('the "webgpu" setting loads the SAME binary and runs the GPU provider in it', async () => {
    const fake = fakeOrt();
    const loader = loaderFor(fake, true);
    const runtime = await loadWakeRuntime('webgpu', loader.deps);
    await runtime.createSession(new Uint8Array([1, 2, 3]));

    expect(loader.importCount()).toBe(1);
    expect(runtime.backend).toBe('webgpu');
    expect(runtime.fallbackReason).toBeNull();
    // GPU first, CPU behind it, so an unsupported kernel falls back inside the
    // binary rather than failing the session.
    expect(fake.providers[0]).toEqual(['webgpu', 'wasm']);
  });

  test('both settings resolve to the identical wasm URL, one file in the built assets', async () => {
    const wasmFor = async (backend: 'wasm' | 'webgpu', gpu: boolean): Promise<unknown> => {
      const fake = fakeOrt();
      await loadWakeRuntime(backend, loaderFor(fake, gpu).deps);
      return (fake.module.env.wasm.wasmPaths as { wasm: string }).wasm;
    };
    const onWasm = await wasmFor('wasm', false);
    const onWebGpu = await wasmFor('webgpu', true);
    expect(onWasm).toBe(onWebGpu);
  });

  test('webgpu without an adapter falls back inside the same binary and records a fallback reason', async () => {
    const fake = fakeOrt();
    const loader = loaderFor(fake, false);
    const runtime = await loadWakeRuntime('webgpu', loader.deps);
    await runtime.createSession(new Uint8Array([1]));

    expect(runtime.backend).toBe('wasm');
    expect(runtime.fallbackReason).not.toBeNull();
    // One import even on the fallback path: nothing re-fetches a different engine.
    expect(loader.importCount()).toBe(1);
    expect(fake.providers[0]).toEqual(['wasm']);
  });
});

describe('the two rows that used to be refused now run a real stage', () => {
  test('speex sends captured frames through the filter before anything scores them', async () => {
    const suppression = countingSuppression();
    const harness = hostHarness({ classifier: scriptedClassifier([]), suppression });
    await harness.host.applySettings(settingsFor({ noiseSuppression: 'speex' }));

    expect(harness.spy.getUserMediaCalls).toBe(1);
    expect(suppression.created()).toBe(1);
    // Built for the detector's frame, at the rate the models were trained on.
    expect(suppression.requests).toEqual([{ frameSamples: 1280, sampleRate: CAPTURE_SAMPLE_RATE }]);

    await pushFrames(harness, loudFrame(), 3);
    expect(suppression.processed()).toBe(3);
  });

  test('none opens the same device with no stage at all', async () => {
    const suppression = countingSuppression();
    const harness = hostHarness({ classifier: scriptedClassifier([]), suppression });
    await harness.host.applySettings(settingsFor());

    expect(harness.spy.getUserMediaCalls).toBe(1);
    await pushFrames(harness, loudFrame(), 3);
    expect(suppression.created()).toBe(0);
    expect(suppression.processed()).toBe(0);
  });

  test('a voice-activity floor consults the gate for every frame once it is provisioned', async () => {
    const vad = countingVad(0.9);
    const harness = hostHarness({
      classifier: scriptedClassifier([]),
      vad: { session: vad.session, threshold: 0.5 },
    });
    // vadReady true: the daemon reports the gate artifact verified on disk.
    await harness.host.applySettings(settingsFor({ vadThreshold: 0.5 }, true));

    expect(harness.spy.getUserMediaCalls).toBe(1);
    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 2);
    expect(vad.calls()).toBeGreaterThan(0);
  });

  test('a frame under the floor is withheld: the gate ran, the classifier did not', async () => {
    const vad = countingVad(0.02);
    // Scores that would fire immediately if anything were scored at all.
    const classifier = scriptedClassifier([0.99, 0.99, 0.99, 0.99]);
    const harness = hostHarness({
      classifier,
      vad: { session: vad.session, threshold: 0.8 },
    });
    await harness.host.applySettings(settingsFor({ vadThreshold: 0.8 }, true));

    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 6);
    expect(vad.calls()).toBeGreaterThan(0);
    expect(harness.chimes).toHaveLength(0);
    expect(harness.sttRequests).toHaveLength(0);
  });

  test('the shipped default of 0 consults no gate, even with one loaded', async () => {
    const vad = countingVad(0.9);
    const harness = hostHarness({
      classifier: scriptedClassifier([]),
      vad: { session: vad.session, threshold: 0 },
    });
    await harness.host.applySettings(settingsFor({}, true));

    await pushFrames(harness, loudFrame(), WARMUP_FRAMES + 2);
    expect(vad.calls()).toBe(0);
  });
});
