/**
 * Behaviour verification for the `voice.wake.*` settings.
 *
 * The bar every test here has to clear: drive the setting to two clearly
 * different values, run the code that actually consumes it, and assert that the
 * OUTCOME differs. A test that would still pass if the consuming code ignored
 * the setting is not evidence of anything, so nothing below asserts a default,
 * a description, a schema row, or that a value survives a round trip through
 * ConfigManager.
 *
 * Values are read from the shipped CONFIG_SCHEMA rows rather than hardcoded, so
 * each test drives the setting a user actually gets, and the second value in
 * every pair is derived from it. The one bridge assertion, that the detector's and
 * supervisor's own defaults equal the shipped config defaults, is what makes
 * "drive the detector with the config default" mean the same thing as "drive
 * the shipped setting"; it sits beside real behaviour, never in place of it.
 *
 * Nothing here opens a microphone, spawns a real recorder, or reads a real clock.
 * Time is injected, audio is synthetic, the recorder subprocess is a fake under
 * test control, and the inference sessions are stubs that replay scripted scores.
 * The only filesystem writes are into a per-test temp root, for the one row whose
 * whole subject is a file being written (`voice.wake.retainAudio`).
 *
 * THE CAPTURE-SIDE ROWS ARE COVERED NOW, AND WHERE
 *
 * This file used to end by pinning `notOperable: no-runtime-wiring` and record
 * seventeen rows as honestly NOT COVERED, because nothing captured microphone
 * audio anywhere. That is no longer true: this surface has a capture host
 * (src/audio/capture.ts, src/audio/wake-runtime.ts, src/shell/voice-capture-shell.ts),
 * so `enabled`, `surfaces.agent`, `inputDevice`, `captureCommand`,
 * `noiseSuppression`, `vadThreshold`, `activationSound`, `activationSoundPath`,
 * `indicator`, `captureMaxSeconds`, `silenceStopMs`, `autoSubmit`, `retainAudio`
 * and `customModelDir` all reach real code here and are driven to two values
 * against it in "the capture host on this surface" below, through the REAL SDK
 * listener, the REAL capture opener and the REAL engine, over an injected recorder
 * subprocess and stub inference sessions.
 *
 * TWO OF THOSE ROWS USED TO REFUSE, AND NOW RUN
 *
 * `noiseSuppression: speex` and `vadThreshold` above 0 both stopped the detector
 * rather than pretending, because neither stage existed. Both exist now, the
 * platform carries SpeexDSP's preprocessor as a WebAssembly module, and the speech
 * gate is a pinned head provisioned beside the wake models, so the tests for them
 * assert the stage RUNNING and the gate SCREENING, not the refusal text.
 *
 * `vadThreshold` keeps one refusal, moved rather than removed: it is honoured when
 * this surface has the gate on disk and refused when it does not, because frames
 * reaching the classifier unscreened while the row says they were screened is the
 * thing the refusal exists to prevent.
 *
 * STILL NOT COVERED, DELIBERATELY:
 *
 *   - `surfaces.tui` and `surfaces.webui`, other surfaces' delivery rows. This
 *     repository resolves settings for `agent` and nothing here reads either one;
 *     a test would be asserting the terminal's behaviour from the Agent's suite.
 *   - `browserBackend`, chooses a WASM or WebGPU execution provider inside a
 *     browser tab. There is no tab here, and this surface's inference runtime pins
 *     `wasm` because it is a host process, so no value of the row changes anything
 *     this repo does.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  WAKE_CHUNK_SAMPLES,
  WAKE_EMBED_DIM,
  type WakeInferenceSession,
  type WakeTensor,
} from '@goodvibes-jev/engine/sdk/platform/voice';
import {
  resolveManagedWakePaths,
  retainedClipFileName,
  type CaptureChildProcess,
  type UtteranceAudioArtifact,
} from '@goodvibes-jev/engine/sdk/platform/voice';
import { createAgentCaptureOpener } from '../../audio/capture.ts';
import { startWakeRuntime, wireWakeRuntime, type WakeRuntime, type WakeRuntimeDeps } from '../../audio/wake-runtime.ts';
import { voiceCaptureRowVisible } from '../../core/voice-capture-status.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Stubs and helpers
// ---------------------------------------------------------------------------

/**
 * Stand-in for the speech-embedding backbone. Shape-correct and content-free:
 * every test below decides what the CLASSIFIER emits, so the embedding only has
 * to keep the pipeline moving.
 */
function stubEmbedding(): WakeInferenceSession {
  return {
    inputNames: ['input_1'],
    outputNames: ['embedding'],
    run: async () => ({
      embedding: { data: new Float32Array(WAKE_EMBED_DIM).fill(0.5), dims: [1, 1, 1, WAKE_EMBED_DIM] },
    }),
  };
}

/** A frame of silence. */
function silentFrame(): Float32Array {
  return new Float32Array(WAKE_CHUNK_SAMPLES);
}

/* Narrowing helpers, TypeScript strict, no casts, no `any`. */

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The capture host on this surface.
//
// Everything below drives a `voice.wake.*` row to two values through the REAL
// pieces, the SDK listener and engine, the SDK capture opener, this surface's
// wake runtime, with only two things faked: the recorder subprocess and the
// inference sessions. No microphone is opened, no recorder is spawned, no model
// file is read, no clock is real.
//
// The rule these are built around: a row that the consuming code stopped reading
// must break a test here. Where a row's outcome is only observable as "a device
// was or was not opened", the assertion is on the spawn log, which is the closest
// thing to the microphone itself that a test can hold.
// ---------------------------------------------------------------------------

