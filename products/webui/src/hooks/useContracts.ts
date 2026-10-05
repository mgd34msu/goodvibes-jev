import { useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import contractSchema from '../lib/generated/contract-inspection-schema.json';
import type { ContractRecord } from '../lib/contract-bridge-types';
import { hasStoredTokenSync, sdk } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';

/** A local revision, never a token or user-provided identifier, owns these caches. */
export function useContractScope(): ClientLifetime {
  const client = useQueryClient();
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  useEffect(() => {
    const purge = () => {
      const revision = getClientLifetime().revision;
      client.removeQueries({ predicate: (query) => query.queryKey[0] === 'contracts' && query.queryKey[1] !== revision });
    };
    purge();
    return subscribeClientLifetime(purge);
  }, [client]);
  return lifetime;
}

/** Abort on identity replacement even when the transport has already answered.
 * A late response cannot be adopted after sign-out or an A → B → A switch. */
export async function readInContractScope<T>(
  lifetime: ClientLifetime,
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const check = () => {
    if (signal.aborted || !isClientLifetimeCurrent(lifetime) || !hasStoredTokenSync()) cancel();
    abort.signal.throwIfAborted();
  };
  try {
    check();
    const result = await read(abort.signal);
    check();
    return result;
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', cancel);
  }
}

/** The public engine schema is snapshotted and checked before every build.
 * Invalid nested evidence must fail the query, never crash during rendering. */
function assertContractTree(value: ContractRecord): void {
  const failure = firstJsonSchemaFailure(contractSchema, value);
  if (failure) throw new Error(`The daemon returned an unreadable contract record (${failure.path}).`);
}

export function useContractList(lifetime: ClientLifetime, includeTerminal: boolean, enabled: boolean, live: boolean) {
  return useQuery({
    queryKey: queryKeys.contractList(lifetime.revision, includeTerminal),
    queryFn: ({ signal }) => readInContractScope(lifetime, signal, async (current) => {
      const result = await sdk.operator.contracts.list({ includeTerminal }, current);
      if (!result || !Array.isArray(result.contracts)) throw new Error('The daemon returned an unreadable contract list.');
      result.contracts.forEach(assertContractTree);
      return result;
    }),
    enabled: enabled && hasStoredTokenSync() && isClientLifetimeCurrent(lifetime),
    retry: false,
    gcTime: 0,
    refetchInterval: live ? 60_000 : 15_000,
  });
}

export function useContractDetail(lifetime: ClientLifetime, id: string, live: boolean) {
  return useQuery({
    queryKey: queryKeys.contractDetail(lifetime.revision, id),
    queryFn: ({ signal }) => readInContractScope(lifetime, signal, async (current) => {
      const result = await sdk.operator.contracts.get(id, current);
      assertContractTree(result);
      if (result.id !== id) throw new Error('The daemon returned a different contract. Refresh to try again.');
      return result;
    }),
    enabled: Boolean(id) && hasStoredTokenSync() && isClientLifetimeCurrent(lifetime),
    retry: false,
    gcTime: 0,
    // Retain the safety poll even for terminal snapshots: retained evidence can
    // change, and a lost event must not leave a permanently stale detail.
    refetchInterval: live ? 60_000 : 15_000,
  });
}
