/**
 * useChatSearch, companion-history search hook (first consumer of
 * sessions.search).
 *
 * TWO DISTINCT STAGES, kept separate rather than merged (a deliberate design
 * decision, not an oversight):
 *
 *   1. SESSION search (`sessionResults`), backend-side, via
 *      `sdk.operator.sessions.search({ query, kind: 'companion-chat', ... })`.
 *      Matches session id/title/project only (not message bodies) but reaches
 *      FULL history, not just the ~100 most-recently-fetched sessions the
 *      caller passed in. This is the new capability sessions.search unlocks.
 *
 *   2. MESSAGE-content search (`results`), unchanged from before: client-side,
 *      substring-matches message bodies, but only within the `sessions` the
 *      caller already fetched (capped upstream at ~100, see App.tsx). Kept
 *      because sessions.search cannot see inside message bodies, dropping
 *      this stage would silently narrow what a user can find.
 *
 * THE includeClosed DIVERGENCE (load-bearing, name it wherever this is read):
 * sessions.search defaults `includeClosed` to FALSE, the OPPOSITE of
 * SharedSessionBroker.listSessions' own default (session-search.ts's handler
 * comment on the SDK side calls this out explicitly; sessions-union.ts's
 * consumer, SessionsView, defaults its own includeClosed toggle to TRUE for
 * exactly the same reason it should NOT be true here). A search surface
 * hides dead sessions by default; a full list surface shows them. Do not
 * "fix" this hook to match SessionsView's default, they are intentionally
 * different truths for different surfaces. `includeClosed` is exposed here
 * as an explicit, off-by-default toggle so the user can opt in.
 *
 * Session-search failures degrade honestly: a route-absent/NOT_INVOKABLE
 * response (the daemon does not serve sessions.search) surfaces as the
 * `'unavailable'` state, never a silent empty list indistinguishable from a
 * genuine zero-result search.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { sdk } from '../../lib/goodvibes';
import {
  companionMessagesFromListResponse,
  extractMessageId,
  extractSessionId,
} from '../../lib/companion-chat';
import { errorCode } from '../../lib/errors';
import { firstString } from '../../lib/object';
import type { SessionsSearchSessionSummary } from '../../lib/contract-bridge-types';
import type { ChatMessage } from './types';

/** A single search result referencing a specific message. */
export interface ChatSearchResult {
  sessionId: string;
  messageId: string;
  /** Up to 160-character extract around the matched term. */
  snippet: string;
  /** Display title for the containing session. */
  sessionTitle: string;
  /** Message creation timestamp (epoch ms), if known. */
  createdAt?: number;
}

/** A single session-level search result (title/id match, not a specific message). */
export interface ChatSessionSearchResult {
  sessionId: string;
  sessionTitle: string;
  /** Rendered honestly, a closed session is never relabeled as active. */
  status: 'active' | 'closed';
  project?: string;
  /** Most recent activity timestamp (epoch ms), if known. */
  updatedAt?: number;
}

/**
 * Lifecycle of the backend session-search stage.
 *   'idle'       , no query typed yet.
 *   'searching'  , request in flight (debounced).
 *   'ready'      , a response landed (sessionResults reflects it, may be empty).
 *   'unavailable', the daemon does not serve sessions.search (NOT_INVOKABLE /
 *                   route-absent), distinct from a genuine empty result.
 *   'error'      , some other request failure (network, 5xx, etc).
 */
export type SessionSearchState = 'idle' | 'searching' | 'ready' | 'unavailable' | 'error';

