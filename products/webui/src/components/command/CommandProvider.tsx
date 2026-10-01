/**
 * CommandProvider
 *
 * Mounts the CommandPalette and ShortcutCheatsheet, wires ⌘K / ? hotkeys,
 * and registers the default navigation commands.
 *
 * Integration phase usage:
 *   import CommandProvider from './components/command/CommandProvider';
 *   // In App.tsx (or shell wrapper), wrap children:
 *   <CommandProvider onNavigate={setActiveView}>
 *     {children}
 *   </CommandProvider>
 *
 * Or, if you just want to mount the command system at root without wrapping:
 *   <CommandProvider onNavigate={setActiveView} />
 *
 * onNavigate receives a view id ('chat', 'work', 'library', 'personal'), an
 * optional tab of that destination, and an optional newChat boolean for the
 * "New chat" command. onOpenSettings opens the
 * settings dialog, on a section when one is named ('models' for the old
 * "Go to Providers", 'account' for the old "Go to Admin").
 */

import { useCallback, useEffect, useState } from 'react';
import '../../styles/components/command.css';
import { registerCommand, unregisterCommand } from '../../lib/commands';
import { SETTINGS_SECTIONS } from '../settings/dialog/sections';
import { useHotkeys } from '../../hooks/useHotkeys';
import { CommandPalette } from './CommandPalette';
import { ShortcutCheatsheet } from './ShortcutCheatsheet';

export type ViewId = 'chat' | 'work' | 'library' | 'personal';

interface CommandProviderProps {
  /**
   * Called when a navigation command fires.
   * Integration phase wires this to App's setActiveView.
   */
  onNavigate?: (view: ViewId, options?: { newChat?: boolean; tab?: string }) => void;
  /** Open the settings dialog, on a section when one is named. */
  onOpenSettings?: (section?: string) => void;
  children?: React.ReactNode;
}

export default function CommandProvider({ onNavigate, onOpenSettings, children }: CommandProviderProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openCheatsheet = useCallback(() => setCheatsheetOpen(true), []);
  const closeCheatsheet = useCallback(() => setCheatsheetOpen(false), []);

  // Register default navigation commands
  useEffect(() => {
    registerCommand({
      id: 'nav.chat',
      title: 'Go to Chat',
      group: 'navigation',
      keywords: ['chat', 'messages', 'live'],
      shortcut: 'g c',
      run: () => onNavigate?.('chat'),
    });
    registerCommand({
      id: 'nav.knowledge',
      title: 'Go to Knowledge',
      group: 'navigation',
      keywords: ['knowledge', 'wiki', 'docs'],
      shortcut: 'g k',
      run: () => onNavigate?.('library', { tab: 'knowledge' }),
    });
    registerCommand({
      id: 'nav.work',
      title: 'Go to Work',
      group: 'navigation',
      keywords: ['work', 'sessions', 'agents', 'processes', 'fleet', 'approvals', 'needs you', 'checkpoints', 'ci'],
      shortcut: 'g w',
      run: () => onNavigate?.('work'),
    });
    registerCommand({
      id: 'nav.library',
      title: 'Go to Library',
      group: 'navigation',
      keywords: ['library', 'memory', 'knowledge', 'review'],
      shortcut: 'g l',
      run: () => onNavigate?.('library'),
    });
    registerCommand({
      id: 'nav.personal',
      title: 'Go to Personal',
      group: 'navigation',
      keywords: ['personal', 'calendar', 'mail', 'occasions', 'dates'],
      shortcut: 'g o',
      run: () => onNavigate?.('personal'),
    });
    registerCommand({
      id: 'nav.providers',
      title: 'Models and providers',
      group: 'settings',
      keywords: ['providers', 'models', 'llm', 'ai', 'settings'],
      shortcut: 'g p',
      run: () => onOpenSettings?.('models'),
    });
    registerCommand({
      id: 'nav.admin',
      title: 'Open settings',
      group: 'settings',
      keywords: ['admin', 'settings', 'auth', 'account', 'preferences'],
      shortcut: 'mod+,',
      run: () => onOpenSettings?.(),
    });
    registerCommand({
      id: 'chat.new',
      title: 'New Chat',
      group: 'chat',
      keywords: ['new', 'create', 'session'],
      shortcut: 'mod+shift+n',
      run: () => onNavigate?.('chat', { newChat: true }),
    });
    registerCommand({
      id: 'system.palette',
      title: 'Open Command Palette',
      group: 'system',
      keywords: ['command', 'palette', 'search'],
      shortcut: 'mod+k',
      run: openPalette,
    });
    registerCommand({
      id: 'system.shortcuts',
      title: 'Show Keyboard Shortcuts',
      group: 'system',
      keywords: ['shortcuts', 'hotkeys', 'help', 'cheatsheet'],
      shortcut: '?',
      run: openCheatsheet,
    });
    // Every other settings section is one command in the palette's Settings group
    // ("Models and providers" is nav.providers above).
    const sectionIds: string[] = [];
    for (const section of SETTINGS_SECTIONS) {
      if (section.id === 'models') continue;
      const id = `settings.${section.id}`;
      sectionIds.push(id);
      registerCommand({
        id,
        title: section.label,
        group: 'settings',
        keywords: ['settings', ...section.keywords],
        run: () => onOpenSettings?.(section.id),
      });
    }

    return () => {
      for (const id of sectionIds) unregisterCommand(id);
      unregisterCommand('nav.chat');
      unregisterCommand('nav.knowledge');
      unregisterCommand('nav.work');
      unregisterCommand('nav.library');
      unregisterCommand('nav.personal');
      unregisterCommand('nav.providers');
      unregisterCommand('nav.admin');
      unregisterCommand('chat.new');
      unregisterCommand('system.palette');
      unregisterCommand('system.shortcuts');
    };
  }, [onNavigate, onOpenSettings, openPalette, openCheatsheet]);

  // Global hotkeys
  useHotkeys([
    {
      combo: 'mod+k',
      handler: () => setPaletteOpen((open) => !open),
      // Must fire even when the palette's own search input is focused (toggle/close)
      allowInInput: true,
    },
    {
      combo: '?',
      handler: () => setCheatsheetOpen((open) => !open),
    },
    // NOTE: Escape is intentionally NOT registered here globally.
    // Each overlay (CommandPalette, ShortcutCheatsheet) owns its own Escape
    // handler via onKeyDown so dismiss logic stays within the overlay's
    // event chain and does not interfere with other Escape consumers.
    // Sequence nav shortcuts
    { combo: 'g c', handler: () => { onNavigate?.('chat'); } },
    { combo: 'g k', handler: () => { onNavigate?.('library', { tab: 'knowledge' }); } },
    { combo: 'g w', handler: () => { onNavigate?.('work'); } },
    { combo: 'g l', handler: () => { onNavigate?.('library'); } },
    { combo: 'g o', handler: () => { onNavigate?.('personal'); } },
    { combo: 'g p', handler: () => { onOpenSettings?.('models'); } },
    { combo: 'g a', handler: () => { onOpenSettings?.('account'); } },
    {
      combo: 'mod+shift+n',
      handler: () => { onNavigate?.('chat', { newChat: true }); },
      allowInInput: true,
    },
  ]);

  return (
    <>
      {children}
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      <ShortcutCheatsheet open={cheatsheetOpen} onClose={closeCheatsheet} />
    </>
  );
}
