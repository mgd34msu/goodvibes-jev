/** Session lifecycle wire events share one app-wide session-domain stream. */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sdk, DEFAULT_SSE_RECONNECT } from '../lib/goodvibes';
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
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let close: (() => void) | null = null;

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
            if (disposed) return;
            setConnected(true);
            setError(null);
          },
          onEvent: (eventName: string, payload: unknown) => {
            if (disposed) return;
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
            if (disposed) return;
            setConnected(false);
            setError(err instanceof Error ? err.message : 'Session event stream error');
          },
          onTerminate: () => {
            if (disposed) return;
            setConnected(false);
            setError('Session event stream disconnected: live updates paused, falling back to periodic refresh.');
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
        setError(err instanceof Error ? err.message : 'Failed to open session event stream');
      });

    return () => {
      disposed = true;
      if (close) close();
    };
  }, [enabled, queryClient]);

  return { error, connected };
}
