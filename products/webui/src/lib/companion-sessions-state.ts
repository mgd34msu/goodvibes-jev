/**
 * companion-sessions-state.ts, the one client-side record of the companion chat
 * sessions this browser knows about.
 *
 * App.tsx used to keep three parallel collections for this: an array of local
 * session objects, a set of ids created in this tab and not yet confirmed by a
 * daemon list, and a set of ids hidden after a delete. Every handler that touched
 * sessions had to update all three in step, and any handler that missed one left
 * the sidebar showing a session the other collections had already dropped (or
 * hiding one they still held).
 *
 * Here there is ONE ordered list of entries keyed by session id, and the entry
 * union makes that disagreement unrepresentable: a `removed` entry carries no
 * session object at all, so a hidden session cannot leak a copy into the rendered
 * list, and an entry that carries a session object always carries the id the list
 * renders it under.
 *
 * Pure: no React, no network, no storage. Whatever the daemon knows arrives as a
 * selector argument (`serverSessions`), because the daemon's list stays the source
 * of truth for everything except this browser's own not-yet-confirmed edits.
 */
import { companionSessionFromDetail, mergeCompanionSessions } from './companion-chat';
import { bestId, bestTitle } from './object';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * One session this browser has an opinion about.
 *
 * - `created-here`: started in this tab, no daemon list has returned it yet, so the
 *   local copy is the only way to render it.
 * - `cached`: a local copy of a session the daemon already knows about (restored
 *   from storage, or a `created-here` session a later list confirmed). Kept so a
 *   reload paints the sidebar before the first list request answers.
 * - `removed`: hidden pending the outcome of a delete, or reported gone by the
 *   daemon. Holds no session object by construction.
 */
export type CompanionSessionEntry =
  | { readonly id: string; readonly status: 'created-here'; readonly session: unknown }
  | { readonly id: string; readonly status: 'cached'; readonly session: unknown }
  | { readonly id: string; readonly status: 'removed' };

/** Entries carrying a local session object, newest local write first. */
export type CompanionSessionCopy = Exclude<CompanionSessionEntry, { status: 'removed' }>;

export interface CompanionSessionsState {
  /**
   * Ordered newest-local-write-first. Order is load-bearing: the merge sorts by
   * updatedAt and ties keep insertion order, so two sessions with the same (or no)
   * timestamp render in the order this browser learned about them.
   */
  readonly entries: readonly CompanionSessionEntry[];
}

export type CompanionSessionsAction =
  /** A session was created in this tab (the composer sent its first message). */
  | { readonly type: 'local-session-created'; readonly session: unknown }
  /** A session the operator renamed, or whose detail this tab just re-read. */
  | { readonly type: 'local-session-updated'; readonly sessionId: string; readonly session: unknown }
  /** The operator confirmed a delete; hide the row while the call is in flight. */
  | { readonly type: 'session-delete-requested'; readonly sessionId: string }
  /** The delete did not complete; the row must come back rather than stay falsely hidden. */
  | { readonly type: 'session-delete-failed'; readonly sessionId: string }
  /** The daemon answered "no such session" for a session this tab was showing. */
  | { readonly type: 'session-reported-missing'; readonly sessionId: string }
  /** A daemon session list came back; these ids are no longer this tab's secret. */
  | { readonly type: 'server-sessions-synced'; readonly sessionIds: readonly string[] };

function hasLocalCopy(entry: CompanionSessionEntry): entry is CompanionSessionCopy {
  return entry.status !== 'removed';
}

function findEntry(state: CompanionSessionsState, sessionId: string): CompanionSessionEntry | undefined {
  return state.entries.find((entry) => entry.id === sessionId);
}

/** Upsert at the front: the newest local write leads the list, one entry per id. */
function withEntryFirst(state: CompanionSessionsState, entry: CompanionSessionCopy, alsoDropId: string): CompanionSessionsState {
  const remaining = state.entries.filter((current) => {
    // A tombstone is this state's entire record of a pending/confirmed delete, so a
    // local write never clears one; only the delete flow itself does. The write is
    // dropped outright: if the delete then fails, the row comes back from the next
    // successful daemon list, not from local state. Until a list has succeeded, a
    // write interleaved with a failed delete stays gone; that is the accepted cost
    // of the removed entry carrying no session copy at all.
    if (current.status === 'removed') return true;
    return current.id !== entry.id && current.id !== alsoDropId;
  });
  return { entries: [entry, ...remaining] };
}

function withTombstone(state: CompanionSessionsState, sessionId: string): CompanionSessionsState {
  if (!sessionId) return state;
  const existing = findEntry(state, sessionId);
  if (existing?.status === 'removed') return state;
  const tombstone: CompanionSessionEntry = { id: sessionId, status: 'removed' };
  if (!existing) return { entries: [...state.entries, tombstone] };
  return { entries: state.entries.map((entry) => (entry.id === sessionId ? tombstone : entry)) };
}

