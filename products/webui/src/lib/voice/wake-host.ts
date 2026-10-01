/**
 * wake-host.ts, the browser tab as a wake-word surface.
 *
 * The SDK owns everything that is identical on every surface: the front end, the
 * scoring rules, the pre-roll, the silence and ceiling policy, the engine reset
 * after a command, the restart/latch policy. `WakeListener` is all of that. What a
 * host owns is four things, and this file is those four:
 *
 *   1. a device      , the shared browser capture opener, through the arbiter,
 *   2. an inference runtime, onnxruntime-web sessions over daemon-served models,
 *   3. what a wake MEANS here, chime, indicator, transcript into the composer,
 *   4. an honest state for a surface to render, including every refusal.
 *
 * DISABLED MEANS THE DEVICE IS NEVER TOUCHED. `voice.wake.surfaces.webui`
 * defaults to false, and while it is false (or `voice.wake.enabled` is off, or a
 * row blocks) this host loads no model, creates no session and calls no
 * `getUserMedia`, so no permission prompt appears. `.active` from the resolver is
 * the ONLY thing consulted for that decision; nothing here re-derives it.
 *
 * A module singleton, for the same reason the TTS engine is one: there is one
 * microphone and one tab. `createWakeHost` is exported beside it so a test drives
 * the real engine and the real listener with a stubbed inference session, rather
 * than testing a second implementation of this logic.
 */
import {
  utteranceToAudioArtifact,
  type AudioCaptureError,
  type AudioCaptureOpener,
  type CapturedUtterance,
  type UtteranceAudioArtifact,
  type NoiseSuppressionFactory,
} from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import {
  WakeListener,
  WakeWordEngine,
  type WakeDetection,
  type WakeInferenceSession,
  type WakeListenerState,
  type WakeModelHandle,
  type WakeRuntimeSettings,
  type WakeStartRefusal,
} from '@goodvibes-jev/engine/sdk/platform/voice/wake/runtime';
import { micArbiter, type MicArbiter } from './mic-arbiter';
import { playWakeChime } from './wake-chime';
import { loadWakeModel, openWakeModelCache, WakeModelError } from './wake-models';
import { loadWakeRuntime, type WakeBrowserBackend } from './wake-runtime';
import { CONFIG_SCHEMA_ENTRIES } from '../generated/config-schema';

/**
 * The model id the daemon actually serves to a tab. Read from this repo's
 * generated schema snapshot (the drift-checked copy of the SDK's own row) rather
 * than spelled here, so it cannot fall out of step with the pinned model.
 */
export const PINNED_WAKE_MODEL_ID: string = (() => {
  const row = CONFIG_SCHEMA_ENTRIES.find((entry) => entry.key === 'voice.wake.models');
  const value = typeof row?.default === 'string' ? row.default.split(',')[0]?.trim() : '';
  return value && value.length > 0 ? value : 'hey_goodvibes';
})();

/** What this tab is doing about wake detection, for an indicator that must not lie. */
export type WakeHostPhase =
  /** Not enabled here. No device, no download, no permission prompt. */
  | 'off'
  /** Enabled but refused, a blocker, a latch, a permission the user denied. */
  | 'refused'
  /** Fetching and verifying models, or bringing the runtime up. */
  | 'loading'
  /** The microphone is open and every frame is being scored. */
  | 'listening'
  /** A wake confirmed; the utterance that follows is being recorded. */
  | 'capturing'
  /** The utterance is at speech-to-text. */
  | 'transcribing'
  /** The stream died and the supervisor is waiting out its backoff. */
  | 'restarting'
  /** The supervisor gave up. Needs a deliberate off/on to run again. */
  | 'latched'
  /** Stood down so a push-to-talk press can hold the device. */
  | 'suspended';

