/**
 * Correction when nudging stalls (docs/design/contract-runner.md section 5),
 * on the contract runner with the fake judgment port and a scripted executor:
 * each stall route (split, fresh, owner), a route read below act, the fix
 * rounds running out, planned-fix groups for a unit, a group and the
 * deliverable, and the code checks on a fix plan.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { buildFixGroup, validateFixPlan, type ContractRouteSelector, type Criterion, type FixBrief } from '../../sdk/src/platform/contract/index.js';
import { plannerOutput, type AnswerContext, type DraftPlan } from './plan-support.js';
import { eventsOf, makeHarness, oneUnitPlan, startContract, waitFor, type AgentScript, type Harness } from './runner-support.js';
import {
  MET,
  UNMET,
  answers,
  contractOf,
  finishes,
  fixPlan,
  fixedOutputsMeet,
  judgeOf,
  keepsFailing,
  routeAnswer,
  scriptsWith,
  stepPlanner,
  terminal,
} from './steps-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function use(h: Harness): Harness {
  harness = h;
  return h;
}

const unitFix = (): string => plannerOutput(fixPlan([{ serves: ['u1.c1'], files: ['src/csv.ts'] }]));

describe('routing a stalled unit (5.1)', () => {
  test('split: a planned-fix group runs, and the unit passes when its re-check reads the fix', async () => {
    const asked: Record<string, unknown>[] = [];
    const planner = stepPlanner(oneUnitPlan(1), { fix: unitFix });
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { stallLimit: 2 },
      planner: planner.runner,
      scripts: { u1: keepsFailing(3), 'u1.f1.u1': finishes('fixed the parser') },
      port: answers(fixedOutputsMeet, routeAnswer('split', asked)),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    expect(asked).toHaveLength(1);
    expect(asked[0]!['unmet']).toEqual(['u1.c1']);
    expect(asked[0]!['lastOutput']).toContain('[unmet] attempt 2');
    expect((asked[0]!['lastNudges'] as string[]).length).toBe(2);
    expect(eventsOf(h, 'CONTRACT_STALLED').map((event) => [event.scope, event.targetId, event.route])).toEqual([['unit', 'u1', 'split']]);
    expect(eventsOf(h, 'CONTRACT_FIX_PLANNED').map((event) => [event.scope, event.targetId, event.groupId, event.unitIds, event.round])).toEqual([['unit', 'u1', 'u1.f1', ['u1.f1.u1'], 1]]);
    const fixGroup = done.groups.find((group) => group.id === 'u1.f1')!;
    expect(fixGroup.kind).toBe('fix');
    expect(fixGroup.repairs).toEqual({ scope: 'unit', targetId: 'u1', criterionIds: ['u1.c1'] });
    expect(fixGroup.status).toBe('passed');
    const fixUnit = done.units.find((unit) => unit.id === 'u1.f1.u1')!;
    expect(fixUnit.criteria.map((criterion) => [criterion.origin, criterion.serves])).toEqual([['fix', ['u1.c1']]]);
    const unit = done.units.find((candidate) => candidate.id === 'u1')!;
    expect(unit.fixRounds).toBe(1);
    expect(unit.checks.at(-1)).toMatchObject({ trigger: 'fix-passed', result: 'pass' });
    expect(done.decisions.some((decision) => decision.action === 'fix-planned' && decision.targetId === 'u1')).toBe(true);
    // The fix planner saw the target, its unmet criterion and the corrections already sent.
    const prompt = planner.of('fix')[0]!.userPrompt;
    expect(prompt).toContain('## The part to repair (unit u1)');
    expect(prompt).toContain('[u1.c1] (unmet');
    expect(prompt).toContain('## The last corrections sent');
  }, 20_000);

  test('fresh: the agent is replaced by one on a route picked for a fresh unit, with its previous checks, and passes', async () => {
    const seen = new Set<string>();
    const u1: AgentScript = (record, run) => {
      seen.add(record.id);
      return seen.size === 1 ? keepsFailing(3)(record, run) : finishes('clean start works')(record, run);
    };
    const purposes: string[] = [];
    const routeSelector: ContractRouteSelector = async (request) => {
      purposes.push(request.purpose);
      return { model: 'provider-a:model-a', provider: 'provider-a', reason: `${request.purpose} tier` };
    };
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { stallLimit: 2 }, scripts: { u1 }, routeSelector, port: routeAnswer('fresh') }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    const agents = h.agentsOf('u1');
    expect(agents).toHaveLength(2);
    expect(h.manager.getStatus(agents[1]!)!.task).toContain('Previous checks');
    expect(purposes).toContain('fresh-unit');
    expect(eventsOf(h, 'CONTRACT_UNIT_SPAWNED').map((event) => event.purpose)).toEqual(['unit', 'fresh-unit']);
    const unit = done.units[0]!;
    expect(unit.freshAgents).toBe(1);
    expect(unit.route?.reason).toBe('fresh-unit tier');
    expect(done.decisions.find((decision) => decision.action === 'fresh-agent')?.route?.reason).toBe('fresh-unit tier');
  }, 20_000);

  test('owner: the unit and the contract wait for the owner with the unmet criteria named', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { stallLimit: 2 }, scripts: { u1: keepsFailing(3) }, port: routeAnswer('owner') }));
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the owner to be asked', 15_000);
    const waiting = contractOf(h, contract.id);
    expect(waiting.units[0]!.status).toBe('awaiting-owner');
    expect(waiting.escalations).toHaveLength(1);
    const escalation = waiting.escalations[0]!;
    expect(escalation).toMatchObject({ scope: 'unit', targetId: 'u1', reason: 'stalled', unmetCriterionIds: ['u1.c1'] });
    expect(escalation.question).toContain(`Contract ${contract.id} needs your decision on unit "CSV parser".`);
    expect(escalation.question).toContain('Still not met:\n- [u1.c1] parser property 1');
    expect(eventsOf(h, 'CONTRACT_ESCALATED').map((event) => event.reason)).toEqual(['stalled']);
  }, 20_000);

  test('a route read below act goes to the owner', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { stallLimit: 2 }, scripts: { u1: keepsFailing(3) }, port: routeAnswer('split', [], 0.5) }));
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the owner to be asked', 15_000);
    expect(contractOf(h, contract.id).escalations[0]!.reason).toBe('stalled');
    expect(eventsOf(h, 'CONTRACT_STALLED')[0]!.route).toBe('owner');
    expect(eventsOf(h, 'CONTRACT_FIX_PLANNED')).toHaveLength(0);
  }, 20_000);

  test('when the fix rounds are spent the owner decides, without a route reading', async () => {
    const asked: Record<string, unknown>[] = [];
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { stallLimit: 2, maxFixRounds: 0 }, scripts: { u1: keepsFailing(3) }, port: routeAnswer('split', asked) }));
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the owner to be asked', 15_000);
    expect(asked).toHaveLength(0);
    const escalation = contractOf(h, contract.id).escalations[0]!;
    expect(escalation.reason).toBe('fix-rounds-exhausted');
    expect(escalation.question).toContain('The fix rounds allowed for this work are used up.');
    expect(escalation.question).toContain('approval cannot pass unmet criteria');
  }, 20_000);

  test('a fix plan that leaves a criterion unserved is sent back for repair before it runs', async () => {
    // The first fix plan serves a criterion the unit does not have, and leaves u1.c1 unserved.
    const plans = [plannerOutput(fixPlan([{ serves: ['u1.c2'] }])), unitFix()];
    const planner = stepPlanner(oneUnitPlan(1), { fix: () => plans.shift()! });
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      contract: { stallLimit: 2 },
      planner: planner.runner,
      scripts: { u1: keepsFailing(3), 'u1.f1.u1': finishes('fixed the parser') },
      port: answers(fixedOutputsMeet, routeAnswer('split')),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    expect(contractOf(h, contract.id).status).toBe('passed');
    const fixes = planner.of('fix');
    expect(fixes).toHaveLength(2);
    expect(fixes[1]!.attempt).toBe('repair');
    expect(fixes[1]!.userPrompt).toContain('[serves-unknown');
    expect(fixes[1]!.userPrompt).toContain('[uncovered-criterion u1.c1]');
  }, 20_000);
});

/** A one-unit plan whose group has a criterion of its own. */
function groupCriterionPlan(): DraftPlan {
  const plan = oneUnitPlan(1);
  return { ...plan, groups: [{ ...plan.groups[0]!, criteria: [{ id: 'g1.c1', text: 'the parser is exported', serves: ['c1'] }] }] };
}

