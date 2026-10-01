/**
 * command-groups
 *
 * Shared utilities for grouping commands by category.
 * Imported by CommandPalette and ShortcutCheatsheet to avoid duplication.
 */

import { type CommandDef } from './commands';

export interface GroupedCommands {
  group: string;
  commands: CommandDef[];
}

/** Human-readable labels for each CommandGroup value. */
export const GROUP_LABELS: Record<string, string> = {
  chats: 'Chats',
  settings: 'Settings',
  navigation: 'Go to',
  chat: 'Chat',
  knowledge: 'Knowledge',
  providers: 'Providers',
  admin: 'Admin',
  view: 'View',
  system: 'System',
};

/**
 * Group a flat list of commands by their group property,
 * preserving insertion order of groups.
 */
export function buildGroups(commands: CommandDef[]): GroupedCommands[] {
  const groupMap = new Map<string, CommandDef[]>();
  for (const cmd of commands) {
    const existing = groupMap.get(cmd.group);
    if (existing) {
      existing.push(cmd);
    } else {
      groupMap.set(cmd.group, [cmd]);
    }
  }
  return Array.from(groupMap.entries()).map(([group, cmds]) => ({
    group,
    commands: cmds,
  }));
}

/**
 * The command palette's four sections, in display order (design doc "Menus and
 * modals"): recent chats, places to go, things to do, and settings.
 */
export type PaletteSection = 'chats' | 'goto' | 'actions' | 'settings';

export const PALETTE_SECTION_ORDER: readonly PaletteSection[] = ['chats', 'goto', 'actions', 'settings'];

export const PALETTE_SECTION_LABELS: Record<PaletteSection, string> = {
  chats: 'Chats',
  goto: 'Go to',
  actions: 'Actions',
  settings: 'Settings',
};

/** Which palette section a command group belongs to. */
export function paletteSectionFor(group: string): PaletteSection {
  if (group === 'chats') return 'chats';
  if (group === 'navigation') return 'goto';
  if (group === 'settings' || group === 'providers' || group === 'admin') return 'settings';
  return 'actions';
}

export interface PaletteSectionGroup {
  section: PaletteSection;
  commands: CommandDef[];
}

/**
 * Split commands into the palette's sections in PALETTE_SECTION_ORDER, keeping
 * each section's commands in their incoming order (registry order, or match
 * score while searching). Empty sections are left out.
 */
export function buildPaletteSections(commands: readonly CommandDef[]): PaletteSectionGroup[] {
  const map = new Map<PaletteSection, CommandDef[]>();
  for (const cmd of commands) {
    const section = paletteSectionFor(cmd.group);
    const list = map.get(section);
    if (list) list.push(cmd);
    else map.set(section, [cmd]);
  }
  return PALETTE_SECTION_ORDER.filter((section) => map.has(section)).map((section) => ({
    section,
    commands: map.get(section) ?? [],
  }));
}
