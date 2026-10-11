/**
 * Which phases of a failed turn or task took unusually long for their kind,
 * read by `engine.runtime.forensics-slow-phase`: one reading per timed phase,
 * all sent together. A phase is slow only on a yes strong enough to act on;
 * phases with no duration are not asked.
 */
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forensicsSlowPhase } from './batteries/slow-phase.js';
import type { OwnedJudgmentOptions } from '../owned-judgment-work.js';
import type { PhaseTimingEntry } from './types.js';

export async function readSlowPhases(
  domain: 'turn' | 'task',
  phaseTimings: readonly PhaseTimingEntry[],
  site: string,
  options: OwnedJudgmentOptions = {},
): Promise<string[]> {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  const timed = phaseTimings.filter((entry) => entry.durationMs !== undefined);
  if (timed.length === 0) return [];
  const capture = options.port ? undefined : captureJudgmentPort(site, options);
  const port = options.port ?? capture!.port;
  const signal = options.signal ?? capture?.signal;
  const current = () => { signal?.throwIfAborted(); options.assertCurrent?.(); capture?.assertCurrent(); };
  const slow = await Promise.all(timed.map(async (entry) => {
    const run = await forensicsSlowPhase.run(port, {
      domain,
      phase: entry.phase,
      durationMs: entry.durationMs!,
      succeeded: entry.success,
    }, { site, ...(signal ? { signal } : {}) });
    current();
    const reading = run.readings.slow;
    const isSlow = reading.verdict === 'yes' && reading.outcome === 'act';
    run.recordAction(isSlow ? 'slow' : 'not-slow');
    current();
    return isSlow;
  }));
  current();
  return timed.filter((_, index) => slow[index]).map((entry) => entry.phase);
}
