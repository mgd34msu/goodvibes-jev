/**
 * Shell state and the sidebar auto-collapse API.
 *
 * Implements the design document's "Sidebar auto-collapse" table:
 *
 *   Triggers ....... any right-side panel 400 wide or more (a list and detail
 *                    split showing a detail, a peek drawer, the chat artifacts
 *                    panel). Callers announce one with `useRightPanel(open)`.
 *   Collapsed form . a 56-wide icon rail (the sidebar component draws it).
 *   Restore ........ when the last right panel closes the sidebar returns to the
 *                    person's own state; if they had collapsed it themselves it
 *                    stays collapsed (the auto state is derived, never stored).
 *   Pinned ......... a pinned sidebar never auto-collapses (the panel narrows).
 *   Narrow windows . under 1280 a right panel always collapses it, pinned or
 *                    not; under 900 the sidebar is the phone drawer.
 *   Hover peek ..... hovering the rail for 300 ms, or Ctrl B while a panel holds
 *                    the rail, slides the full sidebar over the content as glass.
 *   Motion ......... the sidebar's width animates over 200 ms; the layout column
 *                    (and so the content) changes once, when the animation ends.
 *                    Instant with reduced motion.
 *
 * The person's own choices (collapsed, pinned, width) persist in localStorage
 * under `goodvibes.webui.sidebar`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useHotkeys } from '../../hooks/useHotkeys';
import { registerCommand, unregisterCommand } from '../../lib/commands';
import { PHONE_QUERY, REDUCED_MOTION_QUERY, useMediaQuery } from '../ui/overlay';

export const SIDEBAR_STORAGE_KEY = 'goodvibes.webui.sidebar';
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const RAIL_WIDTH = 56;
export const RIGHT_PANEL_TRIGGER_WIDTH = 400;
export const NARROW_QUERY = '(max-width: 1279px)';
export const RAIL_MOTION_MS = 200;
export const HOVER_PEEK_DELAY_MS = 300;

export type SidebarMode = 'expanded' | 'rail' | 'drawer';

interface StoredSidebar {
  collapsed: boolean;
  pinned: boolean;
  width: number;
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

export function readStoredSidebar(): StoredSidebar {
  const fallback: StoredSidebar = { collapsed: false, pinned: false, width: SIDEBAR_DEFAULT_WIDTH };
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredSidebar>;
    return {
      collapsed: parsed.collapsed === true,
      pinned: parsed.pinned === true,
      width: typeof parsed.width === 'number' ? clampSidebarWidth(parsed.width) : SIDEBAR_DEFAULT_WIDTH,
    };
  } catch {
    return fallback;
  }
}

function writeStoredSidebar(next: StoredSidebar): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked (private window): the choice lasts for this page only.
  }
}

/** Pure derivation of the sidebar's form, exported for unit tests. */
export function deriveSidebar(input: {
  isPhone: boolean;
  isNarrow: boolean;
  rightPanelOpen: boolean;
  userCollapsed: boolean;
  pinned: boolean;
}): { mode: SidebarMode; autoCollapsed: boolean } {
  if (input.isPhone) return { mode: 'drawer', autoCollapsed: false };
  const autoCollapsed = input.rightPanelOpen && (!input.pinned || input.isNarrow);
  const collapsed = autoCollapsed || input.userCollapsed;
  return { mode: collapsed ? 'rail' : 'expanded', autoCollapsed };
}

export interface ShellApi {
  mode: SidebarMode;
  /** True when the rail is showing only because a right panel is open. */
  autoCollapsed: boolean;
  /** The person's own collapsed choice (what the sidebar restores to). */
  userCollapsed: boolean;
  pinned: boolean;
  rightPanelOpen: boolean;
  /** The rail is showing the full sidebar over the content (hover or Ctrl B). */
  peek: boolean;
  drawerOpen: boolean;
  /** Expanded sidebar width, 220 to 360. */
  width: number;
  /**
   * The width the layout column currently reserves. It follows the sidebar's
   * visual width only after the 200 ms animation, so content reflows once.
   */
  layoutWidth: number;
  toggleSidebar: () => void;
  setPinned: (pinned: boolean) => void;
  setPeek: (peek: boolean) => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  setWidth: (width: number) => void;
  /** Announce a right-side panel; returns the function that withdraws it. */
  registerRightPanel: (id: string) => () => void;
}

const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used within a ShellProvider');
  return ctx;
}

/** Null outside a ShellProvider (isolated unit tests render views without the shell). */
export function useOptionalShell(): ShellApi | null {
  return useContext(ShellContext);
}

