import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from '../lib/client-lifetime';
import { hasStoredTokenSync, sdk } from '../lib/goodvibes';
import { formatError, isSessionClosedError, serializeError } from '../lib/errors';
import { asRecord } from '../lib/object';
import { queryKeys } from '../lib/queries';

type InputReceipt = OperatorMethodOutput<'sessions.inputs.list'>['inputs'][number];
export type DispatchMode = 'steer' | 'followUp';
export interface LocalDispatch {
  id: number;
  mode: DispatchMode;
  text: string;
  state: InputReceipt['state'] | 'sending' | 'unknown';
  inputId?: string;
  updatedAt?: number;
  error?: string;
}
const terminal = new Set<LocalDispatch['state']>(['completed', 'failed', 'cancelled', 'rejected', 'unknown']);
const states = new Set<InputReceipt['state']>(['queued', 'delivered', 'spawned', 'completed', 'cancelled', 'failed', 'rejected']);

function validReceipt(value: unknown, sessionId: string): value is InputReceipt {
  const input = asRecord(value);
  return typeof input.id === 'string' && input.id.length > 0 && input.sessionId === sessionId
    && states.has(input.state as InputReceipt['state']) && typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
    && (input.error === undefined || typeof input.error === 'string');
}

function adopt(dispatch: LocalDispatch, input: InputReceipt): LocalDispatch {
  // An older in-flight list must not undo a newer POST receipt, or regress a
  // delivered/terminal input to queued when updates share a millisecond.
  // Spawn POSTs manufacture a snapshot before the broker's oldest-input claim;
  // a list may correctly show that this particular input is still queued.
  if ((dispatch.updatedAt ?? -Infinity) > input.updatedAt || terminal.has(dispatch.state)
    || (input.state === 'queued' && dispatch.state === 'delivered')) return dispatch;
  if (dispatch.inputId === input.id && dispatch.state === input.state
    && dispatch.updatedAt === input.updatedAt && dispatch.error === input.error) return dispatch;
  return { ...dispatch, inputId: input.id, state: input.state, updatedAt: input.updatedAt, error: input.error };
}

