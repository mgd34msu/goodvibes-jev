/**
 * Daemon health types and pure helper functions.
 * Derives state from data already exposed by the SDK / queries.
 * No `any`. No side effects.
 */
import type { ClientCompatibilityVerdict } from './client-compatibility';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * REACHABLE axis. The daemon HTTP port answered (status < 500), this says nothing
 * about whether we are signed in or authorized. The literal 'connected' is retained
 * for CSS/dot compatibility, but its LABEL is "Reachable", never "Connected": a 401
 * still leaves the daemon reachable while everything else fails.
 */
export type ConnectionState = 'connected' | 'reconnecting' | 'down';

/** SIGNED-IN axis. auth.current returned 200 (signed-in) vs 401 (signed-out). */
export type AuthState = 'signed-in' | 'signed-out' | 'unknown';

/**
 * WORKING axis. An authed read (sessions.list) succeeded without 401. This is the axis
 * that catches a token minted WITHOUT the read:sessions scope: reachable + signed-in
 * but not working, so the strip never claims "live" when session data is silently 401ing.
 */
export type WorkingState = 'working' | 'blocked' | 'unknown';

/**
 * A stream/subscription cannot work over the relay at all (unary-only tunnel, see
 * lib/relay-connection.ts's header comment), distinct from 'error' (a stream that
 * SHOULD work but currently isn't) and from 'disabled' (never attempted, no verdict
 * either way). Consumers show a specific, honest "not available over relay" copy
 * rather than a generic reconnecting/error state.
 */
export type SseState = 'active' | 'connecting' | 'error' | 'disabled' | 'relay-unsupported';

/**
 * ROUTE axis, which transport is currently answering requests when the daemon is
 * reachable at all. 'direct' is an ordinary fetch against the daemon's own origin
 * (the LAN/co-located case, true before relay pairing existed). 'relay' means every
 * unary call is being tunneled end-to-end through a relay server because the direct
 * path is not reachable from this device. `null` when there is no verdict yet or the
 * daemon is not reachable by either path (connection === 'down').
 */
export type RouteState = 'direct' | 'relay' | null;

export interface DaemonHealth {
  /** REACHABLE axis, HTTP port answered (status < 500). NOT "everything is fine". */
  connection: ConnectionState;
  /** ROUTE axis, which transport answered: direct, relay, or none (see RouteState). */
  route: RouteState;
  /** SIGNED-IN axis, auth.current returned 200 vs 401. */
  signedIn: AuthState;
  /** WORKING axis, an authed read succeeded without 401. */
  working: WorkingState;
  /** Round-trip latency of the last health probe in ms, or null if never measured */
  latencyMs: number | null;
  /** SSE stream state */
  sse: SseState;
  /** Number of in-flight agent turns (active sessions being processed) */
  activeTurns: number;
  /** Number of queued / pending tasks not yet executing */
  queuedTasks: number;
  /** Currently-selected model display name, if resolvable */
  modelName: string | null;
  /**
   * This build vs. the daemon's most recently observed client-build floor
   * (X-Goodvibes-Client-Floor, see lib/client-compatibility.ts). Null until at least
   * one response has been observed; a daemon that never sends the header (every
   * currently-shipped one, at this SDK pin) leaves this null forever, which is honest,
   * there is nothing yet to report, not a clean bill of health.
   */
  compatibility: ClientCompatibilityVerdict | null;
}

export const DAEMON_HEALTH_DEFAULTS: DaemonHealth = {
  connection: 'down',
  route: null,
  signedIn: 'unknown',
  working: 'unknown',
  latencyMs: null,
  sse: 'disabled',
  activeTurns: 0,
  queuedTasks: 0,
  modelName: null,
  compatibility: null,
};

interface TaskItem {
  status?: string;
  state?: string;
  [key: string]: unknown;
}

interface TasksListResponse {
  tasks?: TaskItem[];
  items?: TaskItem[];
  data?: TaskItem[];
  [key: string]: unknown;
}

