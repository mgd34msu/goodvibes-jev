/**
 * wake-runtime.ts, wake-word detection on the Agent surface.
 *
 * The SDK owns the policy that would otherwise be rewritten per surface: the
 * front end, the patience/cooldown rules, keeping ONE stream open across a wake
 * so the utterance that follows is not clipped, resetting the engine afterwards
 * so the command just spoken is not scored again, and the supervisor's restart
 * and latch decisions. What is local is everything that touches this machine,
 * the recorder subprocess (capture.ts), the inference runtime (wake-inference.ts),
 * transcription through this process's own voice service
 * (core/voice-stt-gateway.ts), the activation sound, and the footer's listening
 * row.
 *
 * TWO THINGS ARE DELIBERATELY NOT AUTOMATIC
 *
 *  - **Turning it on is not a download trigger, but a missing model is not the
 *    user's errand either.** Enabling wake detection on a host whose artifacts
 *    are absent FETCHES them here, once, and says what it fetched. What it never
 *    does is start a detector that could not score anything, and what it must
 *    never do is print an instruction telling someone to go and run a command
 *    for work this process is holding the ability to do.
 *  - **Disabled means no device is opened at all.** `settings.active` is the only
 *    thing consulted before opening a microphone, and the SDK listener re-checks
 *    it and refuses without touching the capture opener. A configuration that is
 *    off must never produce a microphone permission prompt, and on this surface
 *    that gate is a DOUBLE one: `voice.wake.enabled` and
 *    `voice.wake.surfaces.agent` both have to be on, because the Agent shares a
 *    terminal with the coding shell and two surfaces acting on one spoken
 *    utterance is the confusing default the row exists to avoid.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeWakeListening,
  recordVoiceDiagnostic,
  WakeListener,
  encodeWavPcm16,
  resolveManagedWakePaths,
  resolveWakeModelFiles,
  resolveWakeRuntimeSettings,
  retainedClipFileName,
  utteranceToAudioArtifact,
  wakeProvisionStatus,
  type AudioCaptureOpener,
  type CapturedUtterance,
  type AudioInputDeviceEnumerator,
  type WakeListenerOptions,
  type WakeListenerState,
  type WakeRuntimeSettings,
} from '@goodvibes-jev/engine/sdk/platform/voice';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { agentWakeCapabilities, describeWakeBlockers, describeWakeLimitations } from '../core/wake-provision-status.ts';
import { createWakeEngineFactory } from './wake-inference.ts';
import { AGENT_WAKE_SURFACE } from './wake-surface.ts';
import type { VoiceSttGateway } from '../core/voice-stt-gateway.ts';
import { describeTranscriptionFailure } from '../core/voice-stt-gateway.ts';

// Re-exported from its own dependency-free module: the settings path needs this
// name and must not pull the inference runtime in behind it (see wake-surface.ts).
export { AGENT_WAKE_SURFACE } from './wake-surface.ts';

/**
 * The row for a listener state, derived from CAPTURE TRUTH.
 *
 * This used to be a map from the listener's PHASE, with `starting` pointing at
 * the listening row. A start that never finished therefore rendered "listening
 * for the wake phrase" for an entire boot on a machine with no capture stream,
 * no recorder process and nothing in the log. The SDK now answers what may be
 * claimed, `describeWakeListening`, which requires a stream open AND frames
 * arriving, and this only chooses which row shows it.
 */
function indicatorFor(state: WakeListenerState): VoiceCaptureIndicatorState['kind'] | null {
  const claim = describeWakeListening(state);
  if (claim.kind === 'listening') {
    return state.phase === 'capturing-utterance' ? 'wake-capturing' : 'wake-listening';
  }
  if (claim.kind === 'starting') return 'wake-starting';
  if (claim.kind === 'no-audio') return 'wake-no-audio';
  if (state.phase === 'restarting') return 'wake-restarting';
  if (state.phase === 'latched') return 'wake-latched';
  if (state.deviceBinding?.state === 'no-microphone') return 'wake-no-microphone';
  return null;
}