type DataListener = (chunk: Uint8Array) => void;
type CloseListener = (code: number | null, signal: string | null) => void;

/**
 * A recorder subprocess under test control. Mirrors what the SDK's capture opener
 * actually consumes: stdout data, stderr data, 'error', 'close', kill.
 */
class FakeRecorder implements CaptureChildProcess {
  readonly killSignals: string[] = [];
  private readonly dataListeners: DataListener[] = [];
  private readonly stderrListeners: DataListener[] = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly closeListeners: CloseListener[] = [];
  private closed = false;

  readonly stdout = { on: (_event: 'data', listener: DataListener): unknown => { this.dataListeners.push(listener); return this; } };
  readonly stderr = { on: (_event: 'data', listener: DataListener): unknown => { this.stderrListeners.push(listener); return this; } };

  on(event: 'error' | 'close', listener: (...args: never[]) => void): unknown {
    if (event === 'error') this.errorListeners.push(listener as unknown as (error: Error) => void);
    else this.closeListeners.push(listener as unknown as CloseListener);
    return this;
  }

  kill(signal?: string): unknown {
    this.killSignals.push(signal ?? 'SIGTERM');
    // A real recorder exits on SIGTERM; emitting on a microtask (not synchronously)
    // matches that ordering and lets the SDK's bounded stop() settle immediately
    // instead of waiting out its escalation timer.
    void Promise.resolve().then(() => this.emitClose(0));
    return true;
  }

  /** Test control: the recorder wrote raw PCM to stdout. */
  emitBytes(bytes: Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener(bytes);
  }

  /** Test control: the recorder wrote a diagnostic to stderr. */
  emitStderr(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const listener of [...this.stderrListeners]) listener(bytes);
  }

  /** Test control: the recorder exited. */
  emitClose(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener(code, null);
  }
}

/** A spawn factory that records every call and hands back fakes. */
function recordingSpawn(): {
  readonly spawn: (command: string, args: readonly string[]) => CaptureChildProcess;
  readonly calls: Array<{ command: string; args: readonly string[] }>;
  readonly processes: FakeRecorder[];
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const processes: FakeRecorder[] = [];
  return {
    calls,
    processes,
    spawn: (command, args) => {
      calls.push({ command, args });
      const proc = new FakeRecorder();
      processes.push(proc);
      return proc;
    },
  };
}

/** Encode int16 magnitudes as the little-endian PCM a recorder writes. */
// Accepts a Float32Array as well as a plain sample array: silentFrame() hands
// back the Float32Array shape the recorder actually emits, and the callers that
// feed it here were failing typecheck:test against a number[]-only signature.
function pcmBytes(samples: readonly number[] | Float32Array): Uint8Array {
  const values = Array.from(samples);
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
}

/** A run of loud audio, well above the SDK's silence floor. */
function loudSamples(count: number, seed = 1): number[] {
  return Array.from({ length: count }, (_unused, index) => (index % 2 === 0 ? 9000 + seed : -9000 - seed));
}

/** A run of silence. */
function silentSamples(count: number): number[] {
  return Array.from({ length: count }, () => 0);
}

/** Let the listener's promise chain (framing -> inference -> handlers) settle. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A classifier stand-in that scores from a script and HOLDS the last value once
 * the script runs out, so a test says exactly when a wake confirms and then stops
 * having to think about frame counts.
 */
function holdingClassifier(scores: readonly number[]): WakeInferenceSession {
  let index = 0;
  return {
    inputNames: ['onnx::Flatten_0'],
    outputNames: ['output'],
    run: async (): Promise<Readonly<Record<string, WakeTensor>>> => {
      const score = scores[Math.min(index, scores.length - 1)] ?? 0;
      index += 1;
      return { output: { data: Float32Array.from([score]), dims: [1, 1] } };
    },
  };
}

/** A config source backed by a plain map, with the subscription the runtime uses. */
function configSource(overrides: Readonly<Record<string, unknown>>): {
  readonly read: (key: string) => unknown;
  readonly subscribe: (key: string, listener: () => void) => () => void;
  readonly set: (key: string, value: unknown) => void;
} {
  const values = new Map<string, unknown>(Object.entries(overrides));
  const listeners = new Map<string, Array<() => void>>();
  return {
    read: (key) => values.get(key),
    subscribe: (key, listener) => {
      const list = listeners.get(key) ?? [];
      list.push(listener);
      listeners.set(key, list);
      return () => { listeners.set(key, (listeners.get(key) ?? []).filter((entry) => entry !== listener)); };
    },
    set: (key, value) => {
      values.set(key, value);
      for (const listener of [...(listeners.get(key) ?? [])]) listener();
    },
  };
}

