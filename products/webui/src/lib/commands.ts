/**
 * Command Registry
 *
 * Central registry for all application commands. Supports registration,
 * lookup, grouped queries, and subscriber notifications for reactive UIs.
 *
 * Contract: src/lib/commands.ts
 * Cross-module API: registerCommand, getCommands, subscribeCommands
 */

export type CommandGroup =
  | 'chats'
  | 'settings'
  | 'navigation'
  | 'chat'
  | 'knowledge'
  | 'providers'
  | 'admin'
  | 'view'
  | 'system';

export interface CommandDef {
  /** Stable unique identifier, e.g. "nav.chat" */
  id: string;
  /** Display label shown in the palette */
  title: string;
  /** Logical group for palette section headers */
  group: CommandGroup;
  /** Additional search terms */
  keywords?: readonly string[];
  /** Shortcut display string, e.g. "g c" or "⌘K" */
  shortcut?: string;
  /** Execute the command */
  run: () => void;
}

type Listener = () => void;

interface CommandRegistry {
  commands: Map<string, CommandDef>;
  listeners: Set<Listener>;
}

const registry: CommandRegistry = {
  commands: new Map(),
  listeners: new Set(),
};

function notify(): void {
  registry.listeners.forEach((fn) => fn());
}

/**
 * Register a command. If a command with the same id already exists,
 * it is replaced (allows hot-reload / re-registration).
 */
export function registerCommand(def: CommandDef): void {
  registry.commands.set(def.id, def);
  notify();
}

/**
 * Unregister a previously registered command by id.
 */
export function unregisterCommand(id: string): void {
  if (registry.commands.delete(id)) {
    notify();
  }
}

/**
 * Return a snapshot of all currently registered commands,
 * ordered by group then title (recent chats keep their registration order).
 */
export function getCommands(): CommandDef[] {
  return Array.from(registry.commands.values()).sort((a, b) => {
    const gCmp = a.group.localeCompare(b.group);
    if (gCmp !== 0) return gCmp;
    // Recent chats keep their registration order (most recent first).
    if (a.group === 'chats') return 0;
    return a.title.localeCompare(b.title);
  });
}

/**
 * Subscribe to registry mutations (registrations / unregistrations).
 * Returns an unsubscribe function.
 */
export function subscribeCommands(listener: Listener): () => void {
  registry.listeners.add(listener);
  return () => {
    registry.listeners.delete(listener);
  };
}

/**
 * Fuzzy-match a list of commands against a query string.
 * Returns matching commands with a score (lower = better).
 */
export function filterCommands(commands: CommandDef[], query: string): CommandDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;

  return commands
    .map((cmd) => ({ cmd, score: scoreCommand(cmd, q) }))
    .filter(({ score }) => score < Infinity)
    .sort((a, b) => a.score - b.score)
    .map(({ cmd }) => cmd);
}

function scoreCommand(cmd: CommandDef, q: string): number {
  const title = cmd.title.toLowerCase();
  const group = cmd.group.toLowerCase();
  const keywords = (cmd.keywords ?? []).map((k) => k.toLowerCase()).join(' ');

  // Exact prefix on title, best score
  if (title.startsWith(q)) return 0;
  // Prefix on any keyword
  if (keywords.split(' ').some((k) => k.startsWith(q))) return 1;
  // Substring in title
  if (title.includes(q)) return 2;
  // Substring in group
  if (group.includes(q)) return 3;
  // Substring in keywords
  if (keywords.includes(q)) return 4;
  // Fuzzy: all chars of q appear in title in order
  if (fuzzyMatch(title, q)) return 5;
  // Fuzzy in keywords
  if (fuzzyMatch(keywords, q)) return 6;

  return Infinity;
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  let hi = 0;
  for (const ch of needle) {
    while (hi < haystack.length && haystack[hi] !== ch) hi++;
    if (hi >= haystack.length) return false;
    hi++;
  }
  return true;
}
