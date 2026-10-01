/**
 * CommandPalette (Ctrl K), design doc "Menus and modals": 640 wide glass over the
 * scrim, a search field on top, results grouped Chats / Go to / Actions /
 * Settings. On a phone it is a full-height sheet.
 *
 * Keyboard: Up and Down (or Tab and Shift Tab) move, Enter runs, Escape closes the
 * palette and nothing else. Focus stays in the search field (the options are an
 * aria-activedescendant listbox), is trapped inside the palette, and returns to
 * whatever held it before the palette opened.
 */
import { ArrowRight, CornerDownLeft, MessageSquare, Search, Settings, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { type CommandDef, filterCommands, getCommands, subscribeCommands } from '../../lib/commands';
import {
  buildPaletteSections,
  PALETTE_SECTION_LABELS,
  type PaletteSection,
} from '../../lib/command-groups';
import { PHONE_QUERY, useMediaQuery, useModalFocus, useOverlayLayer, useTopLayerEscape } from '../ui/overlay';
import '../../styles/components/command.css';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const SECTION_ICONS: Record<PaletteSection, ReactNode> = {
  chats: <MessageSquare aria-hidden="true" />,
  goto: <ArrowRight aria-hidden="true" />,
  actions: <Zap aria-hidden="true" />,
  settings: <Settings aria-hidden="true" />,
};

/** "mod+shift+n" → "Ctrl Shift N"; "g c" → "G then C". */
export function formatShortcut(shortcut: string): string {
  const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '');
  if (shortcut.includes(' ') && !shortcut.includes('+')) {
    return shortcut.split(' ').map((part) => part.toUpperCase()).join(' then ');
  }
  return shortcut
    .split('+')
    .map((part) => {
      if (part === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (part === 'shift') return 'Shift';
      if (part === 'alt') return isMac ? '⌥' : 'Alt';
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(' ');
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [allCommands, setAllCommands] = useState<CommandDef[]>(() => getCommands());
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  useModalFocus(open, panelRef, inputRef);
  const isTop = useOverlayLayer(open);
  useTopLayerEscape(open, isTop, onClose);

  useEffect(() => subscribeCommands(() => setAllCommands(getCommands())), []);

  // Every open starts from an empty search on the first result.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const sections = useMemo(() => buildPaletteSections(filterCommands(allCommands, query)), [allCommands, query]);
  // The keyboard order is the on-screen order: section by section.
  const ordered = useMemo(() => sections.flatMap((group) => group.commands), [sections]);
  // Each command's keyboard position, so a row knows whether it is the active one.
  const orderIndex = useMemo(() => new Map(ordered.map((cmd, index) => [cmd, index])), [ordered]);

  useEffect(() => {
    if (activeIndex >= ordered.length) setActiveIndex(Math.max(0, ordered.length - 1));
  }, [ordered.length, activeIndex]);

  useEffect(() => {
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    if (active && typeof (active as HTMLElement).scrollIntoView === 'function') {
      (active as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const runCommand = useCallback(
    (cmd: CommandDef) => {
      onClose();
      cmd.run();
    },
    [onClose],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'Escape':
          // Closes the palette only: never reaches the view (a running turn) below.
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, ordered.length - 1));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        case 'Home':
          if (event.target === inputRef.current && query) return;
          event.preventDefault();
          setActiveIndex(0);
          return;
        case 'End':
          if (event.target === inputRef.current && query) return;
          event.preventDefault();
          setActiveIndex(Math.max(0, ordered.length - 1));
          return;
        case 'Enter': {
          event.preventDefault();
          const cmd = ordered[activeIndex];
          if (cmd) runCommand(cmd);
          return;
        }
        case 'Tab':
          // Focus stays in the search field; Tab steps through the results.
          event.preventDefault();
          setActiveIndex((i) => (event.shiftKey ? Math.max(i - 1, 0) : Math.min(i + 1, ordered.length - 1)));
          return;
        default:
      }
    },
    [activeIndex, ordered, onClose, query, runCommand],
  );

  if (!open || typeof document === 'undefined') return null;

  const activeCommand = ordered[activeIndex];

  return createPortal(
    <div className="gv-overlay cmd-overlay" data-gv-layer="">
      <div className="scrim" role="presentation" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className={['glass', 'cmd-palette', phone ? 'cmd-palette--sheet' : ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {phone && <div className="gv-sheet__grabber" aria-hidden="true" />}
        <div className="cmd-search">
          <Search className="cmd-search__icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmd-input"
            type="text"
            placeholder="Search chats, places, actions and settings"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-controls="cmd-listbox"
            aria-activedescendant={activeCommand ? `cmd-item-${activeCommand.id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {phone && (
            <button type="button" className="cmd-search__cancel" onClick={onClose}>
              Cancel
            </button>
          )}
        </div>

        {ordered.length === 0 ? (
          <p className="cmd-empty" role="status">No results for “{query.trim()}”</p>
        ) : (
          <div ref={listRef} id="cmd-listbox" className="cmd-list" role="listbox" aria-label="Commands">
            {sections.map(({ section, commands }) => (
              <div key={section} className="cmd-group" role="group" aria-labelledby={`cmd-group-label-${section}`}>
                <div id={`cmd-group-label-${section}`} className="cmd-group-label" role="presentation">
                  {PALETTE_SECTION_LABELS[section]}
                </div>
                {commands.map((cmd) => {
                  const index = orderIndex.get(cmd) ?? -1;
                  const isActive = index === activeIndex;
                  return (
                    <div
                      key={cmd.id}
                      id={`cmd-item-${cmd.id}`}
                      className={isActive ? 'cmd-item cmd-item--active' : 'cmd-item'}
                      role="option"
                      aria-selected={isActive}
                      onClick={() => runCommand(cmd)}
                      onMouseMove={() => {
                        if (!isActive) setActiveIndex(index);
                      }}
                    >
                      <span className="cmd-item-icon">{SECTION_ICONS[section]}</span>
                      <span className="cmd-item-title">{cmd.title}</span>
                      {cmd.shortcut && !phone && <kbd className="cmd-item-kbd">{formatShortcut(cmd.shortcut)}</kbd>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {!phone && (
          <div className="cmd-footer" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
            <span><kbd><CornerDownLeft /></kbd> to open</span>
            <span><kbd>Esc</kbd> to close</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
