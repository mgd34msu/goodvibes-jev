/**
 * sessions-union.ts, pure, tolerant readers for the cross-surface session union.
 *
 * The union list is served by GET /api/sessions (sdk.operator.sessions.list) and
 * wrapped as `{ totals, sessions }` where each entry is a SharedSessionRecordResponse
 * (packages/daemon-sdk/src/runtime-session-routes.ts). This module reads that wire
 * shape defensively: `kind` / `status` / `project` are treated as OPEN STRINGS even
 * though the wire enum is a closed union, so a spine daemon newer than the pinned
 * 0.38 client can return a kind we have never seen and we render it verbatim rather
 * than crash or drop it (no zod on this path, see src/lib/object.ts).
 */

import { asArray, firstString, readPath } from './object';
import { companionSessionsFromListResponse } from './companion-chat';

/** The six kinds the 0.38 wire enum declares (SHARED_SESSION_KINDS). */
export const KNOWN_SESSION_KINDS = [
  'tui',
  'agent',
  'webui',
  'companion-task',
  'companion-chat',
  'automation',
] as const;
export type KnownSessionKind = (typeof KNOWN_SESSION_KINDS)[number];

/**
 * The single un-domained wire event that carries every session lifecycle change.
 * The specific transition is the inner `payload.event` discriminant.
 * (control.session_update descriptor, method-catalog-events.ts.)
 */
export const SESSION_UPDATE_WIRE_EVENT = 'session-update';

/**
 * Local mirror of the SDK's SESSION_UPDATE_INTENT_MAP. Kept here (not imported)
 * because the SDK does not re-export it to the browser bundle; verified against
 * packages/sdk/src/platform/control-plane/method-catalog-events.ts. If the daemon
 * adds a new wire event we do not know, sessionUpdateIntent() returns null and the
 * caller invalidates the whole list defensively rather than guessing an intent.
 */
export const SESSION_UPDATE_INTENT_MAP = {
  created: ['session-created'],
  updated: [
    'session-message-appended',
    'session-agent-completed',
    'session-route-attached',
    'session-reopened',
  ],
  steered: ['session-input-delivered', 'session-message-forwarded'],
  closed: ['session-closed'],
} as const;

export type SessionUpdateIntent = keyof typeof SESSION_UPDATE_INTENT_MAP;

/** Map a raw `payload.event` wire value to a coarse invalidation intent, or null. */
export function sessionUpdateIntent(wireEvent: string): SessionUpdateIntent | null {
  for (const [intent, events] of Object.entries(SESSION_UPDATE_INTENT_MAP)) {
    if ((events as readonly string[]).includes(wireEvent)) return intent as SessionUpdateIntent;
  }
  return null;
}

/**
 * A widened union record. Unlike LocalCompanionSession (companion-chat.ts), which
 * hardcodes `kind: 'companion-chat'` and `status: 'active'` literal types, this reads
 * kind/status/project as plain strings so tui/agent/automation/unknown kinds are
 * represented honestly.
 */