/** Reads `kind`'s first check as failing and every later one as met. */
function failsFirst(kind: 'group' | 'deliverable') {
  let checks = 0;
  return (context: AnswerContext): unknown => {
    if (judgeOf(context) !== kind) return undefined;
    if (context.name === 'goal') checks += 1;
    return noulAnswer(checks <= 1 ? UNMET : MET);
  };
}

describe('groups and the deliverable (6.4)', () => {
  test('a group check that fails is repaired by a planned fix, then passes on its re-check', async () => {
    const planner = stepPlanner(groupCriterionPlan(), { fix: () => plannerOutput(fixPlan([{ serves: ['g1.c1'], files: ['src/index.ts'] }])) });
    const h = use(makeHarness({
      plan: groupCriterionPlan(),
      planner: planner.runner,
      scripts: { u1: finishes('parser written'), 'g1.f1.u1': finishes('exported the parser', 'src/index.ts') },
      port: failsFirst('group'),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    const group = done.groups.find((candidate) => candidate.id === 'g1')!;
    expect(group.checks.map((check) => [check.trigger, check.result])).toEqual([['completion', 'stall'], ['fix-passed', 'pass']]);
    expect(group.fixRounds).toBe(1);
    expect(group.criteria[0]!.readings.map((reading) => reading.verdict)).toEqual(['unmet', 'met']);
    expect(eventsOf(h, 'CONTRACT_FIX_PLANNED').map((event) => [event.scope, event.targetId, event.groupId])).toEqual([['group', 'g1', 'g1.f1']]);
    expect(eventsOf(h, 'CONTRACT_CHECKED').filter((event) => event.scope === 'group').map((event) => event.result)).toEqual(['stall', 'pass']);
    const statuses = eventsOf(h, 'CONTRACT_GROUP_STATUS_CHANGED').filter((event) => event.groupId === 'g1').map((event) => event.to);
    expect(statuses).toEqual(['running', 'judging', 'fixing', 'judging', 'passed']);
    // The group's evidence was its own diff and gates, with each unit's verdicts.
    const prompt = planner.of('fix')[0]!.userPrompt;
    expect(prompt).toContain('## The part to repair (group g1)');
  }, 20_000);

  test('a deliverable check that fails is repaired by a planned fix, then the contract passes', async () => {
    const planner = stepPlanner(oneUnitPlan(1), { fix: () => plannerOutput(fixPlan([{ serves: ['c1'], files: ['src/cli.ts'] }])) });
    const h = use(makeHarness({
      plan: oneUnitPlan(1),
      planner: planner.runner,
      scripts: scriptsWith({ u1: finishes('parser written') }, (unitId) => (unitId.endsWith('.f1.u1') ? finishes('wired the parser into the cli', 'src/cli.ts') : undefined)),
      port: failsFirst('deliverable'),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    expect(done.checks.map((check) => [check.trigger, check.result])).toEqual([['completion', 'stall'], ['fix-passed', 'pass']]);
    expect(done.fixRounds).toBe(1);
    expect(done.criteria[0]!.status).toBe('met');
    expect(eventsOf(h, 'CONTRACT_FIX_PLANNED').map((event) => [event.scope, event.groupId])).toEqual([['deliverable', `${contract.id}.f1`]]);
    const statuses = eventsOf(h, 'CONTRACT_STATUS_CHANGED').map((event) => event.to);
    expect(statuses.slice(statuses.indexOf('judging'))).toEqual(['judging', 'fixing', 'judging', 'committing', 'passed']);
    expect(done.commit?.status).toBe('committed');
  }, 20_000);

  test('a deliverable that fails with its fix rounds spent goes to the owner', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { maxFixRounds: 0 }, scripts: { u1: finishes('parser written') }, port: failsFirst('deliverable') }));
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the owner to be asked', 15_000);
    const escalation = contractOf(h, contract.id).escalations[0]!;
    expect(escalation).toMatchObject({ scope: 'deliverable', targetId: contract.id, reason: 'fix-rounds-exhausted', unmetCriterionIds: ['c1'] });
    expect(escalation.question).toContain('on the deliverable "A CSV parser"');
  }, 20_000);

  test('a group without criteria passes without a group check', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('parser written') } }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    expect(contractOf(h, contract.id).status).toBe('passed');
    expect(eventsOf(h, 'CONTRACT_CHECKED').map((event) => event.scope)).toEqual(['unit', 'deliverable']);
  }, 20_000);
});

