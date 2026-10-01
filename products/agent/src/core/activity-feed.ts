/**
 * ActivityFeed, the single ambient record of what the assistant has been doing.
 *
 * The sink for operational traffic (model switches, provider discovery, delivery results,
 * background work updates). The Activity modal renders the most recent
 * entries; high-priority messages additionally land in the conversation via
 * SystemMessageRouter.
 *
 * Design rules:
 * - Append-only ring buffer (oldest entries dropped past MAX_ENTRIES).
 * - No focus, no selection, no scrolling state, this is a glanceable feed,
 *   not an interactive widget. History beyond the visible window is available
 *   through the conversation (high priority) and logs.
 * - Subscribers are render invalidators only; they receive no payload.
 */

export type ActivityKind =
  | 'status'     // runtime/system state changes (model switch, session save)
  | 'tool'       // tool activity worth surfacing
  | 'agent'      // background agent/delegation updates
  | 'schedule'   // scheduled/automation work
  | 'delivery'   // channel deliveries (ntfy, Slack, …)
  | 'security'   // permission/trust events
  | 'system';    // everything else

export type ActivityPriority = 'high' | 'low';

export interface ActivityEntry {
  readonly at: number;
  readonly kind: ActivityKind;
  readonly priority: ActivityPriority;
  readonly text: string;
}

const MAX_ENTRIES = 500;

/** Map a bracket-tagged system message (e.g. "[Model] …") to an ActivityKind. */
export function classifyActivityKind(text: string): ActivityKind {
  const tag = /^\[([^\]]+)\]/.exec(text)?.[1]?.toLowerCase() ?? '';
  if (/(schedule|automation|routine|reminder|watcher)/.test(tag)) return 'schedule';
  if (/(channel|delivery|notify|ntfy|message)/.test(tag)) return 'delivery';
  if (/(agent|delegat|task)/.test(tag)) return 'agent';
  if (/(permission|security|trust|secret)/.test(tag)) return 'security';
  if (/(tool|mcp)/.test(tag)) return 'tool';
  if (/(model|provider|session|memory|recovery|compaction|config|setting)/.test(tag)) return 'status';
  return 'system';
}

export class ActivityFeed {
  private entries: ActivityEntry[] = [];
  private listeners = new Set<() => void>();

  push(text: string, priority: ActivityPriority = 'low', kind?: ActivityKind): void {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    this.entries.push({
      at: Date.now(),
      kind: kind ?? classifyActivityKind(trimmed),
      priority,
      text: trimmed,
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.notify();
  }

  /** Most recent entries, newest first. */
  latest(limit: number): readonly ActivityEntry[] {
    if (limit <= 0) return [];
    return this.entries.slice(-limit).reverse();
  }

  all(): readonly ActivityEntry[] {
    return this.entries;
  }

  get count(): number {
    return this.entries.length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Render invalidators must never break the feed.
      }
    }
  }
}
