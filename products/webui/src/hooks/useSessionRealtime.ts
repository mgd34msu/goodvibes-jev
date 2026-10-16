/** Session lifecycle wire events share one app-wide session-domain stream. */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sdk, DEFAULT_SSE_RECONNECT } from '../lib/goodvibes';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from '../lib/client-lifetime';
import { getActiveRoute, subscribeActiveRoute } from '../lib/relay-connection';
import { queryKeys } from '../lib/queries';
import { SESSION_UPDATE_WIRE_EVENT, sessionUpdateIntent } from '../lib/sessions-union';
import { HOSTED_SESSION_UPDATE_WIRE_EVENT } from '../lib/hosted-sessions';
import { firstString, readPath } from '../lib/object';
import { RELAY_OVERFLOW_EVENT, noteRelayOverflow, readDroppedCount } from '../lib/relay-stream-overflow';

/** Both lifecycle wire names are tagged with the session domain by the gateway. */
const SESSION_EVENTS_PATH = '/api/control-plane/events?domains=session';

export interface SessionRealtimeState {
  /** Human-readable error when the stream failed to open or terminated. */
  error: string | null;
  /** True once the raw stream reported it was ready (headers received). */
  connected: boolean;
}

/**
 * Decode a raw `session-update` frame and return the sessionId it concerns, if any.
 * The frame shape is `{ event, payload, createdAt }` (control.session_update schema);
 * the session id lives on the inner payload.
 */
export function sessionIdFromUpdateFrame(frame: unknown): string {
  return (
    firstString(frame, ['sessionId', 'id'])
    || firstString(readPath(frame, ['payload']), ['sessionId', 'id'])
    || firstString(readPath(frame, ['payload', 'session']), ['sessionId', 'id'])
  );
}

/** The raw event value carried by a session-update frame (`payload.event`). */
export function updateEventName(frame: unknown): string {
  return firstString(frame, ['event']);
}

export function useSessionRealtime(enabled: boolean): SessionRealtimeState {
  const queryClient = useQueryClient();
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  const route = useSyncExternalStore(subscribeActiveRoute, getActiveRoute, getActiveRoute);
  const connection = useMemo(() => ({ enabled, queryClient, lifetime, route }), [enabled, queryClient, lifetime, route]);
  const [state, setState] = useState({ connection, error: null as string | null, connected: false });

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let disposed = false;
    let close: (() => void) | null = null;
    const current = () => !disposed && !controller.signal.aborted && isClientLifetimeCurrent(lifetime) && route === getActiveRoute();

    // Invalidating queryKeys.sessions (['sessions']) non-exactly refetches the union
    // list AND every prefixed detail/messages query. We only INVALIDATE (trigger a
    // revalidate) off the stream, never render straight from the frame, matching the
    // existing useRealtimeInvalidation fast-path-off-the-socket model.
    const invalidateAll = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedSessionsAll });
    };

    sdk.streams
      .open(
        SESSION_EVENTS_PATH,
        {
          onReady: () => {
            if (!current()) return;
            setState({ connection, connected: true, error: null });
          },
          onEvent: (eventName: string, payload: unknown) => {
            if (!current()) return;
            if (eventName === RELAY_OVERFLOW_EVENT) {
              // Live events were dropped over the relay tunnel. Record the honest notice
              // AND revalidate now, the missed frames were only invalidation triggers, so
              // a refetch restores the true session state (the banner still shows so the
              // operator knows a gap happened and can resync explicitly).
              noteRelayOverflow(readDroppedCount(payload));
              invalidateAll();
              return;
            }
            if (eventName === HOSTED_SESSION_UPDATE_WIRE_EVENT) {
              void queryClient.invalidateQueries({ queryKey: queryKeys.hostedSessionsAll });
              return;
            }
            if (eventName !== SESSION_UPDATE_WIRE_EVENT) return;
            // Decode the intent for targeting/observability; an unknown future event
            // (intent === null) still invalidates defensively rather than being dropped.
            const wireEvent = updateEventName(payload);
            void sessionUpdateIntent(wireEvent); // reserved for finer-grained targeting
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
          },
          onError: (err: unknown) => {
            if (!current()) return;
            setState({ connection, connected: false, error: err instanceof Error ? err.message : 'Session event stream error' });
          },
          onTerminate: () => {
            if (!current()) return;
            setState({ connection, connected: false, error: 'Session event stream disconnected: live updates paused, falling back to periodic refresh.' });
          },
        },
        { reconnect: DEFAULT_SSE_RECONNECT, signal: controller.signal },
      )
      .then((dispose) => {
        if (!current()) {
          dispose();
          return;
        }
        close = dispose;
      })
      .catch((err: unknown) => {
        if (!current()) return;
        setState({ connection, connected: false, error: err instanceof Error ? err.message : 'Failed to open session event stream' });
      });

    return () => {
      disposed = true;
      controller.abort();
      if (close) close();
    };
  }, [enabled, queryClient, lifetime, route, connection]);

  return state.connection === connection ? { error: state.error, connected: state.connected } : { error: null, connected: false };
}
