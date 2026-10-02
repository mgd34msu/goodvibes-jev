import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { createAutonomySurfacing, buildCalendarEventsLister } from '../../shell/autonomy-surfacing.ts';
import { LastSeenStore } from '../../core/last-seen-store.ts';
import type { AutomationRunOutcome } from '../../agent/automation-runs-source.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempShellPaths() {
  const root = makeProjectTempDir('goodvibes-autonomy-test');
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

/**
 * Minimal stub for AutonomySurfacingOptions.
 */
function makeOptions(overrides: Partial<Parameters<typeof createAutonomySurfacing>[0]> = {}) {
  const feedPushes: Array<{ text: string; priority?: 'high' | 'low'; kind?: string }> = [];
  const highMessages: string[] = [];
  const shellPaths = tempShellPaths();
  return {
    options: {
      shellPaths,
      listAutomationJobs: () => [],
      listAutomationRunsSince: async () => ({ runs: [], deliveries: [] }),
      listApprovals: () => [],
      getTasksSnapshot: () => [],
      router: {
        high: (msg: string) => { highMessages.push(msg); },
        getFeed: () => ({
          push: (text: string, priority?: 'high' | 'low', kind?: string) => {
            feedPushes.push({ text, priority, kind });
          },
        }),
      },
      render: () => {},
      ...overrides,
    } satisfies Parameters<typeof createAutonomySurfacing>[0],
    feedPushes,
    highMessages,
  };
}

// ---------------------------------------------------------------------------
// onAwayDigest wiring in announceAwayDigest
// ---------------------------------------------------------------------------