export interface WakeHostState {
  readonly phase: WakeHostPhase;
  /** `voice.wake.indicator`, or 'off' when nothing is enabled. */
  readonly indicator: 'off' | 'statusline' | 'banner';
  readonly settings: WakeRuntimeSettings | null;
  /** What opened the device, e.g. "getUserMedia (AudioWorklet)"; null when closed. */
  readonly deviceLabel: string | null;
  /** Why the detector is not running, written for a user to read. */
  readonly refusal: { readonly kind: WakeStartRefusal | 'model-unavailable'; readonly detail: string } | null;
  /** The most recent failure's message, or null. */
  readonly error: string | null;
  /** The inference backend actually in force, once a runtime has loaded. */
  readonly backend: WakeBrowserBackend | null;
  /** Written reason the requested backend was not the one used, or null. */
  readonly backendNote: string | null;
  readonly restarts: number;
  readonly lastWakeAt: number | null;
  /** The last transcript this host handed onward, for a receipt in the UI. */
  readonly lastTranscript: string | null;
  readonly modelIds: readonly string[];
}

const IDLE_STATE: WakeHostState = {
  phase: 'off',
  indicator: 'off',
  settings: null,
  deviceLabel: null,
  refusal: null,
  error: null,
  backend: null,
  backendNote: null,
  restarts: 0,
  lastWakeAt: null,
  lastTranscript: null,
  modelIds: [],
};

/** Where a finished transcript goes. Registered by the view that owns a composer. */
export type WakeTranscriptSink = (text: string, options: { readonly autoSubmit: boolean }) => void;

/** One loaded runtime plus its sessions, ready for an engine. */
export interface WakeModelSet {
  readonly embedding: WakeInferenceSession;
  readonly models: readonly WakeModelHandle[];
  /**
   * The speech gate, present only when `voice.wake.vadThreshold` asks for one AND
   * its artifact is provisioned. Absent means every frame is scored, which is what
   * the shipped default of 0 asks for, never a gate that failed to load, because
   * that is a startup blocker from resolveWakeRuntimeSettings.
   */
  readonly vad?: { readonly session: WakeInferenceSession; readonly threshold: number } | undefined;
  readonly backend: WakeBrowserBackend;
  readonly fallbackReason: string | null;
  /** Rows that are configured but cannot be honoured, e.g. an unservable model id. */
  readonly limitations: readonly string[];
  release(): Promise<void>;
}

export interface WakeHostDeps {
  /** The device path. Defaults to the arbiter's, which refuses a second stream. */
  readonly openCapture: AudioCaptureOpener;
  /** Loads models and the inference runtime for a resolved configuration. */
  readonly loadModelSet: (settings: WakeRuntimeSettings) => Promise<WakeModelSet>;
  /**
   * Builds the speex suppression stage. The SDK's listener wraps the opener and
   * defaults to the embedded WebAssembly filter; injected here so a test can check
   * that captured frames REACH a stage without compiling one, while the filter's
   * own numbers stay the SDK's to assert.
   */
  readonly createNoiseSuppression?: NoiseSuppressionFactory | undefined;
  /** Sends an utterance to speech-to-text and returns the text. */
  readonly transcribe: (artifact: UtteranceAudioArtifact) => Promise<string>;
  /** Plays the activation sound; false when this tab could not make a sound. */
  readonly chime: () => boolean;
  /** Registers this host so a push-to-talk press can stand it down. */
  readonly arbiter: Pick<MicArbiter, 'registerWake'> | null;
  readonly warn: (message: string, meta?: Readonly<Record<string, unknown>>) => void;
  readonly now?: (() => number) | undefined;
}

/** A signature of the rows that require the listener to be rebuilt when they change. */
function runtimeSignature(settings: WakeRuntimeSettings): string {
  return JSON.stringify([
    settings.active,
    settings.modelIds,
    settings.tuning,
    settings.capture,
    settings.preRollMs,
    settings.captureMaxSeconds,
    settings.silenceStopMs,
    settings.supervisor,
    settings.browserBackend,
  ]);
}

export class WakeHost {
  readonly #deps: WakeHostDeps;
  readonly #listeners = new Set<() => void>();
  #state: WakeHostState = IDLE_STATE;
  #listener: WakeListener | null = null;
  #modelSet: WakeModelSet | null = null;
  #signature: string | null = null;
  #sink: WakeTranscriptSink | null = null;
  #unregisterWake: (() => void) | null = null;
  /** Serialises apply/suspend/resume so two config updates cannot overlap. */
  #chain: Promise<void> = Promise.resolve();
  /** True while the arbiter holds the device for a push-to-talk press. */
  #suspended = false;
  #settings: WakeRuntimeSettings | null = null;

