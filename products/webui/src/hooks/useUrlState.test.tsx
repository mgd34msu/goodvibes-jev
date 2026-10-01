/**
 * Tests for useUrlState hook.
 * Uses react-dom/client + flushSync + happy-dom (bunfig.toml preload).
 *
 * CRITICAL StrictMode coverage: each setter must push exactly ONE history
 * entry even under React StrictMode (which double-invokes state updaters).
 *
 * Note on popstate dispatching:
 *   happy-dom installs its Event class at globalThis.Event, but bun's native
 *   globalThis.dispatchEvent() rejects non-native Event objects. To avoid this
 *   we intercept window.addEventListener before hook mount to capture the
 *   popstate handler, then call it directly after mutating the URL.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useUrlState } from './useUrlState';
import type { UseUrlStateReturn } from './useUrlState';

// ---------------------------------------------------------------------------
// Hook harness
// ---------------------------------------------------------------------------

function HookOwner({ onHandle }: { onHandle: (h: UseUrlStateReturn) => void }): null {
  const handle = useUrlState();
  React.useLayoutEffect(() => { onHandle(handle); });
  return null;
}

function renderHook(
  strict = false,
): { getHandle: () => UseUrlStateReturn; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let handle!: UseUrlStateReturn;
  const ui = <HookOwner onHandle={(h) => { handle = h; }} />;
  flushSync(() => {
    root.render(strict ? <StrictMode>{ui}</StrictMode> : ui);
  });
  return {
    getHandle: () => handle,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

// ---------------------------------------------------------------------------
// Spy helpers for history
// ---------------------------------------------------------------------------

let pushCallCount = 0;
let replaceCallCount = 0;
let _originalPush: typeof window.history.pushState;
let _originalReplace: typeof window.history.replaceState;

function installSpies(): void {
  pushCallCount = 0;
  replaceCallCount = 0;
  _originalPush = window.history.pushState.bind(window.history);
  _originalReplace = window.history.replaceState.bind(window.history);
  window.history.pushState = (
    state: unknown,
    title: string,
    url?: string | URL | null,
  ) => {
    pushCallCount++;
    _originalPush(state, title, url);
  };
  window.history.replaceState = (
    state: unknown,
    title: string,
    url?: string | URL | null,
  ) => {
    replaceCallCount++;
    _originalReplace(state, title, url);
  };
}

function removeSpies(): void {
  if (_originalPush) window.history.pushState = _originalPush;
  if (_originalReplace) window.history.replaceState = _originalReplace;
}

// ---------------------------------------------------------------------------
// popstate helper
// ---------------------------------------------------------------------------

/**
 * Wraps a test that needs to simulate popstate. Because bun's native
 * globalThis.dispatchEvent() rejects happy-dom Event instances, we intercept
 * window.addEventListener BEFORE the hook mounts so we can capture and
 * directly invoke the popstate handler without going through dispatchEvent.
 *
 * Usage:
 *   withPopstateTrap((hook, triggerPopstate) => {
 *     // ... call setters, mutate URL ...
 *     triggerPopstate(); // calls the captured handler directly
 *   });
 */
