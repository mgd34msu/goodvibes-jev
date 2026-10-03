/**
 * NotificationFeed, the notification history behind /notifications.
 *
 * Two kinds of entry land here:
 *   - every conversation system notice ([WRFC] …, [Agents] …, a compaction
 *     receipt), full text, via recordNotice (core/notices.ts). The main
 *     transcript draws no row for them; a toast shows each one and this feed
 *     keeps it reachable afterwards.
 *   - routed notifications whose `RoutingDecision.target` is `'panel_only'`,
 *     via record(); collapsed groups (reasonCode `burst_collapsed` /
 *     `batch_window_collapsed`) keep one entry per `batchKey` with an honest
 *     running count.
 *
 * The Notifications modal (input/notifications-modal.ts) shows everything
 * here; renderer/toast-center.ts toasts every notice and the warning and
 * critical routed notifications.
 */
import type { Notification, RoutingDecision } from '@/runtime/index.ts';

export interface NotificationFeedEntry {
  readonly key: string;
  readonly domain: string;
  readonly level: Notification['level'];
  readonly title: string;
  readonly body: string | undefined;
  /** Unix ms of the most recent notification folded into this entry. */
  readonly timestamp: number;
  /** The router's reason, or 'system_notice' for a conversation system notice (recordNotice). */
  readonly reasonCode: RoutingDecision['reasonCode'] | 'system_notice';
  /** How many notifications this entry represents. 1 for a standalone item; >1 for a collapsed group. Always the true count, never estimated. */
  readonly collapsedCount: number;
  /**
   * The view this notification is about (the notification's own panelId or
   * jump action, else one derived from its domain), resolved to a modal by
   * the shell (shell/notification-surfaces.ts). Undefined when it is not about
   * anything that can be opened.
   */
  readonly subject?: string;
  /**
   * Whether this entry toasts: 'always' for a system notice (every one shows
   * as a toast), 'never' for one restored from a saved session (it already
   * happened), absent for a routed notification (warning and critical toast).
   */
  readonly toast?: 'always' | 'never';
}

/** A conversation system notice to keep in the history (see recordNotice). */
export interface NoticeInput {
  readonly domain: string;
  readonly level: Notification['level'];
  readonly title: string;
  readonly body?: string | undefined;
  readonly timestamp: number;
  /** A notice restored from a saved session: kept in history, never toasted, already seen. */
  readonly restored?: boolean;
}

/** Domains whose notifications are about something the Agents modal shows. */
const AGENT_DOMAINS: ReadonlySet<string> = new Set(['agents', 'tasks', 'workflows', 'automation', 'wrfc', 'orchestration', 'plan']);

/** The view a notification is about, or undefined. */
function subjectOf(notification: Notification): string | undefined {
  if (notification.panelId) return notification.panelId;
  if (notification.action?.type === 'jump_to_panel' && notification.action.panelId) return notification.action.panelId;
  if (AGENT_DOMAINS.has(notification.domain)) return 'agents';
  if (notification.domain === 'security') return 'security';
  if (notification.domain === 'git') return 'changes';
  return undefined;
}

/**
 * Entries kept before the oldest leave. System notices share this bound, so a
 * long session's full notice history stays reachable in the modal.
 */
const MAX_ENTRIES = 2000;

/** Reason codes whose notifications fold into one running-count entry per batch key, rather than one entry per occurrence. */
const COLLAPSING_REASON_CODES: ReadonlySet<RoutingDecision['reasonCode']> = new Set([
  'burst_collapsed',
  'batch_window_collapsed',
]);

export class NotificationFeed {
  private readonly entries = new Map<string, NotificationFeedEntry>();
  /** Insertion order of `entries` keys (oldest first), for bounded eviction. */
  private order: string[] = [];
  private readonly listeners = new Set<() => void>();
  /** Unix ms of the newest entry the user has seen in the Notifications modal. */
  private seenThrough = 0;
  private nextNoticeId = 1;

