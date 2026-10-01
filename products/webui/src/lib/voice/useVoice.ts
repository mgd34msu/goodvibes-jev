/**
 * useVoice.ts, React glue for the voice surface.
 *
 *   useVoiceStatus()      the honest availability posture (voice.status), cached/shared.
 *   useSharedVoiceConfig() the shared tts.provider/tts.voice defaults (config.get).
 *   useTts()              speak/stop a reply through the singleton engine, with live state.
 *   useVoiceInput()       mic capture -> voice.stt -> transcript, as an honest state machine.
 *
 * WHAT CHANGED UNDERNEATH useVoiceInput, and why its external contract did not:
 * capture no longer runs a MediaRecorder of its own. It goes through the ONE browser
 * capture primitive (lib/voice/capture.ts) and the SDK's `PushToTalkSession`, so
 * dictation and always-on wake detection share a single device path, and through the
 * arbiter (lib/voice/mic-arbiter.ts), so a press while the wake listener holds the
 * microphone stands that listener down instead of opening a second stream.
 *
 * The audio therefore leaves as 16 kHz mono PCM in a WAV container
 * (`utteranceToAudioArtifact`) rather than a webm/opus blob. Same `voice.stt` verb, same
 * artifact shape, mimeType/format/dataBase64, just an encoding both surfaces can
 * produce from raw frames without a codec, which is what let the terminal have voice
 * input at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AudioCaptureError,
  CAPTURE_SAMPLE_RATE,
  PushToTalkSession,
  utteranceToAudioArtifact,
  type AudioCaptureFailureReason,
  type CapturedUtterance,
} from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { sdk } from '../goodvibes';
import { asRecord } from '../object';
import { coalesceForSpeech } from './request-policy';
import { ttsEngine, canPlayAudio, type TtsPlaybackState } from './tts-player';
import {
  deriveVoiceAvailability,
  readSharedVoiceConfig,
  type SharedVoiceConfig,
  type VoiceAvailability,
} from './voice-config';
import type { WakeRuntimeSettings } from '@goodvibes-jev/engine/sdk/platform/voice/wake/runtime';
import { detectMicSupport, type MicSupport } from './capture';
import { micArbiter, type MicLease } from './mic-arbiter';
import { resolveWebuiWakeSettings } from './wake-config';

/** The container format requested from the streaming TTS route. mp3 decodes across
 * browsers' AudioContext.decodeAudioData; providers default to it too. */
const DEFAULT_TTS_FORMAT = 'mp3';

const EMPTY_CONFIG: SharedVoiceConfig = { provider: '', voice: '' };

/** voice.status -> availability posture. Failure degrades to "not available" honestly. */
export function useVoiceStatus(): { availability: VoiceAvailability; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['voice', 'status'],
    queryFn: () => sdk.operator.voice.status(),
    staleTime: 30_000,
  });
  const availability = useMemo(() => deriveVoiceAvailability(query.data), [query.data]);
  return { availability, isLoading: query.isLoading };
}

/** config.get -> the shared tts.* voice defaults. Failure degrades to empty (the daemon
 * then applies its own defaults). */
export function useSharedVoiceConfig(): { config: SharedVoiceConfig; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['voice', 'config'],
    queryFn: () => sdk.operator.config.get(),
    staleTime: 30_000,
    retry: false,
  });
  const config = useMemo(
    () => (query.data ? readSharedVoiceConfig(query.data) : EMPTY_CONFIG),
    [query.data],
  );
  return { config, isLoading: query.isLoading };
}

export interface UseTtsResult {
  readonly availability: VoiceAvailability;
  readonly voiceConfig: SharedVoiceConfig;
  readonly state: TtsPlaybackState;
  readonly canPlay: boolean;
  /** True while THIS message is loading or playing. */
  readonly isActive: (id: string) => boolean;
  readonly speak: (id: string, text: string) => void;
  readonly stop: () => void;
}

