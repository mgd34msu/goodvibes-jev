/**
 * The Jev plan checks of design section 3.4 with a fake port: each check
 * produces its problem at the readings the design names, clean readings pass,
 * topology-only criteria get their dispositions, and there is no read without
 * an installed port.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { EXCLUDED_TOPOLOGY_REASON, readCriterionDispositions, runPlanChecks } from '../../sdk/src/platform/contract/plan-checks.js';
import type { PlanProblemCode } from '../../sdk/src/platform/contract/plan-schema.js';
import { ASK, asPlan, planningPort, shapeOf, unitTitleOf, validPlan, type AnswerContext } from './plan-support.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

function install(override?: (context: AnswerContext) => unknown) {
  const fake = planningPort(override);
  installJudgmentPort(fake.port);
  return fake;
}

async function check(override?: (context: AnswerContext) => unknown, shape = shapeOf(), plan = validPlan()) {
  install(override);
  return runPlanChecks(asPlan(plan), ASK, shape);
}

const claimOf = (state: Record<string, unknown>): string => String(state['claim'] ?? '');
const criterionOf = (state: Record<string, unknown>): string => String(state['criterion'] ?? '');

function problemCodes(verdict: Awaited<ReturnType<typeof runPlanChecks>>, code: PlanProblemCode): (string | undefined)[] {
  return verdict.problems.filter((problem) => problem.code === code).map((problem) => problem.targetId);
}

test('a clean plan passes every check, with every request counted', async () => {
  const fake = install();
  const verdict = await runPlanChecks(asPlan(validPlan()), ASK, shapeOf());
  expect(verdict.problems).toEqual([]);
  expect(verdict.dispositions.size).toBe(0);
  expect(verdict.reports.map((report) => [report.check, report.passed])).toEqual([
    ['criterion-trace', true], ['plan-coverage', true], ['criterion-shape', true], ['unit-shape', true],
  ]);
  // 3 traces + 1 coverage + 3 criterion shapes + 3 unit shapes, each its own request.
  expect(fake.requests).toHaveLength(10);
  expect(verdict.usage).toEqual({ calls: 10, inputTokens: 10, outputTokens: 10 });
});

test('the checks ask about the right states', async () => {
  const fake = install();
  await runPlanChecks(asPlan(validPlan()), ASK, shapeOf());
  const states = fake.requests.map((request) => request.state as Record<string, unknown>);
  expect(states).toContainEqual({ claim: 'The user requires: A CSV parser with unit tests exists', source: ASK });
  expect(states).toContainEqual({ request: ASK, criteria: validPlan().criteria.map((criterion) => criterion.text) });
  expect(states).toContainEqual({ request: ASK, criterion: 'A JSON formatter with unit tests exists' });
  const unitState = states.find((state) => unitTitleOf(state) === 'CSV parser')!;
  expect(unitState['goal']).toBe(validPlan().goal);
  expect(unitState['criteria']).toEqual(['A CSV parser with unit tests exists']);
  expect(unitState['otherUnits']).toEqual([{ title: 'JSON formatter', goal: 'Goal of u2' }, { title: 'Wire convert', goal: 'Goal of u3' }]);
  const sites = new Set(fake.requests.map((request) => request.context?.site));
  expect([...sites].sort()).toEqual([
    'contract.plan-checks.criterion-shape', 'contract.plan-checks.criterion-trace', 'contract.plan-checks.plan-coverage', 'contract.plan-checks.unit-shape',
  ]);
});

describe('criterion-trace: fidelity is not supported at act', () => {
  test('says nothing, and contradicts', async () => {
    const verdict = await check(({ name, question, state }) => {
      if (name !== 'relation') return undefined;
      if (claimOf(state).includes('CSV parser')) return choiceAnswer(question, 'says_nothing', 0.95);
      if (claimOf(state).includes('JSON formatter')) return choiceAnswer(question, 'contradicts', 0.95);
      return undefined;
    });
    expect(problemCodes(verdict, 'untraced')).toEqual(['c1', 'c2']);
    expect(verdict.problems[0]!.message).toContain('not something the user');
    expect(verdict.problems[1]!.message).toContain('goes against');
    expect(verdict.reports[0]!.passed).toBe(false);
  });

  test('supports below the high-stakes supports band', async () => {
    const verdict = await check(({ name, question, state }) =>
      name === 'relation' && claimOf(state).includes('convert') ? choiceAnswer(question, 'supports', 0.8) : undefined);
    expect(problemCodes(verdict, 'untraced')).toEqual(['c3']);
    expect(verdict.problems[0]!.message).toContain('not clear');
  });

  test('a fabricated quote needs no request', async () => {
    const plan = validPlan();
    plan.criteria[0]!.quote = 'an XML parser';
    const fake = install();
    const verdict = await runPlanChecks(asPlan(plan), ASK, shapeOf());
    expect(problemCodes(verdict, 'untraced')).toEqual(['c1']);
    expect(fake.requests.filter((request) => 'relation' in request.questions)).toHaveLength(2);
  });
});

describe('plan-coverage: yes at any outcome, or no below act', () => {
  test('yes', async () => {
    const verdict = await check(({ name }) => (name === 'uncovered_requirement' ? noulAnswer(0.9) : undefined));
    expect(verdict.problems.map((problem) => problem.code)).toEqual(['uncovered-requirement']);
  });

  test('yes read only at escalate', async () => {
    const verdict = await check(({ name }) => (name === 'uncovered_requirement' ? noulAnswer(0.5) : undefined));
    expect(verdict.problems.map((problem) => problem.code)).toEqual(['uncovered-requirement']);
  });

  test('no below act', async () => {
    const verdict = await check(({ name }) => (name === 'uncovered_requirement' ? noulAnswer(0.2) : undefined));
    expect(verdict.problems.map((problem) => problem.code)).toEqual(['uncovered-requirement']);
    expect(verdict.problems[0]!.message).toContain('not clear');
  });

  test('no at act clears it', async () => {
    const verdict = await check(({ name }) => (name === 'uncovered_requirement' ? noulAnswer(0.1) : undefined));
    expect(verdict.problems).toEqual([]);
  });
});

describe('criterion-shape', () => {
  test('checkable no at act or confirm is a problem; uncertain is not', async () => {
    const verdict = await check(({ name, state }) => {
      if (name !== 'checkable') return undefined;
      if (criterionOf(state).includes('CSV')) return noulAnswer(0.1);
      if (criterionOf(state).includes('JSON')) return noulAnswer(0.35);
      return noulAnswer(0.5);
    });
    expect(problemCodes(verdict, 'not-checkable')).toEqual(['c1', 'c2']);
  });

  test('topology-only at act is excluded when the plan does not honour a parallel request, and never a checkable problem', async () => {
    const verdict = await check(({ name, state }) => {
      if (!criterionOf(state).includes('convert')) return undefined;
      if (name === 'topology_only') return noulAnswer(0.95);
      if (name === 'checkable') return noulAnswer(0.05);
      return undefined;
    });
    expect(verdict.problems).toEqual([]);
    expect(verdict.dispositions.get('c3')).toEqual({ disposition: 'excluded', reason: EXCLUDED_TOPOLOGY_REASON });
  });

  test('topology-only at act is met by structure when the plan honours a parallel request', async () => {
    const verdict = await check(
      ({ name, state }) => (name === 'topology_only' && criterionOf(state).includes('convert') ? noulAnswer(0.95) : undefined),
      shapeOf(['requests_parallel_agents']),
    );
    const ruling = verdict.dispositions.get('c3');
    expect(ruling?.disposition).toBe('met-by-structure');
    expect(ruling?.reason).toContain('group g1');
  });

  test('topology-only below act stays judged', async () => {
    const verdict = await check(({ name }) => (name === 'topology_only' ? noulAnswer(0.7) : undefined));
    expect(verdict.dispositions.size).toBe(0);
  });

  test('readCriterionDispositions reads only the criterion shapes', async () => {
    const fake = install(({ name, state }) => (name === 'topology_only' && criterionOf(state).includes('CSV') ? noulAnswer(0.95) : undefined));
    const read = await readCriterionDispositions(asPlan(validPlan()), ASK, shapeOf());
    expect(read.dispositions.get('c1')?.disposition).toBe('excluded');
    expect(fake.requests).toHaveLength(3);
    expect(read.usage.calls).toBe(3);
  });
});

describe('unit-shape', () => {
  test('a review, test or verify role at act is a verification unit', async () => {
    const roles: Record<string, string> = { 'CSV parser': 'review', 'JSON formatter': 'test', 'Wire convert': 'verify' };
    const verdict = await check(({ name, question, state }) => (name === 'role' ? choiceAnswer(question, roles[unitTitleOf(state)!]!, 0.95) : undefined));
    expect(problemCodes(verdict, 'verification-unit')).toEqual(['u1', 'u2', 'u3']);
    expect(verdict.problems[0]!.message).toContain('criteria of the unit it would check');
  });

  test('a verification role below act is not acted on', async () => {
    const verdict = await check(({ name, question, state }) =>
      name === 'role' && unitTitleOf(state) === 'CSV parser' ? choiceAnswer(question, 'review', 0.65) : undefined);
    expect(verdict.problems).toEqual([]);
  });

  test('a role that disagrees with the plan is a mismatch; integration reads as implement', async () => {
    const verdict = await check(({ name, question, state }) =>
      name === 'role' && unitTitleOf(state) === 'JSON formatter' ? choiceAnswer(question, 'research', 0.95) : undefined);
    expect(problemCodes(verdict, 'role-mismatch')).toEqual(['u2']);
    expect(problemCodes(verdict, 'role-mismatch')).not.toContain('u3');
  });

  test('a research unit read as research agrees', async () => {
    const plan = validPlan();
    plan.groups[0]!.units[0]!.role = 'research';
    const verdict = await check(({ name, question, state }) =>
      name === 'role' && unitTitleOf(state) === 'CSV parser' ? choiceAnswer(question, 'research', 0.95) : undefined, shapeOf(), plan);
    expect(verdict.problems).toEqual([]);
  });

  test('narrows: yes at any outcome, or no below act', async () => {
    const readings: Record<string, number> = { 'CSV parser': 0.9, 'JSON formatter': 0.2, 'Wire convert': 0.1 };
    const verdict = await check(({ name, state }) => (name === 'narrows' ? noulAnswer(readings[unitTitleOf(state)!]!) : undefined));
    expect(problemCodes(verdict, 'narrows')).toEqual(['u1', 'u2']);
    expect(verdict.problems[0]!.message).toContain('does less');
    expect(verdict.problems[1]!.message).toContain('not clear');
  });
});

test('every problem from every check is returned together', async () => {
  const verdict = await check(({ name, question, state }) => {
    if (name === 'relation' && claimOf(state).includes('CSV')) return choiceAnswer(question, 'says_nothing', 0.95);
    if (name === 'uncovered_requirement') return noulAnswer(0.9);
    if (name === 'checkable' && criterionOf(state).includes('JSON')) return noulAnswer(0.1);
    if (name === 'narrows' && unitTitleOf(state) === 'Wire convert') return noulAnswer(0.9);
    return undefined;
  });
  expect(verdict.problems.map((problem) => problem.code)).toEqual(['untraced', 'uncovered-requirement', 'not-checkable', 'narrows']);
  expect(verdict.reports.every((report) => !report.passed)).toBe(true);
});

test('there is no read without an installed port', async () => {
  await expect(runPlanChecks(asPlan(validPlan()), ASK, shapeOf())).rejects.toBeInstanceOf(JudgmentPortMissingError);
});