/** One local receipt per send; list/event refreshes match only the returned input ID. */
export function useSessionDispatches(lifetime: ClientLifetime, sessionId: string, streamPaused: boolean) {
  const client = useQueryClient();
  const [dispatches, setDispatches] = useState<LocalDispatch[]>([]);
  const sequence = useRef(0);
  const owner = useRef(false);
  const flights = useRef(new Set<AbortController>());
  const current = () => isClientLifetimeCurrent(lifetime) && hasStoredTokenSync();
  const owned = () => owner.current && current();
  const key = queryKeys.sessionInputs(lifetime.revision, sessionId);

  useEffect(() => {
    owner.current = true;
    const aborts = flights.current;
    const release = () => {
      owner.current = false;
      for (const abort of aborts) abort.abort();
      aborts.clear();
      client.removeQueries({ queryKey: queryKeys.sessionInputs(lifetime.revision, sessionId), exact: true });
    };
    const unsubscribe = subscribeClientLifetime(release);
    return () => { unsubscribe(); release(); };
  }, [client, lifetime, sessionId]);

  const watching = dispatches.some((dispatch) => dispatch.inputId && !terminal.has(dispatch.state));
  const inputs = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      const unsubscribe = subscribeClientLifetime(cancel);
      const timer = setTimeout(cancel, 15_000);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (signal.aborted || !current()) cancel();
        abort.signal.throwIfAborted();
        const result = await sdk.operator.sessions.inputs.list(sessionId, abort.signal);
        if (!current()) cancel();
        abort.signal.throwIfAborted();
        if (!Array.isArray(result?.inputs) || result.inputs.some((input) => !validReceipt(input, sessionId))) {
          throw new Error('The daemon returned unreadable input receipts.');
        }
        return result;
      } finally { clearTimeout(timer); unsubscribe(); signal.removeEventListener('abort', cancel); }
    },
    enabled: watching && current(),
    retry: false,
    gcTime: 0,
    // Session events invalidate this prefixed query; polling also covers lost events.
    refetchInterval: streamPaused ? 5_000 : 15_000,
  });

  useEffect(() => {
    if (!inputs.data || !isClientLifetimeCurrent(lifetime)) return;
    const receipts = new Map(inputs.data.inputs.map((input) => [input.id, input]));
    setDispatches((previous) => {
      const next = previous.map((dispatch) => {
        const input = dispatch.inputId ? receipts.get(dispatch.inputId) : undefined;
        return input ? adopt(dispatch, input) : dispatch;
      });
      return next.some((dispatch, index) => dispatch !== previous[index]) ? next : previous;
    });
  }, [inputs.data, dispatches, lifetime]);

  // Keep dispatch text/receipts local to this mounted identity, rather than
  // retaining them in QueryClient's cross-account mutation cache after navigation.
  async function dispatch(id: number, body: string, mode: DispatchMode, abort: AbortController) {
    const timer = setTimeout(() => {
      if (!owned() || abort.signal.aborted) return;
      setDispatches((previous) => previous.map((entry) => entry.id !== id ? entry : { ...entry, state: 'unknown',
        error: 'Delivery confirmation timed out. Check the transcript before sending again. The request will not be retried automatically.' }));
      abort.abort();
    }, 30_000);
    const clearDeadline = () => clearTimeout(timer);
    abort.signal.addEventListener('abort', clearDeadline, { once: true });
    try {
      if (!owned()) abort.abort();
      abort.signal.throwIfAborted();
      const data = await (mode === 'steer'
        ? sdk.operator.sessions.steer(sessionId, { body }, abort.signal)
        : sdk.operator.sessions.followUp(sessionId, { body }, abort.signal));
      if (!owned() || abort.signal.aborted) return;
      setDispatches((previous) => previous.map((entry) => entry.id !== id ? entry
        : validReceipt(data?.input, sessionId) ? adopt(entry, data.input)
          : { ...entry, state: 'unknown', error: 'The request returned no readable input receipt. Check the transcript before sending again.' }));
      void client.invalidateQueries({ queryKey: queryKeys.sessions });
    } catch (error) {
      if (!owned() || abort.signal.aborted) return;
      const closed = isSessionClosedError(error);
      const serialized = serializeError(error);
      const transport = asRecord(serialized.transport);
      const input = asRecord(serialized.body ?? transport.body).input;
      // A bare error can follow persistence (for example spawn-capacity 429).
      // Only an explicit input receipt or pre-submission closed guard is final.
      setDispatches((previous) => previous.map((entry) => entry.id !== id ? entry
        : validReceipt(input, sessionId) ? adopt(entry, input)
          : { ...entry, state: closed ? 'failed' : 'unknown', error: closed
            ? 'This session is closed. Reopen it to continue.'
            : `${formatError(error)}. Delivery is unknown. Check the transcript before sending again. The request will not be retried automatically.` }));
      if (closed || validReceipt(input, sessionId)) void client.invalidateQueries({ queryKey: queryKeys.sessions });
    } finally { clearDeadline(); abort.signal.removeEventListener('abort', clearDeadline); flights.current.delete(abort); }
  }

  function send(body: string, mode: DispatchMode): boolean {
    if (!owned()) return false;
    const id = ++sequence.current;
    const abort = new AbortController();
    flights.current.add(abort);
    setDispatches((previous) => [{ id, mode, text: body, state: 'sending' as const }, ...previous].slice(0, 20));
    void dispatch(id, body, mode, abort);
    return true;
  }

  const missingReceipt = watching && inputs.isSuccess && dispatches.some((entry) => entry.inputId
    && !terminal.has(entry.state) && !inputs.data.inputs.some((input) => input.id === entry.inputId));
  return { dispatches, send, refreshFailed: watching && inputs.isError, missingReceipt };
}