  /**
   * Record a routed notification. Only notifications actually targeted at
   * `panel_only` are kept, a caller passing anything else is a mistake (the
   * router sent it elsewhere), so it's dropped rather than shown in the
   * wrong place.
   */
  record(notification: Notification, decision: RoutingDecision): void {
    if (decision.target !== 'panel_only') return;

    const collapsing = COLLAPSING_REASON_CODES.has(decision.reasonCode) && Boolean(decision.batchKey);
    const key = collapsing ? `group:${decision.batchKey}` : `single:${notification.id}`;
    const previousCount = collapsing ? (this.entries.get(key)?.collapsedCount ?? 0) : 0;

    const entry: NotificationFeedEntry = {
      key,
      domain: notification.domain,
      level: notification.level,
      title: notification.title,
      body: notification.body,
      timestamp: notification.timestamp,
      reasonCode: decision.reasonCode,
      collapsedCount: previousCount + 1,
      subject: subjectOf(notification),
    };

    this.store(key, entry);
  }

  /**
   * Record a conversation system notice ([WRFC] …, [Agents] …, a compaction
   * receipt): its full text, one entry per notice. It toasts unless it was
   * restored from a saved session, which also counts as already seen.
   */
  recordNotice(input: NoticeInput): NotificationFeedEntry {
    const key = `notice:${this.nextNoticeId++}`;
    const entry: NotificationFeedEntry = {
      key,
      domain: input.domain,
      level: input.level,
      title: input.title,
      body: input.body,
      timestamp: input.timestamp,
      reasonCode: 'system_notice',
      collapsedCount: 1,
      subject: AGENT_DOMAINS.has(input.domain) ? 'agents' : undefined,
      toast: input.restored ? 'never' : 'always',
    };
    if (input.restored) this.seenThrough = Math.max(this.seenThrough, input.timestamp);
    this.store(key, entry);
    return entry;
  }

  private store(key: string, entry: NotificationFeedEntry): void {
    if (!this.entries.has(key)) {
      this.order.push(key);
      if (this.order.length > MAX_ENTRIES) {
        const evicted = this.order.shift();
        if (evicted !== undefined) this.entries.delete(evicted);
      }
    }
    this.entries.set(key, entry);
    this.emitChange();
  }

  /** Every entry, most recently updated first. */
  list(): readonly NotificationFeedEntry[] {
    const items: NotificationFeedEntry[] = [];
    for (const key of this.order) {
      const entry = this.entries.get(key);
      if (entry) items.push(entry);
    }
    return items.reverse();
  }

  clear(): void {
    this.entries.clear();
    this.order = [];
    this.emitChange();
  }

  /** Remove one entry (a collapsed group goes as a whole). Returns whether it existed. */
  dismiss(key: string): boolean {
    if (!this.entries.delete(key)) return false;
    this.order = this.order.filter((k) => k !== key);
    this.emitChange();
    return true;
  }

  /** Entries updated since the user last looked. */
  unreadCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.timestamp > this.seenThrough) n++;
    return n;
  }

  /** Whether an entry was updated since the user last looked. */
  isUnread(entry: NotificationFeedEntry): boolean {
    return entry.timestamp > this.seenThrough;
  }

  /** Everything recorded so far counts as seen. */
  markAllSeen(): void {
    for (const entry of this.entries.values()) this.seenThrough = Math.max(this.seenThrough, entry.timestamp);
  }

  /** Subscribe to feed changes (e.g. to repaint an open modal). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

let sharedFeed: NotificationFeed | null = null;

/**
 * The process-wide `panel_only` feed. Lazily created so the running app has
 * exactly one feed that every caller and the Notifications modal agree
 * on, while tests construct their own isolated `NotificationFeed`
 * instance instead of reaching for this one.
 */
export function getSharedNotificationFeed(): NotificationFeed {
  if (!sharedFeed) sharedFeed = new NotificationFeed();
  return sharedFeed;
}
