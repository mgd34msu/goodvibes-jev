/**
 * useUrlState, React hook that reads/writes AppUrlState via the URL.
 *
 * Subscribes to `popstate` so browser back/forward triggers re-renders.
 * Setters call pushState (navigateTo) by default; pass `replace: true`
 * to use replaceState instead.
 *
 * Contract (TOKEN-CONTRACT.md):
 *   useUrlState() => current state + setters
 */

import { useCallback, useEffect, useState } from 'react';
import {
  type AppUrlState,
  type ViewId,
  decodeUrlState,
  encodeUrlState,
  isLegacyView,
  pushState,
  replaceState,
} from '../lib/router';

export interface UrlStateSetters {
  /** Navigate to a different view, preserving session/filters. A new view starts on its default tab. */
  setView: (view: ViewId, options?: { replace?: boolean; tab?: string }) => void;
  /** Switch the current destination's tab ('' for its default). Replaces the history entry by default. */
  setTab: (tab: string, options?: { replace?: boolean }) => void;
  /** Update the active session id. */
  setSession: (session: string, options?: { replace?: boolean }) => void;
  /** Merge filter key/value pairs into current filters. Pass undefined value to remove a key. */
  setFilters: (
    updates: Record<string, string | undefined>,
    options?: { replace?: boolean },
  ) => void;
  /** Replace the entire filters object. */
  resetFilters: (filters: Record<string, string>, options?: { replace?: boolean }) => void;
  /** Set multiple fields at once. */
  setUrlState: (partial: Partial<AppUrlState>, options?: { replace?: boolean }) => void;
}

export interface UseUrlStateReturn extends AppUrlState, UrlStateSetters {}

/**
 * Pure initializer: decode the current URL into initial state.
 * Side effects (URL normalization) are handled separately in a mount effect.
 */
function initializeUrl(): AppUrlState {
  return decodeUrlState();
}

export function useUrlState(): UseUrlStateReturn {
  const [urlState, setLocalState] = useState<AppUrlState>(initializeUrl);

  // Normalize the URL on first mount: if no `view` param, silently replace
  // so a bare `/` becomes `/?view=chat` without adding a history entry.
  // Runs in an effect (not in the lazy initializer) to avoid render-phase
  // side effects that double-fire under StrictMode.
  // Reuse the already-decoded `urlState` (from the lazy initializer) rather
  // than calling decodeUrlState() again, avoids a redundant decode and an
  // unconditional extra render when the URL is already normalized.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // An old link (?view=admin, providers, principals, or one of the data views
    // that became Work, Library and Personal): rewrite it in place to its new
    // home. The fragment is kept: a pairing hand-off (#pair=…), a push
    // notification's approval action or fleet focus may ride the same link.
    if (isLegacyView(window.location.search)) {
      const url = `${window.location.pathname}?${encodeUrlState(urlState)}${window.location.hash}`;
      window.history.replaceState(urlState, '', url);
      return;
    }
    if (!params.has('view')) {
      const url = `${window.location.pathname}?view=${urlState.view}`;
      window.history.replaceState(urlState, '', url);
      // Only sync local state if it would actually change (it won't here since
      // urlState was decoded from the same URL, but guard for clarity).
      setLocalState((prev) => (prev === urlState ? prev : urlState));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to popstate (back/forward navigation)
  useEffect(() => {
    function handlePopState(): void {
      setLocalState(decodeUrlState());
    }
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const setView = useCallback((view: ViewId, options?: { replace?: boolean; tab?: string }): void => {
    // Compute next state from the current closure value, NOT inside the
    // setLocalState updater. This ensures the history side-effect fires exactly
    // once per call even under React StrictMode, which double-invokes updaters.
    // A tab belongs to its destination: moving to another view drops it.
    const tab = options?.tab ?? (view === urlState.view ? urlState.tab : undefined);
    const { tab: _previousTab, ...rest } = urlState;
    const nextState: AppUrlState = tab ? { ...rest, view, tab } : { ...rest, view };
    if (options?.replace) {
      replaceState(nextState);
    } else {
      pushState(nextState);
    }
    setLocalState(nextState);
  }, [urlState]);

  const setTab = useCallback((tab: string, options?: { replace?: boolean }): void => {
    const { tab: _previousTab, ...rest } = urlState;
    const nextState: AppUrlState = tab ? { ...rest, tab } : rest;
    if (options?.replace === false) {
      pushState(nextState);
    } else {
      replaceState(nextState);
    }
    setLocalState(nextState);
  }, [urlState]);

  const setSession = useCallback((session: string, options?: { replace?: boolean }): void => {
    const nextState: AppUrlState = { ...urlState, session };
    if (options?.replace) {
      replaceState(nextState);
    } else {
      pushState(nextState);
    }
    setLocalState(nextState);
  }, [urlState]);

  const setFilters = useCallback(
    (updates: Record<string, string | undefined>, options?: { replace?: boolean }): void => {
      const next: Record<string, string> = { ...urlState.filters };
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      const nextState: AppUrlState = { ...urlState, filters: next };
      if (options?.replace) {
        replaceState(nextState);
      } else {
        pushState(nextState);
      }
      setLocalState(nextState);
    },
    [urlState],
  );

  const resetFilters = useCallback(
    (filters: Record<string, string>, options?: { replace?: boolean }): void => {
      const nextState: AppUrlState = { ...urlState, filters };
      if (options?.replace) {
        replaceState(nextState);
      } else {
        pushState(nextState);
      }
      setLocalState(nextState);
    },
    [urlState],
  );

  const setUrlState = useCallback(
    (partial: Partial<AppUrlState>, options?: { replace?: boolean }): void => {
      const nextState: AppUrlState = { ...urlState, ...partial };
      if (options?.replace) {
        replaceState(nextState);
      } else {
        pushState(nextState);
      }
      setLocalState(nextState);
    },
    [urlState],
  );

  return {
    ...urlState,
    setView,
    setTab,
    setSession,
    setFilters,
    resetFilters,
    setUrlState,
  };
}