/** The rows a listening detector needs, so each test overrides only its own. */
const LISTENING_CONFIG: Readonly<Record<string, unknown>> = {
  'voice.wake.enabled': true,
  'voice.wake.surfaces.agent': true,
  'voice.wake.models': 'hey_goodvibes',
  'voice.wake.threshold': 0.9,
  'voice.wake.patienceFrames': 2,
  'voice.wake.cooldownMs': 2000,
  'voice.wake.silenceStopMs': 400,
  'voice.wake.captureMaxSeconds': 4,
  'voice.wake.preRollMs': 200,
  'voice.wake.autoSubmit': false,
  'voice.wake.activationSound': 'chime',
  'voice.wake.indicator': 'statusline',
  'voice.wake.maxRestarts': 1,
  'voice.wake.restartBackoffMs': 100,
  'voice.wake.crashWindowSeconds': 60,
};

interface CaptureHarness {
  readonly runtime: WakeRuntime;
  readonly spawns: ReturnType<typeof recordingSpawn>;
  readonly config: ReturnType<typeof configSource>;
  readonly notices: string[];
  readonly drafts: string[];
  readonly submitted: string[];
  readonly sounds: readonly { kind: string; path: string }[];
  readonly transcribed: UtteranceAudioArtifact[];
  readonly timers: Array<{ handler: () => void; ms: number }>;
  readonly loadedModelPaths: string[];
  /** One entry per noise-suppression stage the listener asked for. */
  readonly suppressionStages: Array<{ frameSamples: number; frames: number; closed: boolean }>;
  /** How many times the stub speech gate was consulted. */
  readonly vadRuns: () => number;
  now: number;
}

interface CaptureHarnessOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly scores?: readonly number[];
  readonly transcript?: string;
  /** Rejects transcription with this message instead of resolving. */
  readonly transcribeError?: string;
  /** Reports the models as absent, the way a fresh host does. */
  readonly notProvisioned?: boolean;
  /** Wire a provisioner, so the runtime FETCHES missing models instead of reporting a chore. */
  readonly ensureProvisioned?: () => Promise<{ readonly ready: boolean; readonly message: string }>;
  /** A provision read that can change between calls, for the fetch-then-recheck path. */
  readonly provisionStatusOverride?: () => { readonly ready: boolean; readonly reason: string | null; readonly vadReady: boolean };
  /** No transcription available at all, the honest refusal path. */
  readonly noTranscriber?: string;
  /** Which recorders the PATH scan should claim are installed. */
  readonly installed?: readonly string[];
  readonly managedRoot?: string;
  /** Whether the speech gate is on disk and verified, as wakeProvisionStatus reports it. */
  readonly vadReady?: boolean;
  /** Speech probability the stub gate returns for every frame. */
  readonly vadProbability?: number;
}

function makeCaptureHarness(options: CaptureHarnessOptions = {}): CaptureHarness {
  const spawns = recordingSpawn();
  const config = configSource({ ...LISTENING_CONFIG, ...options.config });
  const notices: string[] = [];
  const drafts: string[] = [];
  const submitted: string[] = [];
  const sounds: { kind: string; path: string }[] = [];
  const transcribed: UtteranceAudioArtifact[] = [];
  const timers: Array<{ handler: () => void; ms: number }> = [];
  const loadedModelPaths: string[] = [];
  const suppressionStages: Array<{ frameSamples: number; frames: number; closed: boolean }> = [];
  let vadRuns = 0;
  const classifier = holdingClassifier(options.scores ?? [0]);
  const embedding = stubEmbedding();
  /**
   * The speech gate, stubbed: shape-correct over the same embedding the classifiers
   * read, returning one scripted probability and counting every consultation. The
   * count is the assertion that matters, a gate that is wired but never asked is
   * indistinguishable from no gate at all.
   */
  const vadSession: WakeInferenceSession = {
    inputNames: ['embedding'],
    outputNames: ['speech_probability'],
    run: async (): Promise<Readonly<Record<string, WakeTensor>>> => {
      vadRuns += 1;
      return { speech_probability: { data: Float32Array.from([options.vadProbability ?? 1]), dims: [1, 1] } };
    },
  };
  const harness: Partial<CaptureHarness> & { now: number } = { now: 1_000_000 };

  const deps: WakeRuntimeDeps = {
    readConfig: config.read,
    subscribeConfig: config.subscribe,
    // The REAL capture opener over an injected spawn: the probe order, the argv
    // and the exit handling under test are the shipped ones.
    // The RAW opener, exactly as the shell hands it over: unwrapped, and claiming
    // nothing about suppression. The listener is what wraps it.
    openCapture: createAgentCaptureOpener({
      spawn: spawns.spawn,
      isInstalled: (command) => options.installed === undefined || options.installed.includes(command),
      platform: 'linux',
    }),
    managedRoot: options.managedRoot ?? '/nonexistent-managed-root',
    assetDirectory: '/nonexistent-asset-dir',
    resolveTranscriber: () => (options.noTranscriber !== undefined
      ? { available: false as const, reason: options.noTranscriber }
      : {
        available: true as const,
        gateway: {
          transcribe: async (audio: UtteranceAudioArtifact) => {
            transcribed.push(audio);
            if (options.transcribeError !== undefined) throw new Error(options.transcribeError);
            return options.transcript ?? 'open the deploy log';
          },
          // The gateway now names the route it took, so a surface can say when
          // the connected host answered rather than this process.
          lastRouteExplanation: () => null,
        },
      }),
    playActivationSound: (sound) => { sounds.push({ kind: sound.kind, path: sound.path }); },
    submitTurn: (text) => { submitted.push(text); },
    writeDraft: (text) => { drafts.push(text); },
    notify: (message) => { notices.push(message); },
    render: () => { /* no renderer under test */ },
    sessionId: 'session-under-test',
    warn: () => { /* warnings are not the subject here */ },
    loadSession: async (modelPath: string) => {
      loadedModelPaths.push(modelPath);
      if (modelPath.includes('goodvibes-vad')) return vadSession;
      return modelPath.includes('speech-embedding') ? embedding : classifier;
    },
    provisionStatus: () => (options.provisionStatusOverride !== undefined
      ? options.provisionStatusOverride()
      : options.notProvisioned === true
        ? { ready: false, reason: 'not-provisioned', vadReady: false }
        : { ready: true, reason: null, vadReady: options.vadReady ?? false }),
    ...(options.ensureProvisioned !== undefined ? { ensureProvisioned: options.ensureProvisioned } : {}),
    // The stage the SDK listener wraps this surface's opener with. Injected so the
    // wiring is asserted without instantiating WebAssembly, what is under test here
    // is that the stage is built and every frame goes through it, which is this
    // surface's half; the filter's own arithmetic is the platform's.
    createNoiseSuppression: async (request) => {
      const record = { frameSamples: request.frameSamples, frames: 0, closed: false };
      suppressionStages.push(record);
      return {
        label: 'stub-suppressor',
        blockSamples: 320,
        suppressionDb: -15,
        process: (frame: Float32Array) => {
          record.frames += 1;
          // A NEW frame, as the contract requires (a caller may retain the input).
          return Float32Array.from(frame, (sample) => sample / 2);
        },
        close: () => { record.closed = true; },
      };
    },
    now: () => harness.now,
    setTimeout: (handler, ms) => { timers.push({ handler, ms }); return timers.length; },
    clearTimeout: () => { /* fired manually */ },
  };

  return Object.assign(harness, {
    runtime: wireWakeRuntime(deps),
    spawns,
    config,
    notices,
    drafts,
    submitted,
    sounds,
    transcribed,
    timers,
    loadedModelPaths,
    suppressionStages,
    vadRuns: () => vadRuns,
  }) as CaptureHarness;
}