describe('announceAwayDigest: onAwayDigest wiring', () => {
  test('stub returning > 0 appends the skill-draft feed line', async () => {
    const { options, feedPushes } = makeOptions({
      onAwayDigest: () => 2,
    });
    const autonomy = createAutonomySurfacing(options);
    autonomy.announceAwayDigest();
    // announceAwayDigest is async (void + inner async IIFE), wait one event-loop turn
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const draftLine = feedPushes.find((p) => p.text.includes('drafted') && p.text.includes('skill'));
    expect(draftLine).toBeDefined();
    expect(draftLine?.text).toContain('2');
    expect(draftLine?.text).toContain('review them under Memory');
  });

  test('stub returning 1 uses singular "skill" (not "skills")', async () => {
    const { options, feedPushes } = makeOptions({
      onAwayDigest: () => 1,
    });
    const autonomy = createAutonomySurfacing(options);
    autonomy.announceAwayDigest();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const draftLine = feedPushes.find((p) => p.text.includes('drafted'));
    expect(draftLine).toBeDefined();
    // Should say "1 skill" not "1 skills"
    expect(draftLine?.text).toMatch(/1 skill[^s]/u);
  });

  test('stub returning 0 appends no skill-draft feed line', async () => {
    const { options, feedPushes } = makeOptions({
      onAwayDigest: () => 0,
    });
    const autonomy = createAutonomySurfacing(options);
    autonomy.announceAwayDigest();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const draftLine = feedPushes.find((p) => p.text.includes('drafted') && p.text.includes('skill'));
    expect(draftLine).toBeUndefined();
  });

  test('omitting onAwayDigest appends no skill-draft feed line', async () => {
    const { options, feedPushes } = makeOptions();
    // No onAwayDigest provided
    const autonomy = createAutonomySurfacing(options);
    autonomy.announceAwayDigest();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const draftLine = feedPushes.find((p) => p.text.includes('drafted') && p.text.includes('skill'));
    expect(draftLine).toBeUndefined();
  });

  test('throwing onAwayDigest does not propagate error (silent catch)', async () => {
    const { options, feedPushes } = makeOptions({
      onAwayDigest: () => { throw new Error('proposer exploded'); },
    });
    const autonomy = createAutonomySurfacing(options);
    // Should not throw
    expect(() => autonomy.announceAwayDigest()).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const draftLine = feedPushes.find((p) => p.text.includes('drafted'));
    expect(draftLine).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// announceAwayDigest, connected-host run outcomes (failed / missed), never
// the local automation manager. See src/agent/automation-runs-source.ts.
// ---------------------------------------------------------------------------

describe('announceAwayDigest: connected-host run outcomes', () => {
  function makeRun(overrides: Partial<AutomationRunOutcome> & Pick<AutomationRunOutcome, 'status'>): AutomationRunOutcome {
    return {
      id: overrides.id ?? 'run-1',
      jobId: overrides.jobId ?? 'job-1',
      jobName: overrides.jobName ?? 'Nightly backup',
      queuedAt: overrides.queuedAt ?? Date.now() - 3_600_000,
      endedAt: overrides.endedAt,
      status: overrides.status,
    };
  }

  test('a failed wire run renders a failure line in the digest', async () => {
    const { options, feedPushes } = makeOptions({
      listAutomationRunsSince: async () => ({
        runs: [makeRun({ status: 'failed', jobName: 'Nightly backup', endedAt: Date.now() - 1_800_000 })],
        deliveries: [],
      }),
    });
    LastSeenStore.fromShellPaths(options.shellPaths).save(Date.now() - 3_600_000);

    const autonomy = createAutonomySurfacing(options);
    autonomy.announceAwayDigest();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const failLine = feedPushes.find((p) => p.text.includes('scheduled run failed'));
    expect(failLine).toBeDefined();
    expect(failLine?.text).toContain('Nightly backup');
  });

  test('a missed wire run renders a distinct "missed" line in the digest', async () => {
    const { options, feedPushes } = makeOptions({
      listAutomationRunsSince: async () => ({
        runs: [makeRun({ status: 'missed', jobName: 'Weekly digest', endedAt: Date.now() - 900_000 })],
        deliveries: [],
      }),
    });
    LastSeenStore.fromShellPaths(options.shellPaths).save(Date.now() - 3_600_000);

    const autonomy = createAutonomySurfacing(options);
    autonomy.announceAwayDigest();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const missedLine = feedPushes.find((p) => p.text.includes('missed while asleep'));
    expect(missedLine).toBeDefined();
    expect(missedLine?.text).toContain('Weekly digest');
  });

  test('a failed run and a missed run both surface in the same digest pass', async () => {
    const { options, feedPushes } = makeOptions({
      listAutomationRunsSince: async () => ({
        runs: [
          makeRun({ id: 'r1', status: 'failed', jobName: 'Overnight sync' }),
          makeRun({ id: 'r2', status: 'missed', jobName: 'Morning brief' }),
        ],
        deliveries: [],
      }),
    });
    LastSeenStore.fromShellPaths(options.shellPaths).save(Date.now() - 3_600_000);

    const autonomy = createAutonomySurfacing(options);
    autonomy.announceAwayDigest();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const joined = feedPushes.map((p) => p.text).join('\n');
    expect(joined).toContain('Overnight sync');
    expect(joined).toContain('Morning brief');
  });

  test('the local automation manager is never consulted for the digest, even when it would throw', async () => {
    const { options, feedPushes } = makeOptions({
      listAutomationJobs: () => {
        throw new Error('local automation manager must not be read for the digest');
      },
      listAutomationRunsSince: async () => ({
        runs: [makeRun({ status: 'failed', jobName: 'Poison-guard job' })],
        deliveries: [],
      }),
    });
    LastSeenStore.fromShellPaths(options.shellPaths).save(Date.now() - 3_600_000);

    const autonomy = createAutonomySurfacing(options);
    // If announceAwayDigest ever called the poisoned listAutomationJobs, the
    // throw would be caught by the outer try/catch and the whole digest pass
    // would silently produce zero feed lines, so a rendered line here proves
    // the local manager path was never exercised.
    expect(() => autonomy.announceAwayDigest()).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const failLine = feedPushes.find((p) => p.text.includes('scheduled run failed'));
    expect(failLine).toBeDefined();
    expect(failLine?.text).toContain('Poison-guard job');
  });

  test('completed wire runs still populate the "reminder fired" schedules line', async () => {
    const { options, feedPushes } = makeOptions({
      listAutomationRunsSince: async () => ({
        runs: [makeRun({ status: 'completed', jobName: 'Stand-up reminder', endedAt: Date.now() - 600_000 })],
        deliveries: [],
      }),
    });
    LastSeenStore.fromShellPaths(options.shellPaths).save(Date.now() - 3_600_000);

    const autonomy = createAutonomySurfacing(options);
    autonomy.announceAwayDigest();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    autonomy.stop();

    const firedLine = feedPushes.find((p) => p.text.includes('reminder fired'));
    expect(firedLine).toBeDefined();
    expect(firedLine?.text).toContain('Stand-up reminder');
  });
});

// ---------------------------------------------------------------------------
// F7, comingUpItems returns a defensive copy
// ---------------------------------------------------------------------------

describe('comingUpItems: defensive copy', () => {
  test('mutating the returned array does not affect subsequent calls', async () => {
    const shellPaths = tempShellPaths();
    const autonomy = createAutonomySurfacing({
      shellPaths,
      listAutomationJobs: () => [{
        name: 'Test job',
        enabled: true,
        nextRunAt: Date.now() + 3_600_000, // 1 hour from now
      }],
      listAutomationRunsSince: async () => ({ runs: [], deliveries: [] }),
      listApprovals: () => [],
      getTasksSnapshot: () => [],
      router: { high: () => {}, getFeed: () => null },
      render: () => {},
    });

    // Force a cache fill
    autonomy.refreshComingUp();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const first = autonomy.comingUpItems();
    expect(first.length).toBeGreaterThan(0);

    // Mutate the returned array (cast away readonly for the test)
    (first as string[]).push('injected item');

    // Second call must not include the injected item
    const second = autonomy.comingUpItems();
    expect(second).not.toContain('injected item');

    autonomy.stop();
  });
});

// ---------------------------------------------------------------------------
// F5, buildCalendarEventsLister timezone correctness (real function, DI seam)
// ---------------------------------------------------------------------------

describe('buildCalendarEventsLister: timezone and sort correctness', () => {
  /**
   * These tests exercise the REAL buildCalendarEventsLister via the
   * dependency-injection seam added in the second parameter: `upcomingEvents`.
   * When provided, it replaces registry.upcoming(7) so tests can inject a
   * deterministic mixed event set without touching disk or mocking the module.
   *
   * Revert-guard design: the guard's correctness does not rely on a UTC default
   * runtime. The host default is America/Chicago (not UTC). Both the buggy
   * `Date.parse(start+'Z')` and the fix could produce identical values under any
   * default TZ, so naive ordering tests cannot distinguish them.
   *
   * The cross-day ordering test below is the genuine guard: it sets
   * process.env.TZ = 'America/New_York' BEFORE calling the production function
   * so that `new Date('2099-06-15T00:00:00').getTime()` resolves to NY local
   * midnight (UTC 04:00) rather than UTC midnight (UTC 00:00). It then asserts
   * that a D-1 evening timed event (21:00 NY = UTC 01:00 June 15) sorts BEFORE
   * the all-day event on D (midnight NY = UTC 04:00 June 15). Under the bug
   * (forced UTC midnight = UTC 00:00 June 15), the all-day sorts BEFORE D-1
   * 21:00 NY (UTC 01:00), reversing the expected order and failing the test.
   * Bun honors mid-process TZ reassignment for Date operations (verified
   * empirically: before/after timestamps differ by the NY UTC offset).
   */

  /** Make a minimal AgentCalendarEvent for injection */
  function makeEvent(overrides: {
    id?: string;
    title: string;
    start: string;
    allDay: boolean;
  }): import('../../agent/calendar-registry.ts').AgentCalendarEvent {
    const now = new Date().toISOString();
    return {
      id: overrides.id ?? 'test-event',
      title: overrides.title,
      start: overrides.start,
      allDay: overrides.allDay,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * HOST-INDEPENDENT GUARD: cross-local-day ordering under explicit America/New_York.
   *
   * Pair:
   *   - all-day on 2099-06-15 (day D)
   *   - timed at 21:00 on 2099-06-14 (D-1 evening, LOCAL time, no tz suffix)
   *
   * Under FIX (new Date('2099-06-15T00:00:00').getTime()) with TZ=America/New_York:
   *   all-day sort key = NY midnight = UTC 04:00 June 15 = 4085179200000 + 14400000
   *   D-1 21:00 local   = NY 21:00   = UTC 01:00 June 15 = 4085164800000 + 3600000
   *   → D-1 evening (01:00 UTC) < all-day (04:00 UTC): CORRECT order, test PASSES.
   *
   * Under BUG (Date.parse('2099-06-15T00:00:00Z')) regardless of TZ:
   *   all-day sort key = UTC midnight = UTC 00:00 June 15 = 4085164800000
   *   D-1 21:00 local (TZ=NY) = UTC 01:00 June 15 = 4085164800000 + 3600000
   *   → all-day (00:00 UTC) < D-1 evening (01:00 UTC): WRONG order, test FAILS.
   *
   * This reliably fails on revert under default `bun test` (TZ unset → UTC-pinned).
   */
  test('cross-local-day ordering: D-1 evening sorts before all-day D (NY timezone guard)', () => {
    const prevTZ = process.env.TZ;
    try {
      // Set TZ before constructing Date values; bun re-reads TZ mid-process.
      process.env.TZ = 'America/New_York';

      const events = [
        // D-1 evening: 21:00 local on June 14, no tz suffix (local interpretation).
        // Placed first in array to prove ordering is by sort key, not insertion order.
        makeEvent({ id: 'd1-evening', title: 'Evening event', start: '2099-06-14T21:00:00', allDay: false }),
        // All-day event on D = June 15.
        makeEvent({ id: 'd-allday', title: 'All day June 15', start: '2099-06-15', allDay: true }),
      ];

      const lister = buildCalendarEventsLister(tempShellPaths(), () => events);
      const result = lister();

      expect(result.length).toBe(2);

      const eveningItem = result.find((r) => r.label.includes('Evening event'));
      const allDayItem = result.find((r) => r.label.includes('All day June 15'));
      expect(eveningItem).toBeDefined();
      expect(allDayItem).toBeDefined();

      // D-1 evening (NY 21:00 = UTC 01:00 June 15) must sort BEFORE
      // all-day D (NY midnight = UTC 04:00 June 15) under the fix.
      // Under the bug (forced UTC midnight = UTC 00:00 June 15), all-day
      // sorts BEFORE D-1 evening (UTC 01:00), reversing the order and
      // causing this assertion to fail.
      expect(eveningItem!.start).toBeLessThan(allDayItem!.start);
    } finally {
      // Restore original TZ to avoid leaking state across tests.
      if (prevTZ === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = prevTZ;
      }
    }
  });

  test('events on adjacent days are ordered correctly across the day boundary', () => {
    // An all-day event on day D should sort before a timed event on day D+1.
    const events = [
      makeEvent({ id: 'day2-timed', title: 'Day two event', start: '2099-06-16T08:00:00', allDay: false }),
      makeEvent({ id: 'day1-allday', title: 'Day one event', start: '2099-06-15', allDay: true }),
    ];

    const lister = buildCalendarEventsLister(tempShellPaths(), () => events);
    const result = lister();

    expect(result.length).toBe(2);
    const day1 = result.find((r) => r.label.includes('Day one'));
    const day2 = result.find((r) => r.label.includes('Day two'));
    expect(day1).toBeDefined();
    expect(day2).toBeDefined();
    expect(day1!.start).toBeLessThan(day2!.start);
  });
});
