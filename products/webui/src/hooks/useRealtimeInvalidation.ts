/**
 * useRealtimeInvalidation, refetch React Query caches off the control-plane event feed.
 *
 * CONNECTION BUDGET (the W-2 fix): the browser caps concurrent connections per origin
 * (~6 on HTTP/1.1). The previous implementation used `sdk.realtime.viaSse()` and
 * subscribed to five domains (tasks, gate, providers, knowledge, control-plane),
 * and viaSse opens ONE SSE connection PER domain. Together with useSessionRealtime's
 * own session stream that reached six long-lived streams, saturating the pool so the
 * NEXT fetch (notably SessionsView's sessions.list on navigation) had no socket and hung
 * forever: the Sessions/Union view rendered zero rows with no error and no empty state.
 *
 * The daemon multiplexes every domain onto ONE stream via `?domains=a,b,c`
 * (GET /api/control-plane/events, `event: <domain>` per frame, integration/helpers.ts).
 * So we open a SINGLE raw multiplexed stream here and route by the frame's event name
 * (which IS the domain), invalidating that domain's query keys. This collapses five
 * connections to one; with useSessionRealtime that is two streams total, well under the
 * per-origin cap. We only INVALIDATE (trigger a revalidate) off the stream, never render
 * straight from a frame, matching useSessionRealtime.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getClientLifetime, subscribeClientLifetime } from '../lib/client-lifetime';
import { useQueryClient } from '@tanstack/react-query';
import type { RuntimeEventDomain } from '@goodvibes-jev/engine/contracts';
import { sdk, DEFAULT_SSE_RECONNECT } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';
import { RELAY_OVERFLOW_EVENT, noteRelayOverflow, readDroppedCount } from '../lib/relay-stream-overflow';

/**
 * Domain → the query keys a frame on that domain should revalidate. The raw stream
 * delivers the DOMAIN as the event name (the daemon writes `event: <domain>`), so we
 * invalidate at domain granularity rather than per specific event type, coarser than
 * the old per-event binding but identical in effect (invalidation only triggers a
 * refetch), and it drops the dead 'controlPlane' alias the old code carried.
 */
const DOMAIN_INVALIDATIONS: Record<string, readonly (readonly unknown[])[]> = {
  tasks: [queryKeys.tasks],
  contracts: [queryKeys.contracts],
  // gate: approvals AND queryKeys.sessions, the SDK's PERMISSION_MODE_CHANGED
  // event (events/gate.ts) rides this same domain (no dedicated wire event of
  // its own) and carries no sessionId, so we can't target the one session-scoped
  // permission-mode query that changed. Invalidating the broad `queryKeys.sessions`
  // prefix (queries.ts: sessionPermissionMode/sessionContextUsage are BOTH prefixed
  // with 'sessions') revalidates whichever session's chip is mounted, the same
  // "invalidate off the frame, never render straight from it" idiom the rest of this
  // map already uses. queryKeys.config is NOT invalidated here anymore: nothing reads
  // permission mode off config.get() since SessionsView moved to the session-scoped
  // sessions.permissionMode.get/set verbs (the engine gate preset contract).
  gate: [queryKeys.approvals, queryKeys.sessions, queryKeys.permissionRules],
  // Model changes and provider metadata updates can replace a known context
  // window with an unknown one. Re-read the mounted session usage from the same
  // stream; a provider frame is only an invalidation, never a capacity claim.
  providers: [queryKeys.providers, queryKeys.sessions],
  knowledge: [queryKeys.knowledgeStatus, queryKeys.knowledgeSources, queryKeys.knowledgeRefinement],
  'control-plane': [queryKeys.control],
  // fleet: the SDK now emits per-node lifecycle deltas (FLEET_NODE_STARTED /
  // _STATE_CHANGED / _FINISHED / _BLOCKED_ON_USER / _UNBLOCKED) on the runtime
  // event bus `fleet` domain, which the daemon fans out over this SAME multiplexed
  // stream (no new connection). We follow this hook's established idiom, INVALIDATE
  // off the frame, never render straight from it, so any fleet frame revalidates the
  // live snapshot and the archive: the Fleet tree and the app-level attention badge
  // update on the event instead of waiting for the next poll. The snapshot stays the
  // single source of truth (the registry is "a view, not a second source"), so we do
  // not reconstruct a client-side tree from the deltas. The poll remains as the honest
  // fallback while this stream is down (see FleetView's subscriptionActive gate).
  fleet: [queryKeys.fleet, queryKeys.fleetArchived],
  // ops: the runtime.ops domain, OPS_POWER_STATE_CHANGED rides it (SDK 1.8.0's host
  // sleep-ownership work). Invalidating queryKeys.power revalidates the always-visible
  // "sleep disabled" chip (StatusStrip) and the admin Power panel the instant the owner
  // keep-awake toggle or the automatic work inhibitor changes on ANY attached surface,
  // not only on this one's own mutation success. OPS_MEMORY_PRESSURE (SDK 1.9.0-dev's
  // memory-relay-voice-hardening work) rides the SAME 'ops' domain, invalidating
  // queryKeys.opsMemory here is the whole surfacing story for that event: the admin
  // Memory panel refetches its tier chip on the real pressure change, exactly the way
  // PowerChip/PowerSettings already refetch on OPS_POWER_STATE_CHANGED (invalidate off
  // the frame, re-render the fresh polled state, never a separate attention-item feed;
  // no such feed exists in this webui today, see MemoryDiagnostics.tsx's header comment).
  ops: [queryKeys.power, queryKeys.opsMemory],
} satisfies Partial<Record<RuntimeEventDomain, readonly (readonly unknown[])[]>>;