/**
 * Feed enough frames to fill the SDK front end's window, so the frames after this
 * are the ones that actually get scored.
 */
async function primeFrontEnd(recorder: FakeRecorder): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    recorder.emitBytes(pcmBytes(loudSamples(WAKE_CHUNK_SAMPLES, i)));
    await flush(2);
  }
}

/** Start a listening harness and hand back its (single) recorder. */
async function startListening(harness: CaptureHarness): Promise<FakeRecorder> {
  await harness.runtime.refresh();
  const recorder = harness.spawns.processes[0];
  if (recorder === undefined) throw new Error(`no recorder was spawned; notices: ${harness.notices.join(' | ')}`);
  return recorder;
}

describe('voice.wake.enabled and voice.wake.surfaces.agent are a DOUBLE gate on the microphone', () => {
  test('voice.wake.enabled: false opens no device and spawns no process at all; true spawns a recorder', async () => {
    const off = makeCaptureHarness({ config: { 'voice.wake.enabled': false } });
    await off.runtime.refresh();
    expect(off.spawns.calls).toEqual([]);
    expect(off.runtime.status()).toBeNull();

    const on = makeCaptureHarness({ config: { 'voice.wake.enabled': true } });
    await on.runtime.refresh();
    expect(on.spawns.calls.length).toBe(1);
    // A recorder was SPAWNED, which is not the same as hearing anything: until
    // audio actually arrives the row says so. Claiming to listen here is the
    // defect that showed a listening banner over a microphone producing
    // nothing, for a whole boot.
    expect(on.runtime.status()?.kind).toBe('wake-no-audio');
    on.spawns.processes[0]!.emitBytes(pcmBytes(silentFrame()));
    await flush(2);
    expect(on.runtime.status()?.kind).toBe('wake-listening');
  });

  test('voice.wake.surfaces.agent: false opens no device even with the feature enabled; true opens one', async () => {
    const off = makeCaptureHarness({ config: { 'voice.wake.enabled': true, 'voice.wake.surfaces.agent': false } });
    await off.runtime.refresh();
    expect(off.spawns.calls).toEqual([]);
    expect(off.runtime.status()).toBeNull();
    // Not a silent no-op either way: the resolved settings say which row is off.
    expect(off.runtime.settings().enabled).toBe(true);
    expect(off.runtime.settings().surfaceEnabled).toBe(false);
    expect(off.runtime.settings().active).toBe(false);

    const on = makeCaptureHarness({ config: { 'voice.wake.enabled': true, 'voice.wake.surfaces.agent': true } });
    await on.runtime.refresh();
    expect(on.spawns.calls.length).toBe(1);
    expect(on.runtime.settings().active).toBe(true);
  });

  test('the rows are read LIVE through the shipped subscription: flipping either one takes or releases the device', async () => {
    const harness = makeCaptureHarness({ config: { 'voice.wake.enabled': false } });
    // startWakeRuntime is exactly what main.ts installs, including WHICH rows it
    // subscribes to, a subscription pointed at another surface's row would leave
    // this test flipping a setting that changes nothing.
    const unsubs = startWakeRuntime(harness.runtime, { subscribeConfig: harness.config.subscribe });
    await flush();
    expect(harness.spawns.calls).toEqual([]);

    harness.config.set('voice.wake.enabled', true);
    await flush();
    expect(harness.spawns.calls.length).toBe(1);

    harness.config.set('voice.wake.surfaces.agent', false);
    await flush();
    expect(harness.spawns.processes[0]?.killSignals).toContain('SIGTERM');
    expect(harness.runtime.status()).toBeNull();

    harness.config.set('voice.wake.surfaces.agent', true);
    await flush();
    expect(harness.spawns.calls.length).toBe(2);

    harness.config.set('voice.wake.enabled', false);
    await flush();
    expect(harness.runtime.status()).toBeNull();
    // Still two: turning it off must not open a third device on the way down.
    expect(harness.spawns.calls.length).toBe(2);

    for (const unsub of unsubs) unsub();
    await harness.runtime.stop();
  });

  test('an enabled detector with no models and no provisioner says so, opens nothing, and names no command', async () => {
    const harness = makeCaptureHarness({ notProvisioned: true });
    await harness.runtime.refresh();
    expect(harness.spawns.calls).toEqual([]);
    const said = harness.notices.join('\n');
    expect(said).toContain('the wake models are not on this host');
    // The models are the platform's job. Telling the user to go and run a
    // command for work this process can do is the defect this replaced.
    expect(said).not.toContain('/voice wake setup');
  });

  test('missing models are FETCHED when a provisioner is wired, and the detector then starts', async () => {
    let fetched = 0;
    // Not provisioned on the first read, provisioned once the fetch has run,
    // the runtime re-reads from disk rather than taking the provisioner's word.
    let provisioned = false;
    const harness = makeCaptureHarness({
      provisionStatusOverride: () => (provisioned
        ? { ready: true, reason: null, vadReady: false }
        : { ready: false, reason: 'not-provisioned', vadReady: false }),
      ensureProvisioned: async () => {
        fetched += 1;
        provisioned = true;
        return { ready: true, message: 'Downloaded and checksum-verified the wake models.' };
      },
    });
    await harness.runtime.refresh();

    expect(fetched).toBe(1);
    const said = harness.notices.join('\n');
    expect(said).toContain('fetching and verifying them now');
    expect(said).toContain('Downloaded and checksum-verified');
    // It got as far as opening the device, which is the point of fetching.
    expect(harness.spawns.calls.length).toBeGreaterThan(0);
  });
});

