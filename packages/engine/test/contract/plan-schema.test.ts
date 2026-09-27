/**
 * The plan's JSON shape and the code checks of design section 3.3: every
 * check produces its problem, a valid plan produces none, and the tool
 * contract enforces a request that forbids writing (check 9).
 */
import { describe, expect, test } from 'bun:test';
import {
  findParallelGroup,
  parseContractPlan,
  unitToolContract,
  validateContractPlan,
  type PlanLimits,
  type PlanProblemCode,
} from '../../sdk/src/platform/contract/plan-schema.js';
import { MAX_ATTEMPTS } from '../../sdk/src/platform/orchestration/types.js';
import { PLANNER_DECOMPOSITION_TOOLS } from '../../sdk/src/platform/agents/planner-decomposition-runner.js';
import { ASK, asPlan, draftUnit, plannerOutput, shapeOf, singleUnitPlan, validPlan, type DraftPlan } from './plan-support.js';

const LIMITS: PlanLimits = { maxUnits: 64, defaultAttempts: 1 };

function problemsOf(draft: DraftPlan, shape = shapeOf(), limits = LIMITS) {
  return validateContractPlan(asPlan(draft), ASK, shape, limits);
}

function codes(draft: DraftPlan, shape = shapeOf(), limits = LIMITS): PlanProblemCode[] {
  return problemsOf(draft, shape, limits).map((problem) => problem.code);
}

function targetsOf(draft: DraftPlan, code: PlanProblemCode, shape = shapeOf(), limits = LIMITS): (string | undefined)[] {
  return problemsOf(draft, shape, limits).filter((problem) => problem.code === code).map((problem) => problem.targetId);
}

describe('parseContractPlan', () => {
  test('reads the last fenced JSON block', () => {
    const text = `Draft:\n\`\`\`json\n{"goal": "old"}\n\`\`\`\nFinal:\n${plannerOutput(validPlan())}`;
    const parsed = parseContractPlan(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan.goal).toBe(validPlan().goal);
      expect(parsed.plan.groups.map((group) => group.id)).toEqual(['g1', 'g2']);
    }
  });

  test('defaults a missing group kind to work, missing lists to empty and missing attempts to undefined', () => {
    const text = '```json\n' + JSON.stringify({
      goal: 'g', criteria: [{ id: 'c1', text: 't', quote: 'q' }],
      groups: [{ id: 'g1', title: 't', goal: 'g', units: [{ id: 'u1', title: 't', goal: 'g', role: 'implement', brief: 'b', criteria: [] }] }],
    }) + '\n```';
    const parsed = parseContractPlan(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const group = parsed.plan.groups[0]!;
      expect(group.kind).toBe('work');
      expect(group.dependsOn).toEqual([]);
      expect(group.criteria).toEqual([]);
      expect(group.units[0]!.attempts).toBeUndefined();
      expect(group.units[0]!.files).toEqual([]);
    }
  });

  test('no fenced block is unparseable', () => {
    const parsed = parseContractPlan('I think we should add a parser.');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.map((problem) => problem.code)).toEqual(['unparseable']);
  });

  test('broken JSON is unparseable', () => {
    const parsed = parseContractPlan('```json\n{"goal": \n```');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]!.message).toContain('does not parse');
  });

  test('a top-level array is unparseable', () => {
    const parsed = parseContractPlan('```json\n[]\n```');
    expect(parsed.ok).toBe(false);
  });

  test('every bad field is its own unparseable problem', () => {
    const text = '```json\n' + JSON.stringify({
      goal: '', criteria: [{ id: 'c1' }],
      groups: [{ id: 'g1', title: 't', goal: 'g', kind: 'review', units: [{ id: 'u1', title: 't', goal: 'g', role: 'implement', brief: 'b', attempts: 'two', dependsOn: 'u2', criteria: [] }] }],
    }) + '\n```';
    const parsed = parseContractPlan(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems.every((problem) => problem.code === 'unparseable')).toBe(true);
      const messages = parsed.problems.map((problem) => problem.message).join('\n');
      expect(messages).toContain('plan.goal');
      expect(messages).toContain('plan.criteria[0].text');
      expect(messages).toContain('plan.groups[0].kind');
      expect(messages).toContain('plan.groups[0].units[0].attempts');
      expect(messages).toContain('plan.groups[0].units[0].dependsOn');
    }
  });
});

