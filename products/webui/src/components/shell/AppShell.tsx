/**
 * AppShell, Phase-2 composition module.
 *
 * Nests all UX provider modules into ONE mountable shell, removing the
 * serialization bottleneck from App.tsx. App.tsx edit is exactly 3 lines:
 *
 * ```tsx
 * // 1. Add import:
 * import AppShell from './components/shell/AppShell';
 * // 2. Add hook call inside App (before JSX):
 * const { view, setView } = useUrlState();
 * // 3. Wrap children with AppShell:
 * return <AppShell view={view} onNavigate={setView}>{children}</AppShell>;
 * ```
 *
 * Provider nesting (outermost → innermost):
 *   ThemeProvider → ErrorBoundary → ToastProvider → CommandProvider → ShellProvider → PeekProvider
 *
 * ShellProvider owns the sidebar state and the auto-collapse API
 * (useRightPanel); it sits outside PeekProvider so a peek drawer can announce
 * itself as a right-side panel.
 *
 * Always-on chrome rendered inside PeekProvider:
 *   <ToastViewport />, <AnnouncerRegion />
 * (The bottom status strip is gone: connection state lives on the account
 * avatar and in the account menu; see ShellLayout.)
 *
 * AppShell registers two commands not covered by CommandProvider:
 *   - system.toggleTheme  (group: 'system')
 *   - system.toggleDensity (group: 'view')
 *
 * CommandProvider already registers nav + chat + system.palette + system.shortcuts;
 * those are NOT re-registered here to prevent double-registration.
 */

import { useEffect, type ReactNode } from 'react';
import { ThemeProvider, useTheme } from '../../hooks/useTheme';
import ErrorBoundary from '../feedback/ErrorBoundary';
import { ToastProvider } from '../../lib/toast';
import { ToastViewport } from '../toast/ToastViewport';
import CommandProvider from '../command/CommandProvider';
import { PeekProvider } from '../peek/PeekPanel';
import { ShellProvider } from './ShellContext';
import { useAnnouncer } from '../../hooks/useAnnouncer';
import { registerCommand, unregisterCommand } from '../../lib/commands';
import type { ViewId } from '../../lib/router';

// ─── Props ─────────────────────────────────────────────────────────────────

export interface AppShellProps {
  children: ReactNode;
  /**
   * The currently active view. Read from useUrlState() in App.
   * Passed through to CommandProvider.onNavigate so palette commands
   * can trigger view transitions.
   */
  view: ViewId;
  /**
   * Navigation callback. Wire to App's navigate handler:
   *   <AppShell view={view} onNavigate={handleNavigate}>
   *
   * Receives an optional options bag; when options.newChat is true the
   * caller should start a fresh chat draft in addition to switching to
   * the chat view.
   */
  onNavigate: (view: ViewId, options?: { newChat?: boolean; tab?: string }) => void;
  /** Open the settings dialog (palette commands, g p / g a). */
  onOpenSettings?: (section?: string) => void;
}

// ─── Inner shell (rendered inside ThemeProvider so useTheme is available) ──

interface InnerShellProps {
  children: ReactNode;
  onNavigate: (view: ViewId, options?: { newChat?: boolean; tab?: string }) => void;
  onOpenSettings?: (section?: string) => void;
}

function InnerShell({ children, onNavigate, onOpenSettings }: InnerShellProps) {
  const { toggleTheme, density, setDensity } = useTheme();
  const { AnnouncerRegion } = useAnnouncer();

  // Register AppShell-owned commands (theme + density toggles).
  // Guard: registerCommand is idempotent on id, if this runs twice in
  // StrictMode the second call silently overwrites with the same def.
  // Cleanup unregisters so they are removed on unmount.
  useEffect(() => {
    registerCommand({
      id: 'system.toggleTheme',
      title: 'Toggle Theme',
      group: 'system',
      keywords: ['theme', 'dark', 'light', 'color'],
      shortcut: 'mod+shift+t',
      run: toggleTheme,
    });
    registerCommand({
      id: 'view.toggleDensity',
      title: 'Toggle Density',
      group: 'view',
      keywords: ['density', 'compact', 'comfortable', 'spacious'],
      run: () => setDensity(density === 'compact' ? 'default' : 'compact'),
    });

    return () => {
      unregisterCommand('system.toggleTheme');
      unregisterCommand('view.toggleDensity');
    };
    // Re-register if theme/density callbacks change identity.
  }, [toggleTheme, density, setDensity]);

  return (
    <ErrorBoundary>
      <ToastProvider>
        <CommandProvider onNavigate={onNavigate} onOpenSettings={onOpenSettings}>
          <ShellProvider>
            <PeekProvider>
              {children}
              <ToastViewport />
              <AnnouncerRegion />
            </PeekProvider>
          </ShellProvider>
        </CommandProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

// ─── AppShell (public export) ───────────────────────────────────────────────

export default function AppShell({ children, view: _view, onNavigate, onOpenSettings }: AppShellProps) {
  // _view is accepted but not used internally, CommandProvider receives
  // onNavigate and fires it; the current view is owned by App via useUrlState.
  // It is in the prop signature so App.tsx has a clear contract and can
  // conditionally pass data-view attributes or similar in a future iteration.
  return (
    <ThemeProvider>
      <InnerShell onNavigate={onNavigate} onOpenSettings={onOpenSettings}>
        {children}
      </InnerShell>
    </ThemeProvider>
  );
}