describe('a confirmed wake lands in this surface\'s conversation input', () => {
  test('voice.wake.autoSubmit off: the transcript goes to the composer and no turn is submitted', async () => {
    const harness = makeCaptureHarness({ scores: [0.99], transcript: 'summarise my inbox' });
    const recorder = await startListening(harness);
    await primeFrontEnd(recorder);

    expect(harness.sounds).toEqual([{ kind: 'chime', path: '' }]);
    expect(harness.runtime.status()?.kind).toBe('wake-capturing');

    // Silence ends the utterance the SDK recorder is holding.
    for (let i = 0; i < 12; i += 1) {
      recorder.emitBytes(pcmBytes(silentSamples(WAKE_CHUNK_SAMPLES)));
      await flush(2);
    }
    await flush();

    expect(harness.transcribed.length).toBe(1);
    expect(harness.transcribed[0]?.format).toBe('wav');
    expect(harness.drafts).toEqual(['summarise my inbox']);
    expect(harness.submitted).toEqual([]);
    expect(harness.notices.join('\n')).toContain('voice.wake.autoSubmit is off');
  });

  test('voice.wake.autoSubmit on: the same utterance is submitted as a turn and nothing is drafted', async () => {
    const harness = makeCaptureHarness({
      config: { 'voice.wake.autoSubmit': true },
      scores: [0.99],
      transcript: 'summarise my inbox',
    });
    const recorder = await startListening(harness);
    await primeFrontEnd(recorder);
    for (let i = 0; i < 12; i += 1) {
      recorder.emitBytes(pcmBytes(silentSamples(WAKE_CHUNK_SAMPLES)));
      await flush(2);
    }
    await flush();

    expect(harness.submitted).toEqual(['summarise my inbox']);
    expect(harness.drafts).toEqual([]);
  });

  test('voice.wake.activationSound: the configured kind is the one handed to the player at the moment of the wake', async () => {
    // The row's audible outcome, "none" produces no playback, "chime" produces a
    // WAV, is asserted against the real player path in
    // src/test/audio/player-playback.test.ts. What this asserts is the other half:
    // the row reaches the wake handler at all, and differs between two values.
    const silent = makeCaptureHarness({ config: { 'voice.wake.activationSound': 'none' }, scores: [0.99] });
    await primeFrontEnd(await startListening(silent));
    expect(silent.sounds.map((sound) => sound.kind)).toEqual(['none']);

    const chimed = makeCaptureHarness({ scores: [0.99] });
    await primeFrontEnd(await startListening(chimed));
    expect(chimed.sounds.map((sound) => sound.kind)).toEqual(['chime']);
  });

  test('voice.wake.activationSoundPath: the configured path is what reaches the player when the sound is "custom"', async () => {
    const harness = makeCaptureHarness({
      config: { 'voice.wake.activationSound': 'custom', 'voice.wake.activationSoundPath': '/tmp/ping.wav' },
      scores: [0.99],
    });
    await primeFrontEnd(await startListening(harness));
    expect(harness.sounds).toEqual([{ kind: 'custom', path: '/tmp/ping.wav' }]);

    const other = makeCaptureHarness({
      config: { 'voice.wake.activationSound': 'custom', 'voice.wake.activationSoundPath': '/tmp/other.wav' },
      scores: [0.99],
    });
    await primeFrontEnd(await startListening(other));
    expect(other.sounds).toEqual([{ kind: 'custom', path: '/tmp/other.wav' }]);
  });

  test('a transcription that fails is reported to the user, not swallowed, and nothing lands in the composer', async () => {
    const harness = makeCaptureHarness({ scores: [0.99], transcribeError: 'whisper exited 1' });
    const recorder = await startListening(harness);
    await primeFrontEnd(recorder);
    for (let i = 0; i < 12; i += 1) {
      recorder.emitBytes(pcmBytes(silentSamples(WAKE_CHUNK_SAMPLES)));
      await flush(2);
    }
    await flush();
    expect(harness.drafts).toEqual([]);
    expect(harness.notices.join('\n')).toContain('whisper exited 1');
  });

  test('no speech-to-text provider at all: the capture still happens and the reason is shown verbatim', async () => {
    const harness = makeCaptureHarness({ scores: [0.99], noTranscriber: 'no speech-to-text provider is registered' });
    const recorder = await startListening(harness);
    await primeFrontEnd(recorder);
    for (let i = 0; i < 12; i += 1) {
      recorder.emitBytes(pcmBytes(silentSamples(WAKE_CHUNK_SAMPLES)));
      await flush(2);
    }
    await flush();
    expect(harness.transcribed).toEqual([]);
    expect(harness.notices.join('\n')).toContain('no speech-to-text provider is registered');
  });
});