/** The value returned from useChatSearch. */
export interface UseChatSearchReturn {
  /** Filtered, ranked message-content results for the current query. */
  results: ChatSearchResult[];
  /** True while messages are being fetched for an active query. */
  isSearching: boolean;
  /** Session-discovery results from sessions.search (title/id match, full history). */
  sessionResults: ChatSessionSearchResult[];
  /** Lifecycle of the session-search stage, see SessionSearchState. */
  sessionSearchState: SessionSearchState;
  /**
   * Whether closed/reaped sessions are included in the session-search stage.
   * Defaults to false, matching sessions.search's own default (NOT
   * sessions.list's), see the module doc comment above.
   */
  includeClosed: boolean;
  setIncludeClosed: (value: boolean) => void;
  /** True when a further page of session results exists (nextCursor present). */
  hasMoreSessions: boolean;
  /** True while a load-more request for session results is in flight. */
  isLoadingMoreSessions: boolean;
  /** Fetch the next page of session results and append them. */
  loadMoreSessions: () => void;
}

/** Messages keyed by sessionId. */
type MessageCache = Map<string, ChatMessage[]>;

const SNIPPET_CONTEXT = 80;
const DEBOUNCE_MS = 300;
const MAX_SNIPPET_LENGTH = 160;

/** Extract a short snippet centred on the first occurrence of `term`. */
function buildSnippet(text: string, term: string): string {
  const lower = text.toLowerCase();
  const termLower = term.toLowerCase();
  const idx = lower.indexOf(termLower);
  if (idx === -1) return text.slice(0, MAX_SNIPPET_LENGTH);
  const start = Math.max(0, idx - SNIPPET_CONTEXT);
  const end = Math.min(text.length, idx + term.length + SNIPPET_CONTEXT);
  const excerpt = text.slice(start, end);
  return (start > 0 ? '…' : '') + excerpt + (end < text.length ? '…' : '');
}

/** Extract a displayable title from a raw session object. */
function extractSessionTitle(session: unknown): string {
  return firstString(session, ['title', 'name', 'label']) || 'Untitled session';
}