/**
 * Tell the shell a right-side panel is open, so the sidebar folds to its rail
 * while it is. Panels narrower than 400 are ignored unless `force` is set.
 * A no-op outside the shell.
 */
export function useRightPanel(open: boolean, options?: { width?: number; force?: boolean }): void {
  const shell = useContext(ShellContext);
  const id = useId();
  const counts = options?.force === true
    || options?.width === undefined
    || options.width >= RIGHT_PANEL_TRIGGER_WIDTH;
  const register = shell?.registerRightPanel;
  useEffect(() => {
    if (!open || !counts || !register) return undefined;
    return register(id);
  }, [open, counts, register, id]);
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const isPhone = useMediaQuery(PHONE_QUERY);
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const [stored, setStored] = useState<StoredSidebar>(() =>
    typeof window === 'undefined' ? { collapsed: false, pinned: false, width: SIDEBAR_DEFAULT_WIDTH } : readStoredSidebar(),
  );
  const [panels, setPanels] = useState<ReadonlySet<string>>(() => new Set());
  const [peek, setPeekState] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const update = useCallback((patch: Partial<StoredSidebar>) => {
    setStored((prev) => {
      const next = { ...prev, ...patch };
      writeStoredSidebar(next);
      return next;
    });
  }, []);

  const rightPanelOpen = panels.size > 0;
  const { mode, autoCollapsed } = deriveSidebar({
    isPhone,
    isNarrow,
    rightPanelOpen,
    userCollapsed: stored.collapsed,
    pinned: stored.pinned,
  });

  // Visual width now; layout width after the animation (reflow once, at the end).
  const visualWidth = mode === 'rail' ? RAIL_WIDTH : stored.width;
  const [layoutWidth, setLayoutWidth] = useState(visualWidth);
  useEffect(() => {
    if (reducedMotion) {
      setLayoutWidth(visualWidth);
      return undefined;
    }
    const timer = setTimeout(() => setLayoutWidth(visualWidth), RAIL_MOTION_MS);
    return () => clearTimeout(timer);
  }, [visualWidth, reducedMotion]);

  // Peek only exists on the rail; the drawer only on the phone.
  useEffect(() => {
    if (mode !== 'rail') setPeekState(false);
    if (mode !== 'drawer') setDrawerOpen(false);
  }, [mode]);

  const registerRightPanel = useCallback((id: string) => {
    setPanels((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    return () => {
      setPanels((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    };
  }, []);

  const modeRef = useRef(mode);
  const autoRef = useRef(autoCollapsed);
  useLayoutEffect(() => {
    modeRef.current = mode;
    autoRef.current = autoCollapsed;
  }, [mode, autoCollapsed]);

  const toggleSidebar = useCallback(() => {
    if (modeRef.current === 'drawer') {
      setDrawerOpen((open) => !open);
      return;
    }
    if (autoRef.current) {
      // A right panel holds the rail: Ctrl B shows the sidebar over the content instead.
      setPeekState((open) => !open);
      return;
    }
    setStored((prev) => {
      const next = { ...prev, collapsed: !prev.collapsed };
      writeStoredSidebar(next);
      return next;
    });
    setPeekState(false);
  }, []);

  useHotkeys([
    {
      combo: 'mod+b',
      handler: (event) => {
        event.preventDefault();
        toggleSidebar();
      },
      allowInInput: true,
    },
  ]);

  useEffect(() => {
    registerCommand({
      id: 'view.toggleSidebar',
      title: 'Toggle sidebar',
      group: 'view',
      keywords: ['sidebar', 'navigation', 'collapse', 'rail', 'panel'],
      shortcut: 'mod+b',
      run: toggleSidebar,
    });
    return () => unregisterCommand('view.toggleSidebar');
  }, [toggleSidebar]);

  const api = useMemo<ShellApi>(() => ({
    mode,
    autoCollapsed,
    userCollapsed: stored.collapsed,
    pinned: stored.pinned,
    rightPanelOpen,
    peek: mode === 'rail' && peek,
    drawerOpen: mode === 'drawer' && drawerOpen,
    width: stored.width,
    layoutWidth: mode === 'drawer' ? 0 : layoutWidth,
    toggleSidebar,
    setPinned: (pinned) => update({ pinned }),
    setPeek: (next) => setPeekState(next),
    openDrawer: () => setDrawerOpen(true),
    closeDrawer: () => setDrawerOpen(false),
    setWidth: (width) => update({ width: clampSidebarWidth(width) }),
    registerRightPanel,
  }), [mode, autoCollapsed, stored, rightPanelOpen, peek, drawerOpen, layoutWidth, toggleSidebar, update, registerRightPanel]);

  return <ShellContext.Provider value={api}>{children}</ShellContext.Provider>;
}
