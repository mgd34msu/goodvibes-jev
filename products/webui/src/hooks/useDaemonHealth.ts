import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sdk, GOODVIBES_BASE_URL, WEBUI_VERSION, getCurrentAuth } from '../lib/goodvibes';
import {
  evaluateClientCompatibility,
  getObservedClientCompatibilityFloor,
  subscribeObservedClientCompatibilityFloor,
  type ClientCompatibilityVerdict,
} from '../lib/client-compatibility';
import {
  type DaemonHealth,
  type ConnectionState,
  type AuthState,
  type WorkingState,
  type SseState,
  DAEMON_HEALTH_DEFAULTS,
  taskCountsFromList,
  modelNameFromCurrent,
  clampLatency,
  deriveAuthState,
  deriveWorkingState,
} from '../lib/daemon-health';
import { getStoredRelayPairing } from '../lib/relay-pairing';
import { getActiveRoute, probeRelayReachability, setActiveRoute, subscribeActiveRoute } from '../lib/relay-connection';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to re-probe the daemon (ms) */
const HEALTH_PROBE_INTERVAL_MS = 15_000;

/**
 * Ping endpoint, lightweight, always-available.
 * We treat this probe as PURE LIVENESS: ok = status < 500 (includes 401 when
 * the daemon is up but unauthenticated).
 */
const PING_PATH = '/api/local-auth';

// ---------------------------------------------------------------------------
// Internal latency probe
// ---------------------------------------------------------------------------

async function probeLatency(): Promise<{ latencyMs: number | null; ok: boolean }> {
  const start = performance.now();
  try {
    const url = `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}${PING_PATH}`;
    const res = await fetch(url, { credentials: 'include', method: 'GET' });
    const elapsed = clampLatency(Math.round(performance.now() - start));
    return { latencyMs: elapsed, ok: res.status < 500 };
  } catch {
    return { latencyMs: null, ok: false };
  }
}

