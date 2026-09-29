/**
 * The Jev plan checks of design section 3.4 with a fake port: each check
 * produces its problem at the readings the design names, clean readings pass,
 * topology-only criteria get their dispositions, and there is no read without
 * an installed port.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { quoteLayout } from '../../sdk/src/platform/contract/batteries/plan-coverage.js';
import { EXCLUDED_TOPOLOGY_REASON, readCriterionDispositions, runPlanChecks, SESSION_MODE_REASON, unitShapeState } from '../../sdk/src/platform/contract/plan-checks.js';
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
/** A field of a question's structured instructions, such as the `requirement` a narrows question carries. */
const fieldOf = (question: Question, key: string): string => String((question.instructions as Record<string, unknown>)[key] ?? '');

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
  expect(states).toContainEqual({ request: ASK });
  expect(states).toContainEqual({ request: ASK, criterion: 'A JSON formatter with unit tests exists' });
  const unitState = states.find((state) => unitTitleOf(state) === 'CSV parser')!;
  expect(unitState['goal']).toBe(validPlan().goal);
  // The other units come with their criteria, so Jev can see a sibling make up a shared requirement.
  expect(unitState['otherUnits']).toEqual([
    { title: 'JSON formatter', goal: 'Goal of u2', criteria: ['src/json.ts formats JSON and its tests pass'] },
    { title: 'Wire convert', goal: 'Goal of u3', criteria: ['convert reads CSV and writes JSON'] },
  ]);
  // The requirement rides in its own narrows question, not in the state.
  expect(unitState['criteria']).toBeUndefined();
  const unitRequest = fake.requests.find((request) => unitTitleOf(request.state as Record<string, unknown>) === 'CSV parser')!;
  expect(Object.keys(unitRequest.questions)).toEqual(['role', 'narrows_c1']);
  expect(fieldOf(unitRequest.questions['narrows_c1']!, 'requirement')).toBe('A CSV parser with unit tests exists');
  const coverageRequest = fake.requests.find((request) => request.context?.site === 'contract.plan-checks.plan-coverage')!;
  expect(Object.entries(coverageRequest.questions).map(([name, question]) => [name, fieldOf(question, 'words')])).toEqual([
    ['unquoted_1', 'and'], ['unquoted_2', ', each with unit tests, and'],
    ['falls_short_1', 'Add a CSV parser'], ['falls_short_2', 'a JSON formatter'], ['falls_short_3', 'wire both into the convert command'],
  ]);
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

describe('plan-coverage: each part of the request clears only on no at act or confirm', () => {
  const answering = (key: string, p: number) => ({ name }: { name: string }) => (name === key ? noulAnswer(p) : undefined);

  test('unquoted words that lean yes are a problem naming them', async () => {
    const verdict = await check(answering('unquoted_2', 0.9));
    expect(verdict.problems).toEqual([{
      code: 'uncovered-requirement',
      message: `The user's words ", each with unit tests, and" state a requirement, limit or preference that no contract criterion quotes; add a criterion for it, quoting those words.`,
    }]);
  });

  test('a quoted region that falls short is a problem on the criteria quoting it', async () => {
    const verdict = await check(answering('falls_short_3', 0.9));
    expect(problemCodes(verdict, 'uncovered-requirement')).toEqual(['c3']);
    expect(verdict.problems[0]!.message).toContain('requires less than the user\'s words "wire both into the convert command"');
  });

  test('a reading that leans yes only at escalate is a problem', async () => {
    const verdict = await check(answering('falls_short_1', 0.55));
    expect(problemCodes(verdict, 'uncovered-requirement')).toEqual(['c1']);
    expect(verdict.problems[0]!.message).toContain('not clear');
  });

  test('a reading that leans no without reaching the high no band is a problem asking for the user\'s words', async () => {
    const verdict = await check(answering('falls_short_2', 0.35));
    expect(problemCodes(verdict, 'uncovered-requirement')).toEqual(['c2']);
    expect(verdict.problems[0]!.message).toContain('restate it in the user\'s words');
  });

  test('no at confirm clears its part', async () => {
    const verdict = await check(answering('falls_short_2', 0.25));
    expect(verdict.problems).toEqual([]);
  });

  test('no at act clears it', async () => {
    const verdict = await check(answering('unquoted_1', 0.1));
    expect(verdict.problems).toEqual([]);
  });
});

