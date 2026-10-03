/**
 * voice-capture-shell.ts, the shell's side of microphone capture.
 *
 * Its own module with a single call from main.ts, for the same reason the other
 * shell wiring modules here are: the entrypoint is held under a source-line gate,
 * and new shell composition gets a file rather than another inline block.
 *
 * What this owns is only the shell-facing half, where a transcript lands (the
 * composer, through the same public `prompt`/`cursorPos` fields the external
 * editor path writes), how a turn is submitted, and the teardown registration that
 * guarantees a live recorder subprocess dies with the process. Everything about
 * audio itself lives in src/audio/voice-capture-wiring.ts, which does not import
 * shell UI.
 */

import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/sdk/platform/voice';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { wireVoiceCapture } from '../audio/voice-capture-wiring.ts';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';

export interface VoiceCaptureShellDeps {
  readonly configManager: ConfigManager;
  /** This process's own voice service, what the `voice.stt` verb is served from here. */
  readonly voiceService: VoiceService;
  readonly voiceProviders: Pick<VoiceProviderRegistry, 'findProvider'>;
  /**
   * This surface's plug into the connected host, so a captured utterance can be
   * transcribed by the daemon, which owns the managed whisper install and
   * answers even when this process's own provider cannot.
   */
  readonly daemonVerbs?: Pick<DaemonVerbCaller, 'probe' | 'invoke'> | null | undefined;
  /**
   * Fetches missing wake artifacts. Wired from the agent's voice setup service,
   * so enabling wake on a host without models completes the request.
   */
  readonly ensureWakeProvisioned?: (() => Promise<{ readonly ready: boolean; readonly message: string }>) | undefined;
  readonly shellPaths: Pick<ShellPathService, 'resolveUserPath'>;
  /** Names retained wake clips so the SDK's sweeper reaps them when this session ends. */
  readonly sessionId: string;
  /** The shell's teardown registry; the device release is appended to it. */
  readonly unsubs: Array<() => void>;
  /** The live composer buffer, InputHandler exposes public `prompt`/`cursorPos`. */
  readonly buffer: { prompt: string; cursorPos: number };
  readonly submitInput: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
}

/**
 * Compose voice capture and hand back the footer-row reader.
 *
 * Opens no device: wake detection consults `voice.wake.*` and refuses without
 * touching the capture opener when either enablement row is off.
 */
export function installVoiceCapture(deps: VoiceCaptureShellDeps): () => VoiceCaptureIndicatorState | null {
  const capture = wireVoiceCapture({
    configManager: deps.configManager,
    voiceService: deps.voiceService,
    voiceProviders: deps.voiceProviders,
    daemonVerbs: deps.daemonVerbs ?? null,
    ...(deps.ensureWakeProvisioned !== undefined ? { ensureWakeProvisioned: deps.ensureWakeProvisioned } : {}),
    // The same managed root `/voice setup` uses; the wake tree is `<root>/wake`.
    managedVoiceRoot: deps.shellPaths.resolveUserPath('voice'),
    // Surface-scoped: the extracted onnxruntime assets belong to this surface's
    // own directory, beside its other managed state.
    assetDirectory: deps.shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'onnxruntime'),
    sessionId: deps.sessionId,
    writeDraft: (text) => {
      deps.buffer.prompt = text;
      deps.buffer.cursorPos = text.length;
      deps.render();
    },
    submitTurn: (text) => deps.submitInput(text),
    notify: deps.notify,
    render: deps.render,
  });
  deps.unsubs.push(...capture.unsubs);
  return capture.status;
}
