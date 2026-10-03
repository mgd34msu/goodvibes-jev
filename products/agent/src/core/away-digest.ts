/**
 * Away digest, a friendly "while you were away" summary shown once at launch.
 *
 * This module is intentionally pure: buildAwayDigest() takes a plain snapshot
 * object and returns a structured digest (or null when nothing happened). No
 * side-effects, no imports from the runtime.
 */

export interface AwayDigestScheduleItem {
  readonly name: string;
  readonly lastRunAt?: number;
  readonly runCount: number;
}

export interface AwayDigestTaskItem {
  readonly title: string;
  readonly status: string;
  readonly completedAt?: number;
}

export interface AwayDigestDeliveryItem {
  readonly label: string;
  readonly at?: number;
}

/** A single connected-host automation run outcome (failed or missed) since lastSeenAt. */
export interface AwayDigestRunItem {
  readonly name: string;
  readonly at?: number;
}

export interface AwayDigestInput {
  /** Epoch ms when the user last used the app. null = first run, digest is suppressed. */
  readonly lastSeenAt: number | null;
  /** Schedules that ran since lastSeenAt. */
  readonly schedules: readonly AwayDigestScheduleItem[];
  /** Tasks whose status changed since lastSeenAt. */
  readonly tasks: readonly AwayDigestTaskItem[];
  /**
   * Number of approvals currently waiting, the daemon's record unioned with
   * whatever this process still holds, never one half of that.
   */
  readonly pendingApprovals: number;
  /**
   * Why the daemon's approval record could not be read, when it could not.
   *
   * A count of zero from an unreadable list means "nobody could be asked", not
   * "nothing is waiting", and those two must not print the same. When this is
   * set the digest says so instead of silently omitting the approvals line.
   * Null (or absent) means the record was read and the count is complete.
   */
  readonly approvalsUnavailableReason?: string | null | undefined;
  /** Optional channel deliveries since lastSeenAt. */
  readonly deliveries?: readonly AwayDigestDeliveryItem[];
  /**
   * Connected-host automation runs that failed since lastSeenAt, read from the
   * host's automation.runs.list outcome, never the agent's local automation
   * manager (local execution is disabled by design).
   */
  readonly failedRuns?: readonly AwayDigestRunItem[];
  /**
   * Connected-host automation runs that were missed (the host was asleep past
   * the scheduled time) since lastSeenAt, same wire source as failedRuns.
   */
  readonly missedRuns?: readonly AwayDigestRunItem[];
}

export interface AwayDigest {
  readonly headline: string;
  readonly lines: readonly string[];
}

/**
 * Maximum number of lines in the digest body (the headline is extra).
 * Keeps the digest compact enough to scan without scrolling.
 */
const MAX_LINES = 5;

/**
 * Format a relative time from `from` to `at`, e.g. "9:00" or "yesterday 9:00".
 * Keeps language simple and avoids raw timestamps in user-facing copy.
 */
