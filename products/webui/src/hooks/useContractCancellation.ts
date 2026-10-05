import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasStoredTokenSync, sdk } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';

type Phase = 'idle' | 'confirming' | 'pending' | 'acknowledged' | 'not-cancelled' | 'unknown';
interface Snapshot { phase: Phase; refreshing: boolean; needsRefresh: boolean }
interface Intent {
  snapshot: Snapshot;
  listeners: Set<() => void>;
  abort?: AbortController;
}
// Closing/reopening a detail must not create a second flight or discard an
// ambiguous outcome. Neither keys nor values contain credentials. Weak lifetime
// keys retire these local intent receipts when the account lifetime is gone.
const clients = new WeakMap<QueryClient, WeakMap<ClientLifetime, Map<string, Intent>>>();
function intentFor(client: QueryClient, lifetime: ClientLifetime, id: string): Intent {
  let scopes = clients.get(client);
  if (!scopes) { scopes = new WeakMap(); clients.set(client, scopes); }
  let intents = scopes.get(lifetime);
  if (!intents) { intents = new Map(); scopes.set(lifetime, intents); }
  let intent = intents.get(id);
  if (!intent) {
    intent = { snapshot: { phase: 'idle', refreshing: false, needsRefresh: false }, listeners: new Set() };
    intents.set(id, intent);
  }
  return intent;
}
function update(intent: Intent, value: Partial<Snapshot>) {
  intent.snapshot = { ...intent.snapshot, ...value };
  for (const listener of intent.listeners) listener();
}

function setAbort(intent: Intent, abort: AbortController | undefined) { intent.abort = abort; }

export const CONTRACT_CANCEL_NOTICE = {
  acknowledged: 'Cancellation acknowledged. Child processes may still be stopping. Files already changed may be incomplete.',
  'not-cancelled': 'No live contract was cancelled. This may be a retained record without a live runner. Check contract and process details for the current state.',
  unknown: 'Cancellation outcome is unknown. Refresh contract and process details before deciding whether to cancel again. The request will not be retried automatically.',
} as const;

export function useContractCancellation(lifetime: ClientLifetime, id: string) {
  const client = useQueryClient();
  const intent = useMemo(() => intentFor(client, lifetime, id), [client, lifetime, id]);
  const owner = useRef<Intent | undefined>(undefined);
  const store = useMemo(() => ({
    subscribe: (listener: () => void) => { intent.listeners.add(listener); return () => { intent.listeners.delete(listener); }; },
    read: () => intent.snapshot,
  }), [intent]);
  const state = useSyncExternalStore(store.subscribe, store.read, store.read);
  const current = () => isClientLifetimeCurrent(lifetime) && hasStoredTokenSync();
  const owned = () => owner.current === intent && current();

  useEffect(() => {
    owner.current = intent;
    const release = () => {
      owner.current = undefined;
      if (intent.snapshot.phase === 'confirming') update(intent, { phase: 'idle' });
      // Aborting transport is not a claim that the daemon did not receive it.
      intent.abort?.abort();
    };
    const unsubscribe = subscribeClientLifetime(release);
    return () => { unsubscribe(); release(); };
  }, [owner, intent]);

  async function refresh(manual = true): Promise<void> {
    if (!current() || (manual && !owned()) || intent.snapshot.refreshing || intent.snapshot.phase === 'pending') return;
    update(intent, { refreshing: true });
    const contracts = { queryKey: [...queryKeys.contracts, lifetime.revision] };
    const fleet = { queryKey: queryKeys.fleet };
    // Fleet uses a shared cache key. Cancel this refresh on identity change so
    // its old account's response cannot be adopted by the next account.
    const unsubscribe = subscribeClientLifetime(() => {
      void client.cancelQueries(contracts);
      void client.cancelQueries(fleet);
    });
    try {
      // Supersede pre-mutation snapshots, including initial reads without data.
      await Promise.all([client.cancelQueries(contracts), client.cancelQueries(fleet)]);
      if (!current()) return;
      const reads = [
        ...client.getQueryCache().findAll({ ...contracts, type: 'active' }),
        ...client.getQueryCache().findAll({ ...fleet, type: 'active' }),
      ];
      await Promise.all([
        client.invalidateQueries({ ...contracts, refetchType: 'none' }),
        client.invalidateQueries({ ...fleet, refetchType: 'none' }),
      ]);
      if (!current()) return;
      // Refetch each exact key separately. Prefix refetches internally reject
      // early if one child fails while another still holds old-account data.
      await Promise.allSettled(reads.map(query => client.refetchQueries(
        { queryKey: query.queryKey, exact: true, type: 'active' }, { throwOnError: true },
      )));
      if (!current()) return;
      const activeContracts = client.getQueryCache().findAll({ ...contracts, type: 'active' });
      const detail = client.getQueryCache().find({ queryKey: queryKeys.contractDetail(lifetime.revision, id), exact: true });
      const process = client.getQueryCache().find({ ...fleet, exact: true });
      // invalidateQueries resolves for paused/offline or disabled reads too.
      // Only completed authoritative list/detail/fleet reads release the gate.
      const complete = (query: typeof detail) => Boolean(query?.isActive() && query.state.status === 'success'
        && query.state.fetchStatus === 'idle' && !query.state.isInvalidated);
      const refreshed = complete(detail) && complete(process)
        && activeContracts.some(query => query.queryKey[2] === 'list') && activeContracts.every(complete);
      if (!refreshed) update(intent, { needsRefresh: true });
      else if (manual || intent.snapshot.phase !== 'unknown') update(intent, { needsRefresh: false });
    } catch {
      if (current()) update(intent, { needsRefresh: true });
    } finally {
      unsubscribe();
      if (current()) update(intent, { refreshing: false });
    }
  }

  function ask(): void {
    if (!owned() || intent.snapshot.refreshing || intent.snapshot.needsRefresh || ['pending', 'confirming'].includes(intent.snapshot.phase)) return;
    update(intent, { phase: 'confirming' });
  }
  function dismiss(): void {
    if (owned() && intent.snapshot.phase === 'confirming') update(intent, { phase: 'idle' });
  }
  async function confirm(): Promise<void> {
    // This synchronous transition precedes every await and prevents duplicate
    // submissions, including duplicate confirmation clicks in the same frame.
    if (!owned() || intent.snapshot.phase !== 'confirming') return;
    const abort = new AbortController();
    setAbort(intent, abort);
    update(intent, { phase: 'pending', needsRefresh: false });
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException('Cancellation response interrupted', 'AbortError'));
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    // A missing response cannot leave this user intent pending forever. Timeout
    // is an unknown outcome, never permission to retry this mutation.
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const result = await Promise.race([sdk.operator.contracts.cancel(id, abort.signal), interrupted]);
      abort.signal.throwIfAborted();
      if (!owned()) return;
      update(intent, { phase: result.cancelled ? 'acknowledged' : 'not-cancelled' });
    } catch {
      if (current()) update(intent, { phase: 'unknown', needsRefresh: true });
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
      setAbort(intent, undefined);
      // A closed detail may still refresh this same account's authoritative
      // list/fleet. An old account must not refetch or display its result.
      if (current()) await refresh(false);
    }
  }

  return {
    ...state,
    ask, dismiss, confirm, refresh,
    disabled: state.phase === 'pending' || state.phase === 'confirming' || state.refreshing || state.needsRefresh || !current(),
    notice: state.phase in CONTRACT_CANCEL_NOTICE ? CONTRACT_CANCEL_NOTICE[state.phase as keyof typeof CONTRACT_CANCEL_NOTICE] : undefined,
  };
}
