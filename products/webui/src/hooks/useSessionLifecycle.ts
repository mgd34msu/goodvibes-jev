import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasStoredTokenSync, sdk } from '../lib/goodvibes';
import { serializeError } from '../lib/errors';
import { asRecord } from '../lib/object';
import { queryKeys } from '../lib/queries';

export type SessionAction = 'close' | 'reopen' | 'delete';
type Phase = 'idle' | 'confirming' | 'pending' | 'unknown';
interface Snapshot { phase: Phase; action?: SessionAction; refreshing: boolean; notice?: string }
interface Intent { snapshot: Snapshot; listeners: Set<() => void>; abort?: AbortController }
// One flight/unknown-outcome receipt per account lifetime and target, including
// closing and reopening the pane. No credentials or retained session data here.
const clients = new WeakMap<QueryClient, WeakMap<ClientLifetime, Map<string, Intent>>>();
function intentFor(client: QueryClient, lifetime: ClientLifetime, id: string): Intent {
  let scopes = clients.get(client);
  if (!scopes) { scopes = new WeakMap(); clients.set(client, scopes); }
  let intents = scopes.get(lifetime);
  if (!intents) { intents = new Map(); scopes.set(lifetime, intents); }
  let intent = intents.get(id);
  if (!intent) { intent = { snapshot: { phase: 'idle', refreshing: false }, listeners: new Set() }; intents.set(id, intent); }
  return intent;
}
function setAbort(intent: Intent, abort: AbortController | undefined): void { intent.abort = abort; }
function update(intent: Intent, state: Partial<Snapshot>): void {
  intent.snapshot = { ...intent.snapshot, ...state };
  for (const listener of intent.listeners) listener();
}
// Target-route absence, not a generic router/auth 404. The native transport's
// generic NOT_FOUND code can shadow the daemon body code. Current GET/close
// responses use the exact uncoded message; DELETE also carries its typed code.
function isTargetMissing(error: unknown): boolean {
  const value = serializeError(error);
  const transport = asRecord(value.transport);
  const body = asRecord(value.body ?? transport.body);
  return (value.status ?? transport.status) === 404
    && (body.code === 'SESSION_NOT_FOUND' || body.error === 'Unknown shared session' || body.message === 'Unknown shared session');
}
const UNKNOWN = 'Session action outcome is unknown. Refresh session state before deciding whether to try again. The request will not be retried automatically.';
function unknown(intent: Intent): void { update(intent, { phase: 'unknown', refreshing: false, notice: UNKNOWN }); }

/** The list is authoritative only when every record can be identified. A bad
 * response must never become an empty list and falsely prove deletion. */
export async function readSessionList(lifetime: ClientLifetime, signal: AbortSignal) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const unsubscribe = subscribeClientLifetime(cancel);
  signal.addEventListener('abort', cancel, { once: true });
  const check = () => {
    if (signal.aborted || !isClientLifetimeCurrent(lifetime)) cancel();
    abort.signal.throwIfAborted();
  };
  try {
    check();
    const result = await sdk.operator.sessions.list(abort.signal);
    check();
    const records: unknown = asRecord(result).sessions;
    if (!Array.isArray(records) || records.some((record: unknown) => {
      const id = asRecord(record).id;
      return typeof id !== 'string' || !id.trim();
    })) {
      throw new Error('The daemon returned an unreadable session list.');
    }
    return result;
  } finally { unsubscribe(); signal.removeEventListener('abort', cancel); }
}

