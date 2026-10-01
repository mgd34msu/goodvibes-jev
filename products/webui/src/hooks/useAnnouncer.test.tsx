/**
 * Tests for useAnnouncer hook.
 * Uses react-dom/client + flushSync + happy-dom (bunfig.toml preload), with
 * fake timers driving the hook's 0 ms clear and 50 ms set.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { _resetAnnouncerStore, useAnnouncer } from './useAnnouncer';

// ---------------------------------------------------------------------------
// Types / helpers
// ---------------------------------------------------------------------------

type AnnouncerHandle = ReturnType<typeof useAnnouncer>;

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

function HookOwner({ onHandle }: { onHandle: (h: AnnouncerHandle) => void }): null {
  const handle = useAnnouncer();
  React.useLayoutEffect(() => { onHandle(handle); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// The announcer's clear-then-set cycle runs on timers; fake timers step it
// exactly instead of sleeping past it.
beforeEach(() => { jest.useFakeTimers(); _resetAnnouncerStore(); });
afterEach(() => { _resetAnnouncerStore(); jest.useRealTimers(); });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAnnouncer', () => {
  test('polite message appears in the polite live region', () => {
    let handle!: AnnouncerHandle;
    const owner = renderInto(<HookOwner onHandle={(h) => { handle = h; }} />);
    const { AnnouncerRegion } = handle;
    const region = renderInto(<AnnouncerRegion />);

    handle.announce('File saved');
    // Wait for the clear (0ms) + set (50ms) timers
    jest.advanceTimersByTime(80);
    // Flush any pending React state updates from the store
    flushSync(() => {});

    const politeEl = region.el.querySelector('[aria-live="polite"]');
    expect(politeEl?.textContent).toBe('File saved');

    owner.unmount();
    region.unmount();
  });

  test('assertive message appears in the assertive live region', () => {
    let handle!: AnnouncerHandle;
    const owner = renderInto(<HookOwner onHandle={(h) => { handle = h; }} />);
    const region = renderInto(<handle.AnnouncerRegion />);

    handle.announce('Critical error', 'assertive');
    jest.advanceTimersByTime(80);
    flushSync(() => {});

    const assertiveEl = region.el.querySelector('[aria-live="assertive"]');
    expect(assertiveEl?.textContent).toBe('Critical error');

    owner.unmount();
    region.unmount();
  });

  test('assertive message does NOT appear in polite region', () => {
    let handle!: AnnouncerHandle;
    const owner = renderInto(<HookOwner onHandle={(h) => { handle = h; }} />);
    const region = renderInto(<handle.AnnouncerRegion />);

    handle.announce('Alert!', 'assertive');
    jest.advanceTimersByTime(80);
    flushSync(() => {});

    const politeEl = region.el.querySelector('[aria-live="polite"]');
    expect(politeEl?.textContent).toBe('');

    owner.unmount();
    region.unmount();
  });

  test('same message announced twice cycles through empty for re-read', () => {
    let handle!: AnnouncerHandle;
    const owner = renderInto(<HookOwner onHandle={(h) => { handle = h; }} />);
    const region = renderInto(<handle.AnnouncerRegion />);

    handle.announce('Saved');
    jest.advanceTimersByTime(80);
    flushSync(() => {});
    expect(region.el.querySelector('[aria-live="polite"]')?.textContent).toBe('Saved');

    // Second announce, must clear first, then re-set
    handle.announce('Saved');
    jest.advanceTimersByTime(10);
    flushSync(() => {});
    // Region cleared
    expect(region.el.querySelector('[aria-live="polite"]')?.textContent).toBe('');

    jest.advanceTimersByTime(60);
    flushSync(() => {});
    expect(region.el.querySelector('[aria-live="polite"]')?.textContent).toBe('Saved');

    owner.unmount();
    region.unmount();
  });

  test('rapid announce() calls cancel previous timer, only last message shows', () => {
    let handle!: AnnouncerHandle;
    const owner = renderInto(<HookOwner onHandle={(h) => { handle = h; }} />);
    const region = renderInto(<handle.AnnouncerRegion />);

    handle.announce('First');
    handle.announce('Second');
    handle.announce('Third');
    jest.advanceTimersByTime(100);
    flushSync(() => {});

    expect(region.el.querySelector('[aria-live="polite"]')?.textContent).toBe('Third');

    owner.unmount();
    region.unmount();
  });

  test('AnnouncerRegion re-renders even when not co-located with hook owner', () => {
    let handle!: AnnouncerHandle;
    const owner = renderInto(<HookOwner onHandle={(h) => { handle = h; }} />);
    // Region in a separate container entirely
    const regionEl = document.createElement('div');
    document.body.appendChild(regionEl);
    const region = renderInto(<handle.AnnouncerRegion />, regionEl);

    handle.announce('Remote message');
    jest.advanceTimersByTime(80);
    flushSync(() => {});

    expect(regionEl.querySelector('[aria-live="polite"]')?.textContent).toBe('Remote message');

    owner.unmount();
    region.unmount();
  });
});
