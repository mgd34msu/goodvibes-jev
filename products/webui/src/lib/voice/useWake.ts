/**
 * useWake.ts, React glue for wake-word detection in this tab.
 *
 *   useWakeProvisioning()  voice.wake.status + the explicit voice.wake.provision act.
 *   useWakeHost()          mounts the singleton host: resolve settings, start/stop,
 *                          and route a confirmed wake's transcript onward.
 *   useWakeState()         read-only live state, for the indicator components.
 *
 * The host itself (lib/voice/wake-host.ts) holds no React and no daemon client; this
 * file is where the two are joined, which is why the daemon-facing dependencies are
 * INSTALLED here rather than imported there, a component that only wants the
 * indicator must not pull the whole SDK client surface in behind it.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WakeRuntimeSettings } from '@goodvibes-jev/engine/sdk/platform/voice/wake/runtime';
import { sdk } from '../goodvibes';
import type { OperatorMethodOutput } from '../goodvibes';
import {
  createBrowserModelSetLoader,
  installWakeHostDaemonDeps,
  wakeHost,
  wakeHostWarn,
  type WakeHostState,
  type WakeTranscriptSink,
} from './wake-host';
import { transcribeUtterance, useVoiceStatus, useWakeSettings, WAKE_STATUS_QUERY_KEY } from './useVoice';
import type { WakeModelChunk, WakeModelComponent } from './wake-models';

export type WakeStatus = OperatorMethodOutput<'voice.wake.status'>;
export type WakeProvisionReceipt = OperatorMethodOutput<'voice.wake.provision'>;

/** The query key the provisioning read shares, so a provision can invalidate it. */
// Defined in useVoice.ts (the shared side of the import), re-exported here so
// this module's public surface is unchanged.
export { WAKE_STATUS_QUERY_KEY } from './useVoice';

/**
 * `voice.wake.status` plus the one-act `voice.wake.provision`.
 *
 * Provisioning is never automatic: it is ~3.7 MB fetched by the daemon on an
 * explicit act, exactly like managed local voice. `enabled` gates the read so a tab
 * that never opens the voice surface does not poll it.
 */
export function useWakeProvisioning(enabled = true) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: WAKE_STATUS_QUERY_KEY,
    queryFn: () => sdk.operator.voice.wake.status(),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const provision = useMutation({
    mutationFn: () => sdk.operator.voice.wake.provision(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: WAKE_STATUS_QUERY_KEY });
    },
  });
  return { status, provision };
}

/** Read the live host state. Safe in a render path; the host keeps a snapshot. */
export function useWakeState(): WakeHostState {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => wakeHost.subscribe(onChange), []),
    () => wakeHost.getState(),
    () => wakeHost.getState(),
  );
}

let daemonDepsInstalled = false;

/**
 * Install the host's daemon-facing dependencies once per page.
 *
 * `modelVersion` is read from `voice.wake.status` because it is part of the model
 * cache key: a pin change must invalidate cached bytes rather than be served a
 * stale hit, and the version is the daemon's answer, not something a tab can know.
 */
function ensureDaemonDeps(): void {
  if (daemonDepsInstalled) return;
  daemonDepsInstalled = true;
  installWakeHostDaemonDeps({
    loadModelSet: createBrowserModelSetLoader({
      readChunk: async (input: { component: WakeModelComponent; offset: number }): Promise<WakeModelChunk> =>
        await sdk.operator.voice.wake.model.get({ component: input.component, offset: input.offset }),
      modelVersion: async () => {
        try {
          return (await sdk.operator.voice.wake.status()).modelVersion;
        } catch {
          // A status read that fails is not a reason to refuse the download; it
          // only costs the cache its version segment.
          return null;
        }
      },
      warn: wakeHostWarn,
    }),
    transcribe: async (artifact) => {
      const result = await sdk.operator.voice.stt({
        audio: {
          mimeType: artifact.mimeType,
          format: artifact.format,
          dataBase64: artifact.dataBase64,
          metadata: { sampleRateHz: artifact.sampleRateHz, durationMs: artifact.durationMs },
        },
      });
      const text = (result as { text?: unknown }).text;
      return typeof text === 'string' ? text.trim() : '';
    },
  });
}

/**
 * Mount the wake host: resolve `voice.wake.*` for this surface and apply it.
 *
 * `applySettings` is idempotent, so this runs on every `config.get` refetch without
 * restarting anything that has not changed. While the resolved settings are not
 * `.active` the host loads no model and calls no `getUserMedia`, so a tab with
 * `voice.wake.surfaces.webui` false never produces a permission prompt.
 *
 * `onTranscript` receives the words a confirmed wake produced, together with
 * whether `voice.wake.autoSubmit` says to send them rather than place them in the
 * draft. Pass it from the view that owns a composer; omit it and the host still
 * listens and still records the transcript in its own state.
 */
export function useWakeHost(onTranscript?: WakeTranscriptSink): WakeHostState {
  const { settings } = useWakeSettings();
  const state = useWakeState();
  ensureDaemonDeps();

  useEffect(() => {
    void wakeHost.applySettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!onTranscript) return undefined;
    return wakeHost.setTranscriptSink(onTranscript);
  }, [onTranscript]);

  return state;
}

/**
 * Register where a confirmed wake's transcript goes, without owning the host's
 * lifetime.
 *
 * The host is mounted at the shell (it holds a microphone across view changes); the
 * composer belongs to a view. So the view registers the sink and unregisters on
 * unmount, and the host keeps listening either way, recording the transcript in its
 * own state so a wake is never silently lost because no composer was mounted.
 */
export function useWakeTranscriptSink(sink: WakeTranscriptSink): void {
  useEffect(() => wakeHost.setTranscriptSink(sink), [sink]);
}

/**
 * The settings the indicator and the settings UI both read, without either of them
 * re-resolving them. Exported so a component can render `blockers`/`limitations`
 * verbatim, those strings are the resolver's own written reasons, never re-worded
 * here.
 */
export function useWakeSurfaceSettings(): WakeRuntimeSettings {
  return useWakeSettings().settings;
}

/**
 * Whether this tab could transcribe a wake's utterance at all. A detector that
 * fires into a daemon with no speech-to-text provider produces audio nobody can
 * read, and saying so up front beats a wake that appears to do nothing.
 */
export function useWakeTranscriptionAvailable(): boolean {
  return useVoiceStatus().availability.sttAvailable;
}

/** Re-exported so the wake settings UI can transcribe a test utterance if needed. */
export { transcribeUtterance };
