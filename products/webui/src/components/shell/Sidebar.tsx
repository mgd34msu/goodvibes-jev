/**
 * The sidebar (design doc "App shell" and "Sidebar auto-collapse").
 *
 * Expanded: 260 wide (resizable 220 to 360), brand with spark and wordmark, a
 * pin and the collapse button in its header, New chat, Search (Ctrl K), Work,
 * Library, Personal, the "Recent" chat list, and the account button (44 tall)
 * at the foot. Nav items are 32 tall, 8 radius, 16 icons, no subtitles.
 *
 * Rail: 56 wide, spark, the destinations as icon buttons with tooltips, the
 * account avatar at the bottom. Hovering it for 300 ms (or Ctrl B while a right
 * panel holds it) slides the full sidebar over the content as glass.
 *
 * Drawer: the same content inside the phone drawer.
 */
import {
  CalendarDays,
  LayoutGrid,
  LibraryBig,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { ViewId } from '../../lib/router';
import { Tooltip } from '../ui/Tooltip';
import { IconButton } from '../ui/IconButton';
import { AccountMenu, type HealthSummary } from './AccountMenu';
import { DESTINATIONS, destinationOf, type DestinationId } from './nav';
import { Spark } from './Spark';
import {
  HOVER_PEEK_DELAY_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useShell,
} from './ShellContext';

export interface RecentChat {
  id: string;
  title: string;
}

export interface SidebarProps {
  view: ViewId;
  activeChatId: string;
  /** True while a new chat draft is open (New chat reads as current). */
  draftChat: boolean;
  recentChats: readonly RecentChat[];
  deletingChatId: string | null;
  workAttention: number;
  accountName: string;
  health: HealthSummary;
  onNavigate: (view: ViewId) => void;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string, title: string) => void;
  onSearch: () => void;
  onSignOut: () => void;
  /** Open the settings dialog, on a section when one is named. */
  onOpenSettings: (section?: string) => void;
}

const DESTINATION_ICONS: Record<Exclude<DestinationId, 'chat' | 'account'>, ReactNode> = {
  work: <LayoutGrid aria-hidden="true" />,
  library: <LibraryBig aria-hidden="true" />,
  personal: <CalendarDays aria-hidden="true" />,
};

interface NavItemProps {
  icon: ReactNode;
  label: string;
  current?: boolean;
  compact: boolean;
  trailing?: ReactNode;
  ariaLabel?: string;
  shortcut?: string;
  onClick: () => void;
}

function NavItem({ icon, label, current = false, compact, trailing, ariaLabel, shortcut, onClick }: NavItemProps) {
  const button = (
    <button
      type="button"
      className={compact ? 'shell-nav-item shell-nav-item--icon' : 'shell-nav-item'}
      aria-current={current ? 'page' : undefined}
      aria-label={ariaLabel ?? (compact ? label : undefined)}
      onClick={onClick}
    >
      {icon}
      {!compact && <span className="shell-nav-item__label">{label}</span>}
      {trailing}
    </button>
  );
  if (!compact) return button;
  return <Tooltip content={label} shortcut={shortcut} placement="right" labelOnly>{button}</Tooltip>;
}