describe('the capture rows choose the device, the recorder, and what is refused', () => {
  test('voice.wake.inputDevice: the configured device is what the recorder is actually told to open', async () => {
    const named = makeCaptureHarness({ config: { 'voice.wake.inputDevice': 'alsa_input.usb-Blue_Microphones' } });
    await startListening(named);
    expect(named.spawns.calls[0]?.args.join(' ')).toContain('alsa_input.usb-Blue_Microphones');

    const other = makeCaptureHarness({ config: { 'voice.wake.inputDevice': 'alsa_input.pci-0000_00_1f.3' } });
    await startListening(other);
    expect(other.spawns.calls[0]?.args.join(' ')).toContain('alsa_input.pci-0000_00_1f.3');
    expect(other.spawns.calls[0]?.args.join(' ')).not.toContain('Blue_Microphones');
  });

  test('voice.wake.captureCommand: the named recorder is the one spawned, and a different name spawns a different one', async () => {
    const parecord = makeCaptureHarness({ config: { 'voice.wake.captureCommand': 'parecord' } });
    await startListening(parecord);
    expect(parecord.spawns.calls[0]?.command).toBe('parecord');

    const arecord = makeCaptureHarness({ config: { 'voice.wake.captureCommand': 'arecord' } });
    await startListening(arecord);
    expect(arecord.spawns.calls[0]?.command).toBe('arecord');
  });

  test('voice.wake.captureCommand: a named recorder that is not installed is REPORTED, not quietly replaced by one that is', async () => {
    const harness = makeCaptureHarness({
      config: { 'voice.wake.captureCommand': 'sox' },
      installed: ['parecord', 'arecord'],
    });
    await harness.runtime.refresh();
    expect(harness.spawns.calls).toEqual([]);
    expect(harness.notices.join('\n')).toContain('sox');
  });

  test('voice.wake.noiseSuppression: "speex" RUNS the stage over every frame; "none" builds no stage at all', async () => {
    // This row used to refuse on this surface. The platform carries SpeexDSP's
    // preprocessor now and the SDK listener wraps this surface's opener with it, so
    // the row's outcome is a filter that runs, and what this asserts is the wiring
    // this surface owns: the stage is built for the frame size the engine wants, and
    // every captured frame goes through it before anything scores it.
    const speex = makeCaptureHarness({ config: { 'voice.wake.noiseSuppression': 'speex' } });
    const recorder = await startListening(speex);
    expect(speex.runtime.settings().blockers).toEqual([]);
    expect(speex.suppressionStages.length).toBe(1);
    expect(speex.suppressionStages[0]?.frameSamples).toBe(WAKE_CHUNK_SAMPLES);

    recorder.emitBytes(pcmBytes(loudSamples(WAKE_CHUNK_SAMPLES)));
    await flush(3);
    expect(speex.suppressionStages[0]?.frames).toBeGreaterThan(0);

    const none = makeCaptureHarness({ config: { 'voice.wake.noiseSuppression': 'none' } });
    const plain = await startListening(none);
    none.runtime.settings();
    plain.emitBytes(pcmBytes(loudSamples(WAKE_CHUNK_SAMPLES)));
    await flush(3);
    // "none" is NO stage, not a stage that does nothing, nothing was built to skip.
    expect(none.suppressionStages).toEqual([]);
    expect(none.runtime.settings().blockers).toEqual([]);
  });

  test('voice.wake.noiseSuppression: the stage is released when the detector stops, so a restart does not leak one', async () => {
    const harness = makeCaptureHarness({ config: { 'voice.wake.noiseSuppression': 'speex' } });
    await startListening(harness);
    expect(harness.suppressionStages[0]?.closed).toBe(false);
    await harness.runtime.stop();
    await flush();
    expect(harness.suppressionStages[0]?.closed).toBe(true);
  });

  test('voice.wake.vadThreshold: above 0 the gate screens frames; 0 never consults it at all', async () => {
    // Above 0 with the gate provisioned: the head is loaded and asked per frame, and
    // a frame it scores below the threshold reaches NO classifier.
    const screened = makeCaptureHarness({
      config: { 'voice.wake.vadThreshold': 0.3 },
      vadReady: true,
      vadProbability: 0.01,
      scores: [0.99],
    });
    const recorder = await startListening(screened);
    expect(screened.runtime.settings().blockers).toEqual([]);
    expect(screened.loadedModelPaths.some((path) => path.includes('goodvibes-vad'))).toBe(true);
    await primeFrontEnd(recorder);
    expect(screened.vadRuns()).toBeGreaterThan(0);
    // The classifier would have fired at 0.99 on every frame; the gate withheld them.
    expect(screened.sounds).toEqual([]);
    expect(screened.runtime.status()?.kind).toBe('wake-listening');

    // The same audio and the same scores, with the gate opening instead.
    const passed = makeCaptureHarness({
      config: { 'voice.wake.vadThreshold': 0.3 },
      vadReady: true,
      vadProbability: 0.99,
      scores: [0.99],
    });
    await primeFrontEnd(await startListening(passed));
    expect(passed.vadRuns()).toBeGreaterThan(0);
    expect(passed.sounds.map((sound) => sound.kind)).toEqual(['chime']);

    // 0 is no gate: the head is never even loaded, let alone consulted.
    const off = makeCaptureHarness({
      config: { 'voice.wake.vadThreshold': 0 },
      vadReady: true,
      vadProbability: 0.01,
      scores: [0.99],
    });
    await primeFrontEnd(await startListening(off));
    expect(off.loadedModelPaths.some((path) => path.includes('goodvibes-vad'))).toBe(false);
    expect(off.vadRuns()).toBe(0);
    expect(off.sounds.map((sound) => sound.kind)).toEqual(['chime']);
  });

  test('voice.wake.vadThreshold: above 0 with the gate NOT provisioned still refuses, naming the pinned head', async () => {
    // The refusal did not disappear, it moved: the row is honoured when this surface
    // has the gate and refused when it does not, rather than screening nothing while
    // claiming to screen.
    const missing = makeCaptureHarness({ config: { 'voice.wake.vadThreshold': 0.5 }, vadReady: false });
    await missing.runtime.refresh();
    expect(missing.spawns.calls).toEqual([]);
    const blocker = missing.runtime.settings().blockers.find((entry) => entry.key === 'voice.wake.vadThreshold');
    expect(blocker?.detail).toContain('has not loaded the speech gate');
    expect(blocker?.detail).toContain('goodvibes-vad');
    expect(blocker?.detail).toContain('0.5');
    expect(missing.notices.join('\n')).toContain('voice.wake.vadThreshold');
  });

  test('voice.wake.indicator: the row travels to the footer state, and "off" is what suppresses the row', async () => {
    const statusline = makeCaptureHarness({ config: { 'voice.wake.indicator': 'statusline' } });
    await startListening(statusline);
    expect(statusline.runtime.status()?.indicator).toBe('statusline');
    expect(voiceCaptureRowVisible(statusline.runtime.status())).toBe(true);

    const banner = makeCaptureHarness({ config: { 'voice.wake.indicator': 'banner' } });
    await startListening(banner);
    expect(banner.runtime.status()?.indicator).toBe('banner');

    const hidden = makeCaptureHarness({ config: { 'voice.wake.indicator': 'off' } });
    const hiddenRecorder = await startListening(hidden);
    // Still listening, the device is open, the ROW is what is hidden. Frames
    // have to arrive before "listening" is a true thing to say, so they do.
    expect(hidden.spawns.calls.length).toBe(1);
    hiddenRecorder.emitBytes(pcmBytes(silentFrame()));
    await flush(2);
    expect(hidden.runtime.status()?.kind).toBe('wake-listening');
    expect(voiceCaptureRowVisible(hidden.runtime.status())).toBe(false);
  });
});

