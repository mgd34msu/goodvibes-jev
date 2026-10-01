/**
 * companion-sessions-state, the single record of the companion chat sessions this
 * browser knows about.
 *
 * These tests exist because the state this module replaces was three parallel
 * collections in App.tsx (local session objects, ids created in this tab, ids hidden
 * after a delete) that every handler had to update in lockstep. The standing bug was
 * a handler touching two of the three and leaving a session visible in one view and
 * absent from another. So alongside the per-action tests there is an invariant sweep
 * that re-checks, after EVERY action, that the derived views cannot disagree.
 */

import { describe, expect, test } from 'bun:test';
import {
  companionSessionsReducer,
  companionSessionsStateFromStored,
  selectLocalSessions,
  selectLocallyCreatedSessionIds,
  selectNextSessionId,
  selectRemovedSessionIds,
  selectVisibleSessions,
  type CompanionSessionsAction,
  type CompanionSessionsState,
} from './companion-sessions-state';
import { bestId } from './object';

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, sessionId: id, title: `Session ${id}`, status: 'active', updatedAt: 0, ...extra };
}

function visibleIds(state: CompanionSessionsState, serverSessions: unknown[], serverListLoaded: boolean): string[] {
  return selectVisibleSessions(state, { serverSessions, serverListLoaded }).map(bestId);
}

function apply(state: CompanionSessionsState, ...actions: CompanionSessionsAction[]): CompanionSessionsState {
  return actions.reduce(companionSessionsReducer, state);
}

const EMPTY = companionSessionsStateFromStored([]);

// ---------------------------------------------------------------------------
// Seeding from stored sessions
// ---------------------------------------------------------------------------

