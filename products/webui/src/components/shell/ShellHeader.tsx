/**
 * The 48-tall header (52 on phone). Desktop: title on the left, the indicator
 * chips that must stay visible while their condition holds (sleep disabled,
 * wake-word listening, reload to update), then up to three icon buttons with
 * tooltips. Phone: menu button, title, new-chat button.
 */
import { Menu as MenuIcon, RefreshCw, Search, SquarePen } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '../ui/IconButton';
import { useHeaderSlotHost } from './HeaderSlots';

export interface ShellHeaderProps {
  title: string;
  phone: boolean;
  indicators?: ReactNode;
  onOpenDrawer: () => void;
  onNewChat: () => void;
  onSearch: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
  /** Work items that need the person; shown as a dot on the phone menu button. */
  attention?: number;
  /**
   * Leave out the palette search button: the view puts its own search in the
   * header (the chat's find button), and two magnifiers side by side would read
   * as the same control. Ctrl K and the sidebar's Search still open the palette.
   */
  hideSearch?: boolean;
}

export function ShellHeader({ title, phone, indicators, onOpenDrawer, onNewChat, onSearch, onRefresh, refreshing, attention = 0, hideSearch = false }: ShellHeaderProps) {
  const slots = useHeaderSlotHost();
  const titleClaimed = slots?.titleClaimed ?? false;
  // A view that claims the title (the chat) portals its own into the slot; the
  // plain title steps aside while it does.
  const titleArea = (
    <>
      {!titleClaimed && <h1 className="shell-header__title">{title}</h1>}
      <div className="shell-header__title-slot" ref={slots?.setTitleSlot} hidden={!titleClaimed} />
    </>
  );
  const actionsSlot = <div className="shell-header__actions-slot" ref={slots?.setActionsSlot} />;
  if (phone) {
    const needs = attention > 0 ? `, ${attention} need${attention === 1 ? 's' : ''} you` : '';
    return (
      <header className="shell-header shell-header--phone">
        <IconButton
          label={`Open navigation${needs}`}
          icon={(
            <span className="shell-nav-item__icon">
              <MenuIcon />
              {attention > 0 && <span className="shell-rail-badge shell-rail-badge--header" aria-hidden="true" />}
            </span>
          )}
          onClick={onOpenDrawer}
          noTooltip
        />
        {titleArea}
        {indicators && <div className="shell-header__indicators">{indicators}</div>}
        {actionsSlot}
        <IconButton label="New chat" icon={<SquarePen />} onClick={onNewChat} noTooltip />
      </header>
    );
  }
  return (
    <header className="shell-header">
      {titleArea}
      <div className="shell-header__end">
        {indicators && <div className="shell-header__indicators">{indicators}</div>}
        {actionsSlot}
        {!hideSearch && <IconButton label="Search" shortcut="Ctrl K" icon={<Search />} onClick={onSearch} />}
        <IconButton label="Refresh" icon={<RefreshCw />} onClick={onRefresh} disabled={refreshing} />
      </div>
    </header>
  );
}
