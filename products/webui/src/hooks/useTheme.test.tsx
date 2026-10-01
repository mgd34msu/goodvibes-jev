/**
 * Tests for useTheme hook and ThemeProvider.
 * Uses react-dom/client + flushSync + happy-dom (bunfig.toml preload).
 *
 * With @happy-dom/global-registrator (installed by test-setup.ts), `window`
 * IS a real happy-dom Window whose dispatchEvent/addEventListener/
 * removeEventListener are all native happy-dom methods. No event-bus patch
 * is needed, events dispatched on `window` are received by listeners on
 * `window` directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider, useTheme } from './useTheme';
import {
  THEME_PREFERENCES_EVENT,
  THEME_PREFERENCES_KEY,
  readThemePreferences,
} from '../lib/theme';

// ---------------------------------------------------------------------------
// Types / render helper
// ---------------------------------------------------------------------------

type UseThemeHandle = ReturnType<typeof useTheme>;

function renderInto(
  ui: React.ReactElement,
  el?: HTMLElement,
): { el: HTMLElement; root: ReturnType<typeof createRoot>; unmount: () => void } {
  const container = el ?? document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(ui); });
  return {
    el: container,
    root,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

/**
 * Captures the useTheme handle from inside a ThemeProvider.
 * useLayoutEffect fires synchronously after each render, so handle is always
 * current after flushSync.
 */
function HookCapture({ onHandle }: { onHandle: (h: UseThemeHandle) => void }): null {
  const handle = useTheme();
  React.useLayoutEffect(() => { onHandle(handle); });
  return null;
}

function renderThemeProvider(
  onHandle: (h: UseThemeHandle) => void,
): ReturnType<typeof renderInto> {
  return renderInto(
    <ThemeProvider>
      <HookCapture onHandle={onHandle} />
    </ThemeProvider>,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});

// ---------------------------------------------------------------------------
// useTheme, error boundary
// ---------------------------------------------------------------------------

describe('useTheme outside ThemeProvider', () => {
  test('throws when called outside ThemeProvider', () => {
    let threw = false;
    function BadConsumer(): null {
      try { useTheme(); } catch { threw = true; }
      return null;
    }
    const r = renderInto(<BadConsumer />);
    r.unmount();
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ThemeProvider, initial state
// ---------------------------------------------------------------------------

describe('ThemeProvider initial state', () => {
  test('defaults to dark theme when nothing stored', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });
    expect(handle.theme).toBe('dark');
    r.unmount();
  });

  test('defaults to default density when nothing stored', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });
    expect(handle.density).toBe('default');
    r.unmount();
  });

  test('picks up stored light theme on mount', () => {
    window.localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify({ theme: 'light', density: 'default' }));
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });
    expect(handle.theme).toBe('light');
    r.unmount();
  });

  test('picks up stored compact density on mount', () => {
    window.localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify({ theme: 'dark', density: 'compact' }));
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });
    expect(handle.density).toBe('compact');
    r.unmount();
  });

  test('applies data-theme to documentElement on mount', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });
    expect(document.documentElement.getAttribute('data-theme')).toBe(handle.theme);
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// setTheme
// ---------------------------------------------------------------------------

describe('setTheme', () => {
  test('updates theme state to light', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setTheme('light'); });

    expect(handle.theme).toBe('light');
    r.unmount();
  });

  test('sets data-theme attribute on documentElement', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setTheme('light'); });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    r.unmount();
  });

  test('persists theme to localStorage', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setTheme('light'); });

    const stored = readThemePreferences();
    expect(stored.theme).toBe('light');
    r.unmount();
  });

  test('can switch back from light to dark', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setTheme('light'); });
    flushSync(() => { handle.setTheme('dark'); });

    expect(handle.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// setDensity
// ---------------------------------------------------------------------------

describe('setDensity', () => {
  test('updates density state to compact', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setDensity('compact'); });

    expect(handle.density).toBe('compact');
    r.unmount();
  });

  test('sets data-density attribute on documentElement', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setDensity('compact'); });

    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    r.unmount();
  });

  test('removes data-density attribute when switching back to default', () => {
    window.localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify({ theme: 'dark', density: 'compact' }));
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setDensity('default'); });

    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
    r.unmount();
  });

  test('persists density to localStorage', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setDensity('compact'); });

    const stored = readThemePreferences();
    expect(stored.density).toBe('compact');
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// toggleTheme
// ---------------------------------------------------------------------------

describe('toggleTheme', () => {
  test('toggles from dark to light', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });
    expect(handle.theme).toBe('dark');

    flushSync(() => { handle.toggleTheme(); });

    expect(handle.theme).toBe('light');
    r.unmount();
  });

  test('toggles from light to dark', () => {
    window.localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify({ theme: 'light', density: 'default' }));
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.toggleTheme(); });

    expect(handle.theme).toBe('dark');
    r.unmount();
  });

  test('toggle updates data-theme on documentElement', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.toggleTheme(); });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    r.unmount();
  });

  test('toggle persists to localStorage', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.toggleTheme(); });

    const stored = readThemePreferences();
    expect(stored.theme).toBe('light');
    r.unmount();
  });

  test('toggling from GoodVibes Neon (a dark theme) goes to light', () => {
    window.localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify({ theme: 'neon', density: 'default' }));
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });
    expect(handle.theme).toBe('neon');
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon');

    flushSync(() => { handle.toggleTheme(); });

    expect(handle.theme).toBe('light');
    r.unmount();
  });

  test('setTheme("auto") stores auto and marks the root for the OS media query', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.setTheme('auto'); });

    expect(document.documentElement.getAttribute('data-theme')).toBe('auto');
    expect(readThemePreferences().theme).toBe('auto');
    r.unmount();
  });

  test('double toggle returns to original theme', () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    flushSync(() => { handle.toggleTheme(); });
    flushSync(() => { handle.toggleTheme(); });

    expect(handle.theme).toBe('dark');
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Cross-tab / storage event sync
// ---------------------------------------------------------------------------

describe('cross-tab storage event sync', () => {
  test('updates theme state when storage event fires with new prefs', async () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });
    expect(handle.theme).toBe('dark');

    // Simulate another tab writing to localStorage
    window.localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify({ theme: 'light', density: 'default' }));
    // Dispatch a storage event on the global window (happy-dom Window via GlobalRegistrator)
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_PREFERENCES_KEY }));
    // Allow React to process the state update
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});

    expect(handle.theme).toBe('light');
    r.unmount();
  });

  test('updates density state when custom theme event fires', async () => {
    let handle!: UseThemeHandle;
    const r = renderThemeProvider((h) => { handle = h; });

    // Simulate same-tab custom event (e.g., from another ThemeProvider instance)
    window.localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify({ theme: 'dark', density: 'compact' }));
    // Dispatch a custom event directly on the global window
    window.dispatchEvent(new CustomEvent(THEME_PREFERENCES_EVENT, {
      detail: { theme: 'dark', density: 'compact' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});

    expect(handle.density).toBe('compact');
    r.unmount();
  });
});
