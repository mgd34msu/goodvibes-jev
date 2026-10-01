/**
 * Tests for useChatSearch hook.
 *
 * Covers the message-content stage (unchanged from before session search):
 *   - debounce timing (300 ms)
 *   - abort on rapid retype (no stale results)
 *   - cache hit, second query with same sessions does NOT re-fetch
 *   - cache invalidation when sessions identity changes
 *   - recency ranking (most recent createdAt first)
 *
 * And the session-search stage (sessions.search):
 *   - includeClosed defaults to false on every fresh query (the documented
 *     divergence from sessions.list's own default)
 *   - toggling includeClosed re-queries with includeClosed:true and renders a
 *     closed session honestly (status never relabeled as active)
 *   - a NOT_INVOKABLE rejection surfaces as sessionSearchState 'unavailable',
 *     never a silently-empty result indistinguishable from a real zero-match
 *   - pagination: hasMore/nextCursor drive loadMoreSessions, which appends
 *     rather than replaces, and is a no-op with no cursor/while not hasMore
 *   - the kind filter scopes to 'companion-chat' (this hook's domain)
 *
 * Uses real timers via bun:test. DOM render via createRoot + flushSync
 * (happy-dom is installed by bunfig.toml preload).
 *
 * Module mocks must be declared before any dynamic import of the module
 * under test, because bun:test module mocking is synchronous and import-
 * scoped. All SDK interactions are stubbed via mock.module.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

/**
 * Fake session objects used across tests. Each has `id` and `sessionId` so
 * extractSessionId() (which reads those fields) returns a stable value.
 */
interface FakeSession { id: string; sessionId: string; title: string }

/** Control surface for the SDK list stub. */
interface ListStub {
  /** Messages returned per sessionId, keyed by id. */
  responses: Map<string, Record<string, unknown>[]>;
  /** Number of times list() was called, keyed by sessionId. */
  callCounts: Map<string, number>;
  /** Set to true to make all calls reject. */
  shouldFail: boolean;
}

const stub: ListStub = {
  responses: new Map(),
  callCounts: new Map(),
  shouldFail: false,
};

/** A single recorded sessions.search call's input. */
interface SessionSearchCall {
  query?: string;
  kind?: string;
  includeClosed?: boolean;
  limit?: number;
  cursor?: string;
}

/** Control surface for the sessions.search stub. */
interface SessionSearchStub {
  calls: SessionSearchCall[];
  /** Response returned on the NEXT call (or every call, if `sticky`). */
  response: { sessions: Record<string, unknown>[]; nextCursor?: string; hasMore: boolean };
  /** 'none' | 'not-invokable' | 'generic' */
  failMode: 'none' | 'not-invokable' | 'generic';
  /** Delay (ms) applied ONLY to load-more calls (those carrying a cursor), lets a test
   *  hold a load-more in flight while a fresh search completes and supersedes it. */
  loadMoreDelayMs: number;
}

const sessionSearchStub: SessionSearchStub = {
  calls: [],
  response: { sessions: [], nextCursor: undefined, hasMore: false },
  failMode: 'none',
  loadMoreDelayMs: 0,
};

// Mock the SDK before any import of useChatSearch.
mock.module('../../lib/goodvibes', () => ({
  sdk: {
    operator: {
      sessions: {
        messages: {
          list: async (sessionId: string): Promise<unknown> => {
            stub.callCounts.set(sessionId, (stub.callCounts.get(sessionId) ?? 0) + 1);
            if (stub.shouldFail) throw new Error('network error');
            const msgs = stub.responses.get(sessionId) ?? [];
            // companionMessagesFromListResponse reads .items on the response
            return { items: msgs };
          },
        },
        search: async (input: SessionSearchCall): Promise<unknown> => {
          sessionSearchStub.calls.push(input);
          if (sessionSearchStub.failMode === 'not-invokable') {
            throw Object.assign(new Error('Method sessions.search is not invokable from this surface'), {
              status: 400,
              category: 'service',
              body: { error: 'Method sessions.search is not invokable from this surface', code: 'NOT_INVOKABLE' },
            });
          }
          if (sessionSearchStub.failMode === 'generic') {
            throw Object.assign(new Error('internal error'), { status: 500, category: 'service', body: { code: 'INTERNAL' } });
          }
          // Snapshot the response at CALL time so a test can reassign it for the fresh
          // search while a delayed load-more is still resolving with the old page.
          const snapshot = sessionSearchStub.response;
          if (input.cursor && sessionSearchStub.loadMoreDelayMs > 0) {
            await new Promise((r) => setTimeout(r, sessionSearchStub.loadMoreDelayMs));
          }
          return snapshot;
        },
      },
    },
  },
}));