export interface WakeRuntimeDeps {
  /** Reads a config key. Live-read on every refresh, never frozen at startup. */
  readonly readConfig: (key: string) => unknown;
  /** Runtime toggling: `voice.wake.enabled` and `voice.wake.surfaces.agent`. */
  readonly subscribeConfig: (key: string, listener: () => void) => () => void;
  readonly openCapture: AudioCaptureOpener;
  /** Managed root the wake tree hangs off, `<managed>/wake` (SDK resolveManagedWakePaths). */
  readonly managedRoot: string;
  /** Directory this surface owns for the extracted onnxruntime assets. */
  readonly assetDirectory: string;
  /**
   * Builds the noise-suppression stage. Passed straight to the SDK listener, which
   * is what wraps this surface's opener with it; injected only so a test can drive
   * the stage deterministically instead of instantiating WebAssembly.
   */
  readonly createNoiseSuppression?: WakeListenerOptions['createNoiseSuppression'];
  readonly resolveTranscriber: () => { readonly available: true; readonly gateway: VoiceSttGateway } | { readonly available: false; readonly reason: string };
  /**
   * Fetch the wake artifacts this host is missing. Called when the feature is
   * on and the models are not on disk, the platform completes the request
   * rather than handing back a command to type. Absent in a composition with no
   * provisioner, where the honest report is that they are missing.
   */
  readonly ensureProvisioned?: (() => Promise<{ readonly ready: boolean; readonly message: string }>) | undefined;
  /**
   * Lists this host's input devices so the SDK can validate
   * `voice.wake.inputDevice` rather than believe it. Omitted, the pin is used
   * as written, the behaviour before any of this existed.
   */
  readonly enumerateInputDevices?: AudioInputDeviceEnumerator | undefined;
  /** Plays the resolved activation sound at the moment of a wake. */
  readonly playActivationSound: (sound: WakeRuntimeSettings['activationSound']) => void;
  /** Submits the recognised text as a turn (`voice.wake.autoSubmit` on). */
  readonly submitTurn: (text: string) => void;
  /** Writes the recognised text into the composer (`voice.wake.autoSubmit` off). */
  readonly writeDraft: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
  /** Names the retained clip so the SDK sweeper can reap it when this session ends. */
  readonly sessionId: string;
  readonly warn: (message: string, meta?: Readonly<Record<string, unknown>>) => void;
  /** Injected in tests: a stub inference session per model path. */
  readonly loadSession?: WakeRuntimeTestSeams['loadSession'];
  /** Injected in tests: skips the on-disk provisioning check. */
  readonly provisionStatus?: WakeRuntimeTestSeams['provisionStatus'];
  readonly now?: () => number;
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** The two seams a test replaces so no model file and no runtime are needed. */
export interface WakeRuntimeTestSeams {
  readonly loadSession: Parameters<typeof createWakeEngineFactory>[0]['loadSession'];
  /**
   * `vadReady` is read from here too, and NOT separately: the same answer decides
   * whether this surface claims `vadAvailable` to the settings resolver and whether
   * the engine factory loads the gate, so the claim and the wiring move together.
   */
  readonly provisionStatus: (managedRoot: string) => {
    readonly ready: boolean;
    readonly reason: string | null;
    readonly vadReady: boolean;
  };
}

export interface WakeRuntime {
  /**
   * Apply the current configuration: start the detector when it should run, stop
   * it when it should not. Called once at startup and on every change to the two
   * enablement rows.
   */
  refresh(): Promise<void>;
  /** Current footer row, or null when nothing is listening. */
  status(): VoiceCaptureIndicatorState | null;
  /** The resolved settings, for a status surface. */
  settings(): WakeRuntimeSettings;
  /** Stop and release the device. Registered in the shell's teardown registry. */
  stop(): Promise<void>;
}

/** Wire wake detection. Nothing is opened until `refresh()` finds it active. */
export function wireWakeRuntime(deps: WakeRuntimeDeps): WakeRuntime {
  let listener: WakeListener | null = null;
  let phase: WakeListenerState['phase'] = 'idle';
  let deviceLabel: string | null = null;
  let detail: string | undefined;
  /**
   * Whether the speech gate is on disk and verified, as of the last refresh.
   *
   * Cached rather than read inside `resolve()` on purpose: `status()` resolves
   * settings and is called from the render path, so a disk read there would put
   * five `stat`s behind every frame. False until the first refresh, which is the
   * safe direction, it means `voice.wake.vadThreshold` above 0 is refused until
   * this surface has actually confirmed it has the gate.
   */
  let vadReady = false;
  /**
   * Why the last start refused, kept so the row can say it after the listener
   * is gone. A machine with no microphone refuses, and rendering nothing there
   * is the silence this whole change exists to end.
   */
  let refusal: { kind: VoiceCaptureIndicatorState['kind']; message: string } | null = null;

  const readProvision = deps.provisionStatus ?? ((root: string) => wakeProvisionStatus({ managedRoot: root }));

  const resolve = (): WakeRuntimeSettings => resolveWakeRuntimeSettings(
    deps.readConfig,
    AGENT_WAKE_SURFACE,
    agentWakeCapabilities({ vadReady }),
  );

  const status = (): VoiceCaptureIndicatorState | null => {
    const active = listener;
    if (active === null) {
      // Refused to start: the row still has something honest to say, and a
      // machine with no microphone must not simply render nothing.
      if (refusal === null) return null;
      return {
        kind: refusal.kind,
        deviceLabel: null,
        indicator: resolve().indicator,
        detail: refusal.message,
      };
    }
    // Asked of the LIVE listener rather than remembered from the last state
    // change: whether frames are still arriving is a question about now, and a
    // cached answer is how "listening" outlives the audio.
    const state = active.state();
    const kind = indicatorFor(state);
    if (kind === null) return null;
    return {
      kind,
      deviceLabel,
      indicator: resolve().indicator,
      detail: describeWakeListening(state).message,
    };
  };

  /** Write one capture-path fact to the surface's voice diagnostics. */
  const recordDiagnostic = (ok: boolean, operation: string, error: string | undefined, detailText: string): void => {
    recordVoiceDiagnostic(deps.managedRoot, {
      at: new Date().toISOString(),
      operation,
      route: 'in-process',
      ok,
      provider: 'wake capture',
      configSource: `voice.wake.inputDevice=${String(deps.readConfig('voice.wake.inputDevice') ?? '')|| '(system default)'}, `
        + `voice.wake.captureCommand=${String(deps.readConfig('voice.wake.captureCommand') ?? 'auto')}`,
      ...(error !== undefined ? { error } : {}),
      detail: detailText,
    });
  };

  const retainClip = (utterance: CapturedUtterance): void => {
    const retainedDir = resolveManagedWakePaths(deps.managedRoot).retainedDir;
    try {
      mkdirSync(retainedDir, { recursive: true });
      // The SDK owns the filename, and it is load-bearing rather than cosmetic: the
      // recovery sweeper reads the owning session id from the first `--`-delimited
      // segment, so a name invented here would get a live session's clips reaped as
      // orphans (or leave them unreaped forever).
      const target = join(retainedDir, retainedClipFileName(deps.sessionId, (deps.now ?? Date.now)()));
      writeFileSync(target, encodeWavPcm16(utterance.samples, utterance.sampleRate));
    } catch (error) {
      deps.warn('retaining the wake clip failed', { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const transcribeUtterance = async (utterance: CapturedUtterance, settings: WakeRuntimeSettings): Promise<void> => {
    if (settings.retainAudio === 'session-temp') retainClip(utterance);
    if (utterance.silent) {
      deps.notify('[Wake] Heard the wake phrase but nothing above the silence floor followed it.');
      deps.render();
      return;
    }
    const resolution = deps.resolveTranscriber();
    if (!resolution.available) {
      deps.notify(`[Wake] Captured the utterance after the wake phrase but could not transcribe it: ${resolution.reason}`);
      // Written down as well as shown. A notification scrolls away; this is
      // what makes the question "why did voice stop working" answerable later.
      recordVoiceDiagnostic(deps.managedRoot, {
        at: new Date().toISOString(),
        operation: 'wake-transcribe',
        route: 'none',
        ok: false,
        provider: 'none',
        configSource: 'no speech-to-text route resolved on this surface',
        error: resolution.reason,
      });
      deps.render();
      return;
    }
    try {
      const text = (await resolution.gateway.transcribe(utteranceToAudioArtifact(utterance))).trim();
      if (text.length === 0) {
        deps.notify('[Wake] Speech-to-text returned no words for what followed the wake phrase.');
        deps.render();
        return;
      }
      if (settings.autoSubmit) deps.submitTurn(text);
      else {
        deps.writeDraft(text);
        deps.notify('[Wake] Transcript placed in the composer (voice.wake.autoSubmit is off, press Enter to send it).');
        deps.render();
      }
    } catch (error) {
      const detail = describeTranscriptionFailure(error);
      deps.notify(`[Wake] Transcription failed: ${detail}`);
      // The SDK's routing records each ROUTE's own attempt; this records the
      // failure of the whole act, which is the entry that says a wake fired and
      // produced nothing.
      recordVoiceDiagnostic(deps.managedRoot, {
        at: new Date().toISOString(),
        operation: 'wake-transcribe',
        route: 'none',
        ok: false,
        provider: 'every available route',
        configSource: 'this surface\'s resolved speech-to-text routes',
        error: detail,
      });
      deps.render();
    }
  };

  const start = async (settings: WakeRuntimeSettings, provision: { readonly ready: boolean; readonly reason: string | null }): Promise<void> => {
    let ready = provision.ready;
    if (!ready) {
      if (deps.ensureProvisioned === undefined) {
        deps.notify(
          `[Wake] Wake detection is on, but the wake models are not on this host (${provision.reason ?? 'not-provisioned'}), `
          + 'and this surface has no provisioner wired, so nothing is listening.',
        );
        deps.render();
        return;
      }
      // The models are the platform's job, not an errand for the user.
      deps.notify('[Wake] The wake models are not on this host yet, fetching and verifying them now.');
      deps.render();
      const outcome = await deps.ensureProvisioned();
      ready = outcome.ready;
      deps.notify(`[Wake] ${outcome.message}`);
      if (!ready) {
        deps.render();
        return;
      }
      // Re-read from disk: the provisioner's own word is not the last one.
      const after = readProvision(deps.managedRoot);
      vadReady = after.vadReady;
      if (!after.ready) {
        deps.notify(`[Wake] The wake models still do not verify on disk (${after.reason ?? 'not-provisioned'}), so nothing is listening.`);
        deps.render();
        return;
      }
    }
    const paths = resolveManagedWakePaths(deps.managedRoot);
    // The SDK resolves `voice.wake.models` to files: the pinned id inside the
    // managed tree, any other id against voice.wake.customModelDir, and when that
    // row is empty, against the managed `custom` directory, which is the fallback
    // the row's description promises and the one a host would otherwise get wrong
    // by looking in the process's working directory.
    const modelFiles = resolveWakeModelFiles(settings.modelIds, {
      managedRoot: deps.managedRoot,
      customModelDir: settings.customModelDir,
    });
    const unpinned = modelFiles.filter((model) => !model.pinned);
    if (unpinned.length > 0) {
      // Worth saying out loud: these bytes were never checksum-verified.
      deps.notify(`[Wake] Loading ${unpinned.length} custom model${unpinned.length === 1 ? '' : 's'} that ${unpinned.length === 1 ? 'is' : 'are'} not checksum-pinned: ${unpinned.map((model) => `${model.id} (${model.path})`).join(', ')}`);
    }
    const active = new WakeListener({
      settings,
      openCapture: deps.openCapture,
      createEngine: createWakeEngineFactory({
        assetDirectory: deps.assetDirectory,
        embeddingPath: paths.embeddingPath,
        models: modelFiles.map((model) => ({ id: model.id, path: model.path })),
        // Same `vadReady` the capability claim above was built from.
        vad: { path: paths.vadPath, ready: vadReady },
        settings,
        warn: deps.warn,
        ...(deps.loadSession !== undefined ? { loadSession: deps.loadSession } : {}),
      }),
      ...(deps.createNoiseSuppression !== undefined ? { createNoiseSuppression: deps.createNoiseSuppression } : {}),
      // Every completed capture leaves a receipt (floor, stop reason, timings)
      // in the shared voice diagnostics, so "it kept listening" is a number,
      // not a mystery.
      recordDiagnostic: (entry) => recordVoiceDiagnostic(deps.managedRoot, entry),
      handlers: {
        onStateChange: (state) => {
          phase = state.phase;
          deviceLabel = state.deviceLabel;
          if (state.phase === 'latched') detail = state.latchReason ?? undefined;
          deps.render();
        },
        onWake: (event) => {
          deps.playActivationSound(event.activationSound);
          deps.render();
        },
        onUtterance: (utterance) => { void transcribeUtterance(utterance, settings); },
        onDeviceBinding: (binding) => {
          // A device rollover in either direction is one line the user sees,
          // and one entry on disk: a pin that silently stopped being honoured
          // is exactly how wake went deaf without anyone being told.
          if (binding.state !== 'pinned' && binding.state !== 'default') {
            deps.notify(`[Wake] ${binding.message}`);
            recordDiagnostic(binding.usable, 'wake-input-device', undefined, binding.message);
          } else if (binding.state === 'pinned') {
            deps.notify(`[Wake] ${binding.message}`);
          }
          deps.render();
        },
        onFailure: (error, restarting, failureDetail) => {
          detail = failureDetail;
          recordDiagnostic(false, 'wake-capture', error.message, failureDetail);
          // Reported to the user, not only logged: a detector that stopped
          // listening is exactly the thing a silent log entry hides.
          deps.notify(restarting
            ? `[Wake] The capture stream ended (${error.message}), ${failureDetail}.`
            : `[Wake] The wake-word detector stopped: ${failureDetail}. It stays off until voice.wake.enabled is turned off and on again.`);
          deps.render();
        },
      },
      warn: deps.warn,
      // Lets the SDK CHECK voice.wake.inputDevice instead of believing it.
      ...(deps.enumerateInputDevices !== undefined ? { enumerateInputDevices: deps.enumerateInputDevices } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.setTimeout !== undefined ? { setTimeout: deps.setTimeout } : {}),
      ...(deps.clearTimeout !== undefined ? { clearTimeout: deps.clearTimeout } : {}),
    });
    listener = active;
    const outcome = await active.start();
    if (!outcome.started) {
      listener = null;
      phase = 'idle';
      // A start that failed at boot has no caller reading its return value.
      // It is shown, and it is written down, because the whole failure class
      // here was a microphone that never opened and never said so.
      refusal = {
        kind: outcome.refusal === 'no-microphone' ? 'wake-no-microphone' : 'wake-latched',
        message: outcome.detail,
      };
      recordDiagnostic(false, 'wake-capture-start', outcome.detail, `the wake detector did not start (${outcome.refusal})`);
      deps.notify(`[Wake] The wake-word detector did not start (${outcome.refusal}): ${outcome.detail}`);
    } else {
      refusal = null;
      const limitations = describeWakeLimitations(settings);
      if (limitations.length > 0) {
        deps.notify([`[Wake] Listening on ${outcome.deviceLabel}, with these rows not in force:`, ...limitations].join('\n'));
      }
    }
    deps.render();
  };

  const stop = async (): Promise<void> => {
    const active = listener;
    listener = null;
    phase = 'idle';
    deviceLabel = null;
    detail = undefined;
    if (active !== null) await active.stop();
  };

  return {
    refresh: async () => {
      // Read BEFORE resolving: whether the gate is on disk is an input to whether
      // `voice.wake.vadThreshold` is honoured or refused, so a stale read here
      // would produce a blocker (or the absence of one) that does not match disk.
      const provision = readProvision(deps.managedRoot);
      vadReady = provision.vadReady;
      const settings = resolve();
      if (!settings.active) {
        await stop();
        if (settings.enabled && settings.surfaceEnabled && settings.blockers.length > 0) {
          // Blocked, not off: the user asked for this and is owed the reason.
          deps.notify(['[Wake] The wake-word detector cannot start:', ...describeWakeBlockers(settings)].join('\n'));
        }
        deps.render();
        return;
      }
      if (listener !== null) return;
      await start(settings, provision);
    },
    status,
    settings: resolve,
    stop,
  };
}

/**
 * Subscribe to the two rows that turn detection on and off at runtime, and apply
 * the current configuration once. Returns the unsubscribers for the shell's
 * teardown registry, plus a final release so a live recorder subprocess cannot
 * outlive the process on any exit path.
 */
export function startWakeRuntime(runtime: WakeRuntime, deps: Pick<WakeRuntimeDeps, 'subscribeConfig'>): readonly (() => void)[] {
  const apply = (): void => { void runtime.refresh(); };
  const unsubs = [
    deps.subscribeConfig('voice.wake.enabled', apply),
    deps.subscribeConfig(`voice.wake.surfaces.${AGENT_WAKE_SURFACE}`, apply),
    () => { void runtime.stop(); },
  ];
  apply();
  return unsubs;
}