export function useTts(): UseTtsResult {
  const { availability } = useVoiceStatus();
  const { config } = useSharedVoiceConfig();

  const state = useSyncExternalStore(
    useCallback((onChange: () => void) => ttsEngine.subscribe(onChange), []),
    () => ttsEngine.getState(),
    () => ttsEngine.getState(),
  );

  // Synthesise one segment via the streaming TTS route, requesting the SHARED voice so it
  // sounds the same as the TUI/agent. Omitted provider/voice let the daemon apply the
  // shared tts.* defaults itself.
  const synth = useCallback(
    (text: string, signal: AbortSignal) =>
      sdk.operator.voice
        .ttsStream(
          {
            text,
            format: DEFAULT_TTS_FORMAT,
            ...(config.provider ? { providerId: config.provider } : {}),
            ...(config.voice ? { voiceId: config.voice } : {}),
            ...(config.speed ? { speed: config.speed } : {}),
          },
          signal,
        )
        .then((response) => response.arrayBuffer()),
    [config.provider, config.voice, config.speed],
  );

  const speak = useCallback(
    (id: string, text: string) => {
      const segments = coalesceForSpeech(text);
      void ttsEngine.speak({ id, segments, synth });
    },
    [synth],
  );

  const stop = useCallback(() => ttsEngine.stop(), []);
  const isActive = useCallback((id: string) => state.id === id, [state.id]);

  return { availability, voiceConfig: config, state, canPlay: canPlayAudio(), isActive, speak, stop };
}

/**
 * The resolved `voice.wake.*` rows for THIS surface, from the same `config.get`
 * query the shared voice config reads.
 *
 * Two consumers: the wake host (which starts a detector only when `.active`), and
 * push-to-talk (which takes its device, ceiling and frame size from the SAME rows
 *, that is what `voice.wake.inputDevice`'s description means by "shared by BOTH
 * microphone consumers").
 */
/**
 * The `voice.wake.status` cache key. Defined here rather than in useWake.ts
 * because that module imports this one, and both read this endpoint, two keys
 * for one read would mean two fetches and two answers that can disagree.
 */
export const WAKE_STATUS_QUERY_KEY = ['voice', 'wake', 'status'] as const;

export function useWakeSettings(): { settings: WakeRuntimeSettings; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['voice', 'config'],
    queryFn: () => sdk.operator.config.get(),
    staleTime: 30_000,
    retry: false,
  });
  // Whether the daemon has the SPEECH GATE on disk. Its own artifact and its own
  // read, because `voice.wake.vadThreshold` above 0 must block while it is missing
  // rather than let the tab score frames ungated behind a row that says otherwise.
  // A failed or absent read leaves it false, which is the safe direction.
  const gate = useQuery({
    queryKey: WAKE_STATUS_QUERY_KEY,
    queryFn: () => sdk.operator.voice.wake.status(),
    staleTime: 30_000,
    retry: false,
  });
  // No tree yet resolves to the SHIPPED defaults (enabled false, surfaces.webui
  // false) rather than to zeroes, so a tab that has not loaded its config never
  // opens a device on the strength of a blank read.
  const settings = useMemo(
    () => resolveWebuiWakeSettings(query.data ?? {}, gate.data?.vadReady === true),
    [query.data, gate.data?.vadReady],
  );
  return { settings, isLoading: query.isLoading };
}

export type MicPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error';

export interface MicError {
  /** The SDK's capture failure reasons, plus this surface's own transcription one. */
  readonly reason: AudioCaptureFailureReason | 'stt-failed';
  readonly message: string;
}

export interface UseVoiceInputResult {
  readonly support: MicSupport;
  readonly availability: VoiceAvailability;
  readonly phase: MicPhase;
  readonly error: MicError | null;
  /** True when dictation can actually be attempted (secure context + STT provider). */
  readonly ready: boolean;
  readonly start: () => Promise<void>;
  readonly stopAndTranscribe: () => Promise<void>;
  readonly cancel: () => void;
}

/**
 * Send one captured utterance to `voice.stt` and return the words.
 *
 * Shared by dictation and by the wake host, because a wake's utterance goes to the
 * SAME verb with the SAME artifact, that handoff is the reason both consumers sit
 * on one device path in the first place.
 */
export async function transcribeUtterance(
  utterance: CapturedUtterance,
  providerId?: string,
): Promise<string> {
  const artifact = utteranceToAudioArtifact(utterance);
  const result = await sdk.operator.voice.stt({
    audio: {
      mimeType: artifact.mimeType,
      format: artifact.format,
      dataBase64: artifact.dataBase64,
      metadata: { sampleRateHz: artifact.sampleRateHz, durationMs: artifact.durationMs },
    },
    ...(providerId ? { providerId } : {}),
  });
  const text = asRecord(result).text;
  return typeof text === 'string' ? text.trim() : '';
}

/** Mic capture -> voice.stt -> transcript. The transcript is handed to `onTranscript` for
 * REVIEW-BEFORE-SEND (it fills the composer draft; it is never auto-sent). */