// Import hook after mock registration.
const { useChatSearch } = await import('./useChatSearch');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The real setImmediate, captured before any test installs fake timers: React
// commits async state updates on a macrotask, which elapse() lets run between
// clock steps.
const realSetImmediate = globalThis.setImmediate;

/**
 * Move the fake clock forward by `ms` in 10 ms steps. After each step the
 * microtask queue and one real macrotask turn run, so the stubbed RPCs resolve
 * and React commits what they set before the next step. The hook's 300 ms
 * debounce and the stub's load-more delay fire exactly when the clock says.
 */
async function elapse(ms: number): Promise<void> {
  let remaining = ms;
  do {
    const step = Math.min(10, remaining);
    jest.advanceTimersByTime(step);
    remaining -= step;
    await new Promise<void>((r) => realSetImmediate(r));
  } while (remaining > 0);
}

type SearchState = ReturnType<typeof useChatSearch>;

const EMPTY_STATE: SearchState = {
  results: [],
  isSearching: false,
  sessionResults: [],
  sessionSearchState: 'idle',
  includeClosed: false,
  setIncludeClosed: () => {},
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  loadMoreSessions: () => {},
};

/**
 * Mount useChatSearch in a component. Returns a handle for:
 *   - reading the latest state snapshot
 *   - updating query / sessions props by re-rendering
 *   - driving the returned setIncludeClosed/loadMoreSessions callbacks
 *   - unmounting
 */
