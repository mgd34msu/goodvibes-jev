/**
 * Ambient autonomy surfacing module.
 *
 * HISTORY: this factory was extracted from main.ts to keep that file under the
 * 800-line cap. After extraction it gained two capabilities:
 *   1. Calendar merging, listCalendarEvents callback merges upcoming events
 *      into the Activity modal's Coming up alongside scheduled jobs (buildCalendarEventsLister).
 *   2. Skill-draft accrual, onAwayDigest callback runs skill-draft proposal
 *      once per away-digest pass and appends a feed line when drafts are created
 *      (buildSkillDraftProposer).
 * These additions are NOT "no behavior change" refactors; they add real surface.
 */

import { buildAwayDigest, formatDigestTime, formatRelativeTime } from '../core/away-digest.ts';
import type { AwayDigestScheduleItem } from '../core/away-digest.ts';
import { LastSeenStore } from '../core/last-seen-store.ts';
import type { AutomationRunsSinceResult } from '../agent/automation-runs-source.ts';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { AgentCalendarRegistry } from '../agent/calendar-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { runSkillDraftProposer } from '../agent/skill-draft-runner.ts';
import type { CommandContext } from '../input/command-registry.ts';

interface AutomationJobLike {
  readonly name: string;
  readonly enabled: boolean;
  readonly nextRunAt?: number;
  readonly lastRunAt?: number;
  readonly runCount?: number;
}

interface ApprovalLike {
  readonly status: string;
}

interface AutonomyMessageRouter {
  high(message: string): void;
  getFeed(): { push(text: string, priority?: 'high' | 'low', kind?: string): void } | null;
}

export interface AutonomySurfacingOptions {
  readonly shellPaths: Parameters<typeof LastSeenStore.fromShellPaths>[0];
  /** Feeds the Activity modal's Coming-up next-run entries only, the local automation
   * manager's job list (local execution is disabled by design; see
   * src/runtime/bootstrap.ts). The away digest's run OUTCOMES never read this;
   * see listAutomationRunsSince below. */
  readonly listAutomationJobs: () => readonly AutomationJobLike[];
  /**
   * The away digest's automation source of truth: connected-host runs
   * (completed/failed/missed) since the given epoch-ms timestamp, read over
   * the wire via automation.runs.list. Never falls back to the local
   * automation manager.
   */
  readonly listAutomationRunsSince: (since: number) => Promise<AutomationRunsSinceResult>;
  /**
   * Every ask waiting for this owner, the daemon's record unioned with the
   * asks still held in this process, NOT the local broker alone. A surface
   * counting only its own broker reports zero while the daemon holds three.
   */
  readonly listApprovals: () => readonly ApprovalLike[];
  /**
   * Why the daemon's approval record could not be read, when it could not, so
   * the digest can say that instead of counting an unreadable list as zero.
   * Returns null when the record WAS read. See runtime/client/approvals-view.ts.
   */
  readonly describeApprovalsUnavailable?: (() => string | null) | undefined;
  readonly getTasksSnapshot: () => readonly unknown[];
  readonly router: AutonomyMessageRouter;
  readonly render: () => void;
  /**
   * Optional callback to list upcoming local calendar events.
   * Each item carries a formatted label and a numeric sort key (ms since epoch)
   * so the Coming up section merges calendar and job entries chronologically.
   */
  readonly listCalendarEvents?: () => readonly { label: string; start: number }[];
  /**
   * Optional callback invoked once per announceAwayDigest pass.
   * Should run skill draft proposal and return the count of drafts created.
   * When > 0, a line is appended to the digest feed.
   */
  readonly onAwayDigest?: () => number;
}

const COMING_UP_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2500;
const LAST_SEEN_REFRESH_MS = 5 * 60_000;

/**
 * Group completed connected-host runs by job name into the digest's
 * { name, lastRunAt, runCount } shape, the same shape the digest previously
 * derived from the local automation manager's per-job runCount/lastRunAt,
 * but now counting only runs that actually completed since lastSeenAt on the
 * connected host.
 */
function aggregateFiredSchedules(
  completedRuns: readonly { readonly jobName: string; readonly endedAt?: number }[],
): readonly AwayDigestScheduleItem[] {
  const byJob = new Map<string, { lastRunAt?: number; runCount: number }>();
  for (const run of completedRuns) {
    const existing = byJob.get(run.jobName) ?? { lastRunAt: undefined, runCount: 0 };
    byJob.set(run.jobName, {
      runCount: existing.runCount + 1,
      lastRunAt: existing.lastRunAt === undefined
        ? run.endedAt
        : run.endedAt === undefined ? existing.lastRunAt : Math.max(existing.lastRunAt, run.endedAt),
    });
  }
  return [...byJob.entries()].map(([name, agg]) => ({ name, lastRunAt: agg.lastRunAt, runCount: agg.runCount }));
}

