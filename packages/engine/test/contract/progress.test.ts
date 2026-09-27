/**
 * Regression and stall detection (contract/progress.ts, design 4.8): code over
 * the readings history, with no judgment involved.
 */
import { describe, expect, test } from 'bun:test';
import {
  consecutiveUnsettledChecks,
  describeStall,
  detectStall,
  findRegressions,
  madeProgress,
  regressionCounts,
  standingOf,
  type CheckStanding,
} from '../../sdk/src/platform/contract/progress.js';
import type { ContractUnit, CriterionVerdict, Nudge, UnitCheck } from '../../sdk/src/platform/contract/types.js';
import { makeCriterion, makeUnit } from './fixtures.js';

const LIMITS = { stallLimit: 3, maxNudgesPerUnit: 12 };

function unitWith(ids: readonly string[]): ContractUnit {
  return makeUnit({ criteria: ids.map((id) => makeCriterion({ id, origin: 'derived', serves: ['c1'], quote: undefined })) });
}

/** Records a check on the unit with the given verdicts per criterion. */
function record(unit: ContractUnit, trigger: UnitCheck['trigger'], verdicts: Readonly<Record<string, CriterionVerdict>>, extra: Partial<UnitCheck> = {}): UnitCheck {
  const id = `${unit.id}.k${unit.checks.length + 1}`;
  for (const [criterionId, verdict] of Object.entries(verdicts)) {
    unit.criteria.find((criterion) => criterion.id === criterionId)!.readings.push({ checkId: id, at: 1, probabilityUnmet: 0.5, verdict, outcome: 'act', decisionId: undefined });
  }
  const clean = { verdict: 'no' as const, outcome: 'act' as const };
  const check: UnitCheck = {
    id,
    at: 1,
    trigger,
    goal: { probabilityUnmet: 0.05, verdict: 'met', outcome: 'act' },
    quality: { placeholder: clean, tests_weakened: clean, breaks_existing: clean, out_of_scope: clean, hidden_failure: clean, unsupported_claims: clean },
    result: 'nudge',
    problems: ['unmet'],
    qualityProblems: [],
    decisionIds: [],
    evidenceDigest: 'x',
    ...extra,
  };
  unit.checks.push(check);
  return check;
}

function standing(overrides: Partial<CheckStanding>): CheckStanding {
  return { checkId: 'u1.k9', trigger: 'completion', met: new Set(), failingGates: 0, qualityProblems: 0, claimsFailed: false, ...overrides };
}

describe('regressions', () => {
  test('met then unmet is a regression, naming the check it was met at', () => {
    const unit = unitWith(['a', 'b', 'c']);
    record(unit, 'completion', { a: 'met', b: 'unshown', c: 'unmet' });
    const regressions = findRegressions(unit, new Map([['a', 'unmet'], ['b', 'unmet'], ['c', 'unmet']]));
    expect(regressions).toEqual([{ criterionId: 'a', metAtCheckId: 'u1.k1' }]);
  });

  test('met then unshown is not a regression', () => {
    const unit = unitWith(['a']);
    record(unit, 'completion', { a: 'met' });
    expect(findRegressions(unit, new Map([['a', 'unshown']]))).toEqual([]);
  });

  test('a regression compares with the latest reading, including a turn-end one', () => {
    const unit = unitWith(['a']);
    record(unit, 'completion', { a: 'unmet' });
    record(unit, 'turn-end', { a: 'met' });
    expect(findRegressions(unit, new Map([['a', 'unmet']]))).toEqual([{ criterionId: 'a', metAtCheckId: 'u1.k2' }]);
  });

  test('regressions are counted per criterion over the whole history', () => {
    const unit = unitWith(['a', 'b']);
    record(unit, 'completion', { a: 'met', b: 'met' });
    record(unit, 'completion', { a: 'unmet', b: 'met' });
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    record(unit, 'completion', { a: 'unmet', b: 'unmet' });
    expect(regressionCounts(unit)).toEqual(new Map([['a', 2], ['b', 1]]));
  });
});

describe('progress', () => {
  test('a strict superset of met criteria is progress; the same set is not', () => {
    expect(madeProgress(standing({ met: new Set(['a', 'b']) }), standing({ met: new Set(['a']) }))).toBe(true);
    expect(madeProgress(standing({ met: new Set(['a']) }), standing({ met: new Set(['a']) }))).toBe(false);
    expect(madeProgress(standing({ met: new Set(['b', 'c']) }), standing({ met: new Set(['a']) }))).toBe(false);
  });

  test('fewer failing gates, fewer quality problems, or a cleared claims failure is progress', () => {
    expect(madeProgress(standing({ failingGates: 1 }), standing({ failingGates: 2 }))).toBe(true);
    expect(madeProgress(standing({ qualityProblems: 0 }), standing({ qualityProblems: 1 }))).toBe(true);
    expect(madeProgress(standing({ claimsFailed: false }), standing({ claimsFailed: true }))).toBe(true);
    expect(madeProgress(standing({ failingGates: 2 }), standing({ failingGates: 2 }))).toBe(false);
  });

  test('a first check is progress', () => {
    expect(madeProgress(standing({}), undefined)).toBe(true);
  });

  test('a recorded check stands on its readings, gates, quality problems and claims', () => {
    const unit = unitWith(['a', 'b']);
    const check = record(unit, 'completion', { a: 'met', b: 'unmet' }, {
      gates: [{ gate: 't', passed: false, output: '', durationMs: 1 }, { gate: 'l', passed: false, output: '', durationMs: 0, skipped: true }],
      qualityProblems: ['placeholder'],
      problems: ['unmet', 'claims'],
    });
    expect(standingOf(unit, check)).toEqual({ checkId: 'u1.k1', trigger: 'completion', met: new Set(['a']), failingGates: 1, qualityProblems: 1, claimsFailed: true });
  });
});

