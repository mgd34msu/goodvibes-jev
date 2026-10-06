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
  /** Every occurrence in this row came from saved history; separate from this update's toast policy. */
  readonly restored?: boolean;
}

const LEVEL_RANK: Readonly<Record<Notification['level'], number>> = { debug: -1, info: 0, warning: 1, critical: 2 };

/** Keep exact diagnostic text when a replay carries only part of an earlier detail. */
function mergeDetail(previous: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming || previous?.includes(incoming)) return previous;
  if (!previous || incoming.includes(previous)) return incoming;
  return `${previous}\n\n${incoming}`;
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
  /** Producer-declared occurrence shared by bus, notice and replay deliveries. */
  readonly eventKey?: string | undefined;
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
/** Rotate collapsed groups so retained occurrence identities are bounded by 2000 × 100. */
const MAX_GROUP_OCCURRENCES = 100;

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
  private nextGroupId = 1;
  /** Only the current retained group for each router batch key. */
  private readonly activeGroups = new Map<string, string>();
  private readonly eventEntries = new Map<string, string>();
  /** Notice detail outranks bus summaries; subsequent notice replays may only add detail. */
  private readonly noticeDetails = new Map<string, string>();
  private readonly restoredEvents = new Set<string>();
  /** Every member, including keyless arrivals, participates in the group's restored state. */
  private readonly groupMembers = new Map<string, Set<string | symbol>>();
  /** One retained diagnostic per occurrence in a bounded collapsed group. */
  private readonly groupDetails = new Map<string, Map<string | symbol, string>>();

  /**
   * Record a routed notification. Only notifications actually targeted at
   * `panel_only` are kept, a caller passing anything else is a mistake (the
   * router sent it elsewhere), so it's dropped rather than shown in the
   * wrong place.
   */
  record(notification: Notification, decision: RoutingDecision, eventKey?: string): void {
    if (decision.target !== 'panel_only') return;
    if (eventKey && this.foldEvent(eventKey, { level: notification.level, body: notification.body, fromNotice: false, restored: false })) return;

    const collapsing = COLLAPSING_REASON_CODES.has(decision.reasonCode) && Boolean(decision.batchKey);
    const key = collapsing ? this.groupKey(decision.batchKey!)
      : eventKey ? `event:${eventKey}` : `single:${notification.id}`;
    const previous = collapsing ? this.entries.get(key) : undefined;
    const previousCount = previous?.collapsedCount ?? 0;
    if (collapsing) {
      const members = this.groupMembers.get(key) ?? new Set<string | symbol>();
      members.add(eventKey ?? Symbol('keyless delivery'));
      this.groupMembers.set(key, members);
    }
    if (collapsing && notification.body) {
      const details = this.groupDetails.get(key) ?? new Map<string | symbol, string>();
      details.set(eventKey ?? Symbol('keyless detail'), notification.body);
      this.groupDetails.set(key, details);
    }

    const entry: NotificationFeedEntry = {
      key,
      domain: notification.domain,
      level: previous && LEVEL_RANK[previous.level] > LEVEL_RANK[notification.level] ? previous.level : notification.level,
      title: notification.title,
      body: collapsing ? this.groupBody(key) : notification.body,
      timestamp: notification.timestamp,
      reasonCode: decision.reasonCode,
      collapsedCount: previousCount + 1,
      subject: subjectOf(notification),
    };

    this.store(key, entry);
    if (eventKey) this.eventEntries.set(eventKey, key);
  }

  /**
   * Record a conversation system notice ([WRFC] …, [Agents] …, a compaction
   * receipt): its full text, one entry per notice. It toasts unless it was
   * restored from a saved session, which also counts as already seen.
   */
  recordNotice(input: NoticeInput): NotificationFeedEntry {
    if (input.eventKey) {
      const folded = this.foldEvent(input.eventKey, { level: input.level, body: input.body, fromNotice: true, restored: input.restored === true });
      if (folded) return folded;
    }
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
      restored: input.restored === true,
    };
    if (input.eventKey && input.body) this.noticeDetails.set(input.eventKey, input.body);
    if (input.restored && input.eventKey) this.restoredEvents.add(input.eventKey);
    this.store(key, entry);
    if (input.eventKey) this.eventEntries.set(input.eventKey, key);
    return entry;
  }

  /**
   * The second arrival of one runtime event: fold it into the entry the first
   * made, keeping that entry's plain title and place. The conversation line's
   * detail is the fuller one, so it becomes the body; the higher level wins;
   * a live notice remains eligible to toast; restored occurrences stay silent. A
   * collapsed group retains its count while accepting detail and severity. Returns
   * the entry, or undefined when the event has no entry yet.
   */
  private foldEvent(
    eventKey: string,
    arrival: { readonly level: Notification['level']; readonly body: string | undefined; readonly fromNotice: boolean; readonly restored: boolean },
  ): NotificationFeedEntry | undefined {
    const key = this.eventEntries.get(eventKey);
    const existing = key === undefined ? undefined : this.entries.get(key);
    if (!key || !existing) return undefined;
    if (arrival.restored) this.restoredEvents.add(eventKey);
    const eventRestored = this.restoredEvents.has(eventKey);
    const members = this.groupMembers.get(key);
    const rowRestored = members ? [...members].every((member) => typeof member === 'string' && this.restoredEvents.has(member)) : eventRestored;
    const noticeBody = arrival.fromNotice ? mergeDetail(this.noticeDetails.get(eventKey), arrival.body) : undefined;
    if (noticeBody) this.noticeDetails.set(eventKey, noticeBody);
    const details = this.groupDetails.get(key);
    if (key.startsWith('group:')) {
      const current = details ?? new Map<string | symbol, string>();
      const body = arrival.fromNotice
        ? noticeBody ?? current.get(eventKey)
        : current.get(eventKey) ?? arrival.body;
      if (body) current.set(eventKey, body);
      this.groupDetails.set(key, current);
    }
    const merged: NotificationFeedEntry = {
      ...existing,
      level: LEVEL_RANK[arrival.level] > LEVEL_RANK[existing.level] ? arrival.level : existing.level,
      body: key.startsWith('group:') ? this.groupBody(key)
        : arrival.fromNotice ? (noticeBody ?? existing.body) : (existing.body ?? arrival.body),
      restored: rowRestored,
      ...(eventRestored ? { toast: 'never' as const }
        : arrival.fromNotice && !eventRestored ? { toast: 'always' as const } : {}),
    };
    this.store(key, merged);
    return merged;
  }

  private groupBody(key: string): string | undefined {
    return [...this.groupDetails.get(key)?.values() ?? []].join('\n\n') || undefined;
  }

  private groupKey(batchKey: string): string {
    const current = this.activeGroups.get(batchKey);
    const entry = current === undefined ? undefined : this.entries.get(current);
    if (current !== undefined && entry && entry.collapsedCount < MAX_GROUP_OCCURRENCES) return current;
    const next = `group:${this.nextGroupId++}`;
    this.activeGroups.set(batchKey, next);
    return next;
  }

  private store(key: string, entry: NotificationFeedEntry): void {
    if (!this.entries.has(key)) {
      this.order.push(key);
      if (this.order.length > MAX_ENTRIES) {
        const evicted = this.order.shift();
        if (evicted !== undefined) { this.entries.delete(evicted); this.forgetEvents(evicted); }
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
    this.eventEntries.clear();
    this.noticeDetails.clear();
    this.restoredEvents.clear();
    this.groupMembers.clear();
    this.activeGroups.clear();
    this.groupDetails.clear();
    this.order = [];
    this.emitChange();
  }

  /** Remove one entry (a collapsed group goes as a whole). Returns whether it existed. */
  dismiss(key: string): boolean {
    if (!this.entries.delete(key)) return false;
    this.forgetEvents(key);
    this.order = this.order.filter((k) => k !== key);
    this.emitChange();
    return true;
  }

  private forgetEvents(entryKey: string): void {
    this.groupDetails.delete(entryKey);
    this.groupMembers.delete(entryKey);
    for (const [batchKey, owner] of this.activeGroups) if (owner === entryKey) this.activeGroups.delete(batchKey);
    for (const [eventKey, owner] of this.eventEntries) {
      if (owner !== entryKey) continue;
      this.eventEntries.delete(eventKey);
      this.noticeDetails.delete(eventKey);
      this.restoredEvents.delete(eventKey);
    }
  }

  /** Entries updated since the user last looked. */
  unreadCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (!entry.restored && entry.timestamp > this.seenThrough) n++;
    return n;
  }

  /** Whether an entry was updated since the user last looked. */
  isUnread(entry: NotificationFeedEntry): boolean {
    return !entry.restored && entry.timestamp > this.seenThrough;
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
