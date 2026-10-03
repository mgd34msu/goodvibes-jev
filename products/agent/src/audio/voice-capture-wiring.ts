/**
 * voice-capture-wiring.ts, composes this surface's microphone path.
 *
 * One capture opener (capture.ts), one transcription route resolved
 * connected-host-first (core/voice-stt-gateway.ts), one set of `voice.wake.*`
 * rows.
 * Written as a composition root rather than inlined into the wake runtime because
 * the capture opener is shared by construction: a wake does not end a capture
 * session, it starts one, and anything else that ever wants a microphone here has
 * to come through the same opener rather than racing the OS for a held device.
 *
 * It owns nothing the shell does not hand it: the composer write, the turn
 * submission, the message router and the render request all arrive as callbacks,
 * which is what keeps this file out of the shell-UI layers.
 */

import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { AudioInputDeviceEnumerator } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { createAgentCaptureOpener } from './capture.ts';
import { playActivationSound } from './activation-sound.ts';
import { LocalStreamingAudioPlayer } from './player.ts';
import type { StreamingAudioPlayer } from './player.ts';
import { createVoiceSttGateway } from '../core/voice-stt-gateway.ts';
import { startWakeRuntime, wireWakeRuntime } from './wake-runtime.ts';
import { createInputDeviceEnumerator } from './input-devices.ts';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';

export interface VoiceCaptureWiringDeps {
  readonly configManager: ConfigManager;
  /** This process's own voice service, the one the `voice.*` verbs are served from. */
  readonly voiceService: VoiceService;
  /** Read only to answer "is an STT provider registered" before audio is captured. */
  readonly voiceProviders: Pick<VoiceProviderRegistry, 'findProvider'>;
  /** `<root>/voice`, the managed root the wake tree hangs off (the same root /voice setup uses). */
  readonly managedVoiceRoot: string;
  /** A directory this surface owns for the extracted onnxruntime assets. */
  readonly assetDirectory: string;
  /** Names retained clips so the SDK's sweeper can reap them when the session ends. */
  readonly sessionId: string;
  /** Writes recognised text into the composer. */
  readonly writeDraft: (text: string) => void;
  /** Submits recognised text as a turn (`voice.wake.autoSubmit` on). */
  readonly submitTurn: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
  /**
   * This surface's plug into the connected host. Supplied so a captured
   * utterance can be transcribed by the DAEMON, which owns the managed whisper
   * install and works even when this process's own provider does not.
   */
  readonly daemonVerbs?: Pick<DaemonVerbCaller, 'probe' | 'invoke'> | null | undefined;
  /**
   * Fetches the wake artifacts when they are missing, so enabling detection on a
   * host without them completes rather than reporting a chore.
   */
  readonly ensureWakeProvisioned?: (() => Promise<{ readonly ready: boolean; readonly message: string }>) | undefined;
  /** Injected in tests; defaults to listing this host's sources with pactl. */
  readonly enumerateInputDevices?: AudioInputDeviceEnumerator | undefined;
  /** Injected in tests; defaults to a real streaming player for the activation sound. */
  readonly player?: StreamingAudioPlayer;
}

export interface VoiceCaptureWiring {
  /** The live footer row, or null when no microphone is open. */
  readonly status: () => VoiceCaptureIndicatorState | null;
  /** Teardown, for the shell's `unsubs` registry, releases any open device. */
  readonly unsubs: readonly (() => void)[];
}

/** Compose wake detection over this surface's capture path. Opens no device by itself. */
export function wireVoiceCapture(deps: VoiceCaptureWiringDeps): VoiceCaptureWiring {
  const readConfig = (key: string): unknown => deps.configManager.get(key as ConfigKey);
  const warn = (message: string, meta?: Readonly<Record<string, unknown>>): void => {
    logger.debug(`voice capture: ${message}`, meta ?? {});
  };
  // The RAW opener, deliberately unwrapped: the SDK listener wraps it with the
  // platform's speexdsp stage, so `voice.wake.noiseSuppression: "speex"` is applied
  // between the device and every consumer without this surface claiming the
  // capability or filtering twice (see capture.ts).
  const openCapture = createAgentCaptureOpener({ warn });
  const resolveTranscriber = () => {
    const resolution = createVoiceSttGateway({
      voiceService: deps.voiceService,
      voiceProviders: deps.voiceProviders,
      daemonVerbs: deps.daemonVerbs ?? null,
      managedVoiceRoot: deps.managedVoiceRoot,
    });
    return resolution.available
      ? { available: true as const, gateway: resolution.gateway }
      : { available: false as const, reason: resolution.reason };
  };
  const subscribeConfig = (key: string, listener: () => void): (() => void) => deps.configManager.subscribe(key as ConfigKey, listener);
  const player = deps.player ?? new LocalStreamingAudioPlayer();

  const wake = wireWakeRuntime({
    readConfig,
    subscribeConfig,
    openCapture,
    managedRoot: deps.managedVoiceRoot,
    assetDirectory: deps.assetDirectory,
    resolveTranscriber,
    playActivationSound: (sound) => playActivationSound(sound, { player, notify: deps.notify }),
    submitTurn: deps.submitTurn,
    writeDraft: deps.writeDraft,
    notify: deps.notify,
    render: deps.render,
    sessionId: deps.sessionId,
    warn,
    ...(deps.ensureWakeProvisioned !== undefined ? { ensureProvisioned: deps.ensureWakeProvisioned } : {}),
    // A configured device is checked against what this host can actually see.
    enumerateInputDevices: deps.enumerateInputDevices ?? createInputDeviceEnumerator(),
  });

  return {
    status: () => wake.status(),
    unsubs: startWakeRuntime(wake, { subscribeConfig }),
  };
}