export function useVoiceInput(onTranscript: (text: string) => void): UseVoiceInputResult {
  const { availability } = useVoiceStatus();
  const { settings } = useWakeSettings();
  const support = useMemo(() => detectMicSupport(), []);
  const [phase, setPhase] = useState<MicPhase>('idle');
  const [error, setError] = useState<MicError | null>(null);
  const sessionRef = useRef<PushToTalkSession | null>(null);
  /** The arbiter lease held while this press owns the device. */
  const leaseRef = useRef<MicLease | null>(null);

  const ready = support === 'ok' && availability.sttAvailable;

  // The capture rows are the SHARED ones: device, ceiling and frame size come from
  // voice.wake.*, so a device chosen for the detector is the device dictation uses.
  // silenceStopMs is deliberately 0 here, someone holding a button through a pause
  // has not finished talking, so stopping is the user's call, not a timer's.
  const captureOptions = useMemo(() => ({
    device: settings.capture.device,
    backend: settings.capture.backend,
    noiseSuppression: settings.capture.noiseSuppression,
    frameSamples: settings.capture.frameSamples,
    captureMaxSeconds: settings.captureMaxSeconds,
  }), [
    settings.capture.device,
    settings.capture.backend,
    settings.capture.noiseSuppression,
    settings.capture.frameSamples,
    settings.captureMaxSeconds,
  ]);

  const releaseLease = useCallback(async () => {
    const lease = leaseRef.current;
    leaseRef.current = null;
    if (lease) await lease();
  }, []);

  const transcribe = useCallback(async (utterance: CapturedUtterance) => {
    setPhase('transcribing');
    try {
      const text = await transcribeUtterance(utterance, availability.defaultSttProviderId);
      onTranscript(text);
      setPhase('idle');
    } catch (e) {
      setError({
        reason: 'stt-failed',
        message: e instanceof Error ? e.message : 'Could not transcribe the recording.',
      });
      setPhase('error');
    }
  }, [availability.defaultSttProviderId, onTranscript]);

  const start = useCallback(async () => {
    setError(null);
    setPhase('requesting');
    // Take the device before opening anything: this stands the wake listener down
    // and waits for it to release, so the press never races it for the microphone.
    leaseRef.current = await micArbiter.acquireExclusive();
    const session = new PushToTalkSession({
      openCapture: micArbiter.openCapture,
      capture: {
        device: captureOptions.device,
        backend: captureOptions.backend,
        noiseSuppression: captureOptions.noiseSuppression,
        frameSamples: captureOptions.frameSamples,
      },
      captureMaxSeconds: captureOptions.captureMaxSeconds,
      silenceStopMs: 0,
      // The ceiling firing is capture ending itself, not a failure: the audio is
      // real and goes to transcription exactly as a released button's would.
      onAutoStop: (utterance) => {
        sessionRef.current = null;
        void releaseLease().then(() => transcribe(utterance));
      },
    });
    try {
      await session.start();
      sessionRef.current = session;
      setPhase('recording');
    } catch (e) {
      sessionRef.current = null;
      await releaseLease();
      const reason = e instanceof AudioCaptureError ? e.reason : 'unsupported';
      const message = e instanceof Error ? e.message : 'Could not start recording.';
      setError({ reason, message });
      setPhase('error');
    }
  }, [captureOptions, releaseLease, transcribe]);

  const stopAndTranscribe = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    let utterance: CapturedUtterance | null = null;
    let failed = false;
    try {
      utterance = await session.stop();
    } catch (e) {
      failed = true;
      setError({
        reason: e instanceof AudioCaptureError ? e.reason : 'unsupported',
        message: e instanceof Error ? e.message : 'Recording failed.',
      });
      setPhase('error');
    } finally {
      await releaseLease();
    }
    if (utterance) await transcribe(utterance);
    // A released button with nothing recorded is a no-op, not an error, but a stop
    // that FAILED keeps its error phase rather than being reset to idle underneath it.
    else if (!failed) setPhase('idle');
  }, [releaseLease, transcribe]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    void (async () => {
      if (session) await session.cancel();
      await releaseLease();
    })();
    setPhase('idle');
    setError(null);
  }, [releaseLease]);

  // A component unmounting mid-recording must not leave the microphone open, nor
  // the wake listener stood down forever waiting for a lease nobody will release.
  useEffect(() => () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    void (async () => {
      if (session) await session.cancel();
      const lease = leaseRef.current;
      leaseRef.current = null;
      if (lease) await lease();
    })();
  }, []);

  return { support, availability, phase, error, ready, start, stopAndTranscribe, cancel };
}

/** The capture sample rate every artifact this surface sends carries. */
export { CAPTURE_SAMPLE_RATE };