describe('stalls', () => {
  test('stallLimit consecutive non-progress checks stall the unit', () => {
    const unit = unitWith(['a', 'b']);
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    const current = standing({ checkId: 'u1.k4', met: new Set(['a']) });
    expect(detectStall(unit, current, [], LIMITS)).toEqual({ kind: 'no-progress', checks: 3 });
    expect(detectStall(unit, current, [], { ...LIMITS, stallLimit: 4 })).toBeNull();
  });

  test('progress anywhere in the run resets it', () => {
    const unit = unitWith(['a', 'b']);
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    record(unit, 'completion', { a: 'met', b: 'met' });
    expect(detectStall(unit, standing({ met: new Set(['a', 'b']) }), [], LIMITS)).toBeNull();
  });

  test('turn-end checks neither count toward a stall nor break the run', () => {
    const unit = unitWith(['a', 'b']);
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    record(unit, 'turn-end', { a: 'met', b: 'met' }, { result: 'recorded' });
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    record(unit, 'turn-end', { a: 'met', b: 'unmet' }, { result: 'recorded' });
    record(unit, 'completion', { a: 'met', b: 'unmet' });
    expect(detectStall(unit, standing({ met: new Set(['a']) }), [], LIMITS)).toEqual({ kind: 'no-progress', checks: 3 });
    const midRun = standing({ trigger: 'turn-end', met: new Set(['a']) });
    expect(detectStall(unitWithTwoChecks(), midRun, [], LIMITS)).toBeNull();
  });

  test('the same criterion regressing twice stalls, counting this check', () => {
    const unit = unitWith(['a']);
    record(unit, 'completion', { a: 'met' });
    record(unit, 'completion', { a: 'unmet' });
    record(unit, 'completion', { a: 'met' });
    const current = standing({ checkId: 'u1.k4' });
    const reason = detectStall(unit, current, [{ criterionId: 'a', metAtCheckId: 'u1.k3' }], LIMITS);
    expect(reason).toEqual({ kind: 'double-regression', criterionIds: ['a'] });
    expect(describeStall(reason!)).toBe('criteria regressed twice: a');
  });

  test('one regression of each of two criteria is not a double regression', () => {
    const unit = unitWith(['a', 'b']);
    record(unit, 'completion', { a: 'met', b: 'met' });
    record(unit, 'completion', { a: 'unmet', b: 'met' });
    const reason = detectStall(unit, standing({ met: new Set(['a']) }), [{ criterionId: 'b', metAtCheckId: 'u1.k2' }], LIMITS);
    expect(reason).toBeNull();
  });

  test('reaching the nudge ceiling stalls', () => {
    const unit = unitWith(['a']);
    unit.nudges = Array.from({ length: 12 }, (_, index): Nudge => ({
      id: `u1.n${index + 1}`, checkId: 'u1.k1', at: 1, kinds: ['unmet'], criterionIds: ['a'], text: '', delivery: 'hold', agentId: 'a1',
    }));
    expect(detectStall(unit, standing({}), [], LIMITS)).toEqual({ kind: 'nudge-limit', nudges: 12 });
    expect(describeStall({ kind: 'nudge-limit', nudges: 12 })).toBe('12 nudges sent, the most a unit may receive');
    expect(describeStall({ kind: 'no-progress', checks: 3 })).toBe('3 consecutive checks without progress');
  });
});

describe('unsettled checks', () => {
  test('counts the latest run of checks whose only problem was unshown, skipping turn-end', () => {
    const unit = unitWith(['a']);
    record(unit, 'completion', {}, { problems: ['unmet'] });
    record(unit, 'completion', {}, { problems: ['unshown'] });
    record(unit, 'turn-end', {}, { problems: ['unmet'], result: 'recorded' });
    record(unit, 'completion', {}, { problems: ['unshown'] });
    expect(consecutiveUnsettledChecks(unit)).toBe(2);
    record(unit, 'completion', {}, { problems: ['unshown', 'gate'] });
    expect(consecutiveUnsettledChecks(unit)).toBe(0);
  });
});

function unitWithTwoChecks(): ContractUnit {
  const unit = unitWith(['a', 'b']);
  record(unit, 'completion', { a: 'met', b: 'unmet' });
  record(unit, 'completion', { a: 'met', b: 'unmet' });
  return unit;
}