/** The single multiplexed control-plane stream carrying every domain we invalidate on. */
const INVALIDATION_EVENTS_PATH = `/api/control-plane/events?domains=${Object.keys(DOMAIN_INVALIDATIONS).join(',')}`;

/**
 * The ONE operator-facing string this hook ever surfaces. Every failure mode, the
 * open() promise rejecting, an onError frame, or a clean onTerminate, collapses to this
 * friendly copy. Critically, the transport's onError sets `err.message` to the raw daemon
 * RESPONSE BODY (e.g. the `{"error":"Authentication required",...,"code":"AUTH_REQUIRED"}`
 * 401 blob seen on a pre-auth open); passing that through would paint that JSON verbatim
 * across every view's banner. We never render a transport-level body, the banner shows
 * this established "live updates paused / reconnecting" wording instead.
 */
const REALTIME_PAUSED_MESSAGE =
  'Live updates paused: reconnecting. Views fall back to periodic refresh until the stream returns.';

export function useRealtimeInvalidation(enabled: boolean) {
  const queryClient = useQueryClient();
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let close: (() => void) | null = null;
    const invalidate = (key: readonly unknown[], domain?: string) => {
      if (domain === 'providers' && key[0] === 'sessions') {
        // Cancel the context read even if it has no cached data yet. Otherwise a
        // model-change event during the first request only marks it stale and
        // its pre-change capacity can win. Other session queries are untouched.
        const filter = { queryKey: key, predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[2] === 'context-usage' };
        void queryClient.cancelQueries(filter).then(() => {
          if (!disposed && getClientLifetime() === lifetime) void queryClient.invalidateQueries(filter);
        });
        return;
      }
      if (key[0] !== 'contracts') { void queryClient.invalidateQueries({ queryKey: key }); return; }
      // An initial query without data otherwise absorbs invalidation while in
      // flight. A contract event must supersede that pre-event snapshot too.
      void queryClient.cancelQueries({ queryKey: key }).then(() => {
        if (!disposed && getClientLifetime() === lifetime) void queryClient.invalidateQueries({ queryKey: key });
      });
    };

    sdk.streams
      .open(
        INVALIDATION_EVENTS_PATH,
        {
          onReady: () => {
            if (disposed) return;
            setError(null);
          },
          onEvent: (eventName: string, payload: unknown) => {
            if (disposed || getClientLifetime() !== lifetime) return;
            if (eventName === RELAY_OVERFLOW_EVENT) {
              // The relay tunnel dropped multiplexed invalidation frames. Record the honest
              // notice and revalidate every domain we track, a full refetch is the correct
              // recovery since these frames only ever trigger invalidations.
              noteRelayOverflow(readDroppedCount(payload));
              for (const [domain, keys] of Object.entries(DOMAIN_INVALIDATIONS)) {
                for (const key of keys) invalidate(key, domain);
              }
              return;
            }
            if (!Object.hasOwn(DOMAIN_INVALIDATIONS, eventName)) return;
            const keys = DOMAIN_INVALIDATIONS[eventName];
            for (const key of keys) {
              invalidate(key, eventName);
            }
          },
          // NEVER surface `err.message` here, on a pre-auth open it IS the raw 401
          // response body. Collapse every transport error to the friendly copy.
          onError: (_err: unknown) => {
            if (disposed) return;
            setError(REALTIME_PAUSED_MESSAGE);
          },
          onTerminate: () => {
            if (disposed) return;
            setError(REALTIME_PAUSED_MESSAGE);
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
      .catch((_err: unknown) => {
        if (disposed) return;
        setError(REALTIME_PAUSED_MESSAGE);
      });

    return () => {
      disposed = true;
      if (close) close();
    };
  }, [enabled, queryClient, lifetime]);

  return error;
}