  constructor(deps: WakeHostDeps) {
    this.#deps = deps;
  }

  getState(): WakeHostState {
    return this.#state;
  }

  subscribe(onChange: () => void): () => void {
    this.#listeners.add(onChange);
    return () => this.#listeners.delete(onChange);
  }

  /**
   * Register where transcripts go. Returns the unregister function. The host keeps
   * working with no sink registered, it still listens, chimes and transcribes,
   * and reports the transcript in its own state, so a wake is never silently lost
   * because no view happened to be mounted.
   */
  setTranscriptSink(sink: WakeTranscriptSink): () => void {
    this.#sink = sink;
    return () => {
      if (this.#sink === sink) this.#sink = null;
    };
  }

  /**
   * Apply a freshly resolved configuration. Idempotent: an identical
   * configuration is a no-op, so this can be called from a render path on every
   * `config.get` refetch.
   */
  applySettings(settings: WakeRuntimeSettings | null): Promise<void> {
    return this.#run(async () => {
      this.#settings = settings;
      if (settings === null) {
        await this.#teardown();
        this.#patch({ ...IDLE_STATE });
        return;
      }
      const signature = runtimeSignature(settings);
      const unchanged = signature === this.#signature && this.#listener !== null;
      if (unchanged) {
        // Indicator and the written blocker/limitation lists can change without
        // the runtime needing a rebuild.
        this.#patch({ settings, indicator: settings.active ? settings.indicator : 'off' });
        return;
      }
      this.#signature = signature;
      await this.#teardown();

      if (!settings.active) {
        // The one place the "never open a device while disabled" rule is enforced:
        // nothing below this line runs, so no model is fetched and getUserMedia is
        // never called.
        const askedForHere = settings.enabled && settings.surfaceEnabled;
        this.#patch({
          ...IDLE_STATE,
          settings,
          phase: askedForHere ? 'refused' : 'off',
          // A user who switched this on for this origin and got a blocker still
          // gets the indicator, carrying the reason, the alternative is a feature
          // that reads as enabled and shows nothing anywhere.
          indicator: askedForHere ? settings.indicator : 'off',
          refusal: describeInactive(settings),
        });
        return;
      }
      await this.#startListening(settings);
    });
  }

  /** Stand down and release the device, so a press can take it. */
  suspend(): Promise<void> {
    return this.#run(async () => {
      if (this.#listener === null) return;
      this.#suspended = true;
      await this.#listener.stop();
      this.#patch({ phase: 'suspended', deviceLabel: null });
    });
  }

  /** Start listening again after a press released the device. */
  resume(): Promise<void> {
    return this.#run(async () => {
      if (!this.#suspended) return;
      this.#suspended = false;
      const settings = this.#settings;
      if (!settings?.active) return;
      const listener = this.#listener;
      if (listener === null) {
        await this.#startListening(settings);
        return;
      }
      const outcome = await listener.start();
      if (outcome.started) {
        this.#patch({ phase: 'listening', deviceLabel: outcome.deviceLabel, refusal: null });
      } else {
        this.#patch({ phase: 'refused', refusal: { kind: outcome.refusal, detail: outcome.detail } });
      }
    });
  }

  /** Stop for good and release everything. */
  stop(): Promise<void> {
    return this.#run(async () => {
      await this.#teardown();
      this.#signature = null;
      this.#patch({ ...IDLE_STATE, settings: this.#settings });
    });
  }

  /** Clear a latched supervisor. The deliberate act the latch waits for. */
  clearLatch(): void {
    this.#listener?.clearLatch();
    this.#patch({ error: null });
    const settings = this.#settings;
    if (settings?.active === true) void this.resume();
  }

  #run(step: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(step, step);
    this.#chain = next.catch((error: unknown) => {
      this.#deps.warn('wake host step failed', { error: String(error) });
    });
    return this.#chain;
  }

  async #teardown(): Promise<void> {
    this.#unregisterWake?.();
    this.#unregisterWake = null;
    const listener = this.#listener;
    this.#listener = null;
    if (listener !== null) await listener.stop();
    const modelSet = this.#modelSet;
    this.#modelSet = null;
    if (modelSet !== null) {
      try {
        await modelSet.release();
      } catch (error) {
        this.#deps.warn('releasing wake inference sessions failed', { error: String(error) });
      }
    }
  }

  async #startListening(settings: WakeRuntimeSettings): Promise<void> {
    this.#patch({
      ...IDLE_STATE,
      settings,
      phase: 'loading',
      indicator: settings.indicator,
    });

    let modelSet: WakeModelSet;
    try {
      modelSet = await this.#deps.loadModelSet(settings);
    } catch (error) {
      const detail = error instanceof WakeModelError
        ? error.message
        : `The wake-word models could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
      this.#patch({ phase: 'refused', refusal: { kind: 'model-unavailable', detail }, error: detail });
      return;
    }
    this.#modelSet = modelSet;

    const listener = new WakeListener({
      settings,
      openCapture: this.#deps.openCapture,
      ...(this.#deps.createNoiseSuppression !== undefined
        ? { createNoiseSuppression: this.#deps.createNoiseSuppression }
        : {}),
      createEngine: () => Promise.resolve(new WakeWordEngine({
        embedding: modelSet.embedding,
        models: modelSet.models,
        tuning: settings.tuning,
        preRollMs: settings.preRollMs,
        ...(modelSet.vad !== undefined ? { vad: modelSet.vad } : {}),
        // Required in practice: the engine no longer imports a logger (that pulled
        // node:fs and made it unbundleable here), so a model that misbehaves is
        // only ever visible through this sink.
        warn: this.#deps.warn,
      })),
      handlers: {
        onStateChange: (state) => this.#onListenerState(state),
        onWake: ({ activationSound }) => {
          const played = activationSound.kind === 'chime' ? this.#deps.chime() : true;
          if (!played) this.#deps.warn('wake confirmed but this tab could not play the activation chime');
          this.#patch({ phase: 'capturing' });
        },
        onUtterance: (utterance, detection) => {
          void this.#onUtterance(utterance, detection);
        },
        onFailure: (error, restarting, detail) => this.#onFailure(error, restarting, detail),
      },
      warn: this.#deps.warn,
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });
    this.#listener = listener;

    const outcome = await listener.start();
    if (!outcome.started) {
      this.#patch({
        phase: outcome.refusal === 'blocked' ? 'latched' : 'refused',
        refusal: { kind: outcome.refusal, detail: outcome.detail },
        error: outcome.detail,
      });
      return;
    }

    if (this.#deps.arbiter) {
      this.#unregisterWake = this.#deps.arbiter.registerWake({
        suspend: () => this.suspend(),
        resume: () => this.resume(),
      });
    }

    this.#patch({
      phase: 'listening',
      deviceLabel: outcome.deviceLabel,
      backend: modelSet.backend,
      backendNote: modelSet.fallbackReason,
      modelIds: modelSet.models.map((model) => model.id),
      refusal: null,
      error: null,
    });
  }

  #onListenerState(state: WakeListenerState): void {
    // The listener's own phases map onto this host's, EXCEPT while a transcript is
    // in flight (the listener is back to 'listening' by then, but the user is
    // waiting on words) and while suspended (the host stopped it deliberately).
    if (this.#suspended) return;
    if (this.#state.phase === 'transcribing' && state.phase === 'listening') return;
    const phase: WakeHostPhase = state.phase === 'listening'
      ? 'listening'
      : state.phase === 'capturing-utterance'
        ? 'capturing'
        : state.phase === 'restarting'
          ? 'restarting'
          : state.phase === 'latched'
            ? 'latched'
            : state.phase === 'starting'
              ? 'loading'
              : this.#state.phase;
    this.#patch({
      phase,
      deviceLabel: state.deviceLabel,
      restarts: state.restarts,
      lastWakeAt: state.lastWakeAt,
      ...(state.latchReason ? { refusal: { kind: 'blocked' as const, detail: state.latchReason } } : {}),
      ...(state.lastError ? { error: state.lastError } : {}),
    });
  }

  async #onUtterance(utterance: CapturedUtterance, detection: WakeDetection): Promise<void> {
    if (utterance.silent) {
      // Nothing above the silence floor followed the wake. Sending that to a
      // provider bills a request to transcribe a room, so it is reported instead.
      this.#deps.warn('a wake fired but nothing was said after it', { modelId: detection.modelId });
      this.#patch({ phase: 'listening', error: 'A wake fired but nothing was said after it, nothing was sent.' });
      return;
    }
    this.#patch({ phase: 'transcribing' });
    try {
      const artifact = utteranceToAudioArtifact(utterance);
      const text = (await this.#deps.transcribe(artifact)).trim();
      const autoSubmit = this.#settings?.autoSubmit === true;
      this.#patch({ phase: this.#listener === null ? 'off' : 'listening', lastTranscript: text, error: null });
      if (text.length > 0) this.#sink?.(text, { autoSubmit });
      else this.#patch({ error: 'Speech-to-text returned no words for that utterance.' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#patch({
        phase: this.#listener === null ? 'off' : 'listening',
        error: `The utterance after the wake could not be transcribed: ${detail}`,
      });
    }
  }

  #onFailure(error: AudioCaptureError, restarting: boolean, detail: string): void {
    this.#patch({
      phase: restarting ? 'restarting' : 'latched',
      error: detail || error.message,
      deviceLabel: null,
      ...(restarting ? {} : { refusal: { kind: 'blocked' as const, detail: detail || error.message } }),
    });
  }

  #patch(next: Partial<WakeHostState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }
}

/** The written reason an inactive configuration is inactive. */
function describeInactive(settings: WakeRuntimeSettings): WakeHostState['refusal'] {
  if (!settings.enabled) {
    return {
      kind: 'disabled',
      detail: 'voice.wake.enabled is off, so no microphone is opened anywhere.',
    };
  }
  if (!settings.surfaceEnabled) {
    return {
      kind: 'surface-disabled',
      detail: 'voice.wake.surfaces.webui is off, so this browser tab does not listen and never asks for the '
        + 'microphone. Turn it on here to opt this origin in.',
    };
  }
  const blocker = settings.blockers[0];
  if (settings.blockers.length > 0 && blocker !== undefined) {
    return { kind: 'blocked', detail: `${blocker.key} ${blocker.detail}` };
  }
  return null;
}

// ─── The browser's default dependencies ──────────────────────────────────────

/**
 * Load the classifier and the embedding backbone from the daemon, verify both,
 * and bring an inference runtime up over them.
 *
 * Only the PINNED classifier is servable to a tab: `voice.wake.model` reads the
 * managed artifacts, and a custom model in `voice.wake.customModelDir` lives on
 * the host's disk with no route to fetch it. Extra ids are therefore reported as a
 * limitation rather than silently relabelled onto the pinned model, a detector
 * that says it is running your model and is running a different one is worse than
 * one that says it cannot.
 */
export function createBrowserModelSetLoader(deps: {
  readonly readChunk: Parameters<typeof loadWakeModel>[1]['readChunk'];
  readonly modelVersion: () => Promise<string | null>;
  readonly warn: (message: string, meta?: Readonly<Record<string, unknown>>) => void;
}): (settings: WakeRuntimeSettings) => Promise<WakeModelSet> {
  return async (settings) => {
    const [modelVersion, cache] = await Promise.all([deps.modelVersion(), openWakeModelCache()]);
    const loaderDeps = {
      readChunk: deps.readChunk,
      modelVersion,
      warn: deps.warn,
      ...(cache ? { cache } : {}),
    };
    const wantsGate = settings.vadThreshold > 0;
    const [embeddingBytes, classifierBytes, vadBytes] = await Promise.all([
      loadWakeModel('embedding', loaderDeps),
      loadWakeModel('classifier', loaderDeps),
      // Fetched, cached and CHECKSUM-VERIFIED exactly like the other two, a gate
      // assembled from a truncated transfer would screen frames by accident.
      wantsGate ? loadWakeModel('vad', loaderDeps) : Promise.resolve(null),
    ]);

    const runtime = await loadWakeRuntime(settings.browserBackend);
    const embedding = await runtime.createSession(embeddingBytes.bytes);
    const classifier = await runtime.createSession(classifierBytes.bytes);
    const vadSession = vadBytes === null ? null : await runtime.createSession(vadBytes.bytes);

    const limitations: string[] = [];
    const unservable = settings.modelIds.filter((id) => id !== PINNED_WAKE_MODEL_ID);
    if (unservable.length > 0) {
      limitations.push(
        `voice.wake.models names ${unservable.join(', ')}, which a browser tab cannot load: the daemon serves the `
        + `pinned "${PINNED_WAKE_MODEL_ID}" classifier, and a custom model lives on the host's disk with no route to `
        + 'fetch it here. Only the pinned model is being scored in this tab.',
      );
    }
    const models: WakeModelHandle[] = settings.modelIds.includes(PINNED_WAKE_MODEL_ID)
      ? [{ id: PINNED_WAKE_MODEL_ID, session: classifier }]
      : [];
    if (models.length === 0) {
      limitations.push(
        `voice.wake.models does not include "${PINNED_WAKE_MODEL_ID}", so this tab scores nothing. Capture is still `
        + 'available for dictation.',
      );
    }

    return {
      embedding,
      models,
      ...(vadSession !== null ? { vad: { session: vadSession, threshold: settings.vadThreshold } } : {}),
      backend: runtime.backend,
      fallbackReason: runtime.fallbackReason,
      limitations,
      release: async () => {
        await Promise.all([embedding.release?.(), classifier.release?.(), vadSession?.release?.()]);
      },
    };
  };
}