function mountHook(initialQuery: string, initialSessions: unknown[]) {
  let snapshot: SearchState = EMPTY_STATE;

  let currentQuery = initialQuery;
  let currentSessions = initialSessions;

  function HookOwner(): null {
    const state = useChatSearch(currentQuery, currentSessions);
    React.useLayoutEffect(() => {
      snapshot = state;
    });
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(React.createElement(HookOwner)); });

  return {
    get state(): SearchState {
      return snapshot;
    },
    setQuery(q: string) {
      currentQuery = q;
      flushSync(() => { root.render(React.createElement(HookOwner)); });
    },
    setSessions(s: unknown[]) {
      currentSessions = s;
      flushSync(() => { root.render(React.createElement(HookOwner)); });
    },
    updateBoth(q: string, s: unknown[]) {
      currentQuery = q;
      currentSessions = s;
      flushSync(() => { root.render(React.createElement(HookOwner)); });
    },
    setIncludeClosed(value: boolean) {
      flushSync(() => { snapshot.setIncludeClosed(value); });
    },
    loadMoreSessions() {
      flushSync(() => { snapshot.loadMoreSessions(); });
    },
    unmount() {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

/** Build a fake session with at least one message that contains the term. */
function makeSession(id: string, title: string, _messages: Record<string, unknown>[]): FakeSession {
  return { id, sessionId: id, title };
}

/** Seed stub.responses for a session. */
function seedMessages(sessionId: string, messages: Record<string, unknown>[]) {
  stub.responses.set(sessionId, messages);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

function resetSessionSearchStub() {
  sessionSearchStub.calls = [];
  sessionSearchStub.response = { sessions: [], nextCursor: undefined, hasMore: false };
  sessionSearchStub.failMode = 'none';
  sessionSearchStub.loadMoreDelayMs = 0;
}

beforeEach(() => {
  jest.useFakeTimers();
  stub.responses = new Map();
  stub.callCounts = new Map();
  stub.shouldFail = false;
  resetSessionSearchStub();
});

afterEach(() => {
  stub.responses = new Map();
  stub.callCounts = new Map();
  stub.shouldFail = false;
  resetSessionSearchStub();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChatSearch: debounce timing (300 ms)', () => {
  test('does not return results before debounce period elapses', async () => {
    const session = makeSession('s1', 'Session 1', []);
    seedMessages('s1', [{ id: 'm1', messageId: 'm1', content: 'hello world', createdAt: 1_000 }]);

    const handle = mountHook('', [session]);

    // Start a query, should not fire yet within 200ms
    handle.setQuery('hello');
    await elapse(200);
    // No results yet (debounce 300ms has not elapsed)
    expect(handle.state.results).toHaveLength(0);

    // Wait past debounce
    await elapse(200); // total ~400ms
    expect(handle.state.results.length).toBeGreaterThan(0);
    expect(handle.state.results[0]?.snippet).toContain('hello');

    handle.unmount();
  });

  test('results arrive after debounce + fetch (400ms total)', async () => {
    const session = makeSession('s2', 'Session 2', []);
    seedMessages('s2', [{ id: 'm2', messageId: 'm2', content: 'debounce test', createdAt: 2_000 }]);

    const handle = mountHook('debounce', [session]);
    await elapse(450);

    expect(handle.state.results.length).toBeGreaterThan(0);
    expect(handle.state.results[0]?.snippet).toContain('debounce');

    handle.unmount();
  });
});

describe('useChatSearch: abort on rapid retype (no stale results)', () => {
  test('only last query produces results when query changes rapidly', async () => {
    const session = makeSession('s3', 'Session 3', []);
    seedMessages('s3', [
      { id: 'm3a', messageId: 'm3a', content: 'alpha result', createdAt: 1_000 },
      { id: 'm3b', messageId: 'm3b', content: 'beta result', createdAt: 2_000 },
    ]);

    const handle = mountHook('', [session]);

    // Rapidly change query several times without waiting for debounce
    handle.setQuery('alpha');
    await elapse(50);
    handle.setQuery('beta');
    await elapse(50);
    handle.setQuery('beta'); // final query

    // Wait for debounce + fetch
    await elapse(450);

    // Only the last query ("beta") should have results
    const snippets = handle.state.results.map((r) => r.snippet);
    // Stale "alpha" should not appear
    expect(snippets.some((s) => s.includes('alpha'))).toBe(false);
    // "beta" should appear
    expect(snippets.some((s) => s.includes('beta'))).toBe(true);

    handle.unmount();
  });

  test('empty query after typing clears results immediately', async () => {
    const session = makeSession('s4', 'Session 4', []);
    seedMessages('s4', [{ id: 'm4', messageId: 'm4', content: 'clear me', createdAt: 1_000 }]);

    const handle = mountHook('clear', [session]);
    await elapse(450);
    expect(handle.state.results.length).toBeGreaterThan(0);

    // Clear the query
    handle.setQuery('');
    // Results should be cleared synchronously (no debounce for empty)
    await elapse(10);
    expect(handle.state.results).toHaveLength(0);
    expect(handle.state.isSearching).toBe(false);

    handle.unmount();
  });
});

describe('useChatSearch: cache hit and cache invalidation', () => {
  test('cache hit: same sessions: does not re-fetch messages on second query', async () => {
    const session = makeSession('s5', 'Session 5', []);
    seedMessages('s5', [{ id: 'm5', messageId: 'm5', content: 'cached content', createdAt: 1_000 }]);

    const handle = mountHook('cached', [session]);
    await elapse(450);

    expect(stub.callCounts.get('s5')).toBe(1);
    expect(handle.state.results.length).toBeGreaterThan(0);

    // Second query with same sessions, should use cache, not re-fetch
    handle.setQuery('content');
    await elapse(450);
    expect(stub.callCounts.get('s5')).toBe(1); // still 1, not 2
    expect(handle.state.results.length).toBeGreaterThan(0);

    handle.unmount();
  });

  test('cache invalidation: changing sessions identity clears cached messages and re-fetches', async () => {
    const session1 = makeSession('s6', 'Session 6', []);
    seedMessages('s6', [{ id: 'm6', messageId: 'm6', content: 'stale content', createdAt: 1_000 }]);

    const handle = mountHook('stale', [session1]);
    await elapse(450);

    expect(stub.callCounts.get('s6')).toBe(1);

    // Invalidate by changing sessions identity (new array reference with different id set).
    const session2 = makeSession('s6-v2', 'Session 6 v2', []);
    seedMessages('s6-v2', [{ id: 'm6b', messageId: 'm6b', content: 'fresh content stale', createdAt: 2_000 }]);

    handle.setSessions([session2]);
    await elapse(10); // cache reset happens synchronously during render

    // Re-run query with new sessions
    handle.setQuery('stale ');
    handle.setQuery('stale'); // trigger re-render with same effective query to restart effect
    await elapse(450);

    // s6-v2 should have been fetched (new session in cache)
    expect(stub.callCounts.get('s6-v2')).toBeGreaterThanOrEqual(1);

    handle.unmount();
  });

  test('cache is per-session: different sessions populate separate cache entries', async () => {
    const session1 = makeSession('s7a', 'Session 7A', []);
    const session2 = makeSession('s7b', 'Session 7B', []);
    seedMessages('s7a', [{ id: 'm7a', messageId: 'm7a', content: 'shared term here', createdAt: 1_000 }]);
    seedMessages('s7b', [{ id: 'm7b', messageId: 'm7b', content: 'shared term there', createdAt: 2_000 }]);

    const handle = mountHook('shared', [session1, session2]);
    await elapse(450);

    expect(stub.callCounts.get('s7a')).toBe(1);
    expect(stub.callCounts.get('s7b')).toBe(1);
    // Both results should appear
    expect(handle.state.results).toHaveLength(2);

    // Second query, both served from cache
    handle.setQuery('term');
    await elapse(450);
    expect(stub.callCounts.get('s7a')).toBe(1);
    expect(stub.callCounts.get('s7b')).toBe(1);

    handle.unmount();
  });
});

describe('useChatSearch: recency ranking', () => {
  test('results are ordered by createdAt descending (most recent first)', async () => {
    const session = makeSession('s8', 'Session 8', []);
    seedMessages('s8', [
      { id: 'm8a', messageId: 'm8a', content: 'order test older', createdAt: 1_000 },
      { id: 'm8b', messageId: 'm8b', content: 'order test middle', createdAt: 3_000 },
      { id: 'm8c', messageId: 'm8c', content: 'order test newest', createdAt: 5_000 },
    ]);

    const handle = mountHook('order', [session]);
    await elapse(450);

    const results = handle.state.results;
    expect(results).toHaveLength(3);
    // Most recent first
    expect(results[0]?.createdAt).toBe(5_000);
    expect(results[1]?.createdAt).toBe(3_000);
    expect(results[2]?.createdAt).toBe(1_000);

    handle.unmount();
  });

  test('results without createdAt sort to end (treated as 0)', async () => {
    const session = makeSession('s9', 'Session 9', []);
    seedMessages('s9', [
      { id: 'm9a', messageId: 'm9a', content: 'rank no-timestamp', createdAt: undefined },
      { id: 'm9b', messageId: 'm9b', content: 'rank with-timestamp', createdAt: 4_000 },
    ]);

    const handle = mountHook('rank', [session]);
    await elapse(450);

    const results = handle.state.results;
    expect(results).toHaveLength(2);
    // The one with createdAt should come first
    expect(results[0]?.createdAt).toBe(4_000);
    expect(results[1]?.createdAt).toBeUndefined();

    handle.unmount();
  });

  test('cross-session results ranked by createdAt across sessions', async () => {
    const sessionA = makeSession('s10a', 'Session A', []);
    const sessionB = makeSession('s10b', 'Session B', []);
    seedMessages('s10a', [{ id: 'm10a', messageId: 'm10a', content: 'cross rank test old', createdAt: 1_000 }]);
    seedMessages('s10b', [{ id: 'm10b', messageId: 'm10b', content: 'cross rank test new', createdAt: 9_000 }]);

    const handle = mountHook('cross', [sessionA, sessionB]);
    await elapse(450);

    const results = handle.state.results;
    expect(results.length).toBe(2);
    expect(results[0]?.createdAt).toBe(9_000);
    expect(results[1]?.createdAt).toBe(1_000);

    handle.unmount();
  });
});

// ---------------------------------------------------------------------------
// Session-search stage (sessions.search, first consumer)
// ---------------------------------------------------------------------------

describe('useChatSearch: session search (sessions.search) includeClosed default', () => {
  test('defaults includeClosed to false on a fresh query: the documented divergence from sessions.list', async () => {
    sessionSearchStub.response = { sessions: [], nextCursor: undefined, hasMore: false };
    const handle = mountHook('', []);

    handle.setQuery('deploy');
    await elapse(450);

    expect(sessionSearchStub.calls.length).toBeGreaterThan(0);
    expect(sessionSearchStub.calls[sessionSearchStub.calls.length - 1]?.includeClosed).toBe(false);
    expect(handle.state.includeClosed).toBe(false);

    handle.unmount();
  });

  test('scopes the search to kind: companion-chat (this hook\'s domain)', async () => {
    const handle = mountHook('', []);
    handle.setQuery('deploy');
    await elapse(450);

    expect(sessionSearchStub.calls[sessionSearchStub.calls.length - 1]?.kind).toBe('companion-chat');

    handle.unmount();
  });

  test('toggling includeClosed re-queries with includeClosed:true and renders a closed session honestly', async () => {
    sessionSearchStub.response = {
      sessions: [
        { id: 'sc1', kind: 'companion-chat', title: 'Closed session', status: 'closed', createdAt: 1, updatedAt: 1, lastActivityAt: 1, messageCount: 3, pendingInputCount: 0, routeIds: [], surfaceKinds: [], participants: [], metadata: {} },
      ],
      nextCursor: undefined,
      hasMore: false,
    };

    const handle = mountHook('', []);
    handle.setQuery('closed');
    await elapse(450);

    // Default (includeClosed:false), the stub still returns the fixture (a
    // stub does not enforce filtering), but the hook's own default is what
    // this test asserts: the CALL carries includeClosed:false.
    expect(sessionSearchStub.calls.at(-1)?.includeClosed).toBe(false);

    handle.setIncludeClosed(true);
    await elapse(450);

    expect(sessionSearchStub.calls.at(-1)?.includeClosed).toBe(true);
    expect(handle.state.includeClosed).toBe(true);
    // The returned session is rendered with its real status, never relabeled.
    expect(handle.state.sessionResults).toHaveLength(1);
    expect(handle.state.sessionResults[0]?.status).toBe('closed');

    handle.unmount();
  });
});

describe('useChatSearch: session search honest degraded states', () => {
  test('a NOT_INVOKABLE rejection surfaces as sessionSearchState "unavailable", not a silent empty result', async () => {
    sessionSearchStub.failMode = 'not-invokable';
    const handle = mountHook('', []);

    handle.setQuery('deploy');
    await elapse(450);

    expect(handle.state.sessionSearchState).toBe('unavailable');
    expect(handle.state.sessionResults).toHaveLength(0);

    handle.unmount();
  });

  test('a generic failure surfaces as sessionSearchState "error", distinct from "unavailable"', async () => {
    sessionSearchStub.failMode = 'generic';
    const handle = mountHook('', []);

    handle.setQuery('deploy');
    await elapse(450);

    expect(handle.state.sessionSearchState).toBe('error');

    handle.unmount();
  });

  test('a genuine empty result is "ready" with zero sessionResults, distinct from "unavailable"/"error"', async () => {
    sessionSearchStub.response = { sessions: [], nextCursor: undefined, hasMore: false };
    const handle = mountHook('', []);

    handle.setQuery('nomatch');
    await elapse(450);

    expect(handle.state.sessionSearchState).toBe('ready');
    expect(handle.state.sessionResults).toHaveLength(0);

    handle.unmount();
  });

  test('empty query clears session results and resets state to idle', async () => {
    sessionSearchStub.response = {
      sessions: [{ id: 's1', kind: 'companion-chat', title: 'A', status: 'active', createdAt: 1, updatedAt: 1, lastActivityAt: 1, messageCount: 1, pendingInputCount: 0, routeIds: [], surfaceKinds: [], participants: [], metadata: {} }],
      nextCursor: undefined,
      hasMore: false,
    };
    const handle = mountHook('', []);
    handle.setQuery('deploy');
    await elapse(450);
    expect(handle.state.sessionResults.length).toBeGreaterThan(0);

    handle.setQuery('');
    await elapse(10);
    expect(handle.state.sessionResults).toHaveLength(0);
    expect(handle.state.sessionSearchState).toBe('idle');

    handle.unmount();
  });
});

describe('useChatSearch: session search pagination', () => {
  test('hasMoreSessions/nextCursor from the first page drive loadMoreSessions, which APPENDS results', async () => {
    sessionSearchStub.response = {
      sessions: [{ id: 'p1', kind: 'companion-chat', title: 'Page 1', status: 'active', createdAt: 1, updatedAt: 1, lastActivityAt: 1, messageCount: 1, pendingInputCount: 0, routeIds: [], surfaceKinds: [], participants: [], metadata: {} }],
      nextCursor: 'cursor-2',
      hasMore: true,
    };

    const handle = mountHook('', []);
    handle.setQuery('page');
    await elapse(450);

    expect(handle.state.hasMoreSessions).toBe(true);
    expect(handle.state.sessionResults).toHaveLength(1);

    sessionSearchStub.response = {
      sessions: [{ id: 'p2', kind: 'companion-chat', title: 'Page 2', status: 'active', createdAt: 2, updatedAt: 2, lastActivityAt: 2, messageCount: 1, pendingInputCount: 0, routeIds: [], surfaceKinds: [], participants: [], metadata: {} }],
      nextCursor: undefined,
      hasMore: false,
    };
    handle.loadMoreSessions();
    await elapse(50);

    expect(handle.state.sessionResults).toHaveLength(2);
    expect(handle.state.sessionResults.map((r) => r.sessionId)).toEqual(['p1', 'p2']);
    expect(handle.state.hasMoreSessions).toBe(false);
    // The load-more call passed the previous page's cursor.
    expect(sessionSearchStub.calls.at(-1)?.cursor).toBe('cursor-2');

    handle.unmount();
  });

  test('loadMoreSessions is a no-op when hasMoreSessions is false', async () => {
    sessionSearchStub.response = { sessions: [], nextCursor: undefined, hasMore: false };
    const handle = mountHook('', []);
    handle.setQuery('nomore');
    await elapse(450);

    const callsBefore = sessionSearchStub.calls.length;
    handle.loadMoreSessions();
    await elapse(50);

    expect(sessionSearchStub.calls.length).toBe(callsBefore);

    handle.unmount();
  });

  test('a stale load-more page does NOT append onto a fresh same-params search (generation guard, F7d)', async () => {
    const summary = (id: string, cursor?: string, hasMore = false) => ({
      response: {
        sessions: [{
          id, kind: 'companion-chat', title: id, status: 'active',
          createdAt: 1, updatedAt: 1, lastActivityAt: 1, messageCount: 1,
          pendingInputCount: 0, routeIds: [], surfaceKinds: [], participants: [], metadata: {},
        }],
        nextCursor: cursor,
        hasMore,
      },
    });

    // This is generation 1.
    sessionSearchStub.response = summary('p1', 'c1', true).response;
    const handle = mountHook('', []);
    handle.setQuery('paginate');
    await elapse(450);
    expect(handle.state.sessionResults.map((r) => r.sessionId)).toEqual(['p1']);
    expect(handle.state.hasMoreSessions).toBe(true);

    // Launch a load-more, but hold its response in flight (500ms). It carries cursor c1
    // and would resolve to a STALE page, set that as the response it snapshots now.
    sessionSearchStub.loadMoreDelayMs = 500;
    sessionSearchStub.response = summary('stale-page-2').response;
    handle.loadMoreSessions();
    await elapse(20); // let the load-more call fire and snapshot the stale response

    // While it hangs, the user retypes to the SAME query (via a detour), a FRESH search,
    // generation 2, replacing the list with a new first page (different backend cursor).
    sessionSearchStub.loadMoreDelayMs = 0; // the fresh call carries no cursor anyway
    sessionSearchStub.response = summary('fresh-p1').response;
    handle.setQuery('paginat');
    handle.setQuery('paginate');
    await elapse(450); // fresh search debounces + completes → gen bumps, results replaced
    expect(handle.state.sessionResults.map((r) => r.sessionId)).toEqual(['fresh-p1']);

    // The delayed stale load-more resolves; its generation (1) is stale, so it must
    // be discarded, never appended onto the fresh (gen 2) results.
    await elapse(200);
    expect(handle.state.sessionResults.map((r) => r.sessionId)).toEqual(['fresh-p1']);
    expect(handle.state.sessionResults.some((r) => r.sessionId === 'stale-page-2')).toBe(false);

    handle.unmount();
  });
});