function withPopstateTrap(
  fn: (hook: { getHandle: () => UseUrlStateReturn; unmount: () => void }, trigger: () => void) => void,
  strict = false,
): void {
  let capturedHandler: (() => void) | null = null;
  const origAdd = window.addEventListener.bind(window);

  // Temporarily override addEventListener to sniff the popstate registration
  (window as unknown as Record<string, unknown>).addEventListener = (
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: unknown,
  ) => {
    if (type === 'popstate') {
      capturedHandler = handler as () => void;
    }
    origAdd(type, handler as EventListener, options as AddEventListenerOptions);
  };

  const hook = renderHook(strict);

  // Restore after hook mount
  (window as unknown as Record<string, unknown>).addEventListener = origAdd;

  fn(hook, () => {
    if (capturedHandler) {
      flushSync(() => { (capturedHandler as () => void)(); });
    }
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  installSpies();
});

afterEach(() => {
  removeSpies();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('useUrlState: initial state', () => {
  test('defaults to chat when no view param', () => {
    const { getHandle, unmount } = renderHook();
    expect(getHandle().view).toBe('chat');
    unmount();
  });

  test('decodes view from URL', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=library&tab=knowledge');
    installSpies();
    const { getHandle, unmount } = renderHook();
    expect(getHandle().view).toBe('library');
    expect(getHandle().tab).toBe('knowledge');
    unmount();
  });

  test('decodes session from URL', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&session=abc-123');
    installSpies();
    const { getHandle, unmount } = renderHook();
    expect(getHandle().session).toBe('abc-123');
    unmount();
  });

  test('decodes filters from URL', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&filter%5Bstatus%5D=active');
    installSpies();
    const { getHandle, unmount } = renderHook();
    expect(getHandle().filters).toEqual({ status: 'active' });
    unmount();
  });
});

// ---------------------------------------------------------------------------
// setView
// ---------------------------------------------------------------------------

describe('useUrlState: setView', () => {
  test('updates view in returned state', () => {
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().setView('work'); });
    expect(getHandle().view).toBe('work');
    unmount();
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle, unmount } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setView('library'); });
    expect(pushCallCount).toBe(1);
    unmount();
  });

  test('STRICTMODE: setView adds exactly ONE history entry under React.StrictMode', () => {
    const { getHandle, unmount } = renderHook(true);
    pushCallCount = 0;
    flushSync(() => { getHandle().setView('personal'); });
    expect(pushCallCount).toBe(1);
    unmount();
  });

  test('replace option uses replaceState instead of pushState', () => {
    const { getHandle, unmount } = renderHook();
    pushCallCount = 0;
    replaceCallCount = 0;
    flushSync(() => { getHandle().setView('work', { replace: true }); });
    expect(pushCallCount).toBe(0);
    expect(replaceCallCount).toBeGreaterThanOrEqual(1);
    unmount();
  });

  test('preserves session and filters when changing view', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&session=s1&filter%5Ba%5D=1');
    installSpies();
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().setView('work'); });
    expect(getHandle().session).toBe('s1');
    expect(getHandle().filters).toEqual({ a: '1' });
    unmount();
  });
});