/**
 * Create a host over explicit dependencies. Used by the singleton below and by
 * tests, which supply a fake capture stream and a stub inference session so the
 * REAL engine and the REAL listener are what gets exercised.
 */
export function createWakeHost(deps: WakeHostDeps): WakeHost {
  return new WakeHost(deps);
}

/** Warnings go to the console: a tab has no log file, and silence is worse. */
function consoleWarn(message: string, meta?: Readonly<Record<string, unknown>>): void {
  if (meta) console.warn(`[wake] ${message}`, meta);
  else console.warn(`[wake] ${message}`);
}

export const wakeHostWarn = consoleWarn;

/** Placeholder dependencies replaced by `installWakeHostDaemonDeps` at boot. */
const unwiredLoader: WakeHostDeps['loadModelSet'] = () => {
  throw new Error('The wake-word host has no daemon connection wired yet.');
};
const unwiredTranscribe: WakeHostDeps['transcribe'] = () => {
  throw new Error('The wake-word host has no speech-to-text connection wired yet.');
};

const mutableDeps: {
  loadModelSet: WakeHostDeps['loadModelSet'];
  transcribe: WakeHostDeps['transcribe'];
} = { loadModelSet: unwiredLoader, transcribe: unwiredTranscribe };

/**
 * The tab's wake host.
 *
 * Its daemon-facing dependencies are installed by `installWakeHostDaemonDeps`
 * rather than imported here, so this module does not pull `lib/goodvibes` (and
 * with it the whole SDK client surface) into the import graph of anything that
 * only wants the capture primitive.
 */
export const wakeHost: WakeHost = createWakeHost({
  openCapture: micArbiter.openCapture,
  loadModelSet: (settings) => mutableDeps.loadModelSet(settings),
  transcribe: (artifact) => mutableDeps.transcribe(artifact),
  chime: () => playWakeChime(),
  arbiter: micArbiter,
  warn: consoleWarn,
});

/** Wire the singleton's daemon-facing calls. Called once, from the voice hooks. */
export function installWakeHostDaemonDeps(deps: {
  readonly loadModelSet: WakeHostDeps['loadModelSet'];
  readonly transcribe: WakeHostDeps['transcribe'];
}): void {
  mutableDeps.loadModelSet = deps.loadModelSet;
  mutableDeps.transcribe = deps.transcribe;
}
