/**
 * The app shell layout: sidebar (expanded, rail or phone drawer), the header,
 * connection and live-update banners, and the content frame.
 *
 * Connection loss raises a toast and a thin banner (design doc "App shell":
 * the status strip is removed; problems raise a toast and a banner). The
 * connection itself lives on the avatar dot and in the account menu.
 */
import { WifiOff } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { useHotkeys } from '../../hooks/useHotkeys';
import { useOptionalToast } from '../../lib/toast';
import { usePeek } from '../peek/PeekPanel';
import { Drawer } from '../ui/Drawer';
import { connectionPhrase, type HealthSummary } from './AccountMenu';
import { ShellHeader } from './ShellHeader';
import { HeaderSlotsProvider } from './HeaderSlots';
import { Sidebar, SidebarContent, type SidebarProps } from './Sidebar';
import { useShell } from './ShellContext';
import '../../styles/components/shell.css';
import '../../styles/components/data-view.css';

export interface ShellLayoutProps extends SidebarProps {
  title: string;
  health: HealthSummary;
  /** Chips shown in the header while their condition holds. */
  indicators?: ReactNode;
  /** Page-level banners (live updates paused, a failed delete). */
  banners?: ReactNode;
  onRefresh: () => void;
  refreshing?: boolean;
  /** The workspace is behind the daemon-unreachable gate. */
  inert?: boolean;
  children: ReactNode;
}

const EDGE_SWIPE_ZONE = 20;
const EDGE_SWIPE_DISTANCE = 48;

function useConnectionNotices(connection: HealthSummary['connection']): boolean {
  const toastApi = useOptionalToast();
  const toastRef = useRef(toastApi);
  useLayoutEffect(() => {
    toastRef.current = toastApi;
  });
  const [hasConnected, setHasConnected] = useState(false);
  const lost = useRef(false);
  const previous = useRef(connection);

  useEffect(() => {
    const before = previous.current;
    previous.current = connection;
    if (connection === 'connected') {
      if (lost.current) toastRef.current?.toast({ tone: 'success', title: 'Reconnected to your daemon' });
      lost.current = false;
      setHasConnected(true);
      return;
    }
    if (before === 'connected' && !lost.current) {
      lost.current = true;
      toastRef.current?.toast({
        tone: 'warning',
        title: connection === 'down' ? 'Lost the connection to your daemon' : 'Connection to your daemon dropped, reconnecting',
      });
    }
  }, [connection]);

  return hasConnected && connection !== 'connected';
}

export function ShellLayout({
  title,
  health,
  indicators,
  banners,
  onRefresh,
  refreshing,
  inert,
  children,
  ...sidebar
}: ShellLayoutProps) {
  const shell = useShell();
  const phone = shell.mode === 'drawer';
  const connectionLost = useConnectionNotices(health.connection);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const peek = usePeek();
  const closePeek = peek.close;

  // A detail belongs to the view that opened it: leaving the view closes it (and
  // so releases the rail).
  useEffect(() => {
    closePeek();
  }, [sidebar.view, closePeek]);

  useHotkeys([
    {
      combo: 'mod+,',
      handler: (event) => {
        event.preventDefault();
        sidebar.onOpenSettings();
      },
      allowInInput: true,
    },
  ]);

  const closeDrawerThen = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    shell.closeDrawer();
    fn(...args);
  };

  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (!phone || shell.drawerOpen) return;
    const touch = event.touches[0];
    swipe.current = touch.clientX <= EDGE_SWIPE_ZONE ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    if (!swipe.current) return;
    const touch = event.touches[0];
    const dx = touch.clientX - swipe.current.x;
    const dy = Math.abs(touch.clientY - swipe.current.y);
    if (dx > EDGE_SWIPE_DISTANCE && dy < 40) {
      swipe.current = null;
      shell.openDrawer();
    }
  };

  return (
    <div
      className="app-shell"
      data-sidebar={shell.mode}
      data-view={sidebar.view}
      inert={inert ? true : undefined}
      aria-hidden={inert ? true : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={() => { swipe.current = null; }}
    >
      {!phone && (
        <div className="shell-sidebar-slot" style={{ width: shell.layoutWidth }}>
          <Sidebar {...sidebar} health={health} />
        </div>
      )}
      {phone && (
        <Drawer
          open={shell.drawerOpen}
          onClose={shell.closeDrawer}
          side="left"
          label="Navigation"
          header={false}
          width="85%"
          className="shell-drawer"
        >
          <SidebarContent
            {...sidebar}
            health={health}
            variant="drawer"
            onNavigate={closeDrawerThen(sidebar.onNavigate)}
            onNewChat={closeDrawerThen(sidebar.onNewChat)}
            onOpenChat={closeDrawerThen(sidebar.onOpenChat)}
            onSearch={closeDrawerThen(sidebar.onSearch)}
            onOpenSettings={closeDrawerThen(sidebar.onOpenSettings)}
          />
        </Drawer>
      )}
      <HeaderSlotsProvider>
      <main className="shell-main" data-view={sidebar.view}>
        <ShellHeader
          title={title}
          phone={phone}
          indicators={indicators}
          onOpenDrawer={shell.openDrawer}
          onNewChat={sidebar.onNewChat}
          onSearch={sidebar.onSearch}
          onRefresh={onRefresh}
          refreshing={refreshing}
          attention={sidebar.workAttention}
          hideSearch={sidebar.view === 'chat'}
        />
        {connectionLost && (
          <div className="banner warning shell-connection-banner" role="status">
            <WifiOff size={14} aria-hidden="true" />
            <span>{connectionPhrase(health)}. Your work stays here; it picks up when the daemon answers.</span>
          </div>
        )}
        {banners}
        <section className="view-frame">
          {/* The frame scrolls; the body is content-sized, so a view's `height: 100%`
              resolves to its content (as it always has) rather than being squeezed
              into whatever the header and banners leave. Chat alone fills the frame. */}
          <div className="view-frame__body">{children}</div>
        </section>
      </main>
      </HeaderSlotsProvider>
    </div>
  );
}