export function SidebarContent({
  variant,
  view,
  activeChatId,
  draftChat,
  recentChats,
  deletingChatId,
  workAttention,
  accountName,
  health,
  onNavigate,
  onNewChat,
  onOpenChat,
  onDeleteChat,
  onSearch,
  onSignOut,
  onOpenSettings,
}: SidebarProps & { variant: 'expanded' | 'rail' | 'drawer' }) {
  const shell = useShell();
  const compact = variant === 'rail';
  const current = destinationOf(view);

  return (
    <div className={`shell-sidebar__inner shell-sidebar__inner--${variant}`}>
      <div className="shell-brand">
        {compact ? (
          <IconButton
            label="Expand sidebar"
            shortcut="Ctrl B"
            tooltipPlacement="right"
            className="shell-brand__rail-button"
            icon={<Spark size={18} />}
            onClick={shell.toggleSidebar}
          />
        ) : (
          <>
            <span className="shell-brand__mark"><Spark size={18} /></span>
            <span className="shell-brand__word">GoodVibes</span>
            {variant === 'expanded' && (
              <span className="shell-brand__tools">
                <IconButton
                  label={shell.pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
                  aria-pressed={shell.pinned}
                  icon={shell.pinned ? <PinOff /> : <Pin />}
                  onClick={() => shell.setPinned(!shell.pinned)}
                />
                <IconButton
                  label={shell.peek ? 'Close sidebar' : 'Collapse sidebar'}
                  shortcut="Ctrl B"
                  icon={shell.peek ? <PanelLeftOpen /> : <PanelLeftClose />}
                  onClick={shell.peek ? () => shell.setPeek(false) : shell.toggleSidebar}
                />
              </span>
            )}
          </>
        )}
      </div>

      <nav className="shell-nav" aria-label="Primary">
        <NavItem
          icon={<Plus aria-hidden="true" />}
          label="New chat"
          compact={compact}
          current={view === 'chat' && draftChat}
          onClick={onNewChat}
        />
        <NavItem
          icon={<Search aria-hidden="true" />}
          label="Search"
          compact={compact}
          shortcut="Ctrl K"
          trailing={compact ? undefined : <span className="gv-kbd">Ctrl K</span>}
          onClick={onSearch}
        />
        {DESTINATIONS.map((destination) => {
          const attention = destination.id === 'work' ? workAttention : 0;
          const shown = attention > 99 ? '99+' : String(attention);
          return (
            <NavItem
              key={destination.id}
              icon={
                <span className="shell-nav-item__icon">
                  {DESTINATION_ICONS[destination.id]}
                  {compact && attention > 0 && <span className="shell-rail-badge" aria-hidden="true" />}
                </span>
              }
              label={destination.label}
              compact={compact}
              current={current === destination.id}
              ariaLabel={attention > 0
                ? `${destination.label}, ${attention} need${attention === 1 ? 's' : ''} you`
                : undefined}
              trailing={!compact && attention > 0
                ? (
                  <span className="gv-chip gv-chip--sm shell-nav-item__count" aria-hidden="true">
                    <span className="gv-dot gv-dot--warn" />
                    {shown}
                  </span>
                )
                : undefined}
              onClick={() => onNavigate(destination.view)}
            />
          );
        })}
      </nav>

      {!compact && (
        <section className="shell-recent" aria-labelledby="shell-recent-label">
          <h2 id="shell-recent-label" className="shell-group-label">Recent</h2>
          {recentChats.length === 0 ? (
            <p className="shell-recent__empty">Chats you start appear here.</p>
          ) : (
            <ul className="shell-recent__list">
              {recentChats.map((chat) => {
                const active = view === 'chat' && !draftChat && chat.id === activeChatId;
                const deleting = deletingChatId === chat.id;
                return (
                  <li key={chat.id} className="shell-recent__row" data-active={active || undefined}>
                    <button
                      type="button"
                      className="shell-nav-item shell-recent__open"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => onOpenChat(chat.id)}
                    >
                      <span className="shell-nav-item__label">{chat.title}</span>
                    </button>
                    <IconButton
                      size="sm"
                      className="shell-recent__delete"
                      label={deleting ? 'Deleting…' : `Delete ${chat.title} permanently`}
                      icon={<Trash2 />}
                      disabled={deletingChatId !== null}
                      tooltipPlacement="right"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteChat(chat.id, chat.title);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <div className="shell-sidebar__foot">
        <AccountMenu
          name={accountName}
          health={health}
          compact={compact}
          onOpenSettings={onOpenSettings}
          onSignOut={onSignOut}
        />
      </div>
    </div>
  );
}

/** Keyboard and pointer resize handle on the sidebar's right edge (220 to 360). */
function ResizeHandle() {
  const shell = useShell();
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    start.current = { x: event.clientX, width: shell.width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    shell.setWidth(start.current.width + (event.clientX - start.current.x));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); shell.setWidth(shell.width - 16); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); shell.setWidth(shell.width + 16); }
    else if (event.key === 'Home') { event.preventDefault(); shell.setWidth(SIDEBAR_MIN_WIDTH); }
    else if (event.key === 'End') { event.preventDefault(); shell.setWidth(SIDEBAR_MAX_WIDTH); }
  };

  return (
    <div
      className="shell-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={shell.width}
      // A focusable separator with a value is the WAI-ARIA window splitter, an
      // interactive widget; jsx-a11y classes every separator as static.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- APG window-splitter pattern
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}

/** The desktop sidebar: expanded column, or the rail with its hover peek. */
export function Sidebar(props: SidebarProps) {
  const shell = useShell();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rail = shell.mode === 'rail';
  const peeking = rail && shell.peek;

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const cancelHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };

  return (
    <aside
      className="shell-sidebar"
      data-form={peeking ? 'peek' : rail ? 'rail' : 'expanded'}
      aria-label="Sidebar"
      style={{ width: rail && !peeking ? undefined : shell.width }}
      onMouseEnter={() => {
        if (!rail || peeking) return;
        cancelHover();
        hoverTimer.current = setTimeout(() => shell.setPeek(true), HOVER_PEEK_DELAY_MS);
      }}
      onMouseLeave={() => {
        cancelHover();
        if (peeking) shell.setPeek(false);
      }}
      onKeyDown={(event) => {
        if (peeking && event.key === 'Escape') {
          event.stopPropagation();
          shell.setPeek(false);
        }
      }}
      onBlur={(event) => {
        if (!peeking) return;
        const next = event.relatedTarget as Node | null;
        const inLayer = next instanceof HTMLElement && next.closest('[data-gv-layer]');
        if (next && !event.currentTarget.contains(next) && !inLayer) shell.setPeek(false);
      }}
    >
      <SidebarContent {...props} variant={peeking ? 'expanded' : rail ? 'rail' : 'expanded'} />
      {!rail && <ResizeHandle />}
    </aside>
  );
}