describe('companionSessionsStateFromStored', () => {
  test('every stored session becomes a cached entry, in stored order', () => {
    const state = companionSessionsStateFromStored([session('a'), session('b')]);
    expect(state.entries.map((entry) => [entry.id, entry.status])).toEqual([
      ['a', 'cached'],
      ['b', 'cached'],
    ]);
    expect(selectLocallyCreatedSessionIds(state).size).toBe(0);
    expect(selectRemovedSessionIds(state).size).toBe(0);
  });

  test('a stored record with no id is dropped: it could never be rendered or matched', () => {
    const state = companionSessionsStateFromStored([{ title: 'nameless' }, session('a')]);
    expect(state.entries.map((entry) => entry.id)).toEqual(['a']);
  });

  test('a duplicated id keeps one entry: the last copy at the first position', () => {
    const state = companionSessionsStateFromStored([
      session('a', { title: 'first' }),
      session('b'),
      session('a', { title: 'second' }),
    ]);
    expect(state.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(selectLocalSessions(state)[0]).toMatchObject({ id: 'a', title: 'second' });
  });
});

// ---------------------------------------------------------------------------
// local-session-created
// ---------------------------------------------------------------------------

describe('local-session-created', () => {
  test('a session started in this tab is visible before any daemon list answers', () => {
    const state = apply(EMPTY, { type: 'local-session-created', session: session('new') });
    expect(selectLocallyCreatedSessionIds(state)).toEqual(new Set(['new']));
    expect(visibleIds(state, [], false)).toEqual(['new']);
  });

  test('a created session survives the first daemon list that does not carry it yet', () => {
    const state = apply(EMPTY, { type: 'local-session-created', session: session('new', { updatedAt: 5 }) });
    expect(visibleIds(state, [session('old', { updatedAt: 1 })], true)).toEqual(['new', 'old']);
  });

  test('a detail envelope is unwrapped to the session record it holds', () => {
    const state = apply(EMPTY, { type: 'local-session-created', session: { session: session('wrapped') } });
    expect(state.entries.map((entry) => entry.id)).toEqual(['wrapped']);
    expect(selectLocalSessions(state)[0]).toMatchObject({ id: 'wrapped' });
  });

  test('a payload with no usable id is ignored rather than stored unrenderable', () => {
    const state = apply(EMPTY, { type: 'local-session-created', session: { title: 'nameless' } });
    expect(state.entries).toEqual([]);
  });

  test('re-creating a known id replaces its copy and moves it to the front', () => {
    const state = apply(
      companionSessionsStateFromStored([session('a'), session('b')]),
      { type: 'local-session-created', session: session('b', { title: 'renewed' }) },
    );
    expect(state.entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(selectLocalSessions(state)[0]).toMatchObject({ title: 'renewed' });
  });

  test('a create cannot resurrect a session whose delete is still in flight', () => {
    const state = apply(
      EMPTY,
      { type: 'session-delete-requested', sessionId: 'a' },
      { type: 'local-session-created', session: session('a') },
    );
    expect(selectRemovedSessionIds(state)).toEqual(new Set(['a']));
    expect(visibleIds(state, [session('a')], true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// local-session-updated
// ---------------------------------------------------------------------------

describe('local-session-updated', () => {
  test('a rename replaces the local copy and leads the list', () => {
    const state = apply(
      companionSessionsStateFromStored([session('a'), session('b')]),
      { type: 'local-session-updated', sessionId: 'b', session: session('b', { title: 'Renamed' }) },
    );
    expect(state.entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(selectLocalSessions(state)[0]).toMatchObject({ id: 'b', title: 'Renamed' });
  });

  test('updating a session created in this tab keeps it created-here: the daemon still has not confirmed it', () => {
    const state = apply(
      EMPTY,
      { type: 'local-session-created', session: session('new') },
      { type: 'local-session-updated', sessionId: 'new', session: session('new', { title: 'Renamed' }) },
    );
    expect(selectLocallyCreatedSessionIds(state)).toEqual(new Set(['new']));
    expect(visibleIds(state, [], true)).toEqual(['new']);
  });

  test('an update whose payload carries no id still records the title under the named session', () => {
    const state = apply(EMPTY, {
      type: 'local-session-updated',
      sessionId: 'a',
      session: { title: 'Titled but idless' },
    });
    expect(state.entries.map((entry) => entry.id)).toEqual(['a']);
    expect(selectLocalSessions(state)[0]).toEqual({ id: 'a', sessionId: 'a', title: 'Titled but idless' });
  });

  test('an update with neither a payload id nor a session id changes nothing', () => {
    const before = companionSessionsStateFromStored([session('a')]);
    expect(companionSessionsReducer(before, { type: 'local-session-updated', sessionId: '', session: {} })).toBe(before);
  });

  test('an update cannot resurrect a removed session', () => {
    const state = apply(
      companionSessionsStateFromStored([session('a')]),
      { type: 'session-delete-requested', sessionId: 'a' },
      { type: 'local-session-updated', sessionId: 'a', session: session('a', { title: 'Renamed' }) },
    );
    expect(selectRemovedSessionIds(state)).toEqual(new Set(['a']));
    expect(visibleIds(state, [session('a')], true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Delete, delete failure, and the daemon reporting a session gone
// ---------------------------------------------------------------------------

describe('session-delete-requested', () => {
  test('the row disappears immediately even though the daemon list still returns it', () => {
    const state = apply(
      companionSessionsStateFromStored([session('a'), session('b')]),
      { type: 'session-delete-requested', sessionId: 'a' },
    );
    expect(visibleIds(state, [session('a'), session('b')], true)).toEqual(['b']);
  });

  test('deleting drops the local copy and the created-here claim in one step', () => {
    const state = apply(
      EMPTY,
      { type: 'local-session-created', session: session('new') },
      { type: 'session-delete-requested', sessionId: 'new' },
    );
    expect(selectLocalSessions(state)).toEqual([]);
    expect(selectLocallyCreatedSessionIds(state).size).toBe(0);
    expect(selectRemovedSessionIds(state)).toEqual(new Set(['new']));
  });

  test('a repeated delete of the same id is a no-op on the state object', () => {
    const state = apply(EMPTY, { type: 'session-delete-requested', sessionId: 'a' });
    expect(companionSessionsReducer(state, { type: 'session-delete-requested', sessionId: 'a' })).toBe(state);
  });

  test('an empty session id is ignored', () => {
    expect(companionSessionsReducer(EMPTY, { type: 'session-delete-requested', sessionId: '' })).toBe(EMPTY);
  });
});

describe('session-delete-failed', () => {
  test('a delete that did not complete brings the daemon-known row back', () => {
    const state = apply(
      companionSessionsStateFromStored([session('a')]),
      { type: 'session-delete-requested', sessionId: 'a' },
      { type: 'session-delete-failed', sessionId: 'a' },
    );
    expect(selectRemovedSessionIds(state).size).toBe(0);
    expect(visibleIds(state, [session('a')], true)).toEqual(['a']);
  });

  test('a failed delete leaves no orphan entry behind for a session nobody else knows', () => {
    const state = apply(
      EMPTY,
      { type: 'local-session-created', session: session('new') },
      { type: 'session-delete-requested', sessionId: 'new' },
      { type: 'session-delete-failed', sessionId: 'new' },
    );
    expect(state.entries).toEqual([]);
    expect(visibleIds(state, [], true)).toEqual([]);
  });

  test('a failure for an id that was never hidden changes nothing', () => {
    const before = companionSessionsStateFromStored([session('a')]);
    expect(companionSessionsReducer(before, { type: 'session-delete-failed', sessionId: 'a' })).toBe(before);
  });
});

describe('session-reported-missing', () => {
  test('a session the daemon says is gone is hidden and loses its local copy', () => {
    const state = apply(
      companionSessionsStateFromStored([session('a'), session('b')]),
      { type: 'session-reported-missing', sessionId: 'a' },
    );
    expect(selectLocalSessions(state).map(bestId)).toEqual(['b']);
    expect(visibleIds(state, [session('a'), session('b')], true)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// server-sessions-synced
// ---------------------------------------------------------------------------

describe('server-sessions-synced', () => {
  test('a created session the daemon now returns stops being contributed locally', () => {
    const created = apply(EMPTY, { type: 'local-session-created', session: session('new', { title: 'local title' }) });
    const synced = apply(created, { type: 'server-sessions-synced', sessionIds: ['new'] });
    expect(selectLocallyCreatedSessionIds(synced).size).toBe(0);
    // The daemon's record is what renders now; the cached local copy is only a
    // reload-time fallback, so the daemon's title wins.
    const rendered = selectVisibleSessions(synced, {
      serverSessions: [session('new', { title: 'daemon title' })],
      serverListLoaded: true,
    });
    expect(rendered).toEqual([session('new', { title: 'daemon title' })]);
  });

  test('a created session the list does not carry yet stays created-here', () => {
    const state = apply(
      EMPTY,
      { type: 'local-session-created', session: session('new') },
      { type: 'server-sessions-synced', sessionIds: ['other'] },
    );
    expect(selectLocallyCreatedSessionIds(state)).toEqual(new Set(['new']));
  });

  test('a sync that changes nothing returns the same state object, so React can bail out', () => {
    const state = companionSessionsStateFromStored([session('a')]);
    expect(companionSessionsReducer(state, { type: 'server-sessions-synced', sessionIds: ['a', ''] })).toBe(state);
    expect(companionSessionsReducer(state, { type: 'server-sessions-synced', sessionIds: [] })).toBe(state);
  });

  test('a sync never revives a removed id', () => {
    const state = apply(
      companionSessionsStateFromStored([session('a')]),
      { type: 'session-delete-requested', sessionId: 'a' },
      { type: 'server-sessions-synced', sessionIds: ['a'] },
    );
    expect(selectRemovedSessionIds(state)).toEqual(new Set(['a']));
    expect(visibleIds(state, [session('a')], true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

describe('selectVisibleSessions', () => {
  test('before the first daemon list, every local copy is shown: it is all this browser has', () => {
    const state = companionSessionsStateFromStored([session('a'), session('b')]);
    expect(visibleIds(state, [], false)).toEqual(['a', 'b']);
  });

  test('once a daemon list has answered, a stale cached copy cannot resurrect a dropped session', () => {
    const state = companionSessionsStateFromStored([session('gone'), session('kept')]);
    expect(visibleIds(state, [session('kept')], true)).toEqual(['kept']);
  });

  test('sessions sort newest-updated first, and equal timestamps keep local-write order', () => {
    const state = apply(
      EMPTY,
      { type: 'local-session-created', session: session('first') },
      { type: 'local-session-created', session: session('second') },
    );
    expect(visibleIds(state, [session('busy', { updatedAt: 99 })], false)).toEqual(['busy', 'second', 'first']);
  });

  test('the daemon record wins over a local copy of the same id', () => {
    const state = companionSessionsStateFromStored([session('a', { title: 'stale' })]);
    const rendered = selectVisibleSessions(state, {
      serverSessions: [session('a', { title: 'fresh' })],
      serverListLoaded: false,
    });
    expect(rendered).toEqual([session('a', { title: 'fresh' })]);
  });
});

describe('selectNextSessionId', () => {
  test('picks the first session that is not the one going away', () => {
    expect(selectNextSessionId([session('a'), session('b')], 'a')).toBe('b');
  });

  test('returns an empty id when nothing else is left, which is what asks for a draft', () => {
    expect(selectNextSessionId([session('a')], 'a')).toBe('');
    expect(selectNextSessionId([], 'a')).toBe('');
  });

  test('skips records with no id rather than selecting a blank one', () => {
    expect(selectNextSessionId([{ title: 'nameless' }, session('b')], 'a')).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Invariants the three-collection design could violate
// ---------------------------------------------------------------------------

describe('invariants across every action', () => {
  const serverSessions = [session('stored'), session('a'), session('b')];

  const script: CompanionSessionsAction[] = [
    { type: 'local-session-created', session: session('a') },
    { type: 'local-session-created', session: { session: session('b') } },
    { type: 'local-session-created', session: { title: 'nameless' } },
    { type: 'local-session-updated', sessionId: 'a', session: session('a', { title: 'Renamed' }) },
    { type: 'local-session-updated', sessionId: 'ghost', session: { title: 'idless' } },
    { type: 'server-sessions-synced', sessionIds: ['a'] },
    { type: 'session-delete-requested', sessionId: 'b' },
    { type: 'local-session-created', session: session('b') },
    { type: 'session-delete-failed', sessionId: 'b' },
    { type: 'session-reported-missing', sessionId: 'stored' },
    { type: 'session-delete-requested', sessionId: 'a' },
    { type: 'server-sessions-synced', sessionIds: ['a', 'b', 'stored'] },
    { type: 'local-session-updated', sessionId: 'a', session: session('a') },
  ];

  function checkInvariants(state: CompanionSessionsState, step: string) {
    const ids = state.entries.map((entry) => entry.id);
    // One entry per id: two entries for one session are exactly how the old
    // collections drifted apart.
    expect(new Set(ids).size, `${step}: duplicate entry id`).toBe(ids.length);
    // No blank id: a blank id matches every id-less record in the merge.
    expect(ids.every(Boolean), `${step}: blank entry id`).toBe(true);

    const localIds = selectLocalSessions(state).map(bestId);
    const created = selectLocallyCreatedSessionIds(state);
    const removed = selectRemovedSessionIds(state);

    // A hidden session carries no local copy that could leak back into a view.
    for (const id of removed) {
      expect(localIds, `${step}: ${id} is removed but still has a local copy`).not.toContain(id);
      expect([...created], `${step}: ${id} is removed but still claims created-here`).not.toContain(id);
    }
    // A session claimed as created-here always has the copy that renders it.
    for (const id of created) {
      expect(localIds, `${step}: ${id} claims created-here with no local copy`).toContain(id);
    }
    // Every local copy is renderable under the id its entry is keyed by.
    expect(localIds.every(Boolean), `${step}: a local copy has no id`).toBe(true);

    for (const serverListLoaded of [false, true]) {
      const rendered = visibleIds(state, serverSessions, serverListLoaded);
      expect(new Set(rendered).size, `${step}: a session rendered twice`).toBe(rendered.length);
      for (const id of rendered) {
        expect(removed.has(id), `${step}: ${id} is removed but still rendered`).toBe(false);
        // Nothing is invented: a rendered session came from a local copy or the daemon.
        expect(
          localIds.includes(id) || serverSessions.map(bestId).includes(id),
          `${step}: ${id} rendered from nowhere`,
        ).toBe(true);
      }
      // Anything claimed as created-here is actually reachable in the rendered list.
      for (const id of created) {
        expect(rendered, `${step}: created-here ${id} is not rendered`).toContain(id);
      }
    }
  }

  test('the derived views stay consistent after every action in a full session lifecycle', () => {
    let state = companionSessionsStateFromStored([session('stored')]);
    checkInvariants(state, 'seed');
    script.forEach((action, index) => {
      state = companionSessionsReducer(state, action);
      checkInvariants(state, `${index + 1}: ${action.type}`);
    });
  });

  test('a removed entry has no session field at all, so there is nothing to leak', () => {
    const state = apply(
      companionSessionsStateFromStored([session('a')]),
      { type: 'session-delete-requested', sessionId: 'a' },
    );
    const entry = state.entries.find((current) => current.id === 'a');
    expect(entry).toEqual({ id: 'a', status: 'removed' });
    expect(Object.hasOwn(entry ?? {}, 'session')).toBe(false);
  });
});
