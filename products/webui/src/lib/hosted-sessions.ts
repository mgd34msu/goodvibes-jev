/**
 * hosted-sessions.ts, display helpers + honesty-bar tolerant readers for
 * sessions.hosted.* (daemon-hosted sessions, already shipped in the SDK): a
 * conversation whose loop runs INSIDE the daemon rather than inside this
 * browser tab, so it does not end when the tab that started it goes away.
 *
 * HONESTY BAR: sessions.hosted.* is real, generated OperatorMethodOutputMap-typed
 * data (contract-bridge-types.ts), but the hermetic e2e mock daemon answers an
 * unmodeled/unknown invoke id with `{}` (mock-daemon.ts's documented fallback),
 * and a real daemon predating this feature would 404 rather than shape-match.
 * Every read here optional-chains so a `{}` response degrades to a STATED empty
 * view, never a crash and never a silently-rendered empty list that looks
 * identical to "no hosted sessions exist".
 */
import { asRecord } from './object';
import { randomUuid } from './uuid';
import type {
  HostedSessionRecord,
  HostedSessionHistoryMessage,
  SessionsHostedListResult,
  SessionsHostedAttachResult,
} from './goodvibes';

const CLIENT_ID_STORAGE_KEY = 'goodvibes.webui.hosted.clientId';

/**
 * A stable per-browser-profile client id for sessions.hosted.attach/detach,
 * minted once, persisted, and distinct from the push device id (push-client.ts):
 * this one names WHICH ATTACHED CLIENT a hosted session sees, not a push
 * subscription endpoint. Mirrors push-client.ts's ensureDeviceId exactly.
 */
export function ensureHostedClientId(): string {
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing) return existing;
    const minted = randomUuid();
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, minted);
    return minted;
  } catch {
    // Storage unavailable (private mode): a per-call id still lets attach/detach
    // work this session; it just cannot recognize itself across a reload.
    return randomUuid();
  }
}

/**
 * Tolerant read of sessions.hosted.list's output, `[]` (never a crash, never
 * indistinguishable from a genuine "none exist") when the daemon answered an
 * unmodeled/unknown shape.
 */
export function hostedSessionsFromListResult(value: unknown): HostedSessionRecord[] {
  const sessions = (value as Partial<SessionsHostedListResult> | undefined)?.sessions;
  return Array.isArray(sessions) ? (sessions as HostedSessionRecord[]) : [];
}

/**
 * Tolerant read of sessions.hosted.attach's output. A null `session` means the
 * response did not carry the shape this client expects, the caller must render
 * an honest "could not attach" rather than a fabricated session.
 */
export function hostedAttachResultFrom(value: unknown): {
  session: HostedSessionRecord | null;
  history: HostedSessionHistoryMessage[];
} {
  const record = value as Partial<SessionsHostedAttachResult> | undefined;
  const session = record?.session && typeof record.session === 'object' ? record.session as HostedSessionRecord : null;
  const history = Array.isArray(record?.history) ? record.history as HostedSessionHistoryMessage[] : [];
  return { session, history };
}

/** Tolerant read of sessions.hosted.create/detach/kill's `{ session }` output. */
export function hostedSessionFromResult(value: unknown): HostedSessionRecord | null {
  const session = asRecord(value).session;
  return session && typeof session === 'object' ? (session as HostedSessionRecord) : null;
}

export function sortHostedSessionsNewestFirst(sessions: readonly HostedSessionRecord[]): HostedSessionRecord[] {
  return [...sessions].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

export function hostedStatusTone(status: string): string {
  switch (status) {
    case 'running': return 'ok';
    case 'idle': return 'neutral';
    case 'terminated': return 'bad';
    default: return 'neutral';
  }
}

export function hostedStatusLabel(status: string): string {
  return status.trim() || 'unknown';
}

/**
 * The policy line rendered BEFORE a detach happens, never a guess: reads the
 * record's own `effectiveDetachPolicy`, the field the daemon computes from the
 * session's own override (if any) and the `hostedSessions.detachPolicy` setting
 * otherwise (HostedSessionRecord's own doc comment, types.ts).
 */
export function effectiveDetachPolicyLabel(policy: string): string {
  switch (policy) {
    case 'kill':
      return 'Leaving will end this session (detach policy: kill).';
    case 'survive':
      return 'Leaving keeps this session running, idle and reattachable (detach policy: survive).';
    default:
      return `Leaving applies the "${policy || 'unknown'}" detach policy.`;
  }
}

/**
 * Human line for a terminated hosted session's reason, verbatim mapping of
 * HostedSessionTerminationReason (types.ts), never a guess for a reason this
 * client has never seen (falls through to the raw string).
 */
export function hostedTerminationLabel(record: Pick<HostedSessionRecord, 'status' | 'terminatedReason'>): string | null {
  if (record.status !== 'terminated') return null;
  const reason = record.terminatedReason;
  if (!reason) return 'terminated (no reason recorded)';
  switch (reason) {
    case 'detached': return 'terminated: the last client detached (detach policy: kill)';
    case 'killed': return 'terminated: ended with sessions.hosted.kill';
    case 'daemon-shutdown': return 'terminated: the daemon shut down while hosting it';
    case 'restart-unresumable': return 'terminated: restored from disk but its composition could not be rebuilt';
    case 'retired': return 'terminated: retired after the retention window';
    case 'evicted': return 'terminated: the engine could not keep it (a bound was exceeded, or its workspace went away)';
    default: return `terminated: ${reason}`;
  }
}

export function hostedAttachedClientCount(record: Pick<HostedSessionRecord, 'attachedClients'>): number {
  return Array.isArray(record.attachedClients) ? record.attachedClients.length : 0;
}

/** Whether this browser (by its own persisted client id) is currently attached. */
export function isThisClientAttached(record: Pick<HostedSessionRecord, 'attachedClients'>, clientId: string): boolean {
  return Array.isArray(record.attachedClients) && record.attachedClients.includes(clientId);
}