/** Seed from the sessions cached in browser storage; ids are required, blanks dropped. */
export function companionSessionsStateFromStored(stored: readonly unknown[]): CompanionSessionsState {
  const entries: CompanionSessionCopy[] = [];
  for (const session of stored) {
    const id = bestId(session);
    if (!id) continue;
    const entry: CompanionSessionCopy = { id, status: 'cached', session };
    const existing = entries.findIndex((current) => current.id === id);
    // Last copy wins, first position kept, the same rule mergeCompanionSessions uses.
    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function companionSessionsReducer(
  state: CompanionSessionsState,
  action: CompanionSessionsAction,
): CompanionSessionsState {
  switch (action.type) {
    case 'local-session-created': {
      const session = companionSessionFromDetail(action.session);
      const id = bestId(session);
      // A session object with no id can never be rendered or matched, so it is not
      // worth a slot; the old local array held such objects and never showed them.
      if (!id) return state;
      if (findEntry(state, id)?.status === 'removed') return state;
      return withEntryFirst(state, { id, status: 'created-here', session }, id);
    }

    case 'local-session-updated': {
      const session = companionSessionFromDetail(action.session);
      const updatedId = bestId(session);
      const id = updatedId || action.sessionId;
      if (!id) return state;
      const previous = findEntry(state, id);
      if (previous?.status === 'removed') return state;
      // A payload with no usable id still names a session: keep the row alive under
      // the id the caller asked to update, with whatever title the payload carried.
      const nextSession: unknown = updatedId
        ? session
        : { id: action.sessionId, sessionId: action.sessionId, title: bestTitle(action.session, action.sessionId) };
      const status = previous?.status === 'created-here' ? 'created-here' : 'cached';
      return withEntryFirst(state, { id, status, session: nextSession }, action.sessionId);
    }

    case 'session-delete-requested':
    case 'session-reported-missing':
      return withTombstone(state, action.sessionId);

    case 'session-delete-failed': {
      const entries = state.entries.filter(
        (entry) => !(entry.id === action.sessionId && entry.status === 'removed'),
      );
      return entries.length === state.entries.length ? state : { entries };
    }

    case 'server-sessions-synced': {
      const known = new Set(action.sessionIds.filter(Boolean));
      const confirmed = (entry: CompanionSessionEntry): entry is CompanionSessionCopy =>
        entry.status === 'created-here' && known.has(entry.id);
      // Returning the SAME state object when a list confirms nothing new lets React
      // bail out of the re-render this dispatch would otherwise cause on every fetch.
      if (!state.entries.some(confirmed)) return state;
      return {
        entries: state.entries.map((entry): CompanionSessionEntry => (
          confirmed(entry) ? { id: entry.id, status: 'cached', session: entry.session } : entry
        )),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Every local session object this browser holds, newest local write first. */
export function selectLocalSessions(state: CompanionSessionsState): unknown[] {
  return state.entries.filter(hasLocalCopy).map((entry) => entry.session);
}

/** Ids started in this tab that no daemon list has returned yet. */
export function selectLocallyCreatedSessionIds(state: CompanionSessionsState): Set<string> {
  return new Set(state.entries.filter((entry) => entry.status === 'created-here').map((entry) => entry.id));
}

/** Ids hidden pending a delete outcome, or reported gone by the daemon. */
export function selectRemovedSessionIds(state: CompanionSessionsState): Set<string> {
  return new Set(state.entries.filter((entry) => entry.status === 'removed').map((entry) => entry.id));
}

export interface VisibleSessionsInput {
  /** The daemon's own session list, already unwrapped to session records. */
  readonly serverSessions: readonly unknown[];
  /** True once a daemon list request has succeeded at least once this mount. */
  readonly serverListLoaded: boolean;
}

/**
 * The session list the sidebar and chat view render.
 *
 * Until a daemon list has answered, every local copy is shown (that is all this
 * browser has). Once one has, the daemon's records win outright and the only local
 * copies still contributed are `created-here` sessions the daemon has not returned
 * yet, so a stale cached copy can never resurrect a session the daemon dropped.
 * Removed ids are filtered out last, so a tombstone hides a daemon record too.
 */
export function selectVisibleSessions(
  state: CompanionSessionsState,
  { serverSessions, serverListLoaded }: VisibleSessionsInput,
): unknown[] {
  const copies = state.entries.filter(hasLocalCopy);
  const local = serverListLoaded ? copies.filter((entry) => entry.status === 'created-here') : copies;
  const removed = selectRemovedSessionIds(state);
  return mergeCompanionSessions(
    local.map((entry) => entry.session),
    [...serverSessions],
  ).filter((session) => !removed.has(bestId(session)));
}

/** The session to select once `excludedSessionId` goes away, or '' if none is left. */
export function selectNextSessionId(sessions: readonly unknown[], excludedSessionId: string): string {
  return sessions.map(bestId).find((id) => id && id !== excludedSessionId) ?? '';
}