export function useSessionLifecycle(id: string, onClose: () => void) {
  const client = useQueryClient();
  // A still-mounted stale record cannot acquire a replacement account. WorkView
  // remounts on identity change; observing the live revision only disables this
  // old pane if a caller has not remounted it yet.
  const [lifetime] = useState(getClientLifetime);
  useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  const intent = useMemo(() => intentFor(client, lifetime, id), [client, lifetime, id]);
  const selection = useMemo(() => ({ intent }), [intent]);
  const owner = useRef<typeof selection | undefined>(undefined);
  const store = useMemo(() => ({
    subscribe: (listener: () => void) => { intent.listeners.add(listener); return () => { intent.listeners.delete(listener); }; },
    read: () => intent.snapshot,
  }), [intent]);
  const state = useSyncExternalStore(store.subscribe, store.read, store.read);
  const current = () => isClientLifetimeCurrent(lifetime) && hasStoredTokenSync();
  const owned = () => owner.current === selection && current();

  useLayoutEffect(() => {
    owner.current = selection;
    const release = () => {
      owner.current = undefined;
      if (intent.snapshot.phase === 'confirming') update(intent, { phase: 'idle', action: undefined });
      // Aborting after dispatch says nothing about the daemon's outcome. Retain
      // the ambiguity before releasing transport, even if it ignores abort.
      if (intent.snapshot.phase === 'pending') unknown(intent);
      if (intent.snapshot.refreshing) update(intent, { refreshing: false });
      intent.abort?.abort();
    };
    const unsubscribe = subscribeClientLifetime(release);
    return () => { unsubscribe(); release(); };
  }, [selection, intent]);

  async function run(action?: SessionAction): Promise<void> {
    if (!owned() || intent.snapshot.refreshing || intent.snapshot.phase === 'pending') return;
    if (action && intent.snapshot.phase !== 'confirming') return;
    const abort = new AbortController();
    setAbort(intent, abort);
    update(intent, action ? { phase: 'pending', action, notice: undefined } : { refreshing: true });
    const check = () => { if (!owned()) abort.abort(); abort.signal.throwIfAborted(); };
    let rejectAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new DOMException('Session action interrupted', 'AbortError'));
      abort.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => abort.abort(), 30_000);
    const wait = async <T,>(request: Promise<T>): Promise<T> => {
      const result = await Promise.race([request, interrupted]); check(); return result;
    };
    try {
      check();
      if (action === 'close' || action === 'reopen') {
        await wait(sdk.operator.sessions[action](id, abort.signal));
      } else if (action === 'delete') {
        try { await wait(sdk.operator.sessions.close(id, abort.signal)); }
        catch (error) { check(); if (!isTargetMissing(error)) throw error; }
        check();
        try { await wait(sdk.operator.sessions.delete(id, abort.signal)); }
        catch (error) { check(); if (!isTargetMissing(error)) throw error; }
      }
      check();
      const listKey = queryKeys.sessionList(lifetime.revision);
      // Stop pre-action snapshots from overwriting this authoritative read.
      await wait(client.cancelQueries({ queryKey: listKey, exact: true }));
      let result = await wait(readSessionList(lifetime, abort.signal));
      let record = result.sessions.find(record => record.id === id);
      // sessions.list is capped (currently 50). Absence there is not proof of
      // deletion; only this target's explicit SESSION_NOT_FOUND proves it gone.
      if (!record) {
        try {
          const detail = await wait(sdk.operator.sessions.get(id, abort.signal));
          if (asRecord(asRecord(detail).session).id !== id) throw new Error('The daemon returned an unreadable session.');
          record = detail.session;
          result = { ...result, sessions: [...result.sessions, record] };
        } catch (error) { check(); if (!isTargetMissing(error)) throw error; }
      }
      if (action === 'delete' && record) throw new Error('The session record still exists.');
      check();
      // Supersede a realtime read that may have begun during reconciliation.
      await wait(client.cancelQueries({ queryKey: listKey, exact: true }));
      check();
      update(intent, { phase: 'idle', action: undefined, refreshing: false, notice: undefined });
      client.setQueryData(listKey, result);
      if (!record && owned()) onClose();
    } catch {
      if (intent.abort === abort && current()) {
        if (action) unknown(intent);
        else update(intent, { refreshing: false, notice: `${UNKNOWN} Could not refresh session state.` });
      }
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', rejectAbort);
      if (intent.abort === abort) setAbort(intent, undefined);
    }
  }

  function ask(action: SessionAction): void {
    if (!owned() || intent.snapshot.refreshing || intent.snapshot.phase !== 'idle') return;
    update(intent, { phase: 'confirming', action });
    if (action === 'reopen') void run(action);
  }
  function dismiss(): void {
    if (owned() && intent.snapshot.phase === 'confirming') update(intent, { phase: 'idle', action: undefined });
  }
  const confirm = () => { if (intent.snapshot.action) void run(intent.snapshot.action); };
  const refresh = () => { if (intent.snapshot.phase === 'unknown') void run(); };
  return { ...state, ask, dismiss, confirm, refresh,
    disabled: state.phase !== 'idle' || state.refreshing || !current(),
  };
}
