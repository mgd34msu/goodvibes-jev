import { describe, expect, test } from 'bun:test';
import {
  buildAwayDigest,
  formatDigestTime,
  formatRelativeTime,
  type AwayDigestInput,
} from '../../core/away-digest.ts';

// ── formatDigestTime ─────────────────────────────────────────────────────────────────────────

describe('formatDigestTime', () => {
  test('same day returns HH:MM', () => {
    const from = new Date('2026-06-10T14:00:00').getTime();
    const at = new Date('2026-06-10T09:00:00').getTime();
    const result = formatDigestTime(at, from);
    expect(result).toBe('09:00');
  });

  test('yesterday returns "yesterday HH:MM"', () => {
    const from = new Date('2026-06-10T08:00:00').getTime();
    const at = new Date('2026-06-09T21:30:00').getTime();
    const result = formatDigestTime(at, from);
    expect(result).toBe('yesterday 21:30');
  });

  test('older dates include month and day', () => {
    const from = new Date('2026-06-10T08:00:00').getTime();
    const at = new Date('2026-06-07T10:00:00').getTime();
    const result = formatDigestTime(at, from);
    // Must contain time
    expect(result).toContain('10:00');
    // Must not be "yesterday"
    expect(result).not.toContain('yesterday');
  });
});

// ── formatRelativeTime ───────────────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-10T12:00:00').getTime();

  test('past time returns "soon"', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('soon');
  });

  test('30 minutes returns "in 30m"', () => {
    expect(formatRelativeTime(now + 30 * 60_000, now)).toBe('in 30m');
  });

  test('2 hours returns "in 2h"', () => {
    expect(formatRelativeTime(now + 2 * 3_600_000, now)).toBe('in 2h');
  });

  test('2 days returns "in 2d"', () => {
    expect(formatRelativeTime(now + 2 * 86_400_000, now)).toBe('in 2d');
  });
});

// ── buildAwayDigest ────────────────────────────────────────────────────────────────────────