describe('useUrlState: destination tabs', () => {
  test('setTab replaces the history entry and keeps the view', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=work');
    installSpies();
    const { getHandle, unmount } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setTab('agents'); });
    expect(getHandle().view).toBe('work');
    expect(getHandle().tab).toBe('agents');
    expect(pushCallCount).toBe(0);
    expect(window.location.search).toContain('tab=agents');
    unmount();
  });

  test('moving to another view drops the tab, unless one is given', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=work&tab=agents');
    installSpies();
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().setView('library'); });
    expect(getHandle().tab).toBeUndefined();
    flushSync(() => { getHandle().setView('personal', { tab: 'mail' }); });
    expect(getHandle().tab).toBe('mail');
    unmount();
  });

  test('an old data-view link is rewritten in place to its destination, keeping the fragment', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=fleet#fleet-node=n1');
    installSpies();
    const { getHandle, unmount } = renderHook();
    expect(getHandle().view).toBe('work');
    expect(getHandle().tab).toBe('all');
    expect(window.location.search).toBe('?view=work&tab=all');
    expect(window.location.hash).toBe('#fleet-node=n1');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// setSession
// ---------------------------------------------------------------------------

describe('useUrlState: setSession', () => {
  test('updates session in returned state', () => {
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().setSession('sess-xyz'); });
    expect(getHandle().session).toBe('sess-xyz');
    unmount();
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle, unmount } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setSession('s1'); });
    expect(pushCallCount).toBe(1);
    unmount();
  });

  test('STRICTMODE: setSession adds exactly ONE history entry under React.StrictMode', () => {
    const { getHandle, unmount } = renderHook(true);
    pushCallCount = 0;
    flushSync(() => { getHandle().setSession('strict-sess'); });
    expect(pushCallCount).toBe(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// setFilters
// ---------------------------------------------------------------------------

describe('useUrlState: setFilters', () => {
  test('merges new filter keys into existing filters', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&filter%5Ba%5D=1');
    installSpies();
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().setFilters({ b: '2' }); });
    expect(getHandle().filters).toEqual({ a: '1', b: '2' });
    unmount();
  });

  test('removes filter key when value is undefined', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&filter%5Ba%5D=1&filter%5Bb%5D=2');
    installSpies();
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().setFilters({ a: undefined }); });
    expect(getHandle().filters).toEqual({ b: '2' });
    unmount();
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle, unmount } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setFilters({ q: 'hello' }); });
    expect(pushCallCount).toBe(1);
    unmount();
  });

  test('STRICTMODE: setFilters adds exactly ONE history entry under React.StrictMode', () => {
    const { getHandle, unmount } = renderHook(true);
    pushCallCount = 0;
    flushSync(() => { getHandle().setFilters({ q: 'strict' }); });
    expect(pushCallCount).toBe(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// resetFilters
// ---------------------------------------------------------------------------

describe('useUrlState: resetFilters', () => {
  test('replaces entire filters object', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=chat&filter%5Bold%5D=x');
    installSpies();
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().resetFilters({ fresh: 'yes' }); });
    expect(getHandle().filters).toEqual({ fresh: 'yes' });
    unmount();
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle, unmount } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().resetFilters({ x: '1' }); });
    expect(pushCallCount).toBe(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// setUrlState
// ---------------------------------------------------------------------------

describe('useUrlState: setUrlState', () => {
  test('merges partial state', () => {
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().setUrlState({ view: 'work', session: 'x' }); });
    expect(getHandle().view).toBe('work');
    expect(getHandle().session).toBe('x');
    unmount();
  });

  test('pushes exactly ONE history entry per call', () => {
    const { getHandle, unmount } = renderHook();
    pushCallCount = 0;
    flushSync(() => { getHandle().setUrlState({ view: 'work' }); });
    expect(pushCallCount).toBe(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// settings dialog param
// ---------------------------------------------------------------------------

describe('useUrlState: the settings dialog section', () => {
  test('setUrlState opens and closes the dialog through ?settings=', () => {
    const { getHandle, unmount } = renderHook();
    flushSync(() => { getHandle().setUrlState({ settings: 'models' }); });
    expect(getHandle().settings).toBe('models');
    expect(window.location.search).toContain('settings=models');
    flushSync(() => { getHandle().setUrlState({ settings: '' }); });
    expect(window.location.search).not.toContain('settings=');
    unmount();
  });

  test('an old ?view=admin link is rewritten to the chat view with Account open', () => {
    removeSpies();
    window.history.replaceState(null, '', '/?view=admin');
    installSpies();
    const { getHandle, unmount } = renderHook();
    expect(getHandle().view).toBe('chat');
    expect(getHandle().settings).toBe('account');
    expect(window.location.search).toContain('settings=account');
    expect(window.location.search).not.toContain('view=admin');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// popstate (back/forward navigation)
// ---------------------------------------------------------------------------

describe('useUrlState: popstate', () => {
  test('popstate event updates state to new URL', () => {
    withPopstateTrap((hook, triggerPopstate) => {
      const { getHandle, unmount } = hook;
      window.history.pushState(null, '', '/?view=library&session=s99');
      triggerPopstate();
      expect(getHandle().view).toBe('library');
      expect(getHandle().session).toBe('s99');
      unmount();
    });
  });

  test('no feedback loop: handling popstate does not push a new history entry', () => {
    withPopstateTrap((hook, triggerPopstate) => {
      const { getHandle: _h, unmount } = hook;
      window.history.pushState(null, '', '/?view=library');
      pushCallCount = 0;
      triggerPopstate();
      expect(pushCallCount).toBe(0);
      unmount();
    });
  });
});