/** Read a numeric HTTP status off a thrown error, if the caller attached one. */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/** Run an authed call and reduce it to an {ok,status} probe result (never throws). */
async function probeCall(fn: () => Promise<unknown>): Promise<{ ok: boolean; status: number | null }> {
  try {
    await fn();
    return { ok: true, status: 200 };
  } catch (error) {
    return { ok: false, status: statusOf(error) };
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns live daemon health: connection state, latency, SSE stream state,
 * active turn count, queued task count, and current model name.
 *
 * - Probes the daemon every 15 s via a lightweight fetch (no throw on failure).
 * - Reuses the existing queryClient pattern for tasks + model (separate queries).
 * - Subscribes to `sdk.realtime.viaSse()` for SSE state tracking.
 */
export function useDaemonHealth(): DaemonHealth {
  // -- Route state ------------------------------------------------------------
  // Reactive view of the module-level active-route store (lib/relay-connection.ts),
  // the SAME store routedFetch reads for every actual request, so this never drifts
  // from what the SDK client is genuinely dispatching over. The store only ever holds
  // 'direct' or 'relay' (never a 'down'/null verdict); the connection probe below is
  // what flips it, and the health.route field returned at the bottom maps it to null
  // whenever the daemon is unreachable by either path.
  const storeRoute = useSyncExternalStore(subscribeActiveRoute, getActiveRoute, getActiveRoute);

  // -- Client-build compatibility floor --------------------------------------
  // Reactive view of the module-level observed-floor store (lib/client-compatibility.ts),
  // updated by every requestJson/requestStream response (goodvibes.ts), not a
  // dedicated probe of its own, since the floor rides on responses this hook (and the
  // rest of the app) is already making. Null until at least one response has been
  // observed at all.
  const observedFloor = useSyncExternalStore(
    subscribeObservedClientCompatibilityFloor,
    getObservedClientCompatibilityFloor,
    getObservedClientCompatibilityFloor,
  );
  const compatibility: ClientCompatibilityVerdict | null = observedFloor === undefined
    ? null
    : evaluateClientCompatibility({ clientVersion: WEBUI_VERSION, floor: observedFloor });

  // -- SSE state ------------------------------------------------------------
  // Stays 'connecting' until the first real envelope arrives, do NOT set
  // 'active' synchronously before any event, as that would show "Live" even
  // on a dead/stalled stream.
  const [sseState, setSseState] = useState<SseState>('connecting');

  useEffect(() => {
    // Event streams are not tunneled over the relay (see relay-connection.ts's header
    // comment), an honest, immediate verdict rather than attempting a subscription
    // that can only time out. Skip the attempt entirely while routed over relay.
    if (storeRoute === 'relay') {
      setSseState('relay-unsupported');
      return undefined;
    }

    setSseState('connecting');
    let mounted = true;
    const unsubs: (() => void)[] = [];

    try {
      const events = sdk.realtime.viaSse();

      // Subscribe to a lightweight domain to confirm the SSE pipe is alive.
      // The 'turn' domain fires on any agent turn event.
      const turnDomain = (events as Record<string, unknown>).turn as
        | { onEnvelope?: (name: string, cb: (e: unknown) => void) => () => void }
        | undefined;

      if (turnDomain?.onEnvelope) {
        // Only flip to 'active' when the first real envelope arrives from the
        // stream, proving the transport is genuinely delivering events.
        const unsubTurn = turnDomain.onEnvelope('TURN_STARTED', () => {
          if (mounted) setSseState('active');
        });
        const unsubTurnEnd = turnDomain.onEnvelope('TURN_COMPLETED', () => {
          if (mounted) setSseState('active');
        });
        unsubs.push(unsubTurn, unsubTurnEnd);
        // Intentionally NOT setting 'active' here, stay 'connecting' until
        // an envelope actually arrives.
      }
      // else: domain absent, remain 'connecting'; cannot confirm stream health.
    } catch {
      if (mounted) setSseState('error');
    }

    return () => {
      mounted = false;
      for (const fn of unsubs) fn();
      // Don't flip to error on unmount, component teardown, not a real failure
    };
  }, [storeRoute]);

  // -- Latency + connection probe -------------------------------------------
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('down');

  /**
   * Consecutive probe-failure counter (persists across refetch intervals).
   * 1st failure → 'reconnecting'; 2nd+ consecutive failure → 'down' (or a relay
   * fallback probe, if a relay pairing is stored, see the effect below).
   * Any direct success resets it to 0.
   */
  const failureCountRef = useRef<number>(0);

  /** Threshold of consecutive failures before declaring the daemon 'down'. */
  const FAILURE_THRESHOLD = 2;

  // Use TanStack Query so we get deduplication and window-focus coordination.
  // refetchIntervalInBackground: true, intentional trade-off: keeps the strip
  // accurate even when the tab is backgrounded (battery/network cost is low at
  // 15 s intervals; a stale connection indicator would be misleading to users
  // who return to the tab expecting current status).
  const healthQuery = useQuery({
    queryKey: ['daemon-health', 'probe'] as const,
    queryFn: probeLatency,
    refetchInterval: HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  // Derive connection + route state from the direct probe result, falling back to the
  // relay when direct is genuinely down (FAILURE_THRESHOLD+ consecutive misses) and a
  // relay pairing is stored (lib/relay-pairing.ts). Pure liveness: ok (status < 500) on
  // either path → connected. Neither path answering → down, route null.
  useEffect(() => {
    let cancelled = false;

    async function evaluate() {
      if (healthQuery.isSuccess) {
        const { latencyMs: probed, ok } = healthQuery.data;
        if (cancelled) return;
        setLatencyMs(probed);
        if (ok) {
          failureCountRef.current = 0;
          setConnectionState('connected');
          setActiveRoute('direct');
          return;
        }
      } else if (healthQuery.isError) {
        // Defensive guard: probeLatency never rethrows today, but this branch
        // ensures correct failure-threshold behaviour if a future refactor adds
        // a throwing code path to the probe.
        if (cancelled) return;
        setLatencyMs(null);
      } else {
        return; // still pending, nothing to evaluate yet
      }

      failureCountRef.current += 1;
      const directDown = failureCountRef.current >= FAILURE_THRESHOLD;
      if (!directDown) {
        if (!cancelled) setConnectionState('reconnecting');
        return;
      }

      // Direct is down. Try the relay ONLY if this device has a stored pairing,
      // with none, behavior is byte-identical to before this file existed.
      if (getStoredRelayPairing()) {
        const relayOk = await probeRelayReachability();
        if (cancelled) return;
        if (relayOk) {
          setConnectionState('connected');
          setActiveRoute('relay');
          return;
        }
      }

      if (!cancelled) setConnectionState('down');
    }

    void evaluate();
    return () => {
      cancelled = true;
    };
  }, [healthQuery.isSuccess, healthQuery.isError, healthQuery.data]);

  // -- Tasks ----------------------------------------------------------------
  const tasksQuery = useQuery({
    queryKey: ['tasks'] as const,
    queryFn: () => sdk.operator.tasks.list(),
    refetchInterval: HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  // -- Signed-in axis (auth.current: 200 vs 401) ----------------------------
  const authProbe = useQuery({
    queryKey: ['daemon-health', 'auth'] as const,
    queryFn: () => probeCall(getCurrentAuth),
    refetchInterval: HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  // -- Working axis (an authed read that surfaces the read:sessions scope gap) --
  // A token that is signed-in but lacks read:sessions will 401 here → 'blocked',
  // so the strip shows reachable+signed-in but NOT working rather than a false "live".
  const workingProbe = useQuery({
    queryKey: ['daemon-health', 'working'] as const,
    queryFn: () => probeCall(() => sdk.operator.sessions.list()),
    refetchInterval: HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  const signedIn: AuthState = authProbe.isSuccess ? deriveAuthState(authProbe.data) : 'unknown';
  const working: WorkingState = workingProbe.isSuccess ? deriveWorkingState(workingProbe.data) : 'unknown';

  // -- Current model --------------------------------------------------------
  const modelQuery = useQuery({
    queryKey: ['daemon-health', 'model'] as const,
    queryFn: () => sdk.operator.models.current.get(),
    // Models change rarely, refresh every 60 s
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 0,
    staleTime: 30_000,
  });

  // -- Derive counts --------------------------------------------------------
  const { activeTurns, queuedTasks } = tasksQuery.isSuccess
    ? taskCountsFromList(tasksQuery.data)
    : { activeTurns: DAEMON_HEALTH_DEFAULTS.activeTurns, queuedTasks: DAEMON_HEALTH_DEFAULTS.queuedTasks };

  const modelName = modelQuery.isSuccess ? modelNameFromCurrent(modelQuery.data) : null;

  return {
    connection: connectionState,
    // Down means neither path answered, a stale 'relay' from a prior success has no
    // meaning once nothing is reachable, so this reports null rather than a route that
    // is not actually carrying anything right now.
    route: connectionState === 'down' ? null : storeRoute,
    signedIn,
    working,
    latencyMs,
    sse: sseState,
    activeTurns,
    queuedTasks,
    modelName,
    compatibility,
  };
}