/**
 * Ambient autonomy surfacing for the shell: the launch "While you were away"
 * digest and the Activity modal's Coming up entries. Everything here is best-effort
 * and offline-tolerant, failures are silent and renders are never blocked.
 */
export function createAutonomySurfacing(options: AutonomySurfacingOptions) {
  const lastSeenStore = LastSeenStore.fromShellPaths(options.shellPaths);

  // Refresh lastSeenAt every 5 minutes so rapid restarts still detect activity.
  const lastSeenRefreshInterval = setInterval(() => {
    lastSeenStore.save();
  }, LAST_SEEN_REFRESH_MS);
  lastSeenRefreshInterval.unref();

  const comingUpCache: { items: string[]; fetchedAt: number | null; fetching: boolean } = {
    items: [],
    fetchedAt: null,
    fetching: false,
  };

  function refreshComingUp(): void {
    if (comingUpCache.fetching) return;
    const now = Date.now();
    if (comingUpCache.fetchedAt !== null && now - comingUpCache.fetchedAt < COMING_UP_TTL_MS) return;
    comingUpCache.fetching = true;
    Promise.resolve().then(() => {
      try {
        const jobs = options.listAutomationJobs();
        const jobItems: Array<{ label: string; sortKey: number }> = jobs
          .filter((job) => job.enabled && job.nextRunAt !== undefined && job.nextRunAt > now)
          .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
          .map((job) => {
            const when = job.nextRunAt ? formatRelativeTime(job.nextRunAt, now) : '';
            const name = job.name.length > 22 ? `${job.name.slice(0, 20)}…` : job.name;
            return { label: when ? `${name}, ${when}` : name, sortKey: job.nextRunAt ?? 0 };
          });

        const calItems: Array<{ label: string; sortKey: number }> = [];
        if (options.listCalendarEvents) {
          try {
            for (const ev of options.listCalendarEvents()) {
              calItems.push({ label: ev.label, sortKey: ev.start });
            }
          } catch {
            // Calendar unavailable, skip silently.
          }
        }

        comingUpCache.items = [...jobItems, ...calItems]
          .sort((a, b) => a.sortKey - b.sortKey)
          .slice(0, 3)
          .map((item) => item.label);
        comingUpCache.fetchedAt = Date.now();
      } catch {
        // Offline or manager unavailable, leave cache as-is.
      } finally {
        comingUpCache.fetching = false;
      }
    }).catch(() => {
      comingUpCache.fetching = false;
    });
  }

  function announceAwayDigest(): void {
    void (async () => {
      try {
        const lastSeenAt = lastSeenStore.read();
        const withTimeout = <T>(get: () => T) => Promise.race([
          Promise.resolve(get()),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
        ]);

        // The automation source of truth is the connected host's run outcomes,
        // never the agent's local automation manager (local execution is
        // disabled by design). Only queried once there's a real lastSeenAt to
        // query since; first run suppresses the whole digest anyway.
        const [runsResult, tasksResult] = await Promise.allSettled([
          lastSeenAt !== null
            ? withTimeout(() => options.listAutomationRunsSince(lastSeenAt))
            : Promise.resolve<AutomationRunsSinceResult>({ runs: [], deliveries: [] }),
          withTimeout(options.getTasksSnapshot),
        ]);
        const runsSince: AutomationRunsSinceResult = runsResult.status === 'fulfilled'
          ? runsResult.value
          : { runs: [], deliveries: [] };
        const allTasks = tasksResult.status === 'fulfilled' ? tasksResult.value : [];

        const firedSchedules = aggregateFiredSchedules(
          runsSince.runs.filter((run) => run.status === 'completed'),
        );

        const failedRuns = runsSince.runs
          .filter((run) => run.status === 'failed')
          .map((run) => ({ name: run.jobName, at: run.endedAt }));

        const missedRuns = runsSince.runs
          .filter((run) => run.status === 'missed')
          .map((run) => ({ name: run.jobName, at: run.endedAt }));

        const changedTasks = lastSeenAt !== null
          ? allTasks
            .filter((task) => {
              const completedAt = (task as { completedAt?: number }).completedAt;
              return completedAt !== undefined ? completedAt > lastSeenAt : false;
            })
            .map((task) => ({
              title: (task as { title?: string; name?: string }).title
                ?? (task as { name?: string }).name
                ?? 'Task',
              status: (task as { status?: string }).status ?? 'done',
              completedAt: (task as { completedAt?: number }).completedAt,
            }))
          : [];

        const pendingApprovals = options.listApprovals()
          .filter((approval) => approval.status === 'pending').length;
        const approvalsUnavailableReason = options.describeApprovalsUnavailable?.() ?? null;

        const digest = buildAwayDigest({
          lastSeenAt,
          schedules: firedSchedules,
          tasks: changedTasks,
          pendingApprovals,
          approvalsUnavailableReason,
          deliveries: runsSince.deliveries,
          failedRuns,
          missedRuns,
        });

        if (digest !== null) {
          const full = [digest.headline, ...digest.lines].join('\n  ');
          options.router.high(`[Status] ${full}`);
          for (const line of digest.lines) {
            options.router.getFeed()?.push(`[Status] ${line}`, 'low', 'schedule');
          }
          options.render();
        }

        // Invoke optional skill-draft hook once per pass.
        if (options.onAwayDigest) {
          try {
            const drafted = options.onAwayDigest();
            if (drafted > 0) {
              options.router.getFeed()?.push(
                `[Status] I drafted ${drafted} skill${drafted !== 1 ? 's' : ''} from recent work, review them under Memory`,
                'low',
                'schedule',
              );
            }
          } catch {
            // Skill draft hook failed, skip silently.
          }
        }
      } catch (err) {
        logger.debug('away-digest failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }

  function stop(): void {
    clearInterval(lastSeenRefreshInterval);
    lastSeenStore.save();
  }

  return {
    refreshComingUp,
    announceAwayDigest,
    stop,
    // Return a defensive copy so callers cannot mutate internal cache state.
    comingUpItems: (): readonly string[] => [...comingUpCache.items],
  };
}

/**
 * Build the onAwayDigest callback for the given shellPaths and command context.
 * Extracted so main.ts can pass a single symbol instead of an inline lambda.
 * (See module-header note for history.)
 */
export function buildSkillDraftProposer(
  shellPaths: Parameters<typeof AgentSkillRegistry.fromShellPaths>[0],
  context: CommandContext,
): () => number {
  return () =>
    runSkillDraftProposer(
      context,
      AgentSkillRegistry.fromShellPaths(shellPaths),
    ).proposed;
}

/**
 * Build the listCalendarEvents callback for the given shellPaths.
 * Extracts the closure that was previously inlined in main.ts so that
 * file stays under the 800-line cap.
 *
 * The optional `upcomingEvents` parameter is a testability seam: when provided,
 * it replaces the `registry.upcoming(7)` call so unit tests can inject a
 * deterministic event set without mocking the module. Production callers omit
 * this parameter; the default is the real registry lookup.
 */
export function buildCalendarEventsLister(
  shellPaths: Parameters<typeof LastSeenStore.fromShellPaths>[0],
  upcomingEvents?: () => readonly import('../agent/calendar-registry.ts').AgentCalendarEvent[],
): () => readonly { label: string; start: number }[] {
  return () => {
    const now = Date.now();
    const registry = AgentCalendarRegistry.fromShellPaths(shellPaths);
    return (upcomingEvents ?? (() => registry.upcoming(7)))()
      .map((e) => {
        const allDay = e.allDay;
        // Sort key: use local midnight for all-day events so they sort at the
        // correct local calendar date rather than UTC midnight (which would land
        // the previous day for timezones east of UTC).
        // Timed events: parse the ISO string directly; Date.parse handles
        // offset-bearing strings correctly.
        const startMs = allDay
          ? new Date(`${e.start}T00:00:00`).getTime()   // no tz suffix ⇒ local time
          : Date.parse(e.start);
        const sortMs = isNaN(startMs) ? now : startMs;
        // Display: format via local Date methods so the user sees their own
        // timezone, never a raw stored offset or UTC-shifted string.
        const label = e.title.length > 22 ? `${e.title.slice(0, 20)}…` : e.title;
        const when = allDay
          ? e.start   // date-only string, no time component to misformat
          : formatDigestTime(startMs, now);
        return { label: `${label}, ${when}`, start: sortMs };
      });
  };
}
