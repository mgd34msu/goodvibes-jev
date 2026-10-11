/**
 * Live turn/tool output and lifecycle updates for an attached hosted session.
 * The app-wide session stream owns list liveness even when nothing is attached.
 * Row changes retarget callbacks through refs without reopening this stream.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sdk, DEFAULT_SSE_RECONNECT } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';
import { HOSTED_SESSION_UPDATE_WIRE_EVENT } from '../lib/hosted-sessions';
import { firstString, readPath } from '../lib/object';
import { readHostedStreamFrame, type HostedStreamFrame } from '../lib/hosted-session-stream';
import { RELAY_OVERFLOW_EVENT, noteRelayOverflow, readDroppedCount } from '../lib/relay-stream-overflow';

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
    const controller = new AbortController();
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
            setError('Live session output paused: reconnecting.');
          },
        },
        { reconnect: DEFAULT_SSE_RECONNECT, signal: controller.signal },
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
      controller.abort();
      if (close) close();
    };
  }, [enabled, queryClient]);

  return { error, connected };
}