describe('buildAwayDigest', () => {
  const baseInput: AwayDigestInput = {
    lastSeenAt: Date.now() - 3_600_000, // 1 hour ago
    schedules: [],
    tasks: [],
    pendingApprovals: 0,
  };

  test('returns null when lastSeenAt is null (first run)', () => {
    const result = buildAwayDigest({ ...baseInput, lastSeenAt: null });
    expect(result).toBeNull();
  });

  test('returns null when nothing happened', () => {
    const result = buildAwayDigest(baseInput);
    expect(result).toBeNull();
  });

  test('single pending approval', () => {
    const result = buildAwayDigest({ ...baseInput, pendingApprovals: 1 });
    expect(result).not.toBeNull();
    expect(result!.headline).toBe('While you were away');
    expect(result!.lines[0]).toContain('1 approval is waiting');
  });

  test('multiple pending approvals', () => {
    const result = buildAwayDigest({ ...baseInput, pendingApprovals: 3 });
    expect(result!.lines[0]).toContain('3 approvals are waiting');
  });

  // ── The approval count is qualified when it cannot be complete ────────────
  // A count read off an unreachable daemon is short, and a short count and a
  // complete one must not print identically.
  test('an unreadable host record qualifies the approval count', () => {
    const result = buildAwayDigest({
      ...baseInput,
      pendingApprovals: 1,
      approvalsUnavailableReason: 'the connected host is disabled (daemon.enabled=false), nothing to reach.',
    });
    expect(result).not.toBeNull();
    expect(result!.lines[0]).toContain('1 approval is waiting');
    expect(result!.lines.at(-1)).toContain('could not be read');
    expect(result!.lines.at(-1)).toContain('daemon.enabled=false');
  });

  test('the qualifier is said even when the short count is zero, given the digest is rendering', () => {
    const result = buildAwayDigest({
      ...baseInput,
      pendingApprovals: 0,
      schedules: [{ name: 'Daily brief', runCount: 1, lastRunAt: Date.now() - 1_000 }],
      approvalsUnavailableReason: 'the request failed (503): host unavailable',
    });
    expect(result).not.toBeNull();
    expect(result!.lines.join('\n')).toContain('any approval count above may be short');
    expect(result!.lines.join('\n')).toContain('503');
  });

  test('an unreadable host record alone is not news: a digest with nothing else stays silent', () => {
    // Otherwise an agent with no host configured would announce this at every
    // single launch. `/health approvals` is where that question gets asked.
    const result = buildAwayDigest({
      ...baseInput,
      approvalsUnavailableReason: 'the connected host is disabled (daemon.enabled=false), nothing to reach.',
    });
    expect(result).toBeNull();
  });

  test('single completed task', () => {
    const result = buildAwayDigest({
      ...baseInput,
      tasks: [{ title: 'Market Research', status: 'done' }],
    });
    const joined = result!.lines.join('\n');
    expect(joined).toContain('Market Research');
    expect(result!.lines[0]).toContain('Research task finished');
  });

  test('multiple completed tasks', () => {
    const result = buildAwayDigest({
      ...baseInput,
      tasks: [
        { title: 'Task A', status: 'done' },
        { title: 'Task B', status: 'completed' },
      ],
    });
    expect(result!.lines[0]).toContain('2 tasks finished');
  });

  test('failed task', () => {
    const result = buildAwayDigest({
      ...baseInput,
      tasks: [{ title: 'Broken Task', status: 'failed' }],
    });
    expect(result!.lines[0]).toContain('Broken Task');
    expect(result!.lines[0]).toContain('needs attention');
  });

  test('single schedule fired', () => {
    const lastRunAt = Date.now() - 30 * 60_000;
    const result = buildAwayDigest({
      ...baseInput,
      schedules: [{ name: 'Stand-up reminder', lastRunAt, runCount: 5 }],
    });
    expect(result!.lines[0]).toContain('1 reminder fired');
    expect(result!.lines[0]).toContain('Stand-up reminder');
  });

  test('multiple schedules fired with most-recent label', () => {
    const recent = Date.now() - 10 * 60_000;
    const older = Date.now() - 50 * 60_000;
    const result = buildAwayDigest({
      ...baseInput,
      schedules: [
        { name: 'Evening Review', lastRunAt: older, runCount: 3 },
        { name: 'Morning Brief', lastRunAt: recent, runCount: 10 },
      ],
    });
    expect(result!.lines[0]).toContain('2 reminders fired');
    // Most recent should be in the label
    expect(result!.lines[0]).toContain('Morning Brief');
  });

  test('a single failed run renders a distinct failure line', () => {
    const at = Date.now() - 30 * 60_000;
    const result = buildAwayDigest({
      ...baseInput,
      failedRuns: [{ name: 'Nightly backup', at }],
    });
    expect(result!.lines[0]).toContain('scheduled run failed');
    expect(result!.lines[0]).toContain('Nightly backup');
  });

  test('multiple failed runs are summarized by count', () => {
    const result = buildAwayDigest({
      ...baseInput,
      failedRuns: [{ name: 'Job A' }, { name: 'Job B' }],
    });
    expect(result!.lines[0]).toContain('2 scheduled runs failed');
  });

  test('a single missed run renders a distinct "missed" line from a failure', () => {
    const at = Date.now() - 10 * 60_000;
    const result = buildAwayDigest({
      ...baseInput,
      missedRuns: [{ name: 'Weekly digest', at }],
    });
    expect(result!.lines[0]).toContain('missed while asleep');
    expect(result!.lines[0]).toContain('Weekly digest');
    expect(result!.lines[0]).not.toContain('scheduled run failed');
  });

  test('a failed run and a missed run both appear as separate lines', () => {
    const result = buildAwayDigest({
      ...baseInput,
      failedRuns: [{ name: 'Overnight sync' }],
      missedRuns: [{ name: 'Morning brief' }],
    });
    const joined = result!.lines.join('\n');
    expect(joined).toContain('Overnight sync');
    expect(joined).toContain('Morning brief');
    expect(result!.lines.some((line) => line.includes('scheduled run failed'))).toBe(true);
    expect(result!.lines.some((line) => line.includes('missed while asleep'))).toBe(true);
  });

  test('deliveries appear in digest', () => {
    const result = buildAwayDigest({
      ...baseInput,
      deliveries: [{ label: 'Slack: daily report sent' }],
    });
    expect(result!.lines[0]).toContain('1 message delivered');
  });

  test('clamped to MAX_LINES (5)', () => {
    const result = buildAwayDigest({
      lastSeenAt: Date.now() - 3_600_000,
      pendingApprovals: 2,
      tasks: [
        { title: 'Task A', status: 'done' },
        { title: 'Task B', status: 'failed' },
      ],
      schedules: [
        { name: 'Brief A', lastRunAt: Date.now() - 10_000, runCount: 1 },
        { name: 'Brief B', lastRunAt: Date.now() - 20_000, runCount: 1 },
      ],
      deliveries: [
        { label: 'ntfy: message' },
        { label: 'ntfy: message 2' },
      ],
    });
    expect(result!.lines.length).toBeLessThanOrEqual(5);
  });

  test('headline is always "While you were away"', () => {
    const result = buildAwayDigest({ ...baseInput, pendingApprovals: 1 });
    expect(result!.headline).toBe('While you were away');
  });
});
