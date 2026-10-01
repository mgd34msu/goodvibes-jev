import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  SIDEBAR_STORAGE_KEY,
  ShellProvider,
  clampSidebarWidth,
  deriveSidebar,
  readStoredSidebar,
  useRightPanel,
  useShell,
  type ShellApi,
} from './ShellContext';

const base = { isPhone: false, isNarrow: false, rightPanelOpen: false, userCollapsed: false, pinned: false };

describe('deriveSidebar: the design doc auto-collapse table', () => {
  test('under 900 the sidebar is the phone drawer, whatever else holds', () => {
    expect(deriveSidebar({ ...base, isPhone: true, rightPanelOpen: true, pinned: true }).mode).toBe('drawer');
  });

  test('nothing open on the right: expanded', () => {
    expect(deriveSidebar(base)).toEqual({ mode: 'expanded', autoCollapsed: false });
  });

  test('a right panel folds an unpinned sidebar to the rail', () => {
    expect(deriveSidebar({ ...base, rightPanelOpen: true })).toEqual({ mode: 'rail', autoCollapsed: true });
  });

  test('a pinned sidebar never auto-collapses on a wide window', () => {
    expect(deriveSidebar({ ...base, rightPanelOpen: true, pinned: true })).toEqual({ mode: 'expanded', autoCollapsed: false });
  });

  test('under 1280 a right panel collapses it, pinned or not', () => {
    expect(deriveSidebar({ ...base, rightPanelOpen: true, pinned: true, isNarrow: true })).toEqual({ mode: 'rail', autoCollapsed: true });
  });

  test("restore: the person's own collapse survives the panel closing", () => {
    expect(deriveSidebar({ ...base, userCollapsed: true })).toEqual({ mode: 'rail', autoCollapsed: false });
    expect(deriveSidebar({ ...base, userCollapsed: true, rightPanelOpen: true }).mode).toBe('rail');
  });
});

describe('sidebar width and storage', () => {
  beforeEach(() => window.localStorage.removeItem(SIDEBAR_STORAGE_KEY));

  test('clamps to 220..360 and falls back on junk', () => {
    expect(clampSidebarWidth(100)).toBe(220);
    expect(clampSidebarWidth(999)).toBe(360);
    expect(clampSidebarWidth(301.6)).toBe(302);
    expect(clampSidebarWidth(Number.NaN)).toBe(260);
  });

  test('reads defaults when nothing or garbage is stored', () => {
    expect(readStoredSidebar()).toEqual({ collapsed: false, pinned: false, width: 260 });
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, '{not json');
    expect(readStoredSidebar()).toEqual({ collapsed: false, pinned: false, width: 260 });
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify({ collapsed: true, pinned: 'yes', width: 9000 }));
    expect(readStoredSidebar()).toEqual({ collapsed: true, pinned: false, width: 360 });
  });
});

describe('ShellProvider: useRightPanel drives the rail', () => {
  let shell: ShellApi | null = null;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function Capture(): null {
    shell = useShell();
    return null;
  }
  function Panel({ open, width }: { open: boolean; width?: number }): null {
    useRightPanel(open, { width });
    return null;
  }
  /** Render, then let the panel's registration effect land and re-render. */
  async function renderPanel(open: boolean, width?: number): Promise<void> {
    flushSync(() => {
      root.render(
        <ShellProvider>
          <Capture />
          <Panel open={open} width={width} />
        </ShellProvider>,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }

  beforeEach(() => {
    window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    shell = null;
  });

  test('opening a 440 panel folds to the rail; closing it restores expanded', async () => {
    await renderPanel(false);
    expect(shell?.mode).toBe('expanded');
    await renderPanel(true, 440);
    expect(shell?.mode).toBe('rail');
    expect(shell?.autoCollapsed).toBe(true);
    // The layout column has not moved yet: content reflows once, after the motion.
    expect(shell?.layoutWidth).toBe(260);
    await renderPanel(false, 440);
    expect(shell?.mode).toBe('expanded');
  });

  test('a panel under 400 wide is not a trigger', async () => {
    await renderPanel(true, 320);
    expect(shell?.mode).toBe('expanded');
  });

  test('toggle while a panel holds the rail opens the peek instead of changing the stored choice', async () => {
    await renderPanel(true, 440);
    expect(shell?.mode).toBe('rail');
    flushSync(() => shell?.toggleSidebar());
    expect(shell?.peek).toBe(true);
    expect(shell?.userCollapsed).toBe(false);
    expect(readStoredSidebar().collapsed).toBe(false);
  });

  test("toggle with nothing open flips and stores the person's choice", async () => {
    await renderPanel(false);
    flushSync(() => shell?.toggleSidebar());
    expect(shell?.mode).toBe('rail');
    expect(shell?.autoCollapsed).toBe(false);
    expect(readStoredSidebar().collapsed).toBe(true);
  });

  test('pinning keeps it open while a panel is open on a wide window', async () => {
    await renderPanel(true, 440);
    expect(shell?.mode).toBe('rail');
    flushSync(() => shell?.setPinned(true));
    expect(shell?.mode).toBe('expanded');
    await renderPanel(false);
    await renderPanel(true, 440);
    expect(shell?.mode).toBe('expanded');
    expect(readStoredSidebar().pinned).toBe(true);
  });
});