interface ModelCurrentResponse {
  name?: string;
  displayName?: string;
  registryKey?: string;
  id?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pure helpers, derive state from raw API responses
// ---------------------------------------------------------------------------

/** Extract task counts from a tasks.list response. */
export function taskCountsFromList(response: unknown): { activeTurns: number; queuedTasks: number } {
  if (!response || typeof response !== 'object') return { activeTurns: 0, queuedTasks: 0 };
  const r = response as TasksListResponse;
  const items: TaskItem[] = r.tasks ?? r.items ?? r.data ?? [];
  if (!Array.isArray(items)) return { activeTurns: 0, queuedTasks: 0 };

  let activeTurns = 0;
  let queuedTasks = 0;

  for (const item of items) {
    const s = (item.status ?? item.state ?? '').toLowerCase();
    if (s === 'running' || s === 'active' || s === 'in_progress') activeTurns++;
    else if (s === 'queued' || s === 'pending' || s === 'waiting') queuedTasks++;
  }

  return { activeTurns, queuedTasks };
}

/** Extract a human-readable model name from a models/current response. */
export function modelNameFromCurrent(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as ModelCurrentResponse;
  return r.displayName ?? r.name ?? r.registryKey ?? r.id ?? null;
}

/**
 * Clamp latency to a sane display range (0–9999 ms).
 * Negative values (clock skew) become null.
 */
export function clampLatency(ms: number): number | null {
  if (ms < 0) return null;
  return Math.min(ms, 9999);
}

/** Format latency for display: "<10ms", "42ms", "1.2s" */
export function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 10) return '<10ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Map the REACHABLE axis to a human-readable label. Deliberately NOT "Connected":
 * a reachable daemon that 401s everything is not "connected" in any useful sense.
 */
export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected': return 'Reachable';
    case 'reconnecting': return 'Reconnecting';
    case 'down': return 'Offline';
  }
}

/** Map the SIGNED-IN axis to a human-readable label. */
export function authLabel(state: AuthState): string {
  switch (state) {
    case 'signed-in': return 'Signed in';
    case 'signed-out': return 'Signed out';
    case 'unknown': return 'Auth ?';
  }
}

/** Map the WORKING axis to a human-readable label. */
export function workingLabel(state: WorkingState): string {
  switch (state) {
    case 'working': return 'Working';
    case 'blocked': return 'No access';
    case 'unknown': return 'Idle';
  }
}

/**
 * Derive the SIGNED-IN axis from an auth.current probe. A resolved call is signed-in;
 * a 401 is signed-out; any other failure (network/5xx) is unknown, not a false negative.
 */
export function deriveAuthState(input: { ok: boolean; status: number | null }): AuthState {
  if (input.ok) return 'signed-in';
  if (input.status === 401) return 'signed-out';
  return 'unknown';
}

/**
 * Derive the WORKING axis from an authed read (sessions.list). Success is working; a
 * 401 is blocked (signed-out OR a token missing the read:sessions scope, either way
 * session data cannot be read, so we must not claim "live"); other failures are unknown.
 */
export function deriveWorkingState(input: { ok: boolean; status: number | null }): WorkingState {
  if (input.ok) return 'working';
  if (input.status === 401) return 'blocked';
  return 'unknown';
}

/** Map SseState to a human-readable label */
export function sseLabel(state: SseState): string {
  switch (state) {
    case 'active': return 'Live';
    case 'connecting': return 'SSE…';
    case 'error': return 'SSE error';
    case 'disabled': return 'SSE off';
    case 'relay-unsupported': return 'Unavailable (relay)';
  }
}

/**
 * Map the ROUTE axis to a human-readable label. `null` reads as an em dash, matching
 * formatLatency's convention for "no verdict" rather than a scary/empty string.
 */
export function routeLabel(route: RouteState): string {
  switch (route) {
    case 'direct': return 'Direct';
    case 'relay': return 'Via relay';
    case null: return '—';
  }
}