describe('quoteLayout', () => {
  const criterion = (id: string, text: string, quote: string | undefined) => ({ id, text, quote });

  test('criteria whose quotes overlap share one region; the words no quote covers are asked about when they have a letter or digit', () => {
    const layout = quoteLayout({
      request: 'Give each module its own test file under test/ with at least 12 test cases.  Then  ship it!',
      criteria: [
        criterion('c1', 'Each module has its own test file', 'Give each module its own test file under test/'),
        criterion('c2', 'At least 12 test cases for parse', 'at least 12 test cases'),
        criterion('c3', 'At least 12 test cases for format', 'at least 12 test cases'),
        criterion('c4', 'Each module has a test file under test/', 'its own test file under test/'),
      ],
    });
    expect(layout.request).toBe('Give each module its own test file under test/ with at least 12 test cases. Then ship it!');
    expect(layout.unquoted).toEqual(['with', '. Then ship it!']);
    expect(layout.regions.map((region) => [region.words, region.criteria.map((entry) => entry.id)])).toEqual([
      ['Give each module its own test file under test/', ['c1', 'c4']],
      ['at least 12 test cases', ['c2', 'c3']],
    ]);
  });

  test('a quote found nowhere covers nothing, so its words stay unquoted', () => {
    const layout = quoteLayout({ request: 'Add a CSV parser, then stop.', criteria: [criterion('c1', 'A CSV parser exists', 'an XML parser'), criterion('c2', 'Stop', undefined)] });
    expect(layout.unquoted).toEqual(['Add a CSV parser, then stop.']);
    expect(layout.regions).toEqual([]);
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

  describe('a criterion asking for one agent to work alone', () => {
    const solo = (soloP: number) => ({ name, state }: { name: string; state: Record<string, unknown> }) => {
      if (!criterionOf(state).includes('CSV')) return undefined;
      if (name === 'topology_only') return noulAnswer(0.95);
      if (name === 'solo') return noulAnswer(soloP);
      return undefined;
    };

    test('is met by structure in session mode, and is never a checkable problem', async () => {
      const verdict = await check(({ name, state }) => (name === 'checkable' && criterionOf(state).includes('CSV') ? noulAnswer(0.1) : solo(0.95)({ name, state })), shapeOf(['forbids_delegation']));
      expect(verdict.problems).toEqual([]);
      expect(verdict.dispositions.get('c1')).toEqual({ disposition: 'met-by-structure', reason: SESSION_MODE_REASON });
    });

    test('is excluded when the contract does not run in session mode', async () => {
      const verdict = await check(solo(0.95));
      expect(verdict.dispositions.get('c1')).toEqual({ disposition: 'excluded', reason: EXCLUDED_TOPOLOGY_REASON });
    });

    test('in session mode, a topology-only criterion that is not solo at act is excluded', async () => {
      const verdict = await check(solo(0.7), shapeOf(['forbids_delegation']));
      expect(verdict.dispositions.get('c1')).toEqual({ disposition: 'excluded', reason: EXCLUDED_TOPOLOGY_REASON });
    });
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

  test('narrows: a requirement read leaning yes is a problem at any outcome, naming the requirement', async () => {
    const readings: Record<string, number> = { 'CSV parser': 0.9, 'JSON formatter': 0.55, 'Wire convert': 0.1 };
    const verdict = await check(({ name, state }) => (name.startsWith('narrows_') ? noulAnswer(readings[unitTitleOf(state)!]!) : undefined));
    expect(problemCodes(verdict, 'narrows')).toEqual(['u1', 'u2']);
    expect(verdict.problems[0]!.message).toContain('does less than contract criterion c1 ("A CSV parser with unit tests exists")');
    expect(verdict.problems[1]!.message).toContain('not clear');
  });

  test('narrows: a requirement read leaning no clears at any outcome, since the deliverable check judges it again', async () => {
    const readings: Record<string, number> = { 'CSV parser': 0.3, 'JSON formatter': 0.45, 'Wire convert': 0.2 };
    const verdict = await check(({ name, state }) => (name.startsWith('narrows_') ? noulAnswer(readings[unitTitleOf(state)!]!) : undefined));
    expect(verdict.problems).toEqual([]);
  });

  test('narrows: one question per contract criterion the unit serves, and only the ones leaning yes are named', async () => {
    const plan = validPlan();
    plan.groups[1]!.units[0]!.criteria = [
      { id: 'u3.c1', text: 'convert reads CSV and writes JSON', serves: ['c3'] },
      { id: 'u3.c2', text: 'convert uses both modules', serves: ['c1', 'c2'] },
    ];
    const fake = install(({ name, question }) =>
      name.startsWith('narrows_') && fieldOf(question, 'requirement') === 'A JSON formatter with unit tests exists' ? noulAnswer(0.8) : undefined);
    const verdict = await runPlanChecks(asPlan(plan), ASK, shapeOf());
    const wire = fake.requests.find((request) => unitTitleOf(request.state as Record<string, unknown>) === 'Wire convert')!;
    expect(Object.keys(wire.questions)).toEqual(['role', 'narrows_c1', 'narrows_c2', 'narrows_c3']);
    expect(problemCodes(verdict, 'narrows')).toEqual(['u2', 'u3']);
    expect(verdict.problems.at(-1)!.message).toContain('contract criterion c2 (');
    expect(verdict.problems.at(-1)!.message).not.toContain('c1 (');
  });

  test('unitShapeState reads the other units with their criteria and the contract criteria the unit serves', () => {
    const plan = asPlan(validPlan());
    const input = unitShapeState(plan, plan.groups[1]!.units[0]!);
    expect(input.requirements).toEqual([{ id: 'c3', text: 'The convert command uses the parser and the formatter' }]);
    expect(input.otherUnits.map((other) => other.criteria)).toEqual([['src/csv.ts parses CSV and its tests pass'], ['src/json.ts formats JSON and its tests pass']]);
  });
});

test('every problem from every check is returned together', async () => {
  const verdict = await check(({ name, question, state }) => {
    if (name === 'relation' && claimOf(state).includes('CSV')) return choiceAnswer(question, 'says_nothing', 0.95);
    if (name === 'unquoted_2') return noulAnswer(0.9);
    if (name === 'checkable' && criterionOf(state).includes('JSON')) return noulAnswer(0.1);
    if (name.startsWith('narrows_') && unitTitleOf(state) === 'Wire convert') return noulAnswer(0.9);
    return undefined;
  });
  expect(verdict.problems.map((problem) => problem.code)).toEqual(['untraced', 'uncovered-requirement', 'not-checkable', 'narrows']);
  expect(verdict.reports.every((report) => !report.passed)).toBe(true);
});

test('there is no read without an installed port', async () => {
  await expect(runPlanChecks(asPlan(validPlan()), ASK, shapeOf())).rejects.toBeInstanceOf(JudgmentPortMissingError);
});
