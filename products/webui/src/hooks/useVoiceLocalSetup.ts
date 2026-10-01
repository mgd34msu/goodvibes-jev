/**
 * useVoiceLocalSetup, the managed local-voice provisioning state and one-act install
 * (voice.local.status / voice.local.install, SDK 1.9.0-dev's memory-relay-voice-
 * hardening work).
 *
 * No wire event exists for this domain (unlike power.*, which rides OPS_POWER_STATE_
 * CHANGED), VoiceSettings refetches manually / on install-mutation success, the same
 * standing gap fleet.*, checkpoints.*, and memory.* document in queries.ts.
 *
 * Live install progress (SDK 5357f09e): while the install mutation is in flight, the
 * status query polls on a short refetchInterval, the same react-query polling idiom
 * FleetView's snapshot uses, because voice.local.status carries an OPTIONAL
 * `installInProgress` section during an active install (the install verb itself stays
 * plain request/response; there is no stream). On an older daemon the section is
 * simply absent and the surface keeps its plain busy state.
 *
 * A successful install also invalidates the sibling voice caches (['voice','status'],
 * ['voice','config']), useVoice.ts's own literal query keys, matched here rather than
 * introduced as a second key for the same data, since the install call may newly
 * configure tts.provider/tts.voice (or make the 'local' provider's capabilities
 * non-empty), and both surfaces need to see that immediately, not on their next
 * unrelated refetch.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sdk } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';
import { readVoiceLocalInstallResult, readVoiceLocalStatus } from '../lib/voice/voice-local-setup';

export function useVoiceLocalStatus(enabled: boolean, pollForInstallProgress = false) {
  return useQuery({
    queryKey: queryKeys.voiceLocalStatus,
    queryFn: async () => {
      const raw = await sdk.operator.voice.local.status();
      // Defensive wire parse: a 200 whose body carries no runtime state is an honest,
      // retriable error, never a crash or an 'undefined' label (see voice-local-setup.ts).
      const status = readVoiceLocalStatus(raw);
      if (!status) {
        throw new Error('The daemon answered, but its response did not carry a local-voice runtime state.');
      }
      return status;
    },
    enabled,
    staleTime: 30_000,
    retry: false,
    // Poll only while the caller's install is in flight, the window in which the
    // daemon serves installInProgress (see the header comment).
    refetchInterval: pollForInstallProgress ? 750 : false,
  });
}

export function useVoiceLocalInstall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const raw = await sdk.operator.voice.local.install();
      const result = readVoiceLocalInstallResult(raw);
      if (!result) {
        throw new Error('The daemon answered, but its response did not carry an install receipt.');
      }
      return result;
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.voiceLocalStatus }),
        queryClient.invalidateQueries({ queryKey: ['voice', 'status'] }),
        queryClient.invalidateQueries({ queryKey: ['voice', 'config'] }),
      ]);
    },
  });
}
