/**
 * useMemoryDiagnostics, the MemoryGovernor observability snapshot (ops.memory.get, SDK
 * 1.9.0-dev's memory-relay-voice-hardening work).
 *
 * Same query-sharing shape as usePowerStatus: one query, refetched on the 'ops' realtime
 * domain (OPS_MEMORY_PRESSURE rides it, see useRealtimeInvalidation's
 * DOMAIN_INVALIDATIONS map), so the admin Memory panel updates the instant the governor
 * crosses a tier or its leak tripwire fires, not only on the next poll.
 */
import { useQuery } from '@tanstack/react-query';
import { sdk } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';
import { readMemoryGovernanceSnapshot } from '../lib/memory-governance';

export function useMemoryDiagnostics() {
  return useQuery({
    queryKey: queryKeys.opsMemory,
    queryFn: async () => {
      const raw = await sdk.operator.ops.memory.get();
      // Defensive wire parse (readMemoryGovernanceSnapshot): a 200 whose body does not
      // actually carry a governor snapshot is an honest, retriable ERROR, never a
      // render crash on a missing field, never placeholder numbers.
      const snapshot = readMemoryGovernanceSnapshot(raw);
      if (!snapshot) {
        throw new Error('The daemon answered, but its response did not carry a memory-governance snapshot.');
      }
      return snapshot;
    },
    staleTime: 10_000,
    retry: false,
  });
}
