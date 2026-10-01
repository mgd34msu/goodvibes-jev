/**
 * fleet-focus-link.ts, the app side of a push "needs-input" tap.
 *
 * When a fleet node becomes blocked waiting on the operator, the daemon fans out
 * a PushMessage whose `data` is `{ kind: 'needs-input', sessionId?, nodeId? }`
 * (SDK push/types.ts PushNotificationData). The service worker opens the app at
 * `/?view=fleet#fleet-node=<nodeId>&fleet-session=<sessionId>` (see
 * notification-link.ts). This module reads that fragment and scrubs it, so
 * FleetView can focus the node the operator was summoned to, mirroring the
 * approval action hand-off's fragment discipline (approval-action-link.ts).
 *
 * Pure over `window.location`, unit-testable, and consistent with the pairing
 * and approval hand-offs.
 */

export interface FleetFocusIntent {
  /** The node to focus in the fleet tree. Always present when an intent parses. */
  nodeId: string;
  /** The session the node belongs to, when the push carried one. */
  sessionId?: string;
}

const NODE_KEY = 'fleet-node';
const SESSION_KEY = 'fleet-session';

/**
 * Read a fleet-focus intent out of a URL hash, or null when none is present.
 * `nodeId` is required, a focus with no node to focus is not an intent. The
 * session id is optional (the push may not know it) and only carried through.
 */
export function parseFleetFocusFromHash(hash: string): FleetFocusIntent | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const nodeId = params.get(NODE_KEY)?.trim() ?? '';
  if (nodeId.length === 0) return null;
  const sessionId = params.get(SESSION_KEY)?.trim() ?? '';
  return sessionId.length > 0 ? { nodeId, sessionId } : { nodeId };
}

/**
 * Remove the fleet-focus keys from the current URL's fragment via
 * history.replaceState, preserving path, query, and any other fragment keys.
 */
export function stripFleetFocusFragment(): void {
  if (typeof window === 'undefined') return;
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(rawHash);
  if (!params.has(NODE_KEY) && !params.has(SESSION_KEY)) return;
  params.delete(NODE_KEY);
  params.delete(SESSION_KEY);
  const remaining = params.toString();
  const url = `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}