/** Extract the primary text content from a ChatMessage. */
function messageText(msg: ChatMessage): string {
  const direct = msg.content ?? msg.text ?? msg.body ?? msg.message ?? msg.delta ?? '';
  if (direct) return direct;
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .map((p: { text?: string; content?: string; body?: string }) => p.text ?? p.content ?? p.body ?? '')
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Fetch messages for a single session, returning typed ChatMessage[]. */
async function fetchMessages(sessionId: string): Promise<ChatMessage[]> {
  const raw = await sdk.operator.sessions.messages.list(sessionId);
  const items = companionMessagesFromListResponse(raw);
  return items.map((item) => item as ChatMessage);
}

const SESSION_SEARCH_LIMIT = 20;

/**
 * Kind filter for sessions.search, scopes the backend session-discovery
 * stage to companion chat sessions (this hook's domain), matching one of the
 * six KNOWN_SESSION_KINDS in sessions-union.ts. Not imported from there: that
 * module exports the full list for the cross-surface union view, not a single
 * literal for one consumer.
 */
const COMPANION_CHAT_KIND = 'companion-chat';

/** Map a wire session-search summary onto this hook's honest result shape. */
function toSessionSearchResult(summary: SessionsSearchSessionSummary): ChatSessionSearchResult {
  return {
    sessionId: summary.id,
    sessionTitle: summary.title || 'Untitled session',
    status: summary.status === 'closed' ? 'closed' : 'active',
    project: summary.project,
    updatedAt: summary.lastActivityAt ?? summary.updatedAt,
  };
}

/** True when `error` is the daemon's honest "this method is not served" rejection. */
function isNotInvokableError(error: unknown): boolean {
  return errorCode(error) === 'NOT_INVOKABLE';
}

/**
 * Fetch one page of the backend session-search stage.
 *
 * `includeClosed` defaults to false at the call site below to match
 * sessions.search's own default, see the module doc comment for why this is
 * intentionally different from the union session list's default.
 */
async function fetchSessionSearchPage(
  query: string,
  includeClosed: boolean,
  cursor?: string,
): Promise<{ sessions: ChatSessionSearchResult[]; nextCursor?: string; hasMore: boolean }> {
  const page = await sdk.operator.sessions.search({
    query,
    kind: COMPANION_CHAT_KIND,
    includeClosed,
    limit: SESSION_SEARCH_LIMIT,
    ...(cursor ? { cursor } : {}),
  });
  return {
    sessions: page.sessions.map(toSessionSearchResult),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/**
 * Hook that searches across all companion chat sessions/messages.
 *
 * @param query   - The raw search string (hook debounces internally).
 * @param sessions - Pre-fetched session list from the caller's TanStack Query.
 */
export function useChatSearch(
  query: string,
  sessions: unknown[],
): UseChatSearchReturn {
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Session-search stage (sessions.search), a separate concern from the
  // message-content stage above: different backend, different default
  // (includeClosed=false), its own pagination and lifecycle state.
  const [sessionResults, setSessionResults] = useState<ChatSessionSearchResult[]>([]);
  const [sessionSearchState, setSessionSearchState] = useState<SessionSearchState>('idle');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);
  const sessionSearchAbortRef = useRef<AbortController | null>(null);
  // Tracks the query/includeClosed pair the currently-visible sessionResults were
  // fetched for, so a slow load-more response that lands after the user has
  // already changed the query/toggle is discarded rather than silently applied.
  const activeSessionParamsRef = useRef({ query: '', includeClosed });
  // Monotonic generation counter, bumped every time a FRESH search begins (see
  // runSessionSearch). The param check above can't catch the query-changed-then-changed-
  // BACK case: a load-more launched against generation N, whose page lands after the user
  // retyped the SAME query (a new fresh search, generation N+1, with its own backend
  // cursor), would pass the param equality test and append a stale page onto fresh
  // results. Comparing the generation captured at load-more time closes that hole.
  const searchGenerationRef = useRef(0);

  // Persistent message cache, keyed by sessionId, reset when sessions identity changes.
  const cacheRef = useRef<MessageCache>(new Map());
  // Abort controller to cancel stale searches.
  const abortRef = useRef<AbortController | null>(null);

  // Invalidate message cache when sessions list changes (different count or ids).
  const sessionsKey = sessions
    .map((s) => extractSessionId(s) ?? '')
    .join(',');
  const prevSessionsKeyRef = useRef(sessionsKey);
  // eslint-disable-next-line react-hooks/refs -- documented derived-state-during-render guard, intentional
  if (sessionsKey !== prevSessionsKeyRef.current) {
    // eslint-disable-next-line react-hooks/refs -- documented derived-state-during-render guard, intentional
    prevSessionsKeyRef.current = sessionsKey;
    // eslint-disable-next-line react-hooks/refs -- documented derived-state-during-render guard, intentional
    cacheRef.current = new Map();
  }

  const runSearch = useCallback(
    async (term: string, signal: AbortSignal): Promise<void> => {
      if (!term.trim()) {
        setResults([]);
        setIsSearching(false);
        return;
      }

      setIsSearching(true);
      const termLower = term.toLowerCase();
      const found: ChatSearchResult[] = [];

      for (const session of sessions) {
        if (signal.aborted) break;

        const sessionId = extractSessionId(session);
        if (!sessionId) continue;

        const sessionTitle = extractSessionTitle(session);

        // Fetch messages (cached)
        let messages = cacheRef.current.get(sessionId);
        if (!messages) {
          try {
            messages = await fetchMessages(sessionId);
            if (!signal.aborted) {
              cacheRef.current.set(sessionId, messages);
            }
          } catch {
            continue; // Skip sessions whose messages can't be loaded
          }
        }

        if (signal.aborted) break;

        for (const msg of messages) {
          const text = messageText(msg);
          if (!text) continue;
          if (!text.toLowerCase().includes(termLower)) continue;

          const messageId = extractMessageId(msg) || '';
          const snippet = buildSnippet(text, term);
          const createdAt = msg.createdAt ?? msg.timestamp ?? msg.time;

          found.push({
            sessionId,
            messageId,
            snippet,
            sessionTitle,
            createdAt: typeof createdAt === 'number' ? createdAt : undefined,
          });
        }
      }

      if (!signal.aborted) {
        // Sort: most recent sessions first
        found.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        setResults(found);
        setIsSearching(false);
      }
    },
    [sessions],
  );

  useEffect(() => {
    // Abort any pending search
    abortRef.current?.abort();

    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    const timer = window.setTimeout(() => {
      void runSearch(query, controller.signal);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
      abortRef.current = null;
    };
  }, [query, runSearch]);

  // ── Session-search stage (sessions.search, first consumer) ────────
  //
  // Debounced independently of the message-content stage above: it has no
  // dependency on the caller's `sessions` prop (it searches full history via
  // the backend, not the client-provided corpus), and it re-runs on
  // `includeClosed` toggling in addition to `query` changes.
  const runSessionSearch = useCallback(
    async (term: string, closed: boolean, signal: AbortSignal): Promise<void> => {
      // A fresh search supersedes any in-flight load-more from a prior generation.
      searchGenerationRef.current += 1;
      if (!term.trim()) {
        setSessionResults([]);
        setSessionSearchState('idle');
        setNextCursor(undefined);
        setHasMoreSessions(false);
        return;
      }

      setSessionSearchState('searching');
      try {
        const page = await fetchSessionSearchPage(term, closed);
        if (signal.aborted) return;
        setSessionResults(page.sessions);
        setNextCursor(page.nextCursor);
        setHasMoreSessions(page.hasMore);
        setSessionSearchState('ready');
      } catch (error) {
        if (signal.aborted) return;
        setSessionResults([]);
        setNextCursor(undefined);
        setHasMoreSessions(false);
        setSessionSearchState(isNotInvokableError(error) ? 'unavailable' : 'error');
      }
    },
    [],
  );

  useEffect(() => {
    activeSessionParamsRef.current = { query, includeClosed };
  }, [query, includeClosed]);

  useEffect(() => {
    sessionSearchAbortRef.current?.abort();

    if (!query.trim()) {
      setSessionResults([]);
      setSessionSearchState('idle');
      setNextCursor(undefined);
      setHasMoreSessions(false);
      return;
    }

    const controller = new AbortController();
    sessionSearchAbortRef.current = controller;

    const timer = window.setTimeout(() => {
      void runSessionSearch(query, includeClosed, controller.signal);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
      sessionSearchAbortRef.current = null;
    };
  }, [query, includeClosed, runSessionSearch]);

  const loadMoreSessions = useCallback(() => {
    if (isLoadingMoreSessions || !hasMoreSessions || !nextCursor) return;
    const requestedParams = activeSessionParamsRef.current;
    const requestedGeneration = searchGenerationRef.current;

    setIsLoadingMoreSessions(true);
    void (async () => {
      try {
        const page = await fetchSessionSearchPage(requestedParams.query, requestedParams.includeClosed, nextCursor);
        // Discard if a FRESH search has begun since this page was requested, even if its
        // params happen to match (query changed away and back), it is a different search
        // with a different backend cursor, so appending this page would mix generations.
        if (searchGenerationRef.current !== requestedGeneration) {
          return;
        }
        // Belt-and-braces: also discard on a bare param change (a fresh search may not
        // have STARTED yet, e.g. still debouncing, but the toggle already moved).
        if (
          activeSessionParamsRef.current.query !== requestedParams.query
          || activeSessionParamsRef.current.includeClosed !== requestedParams.includeClosed
        ) {
          return;
        }
        setSessionResults((prev) => [...prev, ...page.sessions]);
        setNextCursor(page.nextCursor);
        setHasMoreSessions(page.hasMore);
      } catch (error) {
        if (isNotInvokableError(error)) setSessionSearchState('unavailable');
        // Otherwise: leave the existing page's results in place. A failed
        // load-more is not a failed search, do not blow away what already
        // rendered successfully.
      } finally {
        setIsLoadingMoreSessions(false);
      }
    })();
  }, [hasMoreSessions, nextCursor, isLoadingMoreSessions]);

  return {
    results,
    isSearching,
    sessionResults,
    sessionSearchState,
    includeClosed,
    setIncludeClosed,
    hasMoreSessions,
    isLoadingMoreSessions,
    loadMoreSessions,
  };
}