export function formatDigestTime(at: number, from: number = Date.now()): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;

  const fromDate = new Date(from);
  const sameDay =
    d.getFullYear() === fromDate.getFullYear() &&
    d.getMonth() === fromDate.getMonth() &&
    d.getDate() === fromDate.getDate();

  if (sameDay) return time;

  const yesterday = new Date(from);
  yesterday.setDate(yesterday.getDate() - 1);
  const wasYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  if (wasYesterday) return `yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Format a relative duration label for an upcoming item, e.g. "in 2h" or "in 30m".
 */
export function formatRelativeTime(targetMs: number, nowMs: number = Date.now()): string {
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'soon';
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 24) return `in ${diffHours}h`;
  const diffDays = Math.round(diffMs / 86_400_000);
  return `in ${diffDays}d`;
}

/**
 * Build a friendly digest from a plain snapshot. Returns null when there is
 * nothing to report or when lastSeenAt is null (first run).
 */
export function buildAwayDigest(input: AwayDigestInput): AwayDigest | null {
  if (input.lastSeenAt === null) return null;

  const lines: string[] = [];
  const now = Date.now();

  // ── Pending approvals (highest urgency first) ──────────────────────────────
  if (input.pendingApprovals > 0) {
    const word = input.pendingApprovals === 1 ? 'approval is waiting' : 'approvals are waiting';
    lines.push(`${input.pendingApprovals} ${word} for you`);
  }

  // ── Tasks that completed/changed ──────────────────────────────────────────
  const doneTasks = input.tasks.filter(
    (t) => t.status === 'done' || t.status === 'completed' || t.status === 'finished',
  );
  const failedTasks = input.tasks.filter(
    (t) => t.status === 'failed' || t.status === 'error',
  );

  if (doneTasks.length === 1) {
    const t = doneTasks[0]!;
    const when = t.completedAt ? ` (${formatDigestTime(t.completedAt, now)})` : '';
    lines.push(`Research task finished: ${t.title}${when}`);
  } else if (doneTasks.length > 1) {
    lines.push(`${doneTasks.length} tasks finished since you were away`);
  }

  if (failedTasks.length === 1) {
    lines.push(`A task needs attention: ${failedTasks[0]!.title}`);
  } else if (failedTasks.length > 1) {
    lines.push(`${failedTasks.length} tasks need attention since you were away`);
  }

  // ── Connected-host automation run outcomes (failed / missed) ────────────────
  const failedRuns = input.failedRuns ?? [];
  const missedRuns = input.missedRuns ?? [];

  if (failedRuns.length === 1) {
    const r = failedRuns[0]!;
    const when = r.at ? ` (${formatDigestTime(r.at, now)})` : '';
    lines.push(`A scheduled run failed: ${r.name}${when}`);
  } else if (failedRuns.length > 1) {
    lines.push(`${failedRuns.length} scheduled runs failed since you were away`);
  }

  if (missedRuns.length === 1) {
    const r = missedRuns[0]!;
    const when = r.at ? ` (${formatDigestTime(r.at, now)})` : '';
    lines.push(`A scheduled run was missed while asleep: ${r.name}${when}`);
  } else if (missedRuns.length > 1) {
    lines.push(`${missedRuns.length} scheduled runs were missed while asleep`);
  }

  // ── Schedule runs ─────────────────────────────────────────────────────────
  if (input.schedules.length === 1) {
    const s = input.schedules[0]!;
    const last = s.lastRunAt ? ` (last: ${s.name}, ${formatDigestTime(s.lastRunAt, now)})` : '';
    lines.push(`1 reminder fired${last}`);
  } else if (input.schedules.length > 1) {
    // Find the most-recently fired for the "last:" note
    const sorted = [...input.schedules].sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
    const mostRecent = sorted[0]!;
    const last = mostRecent.lastRunAt
      ? `, last: ${mostRecent.name}, ${formatDigestTime(mostRecent.lastRunAt, now)}`
      : '';
    lines.push(`${input.schedules.length} reminders fired${last}`);
  }

  // ── Channel deliveries ────────────────────────────────────────────────────
  const deliveries = input.deliveries ?? [];
  if (deliveries.length === 1) {
    lines.push(`1 message delivered: ${deliveries[0]!.label}`);
  } else if (deliveries.length > 1) {
    lines.push(`${deliveries.length} messages delivered`);
  }

  // Nothing to report at all: stay silent. An unreadable approval record is not
  // by itself news, the Activity modal and /health approvals are where that is asked
  // and answered, and announcing it at every launch of an agent with no host
  // configured would be noise, not honesty.
  if (lines.length === 0) return null;

  // But once the digest IS rendering, the approvals count in it must not be
  // read as complete when it is not. The line goes LAST so it qualifies the
  // count above rather than displacing anything, and it is emitted whether the
  // count is zero or not, a short count and an absent one are equally
  // misleading if the owner cannot tell which they are looking at.
  const qualified = input.approvalsUnavailableReason
    ? [...lines.slice(0, MAX_LINES - 1), `Approvals on the connected host could not be read, so any approval count above may be short: ${input.approvalsUnavailableReason}`]
    : lines.slice(0, MAX_LINES);

  return {
    headline: 'While you were away',
    lines: qualified,
  };
}
