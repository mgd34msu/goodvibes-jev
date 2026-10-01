/**
 * useCompactionReceipts, live compaction signal for ONE session's detail view.
 *
 * Opens the raw control-plane stream scoped to the 'compaction' runtime-event
 * domain (see lib/compaction.ts's header for why this is the only wire-honest
 * source of post-compaction receipts and live token-usage numbers). Filters
 * every frame to the given sessionId, the domain is daemon-wide, so a receipt
 * for a DIFFERENT session must never bleed into this view.
 *
 * Content-consuming, not invalidate-only: unlike useRealtimeInvalidation (which
 * only triggers a React Query refetch), there is no GET-equivalent for a
 * compaction receipt, it is an event with no queryable snapshot, so the frame
 * itself is the only copy of this data. This follows useSessionRealtime's raw-
 * stream-escape-hatch precedent rather than the typed viaSse() domain facade.
 *
 * Connection-budget note (see useRealtimeInvalidation.ts's header on the ~6
 * connections-per-origin cap): this hook is meant to be mounted ONLY while a
 * session's detail pane is open (SessionsView's SessionDetail), not app-wide,
 * closed on unmount/session change, same as useChatStream's per-turn stream.
 * App-wide connections (useSessionRealtime, useRealtimeInvalidation) stay at 2;
 * this is a 3rd, transient one, and SessionsView is never mounted alongside
 * ChatView's own per-turn stream (App.tsx renders one active view at a time).
 */

import { useEffect, useState } from 'react';
import { sdk, DEFAULT_SSE_RECONNECT } from '../lib/goodvibes';
import { parseCompactionCheck, parseCompactionReceipt, type CompactionCheck, type CompactionReceipt } from '../lib/compaction';

const COMPACTION_EVENTS_PATH = '/api/control-plane/events?domains=compaction';

/** Cap retained receipts per session, an honest live log, not an unbounded leak. */
const MAX_RECEIPTS = 20;

export interface CompactionReceiptsState {
  receipts: CompactionReceipt[];
  latestCheck: CompactionCheck | null;
  connected: boolean;
  error: string | null;
}

export function useCompactionReceipts(sessionId: string, enabled: boolean): CompactionReceiptsState {
  const [receipts, setReceipts] = useState<CompactionReceipt[]>([]);
  const [latestCheck, setLatestCheck] = useState<CompactionCheck | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reset the log when the session changes, during render (the React-blessed
  // "adjust state when a prop changes" pattern, plain useState, not a ref read
  // during render), before the effect below re-opens the stream, avoiding a
  // one-frame flash of the PREVIOUS session's receipts.
  const [trackedSessionId, setTrackedSessionId] = useState(sessionId);
  if (trackedSessionId !== sessionId) {
    setTrackedSessionId(sessionId);
    setReceipts([]);
    setLatestCheck(null);
  }

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    let disposed = false;
    let close: (() => void) | null = null;

    sdk.streams
      .open(
        COMPACTION_EVENTS_PATH,
        {
          onReady: () => {
            if (disposed) return;
            setConnected(true);
            setError(null);
          },
          onEvent: (eventName: string, payload: unknown) => {
            if (disposed || eventName !== 'compaction') return;
            const receipt = parseCompactionReceipt(payload);
            if (receipt) {
              if (receipt.sessionId === sessionId) {
                setReceipts((current) => [...current, receipt].slice(-MAX_RECEIPTS));
              }
              return;
            }
            const check = parseCompactionCheck(payload);
            if (check) {
              if (check.sessionId === sessionId) setLatestCheck(check);
            }
          },
          onError: (err: unknown) => {
            if (disposed) return;
            setConnected(false);
            setError(err instanceof Error ? err.message : 'Compaction event stream error');
          },
          onTerminate: () => {
            if (disposed) return;
            setConnected(false);
            setError('Compaction event stream disconnected.');
          },
        },
        { reconnect: DEFAULT_SSE_RECONNECT },
      )
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        close = dispose;
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : 'Failed to open compaction event stream');
      });

    return () => {
      disposed = true;
      if (close) close();
    };
  }, [enabled, sessionId]);

  return { receipts, latestCheck, connected, error };
}