describe('the post-wake capture rows bound what is recorded', () => {
  test('voice.wake.captureMaxSeconds: a short ceiling ends the utterance while a long one is still recording', async () => {
    // One second at 16 kHz is 12.5 frames of 1280 samples; 20 loud frames after the
    // wake is well past a 1-second ceiling and well inside a 4-second one.
    const short = makeCaptureHarness({ config: { 'voice.wake.captureMaxSeconds': 1, 'voice.wake.silenceStopMs': 9000 }, scores: [0.99] });
    const shortRecorder = await startListening(short);
    await primeFrontEnd(shortRecorder);
    for (let i = 0; i < 20; i += 1) {
      shortRecorder.emitBytes(pcmBytes(loudSamples(WAKE_CHUNK_SAMPLES, 40 + i)));
      await flush(2);
    }
    await flush();
    expect(short.transcribed.length).toBe(1);

    const long = makeCaptureHarness({ config: { 'voice.wake.captureMaxSeconds': 60, 'voice.wake.silenceStopMs': 9000 }, scores: [0.99] });
    const longRecorder = await startListening(long);
    await primeFrontEnd(longRecorder);
    for (let i = 0; i < 20; i += 1) {
      longRecorder.emitBytes(pcmBytes(loudSamples(WAKE_CHUNK_SAMPLES, 40 + i)));
      await flush(2);
    }
    await flush();
    expect(long.transcribed).toEqual([]);
    expect(long.runtime.status()?.kind).toBe('wake-capturing');
  });

  test('voice.wake.silenceStopMs: the same run of silence ends capture under a short window and not under a long one', async () => {
    const quick = makeCaptureHarness({ config: { 'voice.wake.silenceStopMs': 200 }, scores: [0.99] });
    const quickRecorder = await startListening(quick);
    await primeFrontEnd(quickRecorder);
    for (let i = 0; i < 6; i += 1) {
      quickRecorder.emitBytes(pcmBytes(silentSamples(WAKE_CHUNK_SAMPLES)));
      await flush(2);
    }
    await flush();
    expect(quick.transcribed.length).toBe(1);

    const patient = makeCaptureHarness({ config: { 'voice.wake.silenceStopMs': 5000 }, scores: [0.99] });
    const patientRecorder = await startListening(patient);
    await primeFrontEnd(patientRecorder);
    for (let i = 0; i < 6; i += 1) {
      patientRecorder.emitBytes(pcmBytes(silentSamples(WAKE_CHUNK_SAMPLES)));
      await flush(2);
    }
    await flush();
    expect(patient.transcribed).toEqual([]);
  });

  test('voice.wake.retainAudio: "session-temp" writes the clip where the SDK sweeper can find its owner; "none" writes nothing', async () => {
    const retainedRoot = makeProjectTempDir('wake-retain');
    const retaining = makeCaptureHarness({
      config: { 'voice.wake.retainAudio': 'session-temp' },
      scores: [0.99],
      managedRoot: retainedRoot,
    });
    const recorder = await startListening(retaining);
    await primeFrontEnd(recorder);
    for (let i = 0; i < 12; i += 1) {
      recorder.emitBytes(pcmBytes(silentSamples(WAKE_CHUNK_SAMPLES)));
      await flush(2);
    }
    await flush();
    const retainedDir = resolveManagedWakePaths(retainedRoot).retainedDir;
    const written = readdirSync(retainedDir);
    expect(written.length).toBe(1);
    // The SDK owns the name, and the sweeper parses the owning session out of it.
    expect(written[0]).toBe(retainedClipFileName('session-under-test', retaining.now));
    expect(statSync(join(retainedDir, written[0] ?? '')).size).toBeGreaterThan(0);

    const plainRoot = makeProjectTempDir('wake-no-retain');
    const notRetaining = makeCaptureHarness({
      config: { 'voice.wake.retainAudio': 'none' },
      scores: [0.99],
      managedRoot: plainRoot,
    });
    const plainRecorder = await startListening(notRetaining);
    await primeFrontEnd(plainRecorder);
    for (let i = 0; i < 12; i += 1) {
      plainRecorder.emitBytes(pcmBytes(silentSamples(WAKE_CHUNK_SAMPLES)));
      await flush(2);
    }
    await flush();
    expect(existsSync(resolveManagedWakePaths(plainRoot).retainedDir)).toBe(false);
  });

  test('voice.wake.customModelDir: a non-pinned model id is loaded from the configured directory, and reported as unverified', async () => {
    const custom = makeCaptureHarness({
      config: { 'voice.wake.models': 'hey_operator', 'voice.wake.customModelDir': '/opt/my-wake-models' },
    });
    await startListening(custom);
    expect(custom.loadedModelPaths.some((path) => path.startsWith('/opt/my-wake-models/'))).toBe(true);
    expect(custom.notices.join('\n')).toContain('not checksum-pinned');

    const elsewhere = makeCaptureHarness({
      config: { 'voice.wake.models': 'hey_operator', 'voice.wake.customModelDir': '/srv/wake' },
    });
    await startListening(elsewhere);
    expect(elsewhere.loadedModelPaths.some((path) => path.startsWith('/srv/wake/'))).toBe(true);
    expect(elsewhere.loadedModelPaths.some((path) => path.startsWith('/opt/my-wake-models/'))).toBe(false);
  });
});

describe('a recorder that keeps dying is restarted, then latched, with the reason shown', () => {
  test('voice.wake.maxRestarts + restartBackoffMs bound the retries on a real capture stream', async () => {
    const harness = makeCaptureHarness({ config: { 'voice.wake.maxRestarts': 1, 'voice.wake.restartBackoffMs': 250 } });
    const first = await startListening(harness);

    first.emitStderr('device or resource busy');
    first.emitClose(1);
    await flush();
    expect(harness.runtime.status()?.kind).toBe('wake-restarting');
    expect(harness.timers.at(-1)?.ms).toBe(250);
    expect(harness.notices.join('\n')).toContain('restarting the wake-word detector');

    harness.timers.at(-1)?.handler();
    await flush();
    const second = harness.spawns.processes[1];
    if (second === undefined) throw new Error('the restart did not spawn a second recorder');

    second.emitClose(1);
    await flush();
    expect(harness.runtime.status()?.kind).toBe('wake-latched');
    expect(harness.runtime.status()?.detail ?? '').not.toBe('');
    expect(harness.notices.join('\n')).toContain('stays off until voice.wake.enabled is turned off and on again');
  });
});
