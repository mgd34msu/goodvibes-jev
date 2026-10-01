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
  /** Explicit server identity for a recent chat; never send its browser title. */
  judgmentSource?: { readonly kind: 'chat'; readonly sessionId: string };
  /** Local session snapshot revision. It is never sent as an authorization claim. */
  sourceRevision?: number;
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
let registryRevision = 0;

function notify(): void {
  registryRevision++;
  registry.listeners.forEach((fn) => fn());
}

/** Invalidates pending semantic results when registration or session data changes. */
export function getCommandRegistryRevision(): number { return registryRevision; }

/**
 * Register a command. If a command with the same id already exists,
 * it is replaced (allows hot-reload / re-registration).
 */
export function registerCommand(def: CommandDef): void {
  registry.commands.set(def.id, Object.freeze({ ...def,
    ...(def.keywords === undefined ? {} : { keywords: Object.freeze([...def.keywords]) }),
    ...(def.judgmentSource === undefined ? {} : { judgmentSource: Object.freeze({ ...def.judgmentSource }) }),
  }));
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