export interface UnionSessionRecord {
  id: string;
  kind: string;
  project: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** null when the wire omitted it, absence means FULLY RETAINED, never inferred loss. */
  retainedMessageCount: number | null;
  pendingInputCount: number;
  surfaceKinds: string[];
  activeAgentId: string;
  lastError: string;
  /**
   * Why a closed session closed, when the daemon reported one, the SDK's
   * SharedSessionCloseReason ('idle-reaped' | 'user' | 'surface'), carried on
   * the wire under `metadata.closeReason` (see the SDK's
   * platform/control-plane/session-broker-sessions.ts, SESSION_CLOSE_REASON_METADATA_KEY).
   * Empty string when absent, a build that predates this field, or a session
   * that was never closed. Read tolerantly (not validated against the known
   * enum) so an unrecognized value is still preserved rather than dropped.
   */
  closeReason: string;
  /**
   * Channel-origin attribution (principals.*, SDK 1.6.1's initiative family):
   * bridge-channel intake stamps `metadata.attributedPrincipalId/Name/Known` on a
   * session it originates (channel-profiles/intake.ts, ATTRIBUTED_PRINCIPAL_*_KEY).
   * `attributedPrincipalKnown` is null when the wire never stamped this session at
   * all (most sessions, non-channel-originated, or a pre-feature daemon build),
   * distinct from `false`, which means the sender identity resolved to the honest
   * unknown principal (unmapped, never a guess). Only render an attribution line
   * when `attributedPrincipalKnown !== null`, see SessionsView's SessionDetail.
   */
  attributedPrincipalName: string;
  attributedPrincipalKnown: boolean | null;
  raw: unknown;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return asArray(record[key]).filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function stringAtPath(record: Record<string, unknown>, path: string[]): string {
  const value = readPath(record, path);
  return typeof value === 'string' ? value : '';
}

/** null when absent (or not a boolean), never inferred from absence, matching
 * retentionLabel's "absence means no marker, not a false" stance elsewhere in this file. */
function booleanAtPathOrNull(record: Record<string, unknown>, path: string[]): boolean | null {
  const value = readPath(record, path);
  return typeof value === 'boolean' ? value : null;
}

/** Normalize one raw record (already unwrapped from any envelope) into a UnionSessionRecord. */
export function unionSessionFromRecord(value: unknown): UnionSessionRecord {
  const record = (value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {});
  const id = firstString(record, ['id', 'sessionId']);
  return {
    id,
    kind: firstString(record, ['kind']),
    project: firstString(record, ['project']),
    title: firstString(record, ['title', 'name', 'label']) || id || 'Untitled session',
    status: firstString(record, ['status', 'state']),
    createdAt: numberField(record, 'createdAt'),
    updatedAt: numberField(record, 'updatedAt') || numberField(record, 'lastActivityAt') || numberField(record, 'createdAt'),
    messageCount: numberField(record, 'messageCount'),
    retainedMessageCount: optionalNumberField(record, 'retainedMessageCount'),
    pendingInputCount: numberField(record, 'pendingInputCount'),
    surfaceKinds: stringArrayField(record, 'surfaceKinds'),
    activeAgentId: firstString(record, ['activeAgentId']),
    lastError: firstString(record, ['lastError']),
    closeReason: stringAtPath(record, ['metadata', 'closeReason']),
    attributedPrincipalName: stringAtPath(record, ['metadata', 'attributedPrincipalName']),
    attributedPrincipalKnown: booleanAtPathOrNull(record, ['metadata', 'attributedPrincipalKnown']),
    raw: value,
  };
}

/** Unwrap the {totals, sessions} envelope and normalize every entry. Reuses the
 * existing tolerant extractor rather than hand-rolling a second reader. */
export function unionSessionsFromListResponse(value: unknown): UnionSessionRecord[] {
  return companionSessionsFromListResponse(value).map(unionSessionFromRecord);
}

/** Total count reported by the snapshot envelope, if present (for the capped-50 honesty note). */
export function unionSessionsTotal(value: unknown): number | null {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const totals = record.totals;
  if (totals && typeof totals === 'object') {
    const t = totals as Record<string, unknown>;
    for (const key of ['sessions', 'total', 'all', 'count']) {
      if (typeof t[key] === 'number' && Number.isFinite(t[key] as number)) return t[key] as number;
    }
  }
  const flat = record.total;
  return typeof flat === 'number' && Number.isFinite(flat) ? flat : null;
}

export function isKnownKind(kind: string): boolean {
  return (KNOWN_SESSION_KINDS as readonly string[]).includes(kind);
}

/** Display label for a kind badge, verbatim for unknown kinds, 'unknown' when absent. */
export function kindLabel(kind: string): string {
  return kind.trim() || 'unknown';
}

/** Display label for a project badge, 'unknown' for home-scoped / absent projects. */
export function projectLabel(project: string): string {
  return project.trim() || 'unknown';
}

export function isClosedStatus(status: string): boolean {
  return status.trim().toLowerCase() === 'closed';
}

/** Display label for a status badge. Empty status renders as 'active' (wire always sends one). */
export function statusLabel(status: string): string {
  return status.trim() || 'active';
}

/**
 * An idle-reaped closed session AUTO-REOPENS on the next heartbeat from any
 * participant, it is not the same event as a deliberate user/surface close,
 * so it must not render under the same "closed · history" badge. Tolerant of
 * records without `closeReason` (pre-feature builds, or a deliberate close).
 */
export function isReapedStatus(record: Pick<UnionSessionRecord, 'status' | 'closeReason'>): boolean {
  return isClosedStatus(record.status) && record.closeReason === 'idle-reaped';
}

/**
 * The retention honesty marker. Returns "N of M retained" ONLY when the wire reported
 * a retainedMessageCount strictly less than messageCount. Absent retainedMessageCount
 * (null) → no marker (fully retained). Never infers loss from absence.
 */
export function retentionLabel(record: UnionSessionRecord): string | null {
  const { messageCount, retainedMessageCount } = record;
  if (retainedMessageCount === null) return null;
  if (retainedMessageCount >= messageCount) return null;
  return `${retainedMessageCount} of ${messageCount} retained`;
}

/**
 * Attribution label (principals.*, SDK 1.6.1's initiative family). Returns null when
 * the wire never stamped this session with attribution at all (attributedPrincipalKnown
 * is null, most sessions), so a plain, unattributed session renders no line. Otherwise
 * "known:false" (unmapped sender identity) renders "unknown principal" PLAINLY, never
 * silently as the resolved name and never hidden.
 */
export function attributionLabel(record: Pick<UnionSessionRecord, 'attributedPrincipalName' | 'attributedPrincipalKnown'>): string | null {
  if (record.attributedPrincipalKnown === null) return null;
  if (!record.attributedPrincipalKnown) return 'unknown principal';
  return record.attributedPrincipalName || 'unknown principal';
}

/**
 * Steer only makes sense while an agent is bound and the session is open. Otherwise the
 * detail view offers follow-up (queue a turn) instead of mid-turn steer.
 */
export function canSteer(record: UnionSessionRecord): boolean {
  return !isClosedStatus(record.status) && record.activeAgentId.trim().length > 0;
}

/** Sort newest-first by updatedAt (falling back to createdAt), matching the companion list order. */
export function sortUnionSessions(records: UnionSessionRecord[]): UnionSessionRecord[] {
  return [...records].sort((left, right) => (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt));
}