describe('validateContractPlan', () => {
  test('a valid multi-unit plan and a valid single-unit plan have no problems', () => {
    expect(problemsOf(validPlan())).toEqual([]);
    expect(problemsOf(singleUnitPlan())).toEqual([]);
  });

  describe('check 1: ids and graphs', () => {
    test('bad ids', () => {
      const plan = validPlan();
      plan.criteria[0]!.id = 'crit1';
      plan.groups[0]!.id = 'group1';
      plan.groups[0]!.units[0]!.id = 'unit-1';
      plan.groups[0]!.units[1]!.criteria[0]!.id = 'u9.c1';
      expect(targetsOf(plan, 'bad-id')).toEqual(expect.arrayContaining(['crit1', 'group1', 'unit-1', 'u9.c1']));
    });

    test('duplicate ids', () => {
      const plan = validPlan();
      plan.groups[0]!.units[1]!.id = 'u1';
      plan.groups[0]!.units[1]!.criteria[0]!.id = 'u1.c1';
      expect(targetsOf(plan, 'duplicate-id')).toEqual(['u1', 'u1.c1']);
    });

    test('a dependency on a group that does not exist, and on a unit in another group', () => {
      const plan = validPlan();
      plan.groups[1]!.dependsOn = ['g1', 'g7'];
      plan.groups[1]!.units[0]!.dependsOn = ['u1'];
      const problems = problemsOf(plan).filter((problem) => problem.code === 'unknown-dependency');
      expect(problems.map((problem) => problem.targetId)).toEqual(['g2', 'u3']);
      expect(problems[1]!.message).toContain('not a unit in group g2');
    });

    test('a group cycle and a unit cycle', () => {
      const plan = validPlan();
      plan.groups[0]!.dependsOn = ['g2'];
      plan.groups[0]!.units[0]!.dependsOn = ['u2'];
      plan.groups[0]!.units[1]!.dependsOn = ['u1'];
      const problems = problemsOf(plan).filter((problem) => problem.code === 'cycle');
      expect(problems.map((problem) => problem.targetId)).toEqual(['g2', 'u2']);
      expect(problems[0]!.message).toContain('->');
    });

    test('a unit that depends on itself', () => {
      const plan = validPlan();
      plan.groups[0]!.units[0]!.dependsOn = ['u1'];
      expect(targetsOf(plan, 'cycle')).toEqual(['u1']);
    });
  });

  describe('check 2: criteria present and linked', () => {
    test('no contract criteria', () => {
      const plan = validPlan();
      plan.criteria = [];
      expect(codes(plan)).toContain('no-criteria');
    });

    test('no units, and a group with no units', () => {
      const empty = validPlan();
      empty.groups = [];
      expect(codes(empty)).toContain('no-units');
      const hollow = validPlan();
      hollow.groups.splice(1, 0, { id: 'g3', title: 'Empty', goal: 'nothing', kind: 'work', dependsOn: [], criteria: [], units: [] });
      expect(targetsOf(hollow, 'empty-group')).toEqual(['g3']);
    });

    test('a unit with no criteria', () => {
      const plan = validPlan();
      plan.groups[0]!.units[1]!.criteria = [];
      expect(targetsOf(plan, 'unit-without-criteria')).toEqual(['u2']);
    });

    test('a derived criterion that serves nothing, or serves an unknown criterion', () => {
      const plan = validPlan();
      plan.groups[0]!.criteria[0]!.serves = [];
      plan.groups[0]!.units[0]!.criteria[0]!.serves = ['c1', 'c9'];
      expect(targetsOf(plan, 'serves-missing')).toEqual(['g1.c1']);
      expect(targetsOf(plan, 'serves-unknown')).toEqual(['u1.c1']);
    });
  });

  test('roles outside the unit roles, and fix groups, are refused', () => {
    const plan = validPlan();
    plan.groups[0]!.units[1]!.role = 'review';
    plan.groups[0]!.kind = 'fix';
    expect(targetsOf(plan, 'unknown-role')).toEqual(['u2']);
    expect(targetsOf(plan, 'group-kind')).toEqual(['g1']);
  });

  test('check 3: a contract criterion no unit criterion serves', () => {
    const plan = validPlan();
    plan.groups[0]!.units[1]!.criteria[0]!.serves = ['c1'];
    const problems = problemsOf(plan).filter((problem) => problem.code === 'uncovered-criterion');
    expect(problems.map((problem) => problem.targetId)).toEqual(['c2']);
  });

  test('check 3: a group criterion does not count as coverage', () => {
    const plan = validPlan();
    plan.groups[0]!.units[1]!.criteria[0]!.serves = ['c1'];
    plan.groups[0]!.criteria[0]!.serves = ['c2'];
    expect(targetsOf(plan, 'uncovered-criterion')).toEqual(['c2']);
  });

  describe('check 4: quotes', () => {
    test('a missing quote and a quote not in the ask', () => {
      const plan = validPlan();
      plan.criteria[0]!.quote = undefined;
      plan.criteria[1]!.quote = 'a YAML formatter';
      const problems = problemsOf(plan).filter((problem) => problem.code === 'quote-not-found');
      expect(problems.map((problem) => problem.targetId)).toEqual(['c1', 'c2']);
      expect(problems[1]!.message).toContain('a YAML formatter');
    });

    test('a quote matches across line breaks and curly quotes', () => {
      const plan = validPlan();
      plan.criteria[2]!.quote = 'wire both\n  into the convert command';
      expect(codes(plan)).not.toContain('quote-not-found');
      const curly = validPlan();
      const ask = 'Keep the “legacy” flag.';
      curly.criteria = [{ id: 'c1', text: 'The legacy flag stays', quote: 'the "legacy" flag' }];
      curly.groups = singleUnitPlan().groups;
      curly.groups[0]!.units[0]!.criteria[0]!.serves = ['c1'];
      expect(validateContractPlan(asPlan(curly), ask, shapeOf(), LIMITS).map((problem) => problem.code)).not.toContain('quote-not-found');
    });
  });

  describe('check 5: the integration group', () => {
    test('a multi-unit plan without one', () => {
      const plan = validPlan();
      plan.groups[1]!.kind = 'work';
      plan.groups[1]!.units[0]!.role = 'implement';
      expect(codes(plan)).toContain('integration-missing');
    });

    test('not last, not depending on every group, two units, wrong role, two integration groups', () => {
      const notLast = validPlan();
      notLast.groups.reverse();
      notLast.groups[1]!.dependsOn = [];
      expect(targetsOf(notLast, 'integration-shape')).toContain('g2');

      const missingDep = validPlan();
      missingDep.groups.splice(1, 0, { id: 'g3', title: 'More', goal: 'more', kind: 'work', dependsOn: [], criteria: [], units: [draftUnit('u4')] });
      expect(problemsOf(missingDep).some((problem) => problem.code === 'integration-shape' && problem.message.includes('g3'))).toBe(true);

      const twoUnits = validPlan();
      twoUnits.groups[1]!.units.push(draftUnit('u4', { role: 'integration' }));
      expect(targetsOf(twoUnits, 'integration-shape')).toEqual(['g2']);

      const wrongRole = validPlan();
      wrongRole.groups[1]!.units[0]!.role = 'implement';
      expect(targetsOf(wrongRole, 'integration-shape')).toEqual(['g2']);

      const twoGroups = validPlan();
      twoGroups.groups.push({ id: 'g3', title: 'Again', goal: 'again', kind: 'integration', dependsOn: ['g1', 'g2'], criteria: [], units: [draftUnit('u4', { role: 'integration' })] });
      expect(problemsOf(twoGroups).some((problem) => problem.code === 'integration-shape' && problem.message.includes('2 integration groups'))).toBe(true);
    });

    test('an integration unit outside the integration group', () => {
      const plan = validPlan();
      plan.groups[0]!.units[1]!.role = 'integration';
      expect(targetsOf(plan, 'integration-shape')).toEqual(['u2']);
    });

    test('a single-unit plan has no integration group or unit', () => {
      const withGroup = singleUnitPlan();
      withGroup.groups[0]!.kind = 'integration';
      expect(targetsOf(withGroup, 'integration-unexpected')).toEqual(['g1']);
      const withRole = singleUnitPlan();
      withRole.groups[0]!.units[0]!.role = 'integration';
      expect(targetsOf(withRole, 'integration-unexpected')).toEqual(['u1']);
    });
  });

  describe('check 6: a request for parallel agents', () => {
    const parallel = shapeOf(['requests_parallel_agents']);

    test('holds when a group has two independent units', () => {
      expect(codes(validPlan(), parallel)).not.toContain('parallel-missing');
      expect(findParallelGroup(asPlan(validPlan()))?.id).toBe('g1');
    });

    test('fails when every pair is ordered, even through a chain', () => {
      const plan = validPlan();
      plan.groups[0]!.units.push(draftUnit('u4', { dependsOn: ['u2'] }));
      plan.groups[0]!.units[1]!.dependsOn = ['u1'];
      expect(codes(plan, parallel)).toContain('parallel-missing');
      expect(findParallelGroup(asPlan(plan))).toBeUndefined();
    });

    test('is not required without the request, or read below act, or for a single unit', () => {
      const plan = validPlan();
      plan.groups[0]!.units[1]!.dependsOn = ['u1'];
      expect(codes(plan)).not.toContain('parallel-missing');
      const confirmOnly = shapeOf([], { requests_parallel_agents: { verdict: 'yes', probability: 0.58, outcome: 'confirm' } });
      expect(codes(plan, confirmOnly)).not.toContain('parallel-missing');
      expect(codes(singleUnitPlan(), parallel)).not.toContain('parallel-missing');
    });
  });

  describe('check 7: attempts', () => {
    test('several attempts without an ask are refused', () => {
      const plan = validPlan();
      plan.groups[0]!.units[0]!.attempts = 3;
      expect(targetsOf(plan, 'attempts')).toEqual(['u1']);
    });

    test('several attempts are allowed when asked for at act, or when the default is above one', () => {
      const plan = validPlan();
      plan.groups[0]!.units[0]!.attempts = 3;
      expect(codes(plan, shapeOf(['asks_for_attempts']))).not.toContain('attempts');
      expect(codes(plan, shapeOf(), { ...LIMITS, defaultAttempts: 2 })).not.toContain('attempts');
    });

    test('never above MAX_ATTEMPTS, never below one, always whole', () => {
      const asked = shapeOf(['asks_for_attempts']);
      for (const attempts of [MAX_ATTEMPTS + 1, 0, 1.5]) {
        const plan = validPlan();
        plan.groups[0]!.units[0]!.attempts = attempts;
        expect(targetsOf(plan, 'attempts', asked)).toEqual(['u1']);
      }
      expect(codes(validPlan(), shapeOf(), { ...LIMITS, defaultAttempts: MAX_ATTEMPTS + 1 })).toContain('attempts');
    });
  });

  describe('check 8: size', () => {
    test('more units than contract.maxUnits', () => {
      expect(codes(validPlan(), shapeOf(), { ...LIMITS, maxUnits: 2 })).toContain('too-many-units');
      expect(codes(validPlan(), shapeOf(), { ...LIMITS, maxUnits: 3 })).not.toContain('too-many-units');
    });

    test('a user who forbids delegation gets exactly one unit', () => {
      const forbids = shapeOf(['forbids_delegation']);
      expect(codes(validPlan(), forbids)).toContain('too-many-units');
      expect(codes(singleUnitPlan(), forbids)).toEqual([]);
      const unclear = shapeOf([], { forbids_delegation: { verdict: 'uncertain', probability: 0.5, outcome: 'escalate' } });
      expect(codes(validPlan(), unclear)).toContain('too-many-units');
    });
  });
});

describe('check 9 and the tool contract', () => {
  test('implementation and integration units keep write and exec tools', () => {
    expect(unitToolContract('implement', shapeOf())).toEqual({ readOnly: false, restrictTools: false });
    expect(unitToolContract('integration', shapeOf())).toEqual({ readOnly: false, restrictTools: false });
  });

  test('research and design units are read-only with the planner tool set', () => {
    for (const role of ['research', 'design'] as const) {
      expect(unitToolContract(role, shapeOf())).toEqual({ readOnly: true, tools: PLANNER_DECOMPOSITION_TOOLS, restrictTools: true });
    }
  });

  test('a request that forbids writing at act makes every unit read-only, without a plan problem', () => {
    const forbids = shapeOf(['forbids_writing']);
    for (const role of ['implement', 'integration', 'research', 'design'] as const) {
      expect(unitToolContract(role, forbids).readOnly).toBe(true);
    }
    expect(codes(validPlan(), forbids)).toEqual([]);
  });

  test('a forbids-writing reading below act does not take the tools away', () => {
    const confirm = shapeOf([], { forbids_writing: { verdict: 'yes', probability: 0.7, outcome: 'confirm' } });
    expect(unitToolContract('implement', confirm).readOnly).toBe(false);
  });
});