describe('fix plans in code (5.2)', () => {
  const criterion = (id: string, status: Criterion['status'], severity?: 'critical' | 'major' | 'minor'): Criterion => ({
    id,
    text: `criterion ${id}`,
    origin: 'derived',
    serves: ['c1'],
    disposition: 'judged',
    status,
    readings: severity === undefined ? [] : [{ checkId: 'u1.k1', at: 1, probabilityUnmet: 0.9, verdict: 'unmet', outcome: 'act', severity, decisionId: undefined }],
  });
  const brief = (criteria: Criterion[]): FixBrief => ({
    scope: 'unit', targetId: 'u1', title: 'CSV parser', goal: 'Parse CSV', criteria,
    requiredIds: criteria.filter((entry) => entry.status !== 'met').map((entry) => entry.id),
    lastNudges: [], gateFailures: [], output: '', touchedPaths: [],
  });

  test('every code check reports its problem', () => {
    const target = brief([criterion('u1.c1', 'unmet'), criterion('u1.c2', 'met')]);
    const bad = fixPlan([{ serves: ['u1.c9'] }, { serves: ['u1.c2'], dependsOn: ['u7'] }]);
    const units = bad.groups[0]!.units;
    units[1] = { ...units[1]!, id: 'x1', role: 'review', attempts: 2 };
    const { problems } = validateFixPlan(plannerOutput(bad), target, { maxUnits: 1 });
    expect(problems.map((problem) => problem.code).sort()).toEqual(['attempts', 'bad-id', 'serves-unknown', 'too-many-units', 'uncovered-criterion', 'unknown-dependency', 'unknown-role']);
    expect(validateFixPlan('no json here', target, { maxUnits: 5 }).problems[0]!.code).toBe('unparseable');
    const two = plannerOutput({ ...fixPlan([{ serves: ['u1.c1'] }]), groups: [...fixPlan([{ serves: ['u1.c1'] }]).groups, ...fixPlan([{ serves: ['u1.c1'] }]).groups] });
    expect(validateFixPlan(two, target, { maxUnits: 5 }).problems[0]!.message).toContain('exactly one group');
  });

  test('units that change the same file run one after another, the most severe first', () => {
    const target = brief([criterion('u1.c1', 'unmet', 'minor'), criterion('u1.c2', 'unmet', 'critical')]);
    const checked = validateFixPlan(plannerOutput(fixPlan([{ serves: ['u1.c1'], files: ['src/a.ts'] }, { serves: ['u1.c2'], files: ['src/a.ts'] }, { serves: ['u1.c2'], files: ['src/b.ts'] }])), target, { maxUnits: 5 });
    expect(checked.problems).toEqual([]);
    const { group, units } = buildFixGroup(target, 2, checked.group!);
    expect(group).toMatchObject({ id: 'u1.f2', kind: 'fix', repairs: { scope: 'unit', targetId: 'u1', criterionIds: ['u1.c1', 'u1.c2'] }, unitIds: ['u1.f2.u1', 'u1.f2.u2', 'u1.f2.u3'] });
    // The critical fix to src/a.ts lands first; the minor one waits for it; src/b.ts runs alongside.
    expect(units.map((unit) => [unit.id, unit.dependsOn])).toEqual([['u1.f2.u1', ['u1.f2.u2']], ['u1.f2.u2', []], ['u1.f2.u3', []]]);
    expect(units[0]!.criteria[0]).toMatchObject({ id: 'u1.f2.u1.c1', origin: 'fix', serves: ['u1.c1'], status: 'unread' });
  });
});
