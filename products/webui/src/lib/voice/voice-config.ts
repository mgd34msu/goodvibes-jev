/**
 * voice-config.ts, the shared voice posture the web UI reads before speaking or
 * listening.
 *
 * Two honest reads, both defensive (a daemon newer or older than this client may add or
 * omit fields, parse leniently, never assume a shape):
 *
 *   deriveVoiceAvailability(voice.status), is a provider actually configured for TTS
 *   (read-aloud) and for STT (dictation)? Drives the honest "no provider configured"
 *   refusal, worded as a bring-your-own-key pointer, straight from the status the daemon
 *   reports, never a stale confident "on".
 *
 *   readSharedVoiceConfig(config.get), the SHARED tts.provider / tts.voice / tts.speed
 *   defaults, so the browser speaks in the same voice the TUI does. There is one voice
 *   config across terminal, desktop, and agent, the shared, surface-root-independent
 *   config tier (~/.goodvibes/shared/settings.json) every surface's ConfigManager
 *   resolves tts.* from, and this reads it, it does not invent a per-surface one. See
 *   VoiceSettings.tsx's header comment for the full picture.
 */

import { asRecord } from '../object';

/** The voice provider capability tokens the daemon emits (voice/types.ts). */
export type VoiceCapability = 'tts' | 'tts-stream' | 'stt' | 'realtime' | 'voice-list';

export interface VoiceProviderPosture {
  readonly id: string;
  readonly label: string;
  readonly state: string;
  readonly configured: boolean;
  readonly capabilities: readonly string[];
  readonly detail?: string;
}

export interface VoiceAvailability {
  /** The operator's voice toggle (ui.voiceEnabled), surfaced for context. */
  readonly enabled: boolean;
  /** A configured provider offers spoken output. */
  readonly ttsAvailable: boolean;
  /** A configured provider offers speech-to-text. */
  readonly sttAvailable: boolean;
  readonly providers: readonly VoiceProviderPosture[];
  /** The daemon's own status note (informational context). */
  readonly note: string;
  /** id of the first configured TTS provider, if any (a sensible default). */
  readonly defaultTtsProviderId?: string;
  /** id of the first configured STT provider, if any. */
  readonly defaultSttProviderId?: string;
}

function readCapabilities(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function hasCapability(capabilities: readonly string[], ...wanted: VoiceCapability[]): boolean {
  return wanted.some((cap) => capabilities.includes(cap));
}

/** Parse voice.status into an honest availability posture. Unknown/legacy shapes degrade
 * to "not available" rather than a confident-but-wrong "on". */
export function deriveVoiceAvailability(status: unknown): VoiceAvailability {
  const record = asRecord(status);
  const rawProviders = Array.isArray(record.providers) ? record.providers : [];
  const providers: VoiceProviderPosture[] = rawProviders.map((entry) => {
    const p = asRecord(entry);
    return {
      id: typeof p.id === 'string' ? p.id : '',
      label: typeof p.label === 'string' ? p.label : (typeof p.id === 'string' ? p.id : 'Voice provider'),
      state: typeof p.state === 'string' ? p.state : 'unknown',
      configured: p.configured === true,
      capabilities: readCapabilities(p.capabilities),
      detail: typeof p.detail === 'string' ? p.detail : undefined,
    };
  });

  const ttsProvider = providers.find((p) => p.configured && hasCapability(p.capabilities, 'tts', 'tts-stream'));
  const sttProvider = providers.find((p) => p.configured && hasCapability(p.capabilities, 'stt'));

  return {
    enabled: record.enabled === true,
    ttsAvailable: Boolean(ttsProvider),
    sttAvailable: Boolean(sttProvider),
    providers,
    note: typeof record.note === 'string' ? record.note : '',
    defaultTtsProviderId: ttsProvider?.id,
    defaultSttProviderId: sttProvider?.id,
  };
}

/** The honest, bring-your-own-key refusal shown where read-aloud is unavailable, no
 * configured provider offers spoken output. */
export const TTS_UNAVAILABLE_MESSAGE =
  'Read-aloud needs a voice provider with an API key. Add one (for example ElevenLabs or OpenAI) in the daemon config to hear replies spoken.';

/** The honest refusal shown where dictation is unavailable, no configured STT provider. */
export const STT_UNAVAILABLE_MESSAGE =
  'Dictation needs a speech-to-text provider with an API key. Add one (for example OpenAI, Deepgram, or Google) in the daemon config to speak your message.';

export interface SharedVoiceConfig {
  /** tts.provider, the shared default spoken-output provider. */
  readonly provider: string;
  /** tts.voice, the shared default voice id. */
  readonly voice: string;
  /** tts.speed, the shared playback speed multiplier (0.25–4.0). */
  readonly speed?: number;
}

/**
 * Read the shared spoken-voice defaults out of the resolved config snapshot. The snapshot
 * declares domain sections with additionalProperties, so the `tts` section arrives as an
 * extra property; read it defensively and fall back to empty (the daemon then applies its
 * own tts.* defaults when the request omits them).
 */
export function readSharedVoiceConfig(configSnapshot: unknown): SharedVoiceConfig {
  const tts = asRecord(asRecord(configSnapshot).tts);
  const provider = typeof tts.provider === 'string' ? tts.provider : '';
  const voice = typeof tts.voice === 'string' ? tts.voice : '';
  const speed = typeof tts.speed === 'number' && Number.isFinite(tts.speed) ? tts.speed : undefined;
  return { provider, voice, speed };
}

/** A short human label for the shared voice ("ElevenLabs · Rachel", "provider default"). */
export function describeSharedVoice(config: SharedVoiceConfig): string {
  const parts = [config.provider, config.voice].filter((part) => part.trim().length > 0);
  return parts.length ? parts.join(' · ') : 'provider default';
}
