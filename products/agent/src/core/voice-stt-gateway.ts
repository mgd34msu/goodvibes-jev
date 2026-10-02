/**
 * voice-stt-gateway.ts, speech-to-text for captured audio.
 *
 * A confirmed wake hands over the utterance that followed it, and this is where
 * that audio becomes words.
 *
 * THE CONNECTED HOST FIRST, THIS PROCESS SECOND.
 *
 * This used to call the in-process voice service and nothing else, on the
 * reasoning that the daemon's `voice.stt` verb is a one-line call to the same
 * kind of service, so a loopback request would be asking ourselves a question
 * we already held the answer to. That reasoning was sound and the conclusion
 * was wrong: the two processes do not hold the same answer. On a machine whose
 * config reads were broken, THIS process's local provider threw 'local STT is
 * not configured' while the DAEMON transcribed perfectly, in the same session,
 * from the same managed whisper install. The user was told speech-to-text did
 * not exist on a machine where it demonstrably did.
 *
 * Nobody using this cares which process owns whisper. So the route is resolved
 * rather than assumed, the SDK owns the policy (platform/voice/stt-routing.ts)
 * so every surface gets the same behaviour, and this file supplies the two
 * candidate routes: the connected host's `voice.stt` verb, and this process's
 * own voice service. A fallback states what it fell back from, and every
 * attempt is written to the voice diagnostics file rather than only to a
 * notification that scrolls away.
 */

import { GoodVibesSdkError } from '@goodvibes-jev/engine/sdk';
import {
  recordVoiceDiagnostic,
  transcribeThroughBestRoute,
  SttRoutesExhaustedError,
  type SttRouteCandidate,
  type UtteranceAudioArtifact,
  type VoiceProviderRegistry,
  type VoiceService,
} from '@goodvibes-jev/engine/sdk/platform/voice';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';

/** The narrow verb surface a capture consumer needs. */
export interface VoiceSttGateway {
  /** Transcribe one captured utterance; resolves to the recognised text. */
  transcribe(audio: UtteranceAudioArtifact): Promise<string>;
  /**
   * Plain words for the route the LAST transcription took, or null before one
   * has run. A surface shows this when the route was not the expected one.
   */
  lastRouteExplanation(): string | null;
}

/**
 * Why transcription is unavailable, surfaced so a capture path prints a real
 * reason instead of inventing one.
 */
export type VoiceSttGatewayResolution =
  | { readonly available: true; readonly gateway: VoiceSttGateway }
  | { readonly available: false; readonly reason: string };

/** What the daemon's `voice.stt` verb answers with. */
interface DaemonSttResult {
  readonly providerId?: string;
  readonly text?: string;
}

export interface VoiceSttGatewayDeps {
  readonly voiceService: VoiceService;
  /**
   * The registry behind that service, read only to answer "is there an STT
   * provider at all" BEFORE audio is captured. Checked up front because the
   * alternative is recording a sentence and then discovering there was nothing to
   * transcribe it with.
   */
  readonly voiceProviders: Pick<VoiceProviderRegistry, 'findProvider'>;
  /**
   * This process's one plug into the connected host. Present means the daemon
   * route exists and is tried first; absent means this process holds no
   * connection, which is the honest reason to transcribe locally.
   */
  readonly daemonVerbs?: Pick<DaemonVerbCaller, 'probe' | 'invoke'> | null | undefined;
  /** Where voice diagnostics are written, the managed voice root. */
  readonly managedVoiceRoot?: string | undefined;
}

/**
 * Build the live speech-to-text gateway, or say why there is none.
 *
 * "None" now means BOTH routes are absent, which is a much rarer and much more
 * honest claim than the one this made before.
 */
export function createVoiceSttGateway(deps: VoiceSttGatewayDeps): VoiceSttGatewayResolution {
  const provider = deps.voiceProviders.findProvider('stt');
  const inProcessAvailable = provider !== null && provider.transcribe !== undefined;

  // A reachable host is a route regardless of what this process has registered.
  const hostReachable = deps.daemonVerbs?.probe().available === true;

  if (!inProcessAvailable && !hostReachable) {
    return {
      available: false,
      reason: 'no speech-to-text is available here: this process has no provider registered, and there is no '
        + 'connected host to send the audio to. The managed voice runtime provisions one.',
    };
  }

  const connectedHost: SttRouteCandidate | null = hostReachable && deps.daemonVerbs
    ? {
      route: 'connected-host',
      provider: 'the host\'s configured speech-to-text provider',
      configSource: 'the connected host\'s own settings',
      transcribe: async (audio) => {
        const result = await deps.daemonVerbs!.invoke<DaemonSttResult>('voice.stt', {
          audio: { ...audio, metadata: {} },
        });
        const text = result?.text;
        if (typeof text !== 'string') throw new Error('the host answered without any transcribed text');
        return text;
      },
    }
    : null;

  const inProcess: SttRouteCandidate | null = inProcessAvailable
    ? {
      route: 'in-process',
      provider: provider?.id ?? 'local',
      configSource: 'this process\'s own voice.local.* settings',
      transcribe: async (audio) => {
        // `metadata` is required on the service's artifact and absent from the
        // capture layer's, which is deliberate: the SDK's artifact carries only
        // what the encoder knows. Empty is what the verb sends for a caller that
        // supplied none.
        const result = await deps.voiceService.transcribe(undefined, { audio: { ...audio, metadata: {} } });
        return result.text;
      },
    }
    : null;

  let lastExplanation: string | null = null;

  return {
    available: true,
    gateway: {
      lastRouteExplanation: () => lastExplanation,
      transcribe: async (audio) => {
        const outcome = await transcribeThroughBestRoute(
          { ...audio },
          {
            connectedHost,
            inProcess,
            ...(deps.managedVoiceRoot !== undefined
              ? { recordDiagnostic: (entry) => { recordVoiceDiagnostic(deps.managedVoiceRoot!, entry); } }
              : {}),
          },
        );
        lastExplanation = outcome.explanation;
        return outcome.text;
      },
    },
  };
}

/**
 * Render a transcription failure honestly. A provider that is registered but not
 * configured (no key, no binary) is a different thing the user can act on than a
 * request that reached a provider and failed.
 */
export function describeTranscriptionFailure(error: unknown): string {
  if (error instanceof SttRoutesExhaustedError) {
    // Every route's own reason, so "it did not work" is never the whole answer.
    return error.message;
  }
  if (error instanceof GoodVibesSdkError && error.code === 'PROVIDER_NOT_CONFIGURED') {
    return `${error.message}, the managed voice runtime provisions a local one, or a configured voice provider supplies it.`;
  }
  return error instanceof Error ? error.message : String(error);
}
