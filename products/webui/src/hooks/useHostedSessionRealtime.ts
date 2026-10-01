/**
 * useHostedSessionRealtime, the hosted-sessions raw stream: lifecycle updates
 * for the list, plus the LIVE `turn`/`tools` output for one attached session.
 *
 * WHY A RAW STREAM (the useSessionRealtime pattern, not useRealtimeInvalidation's):
 * `hosted-session-update` is a fixed wire-event NAME (never the domain string) whose
 * specific transition rides `payload.event`, the same "un-domained-looking but
 * actually filter-tagged" shape `session-update` has (useSessionRealtime.ts's header
 * comment). useRealtimeInvalidation's DOMAIN_INVALIDATIONS only matches a frame whose
 * `event:` field IS a domain name (the runtime-bus auto-forward mechanism), so an
 * `event: hosted-session-update` frame is invisible to it, this hook opens its own
 * scoped raw stream via sdk.streams.open, exactly like useSessionRealtime, rather than
 * teaching the app-wide invalidation hook a wire event that only this feature cares
 * about.
 *
 * ONE stream covers both jobs this feature needs:
 *  - list liveness: every `hosted-session-update` frame invalidates the hosted list
 *    query (regardless of which session it names, turn/message counts, attached
 *    client counts and status all live there).
 *  - attach-view liveness: when `attachedSessionId` is given, `turn`/`tools` domain
 *    frames whose `sessionId` matches are decoded and handed to `onStreamFrame` (see
 *    lib/hosted-session-stream.ts), this is the hosted session's live output, the
 *    exact same envelopes a local session's turn emits (no separate wire shape for a
 *    hosted loop, method-catalog-hosted-sessions.ts's header comment). A matching
 *    `hosted-session-update` also calls `onLifecycleUpdate` so the attached view's own
 *    status/attachedClients/turnCount chips can update without a manual refetch.
 *
 * Only mounted while the hosted-sessions view is showing (not app-wide), so this adds
 * at most one connection to the per-origin budget useRealtimeInvalidation's header
 * comment tracks, never a second one for list vs. attach, since attaching narrows
 * what the SAME open stream forwards rather than opening a new one.
 *
 * THE STREAM OPENS EXACTLY ONCE PER `enabled` TOGGLE, NEVER ON ATTACH/DETACH: the
 * connection itself does not depend on which session is attached (the `?domains=`
 * path is a constant), only the in-hook JS filtering does. `attachedSessionId` and
 * the callbacks are read through refs, updated every render, so selecting a
 * different row re-targets what the OPEN stream forwards without tearing the
 * connection down and reopening it. Reopening on every attach would both waste a
 * connection and MISS whatever the daemon published in the gap between close and
 * reopen, there is no replay across that gap in this design.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sdk, DEFAULT_SSE_RECONNECT } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';
import { firstString, readPath } from '../lib/object';
import { readHostedStreamFrame, type HostedStreamFrame } from '../lib/hosted-session-stream';
import { RELAY_OVERFLOW_EVENT, noteRelayOverflow, readDroppedCount } from '../lib/relay-stream-overflow';

/** The fixed wire-event name every hosted-session lifecycle notice rides,
 * always this literal string; the specific transition is `payload.event`
 * (HostedSessionUpdatePayload, hosted-sessions/types.ts). */
export const HOSTED_SESSION_UPDATE_WIRE_EVENT = 'hosted-session-update';

/** `?domains=` narrowing for this stream: `session` tags hosted-session-update
 * (EVENT_DOMAIN in the SDK's gateway-scope-enforcement.ts), `turn`/`tools` carry
 * the ordinary orchestrator's live output the hosted loop emits. */
const HOSTED_SESSION_EVENTS_PATH = '/api/control-plane/events?domains=session,turn,tools';

export interface UseHostedSessionRealtimeOptions {
  readonly enabled: boolean;
  /** The currently-attached hosted session, or null/undefined when only the list
   * is showing, turn/tools frames are forwarded only when they match this id. */
  readonly attachedSessionId?: string | null;
  readonly onStreamFrame?: (frame: HostedStreamFrame) => void;
  /** Called when a hosted-session-update frame's session id matches
   * `attachedSessionId`, the raw frame payload (`{event, session, ...}`). */
  readonly onLifecycleUpdate?: (payload: unknown) => void;
}

export interface UseHostedSessionRealtimeResult {
  readonly connected: boolean;
  readonly error: string | null;
}

export function useHostedSessionRealtime(options: UseHostedSessionRealtimeOptions): UseHostedSessionRealtimeResult {
  const { enabled } = options;
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Read through refs inside the stream's long-lived callbacks so the effect below
  // never needs attachedSessionId/onStreamFrame/onLifecycleUpdate in its deps, see
  // the header comment on why reopening the stream on attach/detach is wrong. Synced
  // in its own effect (never during render) so the stream-opening effect's identity
  // is unaffected by how often this one re-runs.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let close: (() => void) | null = null;

    const invalidateList = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedSessionsAll });
    };

    sdk.streams
      .open(
        HOSTED_SESSION_EVENTS_PATH,
        {
          onReady: () => {
            if (disposed) return;
            setConnected(true);
            setError(null);
          },
          onEvent: (eventName: string, payload: unknown) => {
            if (disposed) return;
            const { attachedSessionId, onStreamFrame, onLifecycleUpdate } = optionsRef.current;
            if (eventName === RELAY_OVERFLOW_EVENT) {
              noteRelayOverflow(readDroppedCount(payload));
              invalidateList();
              return;
            }
            if (eventName === HOSTED_SESSION_UPDATE_WIRE_EVENT) {
              invalidateList();
              const sessionId = firstString(readPath(payload, ['session']), ['id']);
              if (attachedSessionId && sessionId === attachedSessionId) {
                onLifecycleUpdate?.(payload);
              }
              return;
            }
            if (eventName === 'turn' || eventName === 'tools') {
              if (!attachedSessionId) return;
              const frame = readHostedStreamFrame(payload);
              if (frame?.sessionId === attachedSessionId) {
                onStreamFrame?.(frame);
              }
              return;
            }
            // 'session' domain riders (e.g. PERMISSION_MODE_CHANGED) carry nothing
            // this feature renders, ignored, matching useRealtimeInvalidation's
            // "unknown key, no-op" idiom for a frame outside this hook's scope.
          },
          onError: (err: unknown) => {
            if (disposed) return;
            setConnected(false);
            setError(err instanceof Error ? err.message : 'Hosted session event stream error');
          },
          onTerminate: () => {
            if (disposed) return;
            setConnected(false);
            setError('Live updates paused: reconnecting. The hosted sessions list falls back to periodic refresh until the stream returns.');
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
        setError(err instanceof Error ? err.message : 'Failed to open the hosted session event stream');
      });

    return () => {
      disposed = true;
      if (close) close();
    };
  }, [enabled, queryClient]);

  return { error, connected };
}
