/**
 * Which phases of a failed turn or task took unusually long for their kind,
 * read by `engine.runtime.forensics-slow-phase`: one reading per timed phase,
 * all sent together. A phase is slow only on a yes strong enough to act on;
 * phases with no duration are not asked.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { forensicsSlowPhase } from './batteries/slow-phase.js';
import type { PhaseTimingEntry } from './types.js';

export async function readSlowPhases(
  domain: 'turn' | 'task',
  phaseTimings: readonly PhaseTimingEntry[],
  site: string,
): Promise<string[]> {
  const timed = phaseTimings.filter((entry) => entry.durationMs !== undefined);
  if (timed.length === 0) return [];
  const port = judgmentPort(site);
  const slow = await Promise.all(timed.map(async (entry) => {
    const run = await forensicsSlowPhase.run(port, {
      domain,
      phase: entry.phase,
      durationMs: entry.durationMs!,
      succeeded: entry.success,
    }, { site });
    const reading = run.readings.slow;
    const isSlow = reading.verdict === 'yes' && reading.outcome === 'act';
    run.recordAction(isSlow ? 'slow' : 'not-slow');
    return isSlow;
  }));
  return timed.filter((_, index) => slow[index]).map((entry) => entry.phase);
}
