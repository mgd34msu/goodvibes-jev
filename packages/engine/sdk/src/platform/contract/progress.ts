/**
 * Regression and stall detection over a unit's readings history
 * (docs/design/contract-runner.md section 4.8). All of it is counting and set
 * comparison over recorded verdicts, so it is code: Jev reads each criterion,
 * and this module only compares what was read.
 *
 * - Regression: a criterion whose previous verdict was met (met is only ever
 *   read at act) and whose new verdict is unmet.
 * - Progress: the set of criteria reading met is a strict superset of the
 *   previous check's, or fewer gates fail, or fewer quality problems are read,
 *   or a claims failure cleared.
 * - Stall: `contract.stallLimit` consecutive non-progress checks at triggers
 *   other than turn-end, or one criterion regressed twice, or the unit's nudges
 *   reached `contract.maxNudgesPerUnit`.
 */
import { failedGates } from './gates.js';
import type { ContractUnit, CriterionVerdict, UnitCheck } from './types.js';

/** A criterion that read met and now reads unmet. */
export interface Regression {
  readonly criterionId: string;
  /** The check at which it last read met. */
  readonly metAtCheckId: string;
}

/**
 * The regressions in a new set of verdicts, against each criterion's latest
 * recorded reading. `verdicts` maps criterion ids to this check's verdicts.
 */
export function findRegressions(unit: Pick<ContractUnit, 'criteria'>, verdicts: ReadonlyMap<string, CriterionVerdict>): Regression[] {
  const regressions: Regression[] = [];
  for (const criterion of unit.criteria) {
    const verdict = verdicts.get(criterion.id);
    const previous = criterion.readings.at(-1);
    if (verdict === 'unmet' && previous?.verdict === 'met') regressions.push({ criterionId: criterion.id, metAtCheckId: previous.checkId });
  }
  return regressions;
}

/** How many times each criterion has gone from met to unmet across its readings. */
export function regressionCounts(unit: Pick<ContractUnit, 'criteria'>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const criterion of unit.criteria) {
    let count = 0;
    criterion.readings.forEach((reading, index) => {
      if (reading.verdict === 'unmet' && criterion.readings[index - 1]?.verdict === 'met') count += 1;
    });
    if (count > 0) counts.set(criterion.id, count);
  }
  return counts;
}

/** What progress compares between two checks. */
export interface CheckStanding {
  readonly checkId: string;
  readonly trigger: UnitCheck['trigger'];
  /** Ids of the criteria that read met at this check. */
  readonly met: ReadonlySet<string>;
  readonly failingGates: number;
  readonly qualityProblems: number;
  readonly claimsFailed: boolean;
}

/** A recorded check's standing, with the met set rebuilt from the criteria's readings. */
export function standingOf(unit: Pick<ContractUnit, 'criteria'>, check: UnitCheck): CheckStanding {
  const met = new Set(unit.criteria.filter((criterion) => criterion.readings.some((reading) => reading.checkId === check.id && reading.verdict === 'met')).map((criterion) => criterion.id));
  return {
    checkId: check.id,
    trigger: check.trigger,
    met,
    failingGates: failedGates(check.gates).length,
    qualityProblems: check.qualityProblems?.length ?? 0,
    claimsFailed: check.problems?.includes('claims') ?? false,
  };
}

function isStrictSuperset(larger: ReadonlySet<string>, smaller: ReadonlySet<string>): boolean {
  return larger.size > smaller.size && [...smaller].every((id) => larger.has(id));
}

/** Whether `current` made progress over `previous` (4.8). A first check has nothing to fall short of. */
export function madeProgress(current: CheckStanding, previous: CheckStanding | undefined): boolean {
  if (previous === undefined) return true;
  return (
    isStrictSuperset(current.met, previous.met) ||
    current.failingGates < previous.failingGates ||
    current.qualityProblems < previous.qualityProblems ||
    (previous.claimsFailed && !current.claimsFailed)
  );
}

export interface StallLimits {
  readonly stallLimit: number;
  readonly maxNudgesPerUnit: number;
}

export type StallReason =
  | { readonly kind: 'no-progress'; readonly checks: number }
  | { readonly kind: 'double-regression'; readonly criterionIds: readonly string[] }
  | { readonly kind: 'nudge-limit'; readonly nudges: number };

/**
 * Whether a unit has stalled once `current` is counted. `current` is the
 * standing of the check being decided and `regressions` its regressions; the
 * unit's recorded checks and readings do not include it yet.
 */
export function detectStall(
  unit: Pick<ContractUnit, 'criteria' | 'checks' | 'nudges'>,
  current: CheckStanding,
  regressions: readonly Regression[],
  limits: StallLimits,
): StallReason | null {
  const counts = regressionCounts(unit);
  for (const regression of regressions) counts.set(regression.criterionId, (counts.get(regression.criterionId) ?? 0) + 1);
  const twice = [...counts].filter(([, count]) => count >= 2).map(([id]) => id);
  if (twice.length > 0) return { kind: 'double-regression', criterionIds: twice };

  if (unit.nudges.length >= limits.maxNudgesPerUnit) return { kind: 'nudge-limit', nudges: unit.nudges.length };

  const settled = unit.checks.filter((check) => check.trigger !== 'turn-end').map((check) => standingOf(unit, check));
  if (current.trigger !== 'turn-end') settled.push(current);
  let run = 0;
  for (let index = settled.length - 1; index >= 0; index -= 1) {
    if (madeProgress(settled[index]!, settled[index - 1])) break;
    run += 1;
  }
  return run >= limits.stallLimit ? { kind: 'no-progress', checks: run } : null;
}

/** A stall reason in words, for the stall event and the decision record. */
export function describeStall(reason: StallReason): string {
  if (reason.kind === 'double-regression') return `criteria regressed twice: ${reason.criterionIds.join(', ')}`;
  if (reason.kind === 'nudge-limit') return `${reason.nudges} nudges sent, the most a unit may receive`;
  return `${reason.checks} consecutive checks without progress`;
}

/**
 * How many checks in a row, most recent first and skipping turn-end checks,
 * found nothing wrong except readings that did not settle. This is the count
 * `contract.evidenceNudgeLimit` bounds before the owner is asked to confirm.
 */
export function consecutiveUnsettledChecks(unit: Pick<ContractUnit, 'checks'>): number {
  let count = 0;
  for (let index = unit.checks.length - 1; index >= 0; index -= 1) {
    const check = unit.checks[index]!;
    if (check.trigger === 'turn-end') continue;
    const problems = check.problems ?? [];
    if (problems.length === 1 && problems[0] === 'unshown') count += 1;
    else break;
  }
  return count;
}
