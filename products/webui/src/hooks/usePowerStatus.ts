/**
 * usePowerStatus, the host sleep-ownership state (power.status.get, SDK 1.8.0).
 *
 * One query shared by every consumer of this state: the always-visible "sleep
 * disabled" chip (StatusStrip/PowerChip) and the admin Power panel
 * (PowerSettings). Both `work` (the automatic inhibitor tied to active
 * daemon work) and `keepAwake` (the owner's manual toggle) come back from the
 * same call, see power.status.get's real generated shape
 * (OperatorMethodOutput<'power.status.get'>).
 *
 * Refreshed on the 'ops' realtime domain (OPS_POWER_STATE_CHANGED, see
 * useRealtimeInvalidation's DOMAIN_INVALIDATIONS map), so every attached
 * surface's chip updates the instant ANY surface flips the toggle, not only
 * this one's own mutation success.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sdk } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';

export function usePowerStatus() {
  return useQuery({
    queryKey: queryKeys.power,
    queryFn: () => sdk.operator.power.status(),
    staleTime: 10_000,
    retry: false,
  });
}

/** The keepAwake.set mutation, reconciling the shared power query on success/error alike
 *  (the daemon's response IS the fresh state, no need to wait for a refetch). */
export function useSetKeepAwake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => sdk.operator.power.setKeepAwake(enabled),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.power, result);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.power });
    },
  });
}
