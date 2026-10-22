/**
 * Correction when nudging stalls (docs/design/contract-runner.md section 5),
 * on the contract runner with the fake judgment port and a scripted executor:
 * each stall route (split, fresh, owner), a route read below act, the fix
 * rounds running out, planned-fix groups for a unit, a group and the
 * deliverable, and the code checks on a fix plan.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { hashState, JudgmentError, SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { hasContractPlanConsumer } from '../../sdk/src/platform/tools/agent/contract-binding.js';
import { buildFixGroup, validateFixPlan, type ContractRouteSelector, type Criterion, type FixBrief } from '../../sdk/src/platform/contract/index.js';
import { plannerOutput, type AnswerContext, type DraftPlan } from './plan-support.js';
import { eventsOf, makeHarness, oneUnitPlan, startContract, waitFor, type AgentScript, type Harness } from './runner-support.js';
import { makeGroup, makeUnit } from './fixtures.js';
import {
  MET,
  UNMET,
  answers,
  contractOf,
  finishes,
  fixPlan,
  fixedOutputsMeet,
  git,
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

describe('routing a stalled unit', () => {
  test.each(['stall-route', 'planner-route'] as const)('a temporary %s outage retries its reading without repeating workers or spending a repair round', async site => {
    let stallReadings = 0, plannerRoutes = 0;
    const planner = stepPlanner(oneUnitPlan(1), { fix: unitFix });
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { stallLimit: 2, maxFixRounds: 1 },
      planner: planner.runner, scripts: { u1: keepsFailing(3), 'u1.f1.u1': finishes('fixed the parser') },
      routeSelector: async request => {
        if (request.purpose === 'planner' && ++plannerRoutes === 2 && site === 'planner-route')
          throw new JudgmentError('unavailable', 'temporary route transport outage');
        return { model: 'provider-a:model-a', provider: 'provider-a', reason: request.purpose };
      },
      port: answers(fixedOutputsMeet, context => {
        if (context.name !== 'route') return undefined;
        if (++stallReadings === 1 && site === 'stall-route') throw new JudgmentError('unavailable', 'temporary stall transport outage');
        return choiceAnswer(context.question, 'split', 0.95);
      }),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'recovered correction to finish', 15_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    expect(done.units[0]!.fixRounds).toBe(1);
    expect(h.agentsOf('u1')).toHaveLength(1);
    expect(h.agentsOf('u1.f1.u1')).toHaveLength(1);
    expect(planner.of('fix')).toHaveLength(1);
    expect(done.decisions.filter(decision => decision.action === 'resumed' && decision.reason.includes('correction budget unchanged'))).toHaveLength(1);
    expect(stallReadings).toBe(site === 'stall-route' ? 2 : 1);
    expect(plannerRoutes).toBe(site === 'planner-route' ? 3 : 2);
  }, 20_000);

  test('cancelling during a correction reading outage stops retries without starting a repair', async () => {
    let readings = 0;
    const planner = stepPlanner(oneUnitPlan(1), { fix: unitFix });
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { stallLimit: 2 }, planner: planner.runner,
      scripts: { u1: keepsFailing(3) }, port: context => {
        if (context.name === 'route') { readings++; throw new JudgmentError('unavailable', 'temporary transport outage'); }
        return undefined;
      } }));
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).decisions.some(decision => decision.reason.includes('correction budget unchanged')), 'pending correction reading');
    h.runner.cancel(contract.id, 'operator cancelled the task');
    await h.runner.join(contract.id);
    expect(contractOf(h, contract.id).status).toBe('cancelled');
    expect(readings).toBe(1);
    expect(planner.of('fix')).toHaveLength(0);
    expect(contractOf(h, contract.id).units[0]!.fixRounds).toBe(0);
  });

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
    expect(hasContractPlanConsumer(planner.of('fix')[0]!)).toBe(true);
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

  test('the route preserves the current verdict without treating weak confidence as unshown work', async () => {
    const asked: Record<string, unknown>[] = [];
    // u1.c1 reads unmet; a tie for u1.c2 does not invent unmet or unshown work.
    const failsAndUnshown: AgentScript = () => Array.from({ length: 3 }, (_, index) => ({ files: { 'src/csv.ts': `attempt ${index}\n` }, text: `[unmet] attempt ${index} [p=0.9,0.5]` }));
    const h = use(makeHarness({ plan: oneUnitPlan(2), contract: { stallLimit: 2 }, scripts: { u1: failsAndUnshown }, port: routeAnswer('owner', asked) }));
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the owner to be asked', 15_000);
    expect(asked).toHaveLength(1);
    expect(asked[0]!['unmet']).toEqual(['u1.c1']);
    expect(asked[0]!['unshown']).toEqual([]);
    const escalation = contractOf(h, contract.id).escalations[0]!;
    expect(escalation.unmetCriterionIds).toEqual(['u1.c1']);
    expect(escalation.question).not.toContain('Not shown:');
    expect(contractOf(h, contract.id).units[0]!.criteria[1]!.status).toBe('met');
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
    let h: Harness;
    h = use(makeHarness({ plan: oneUnitPlan(1), contract: { stallLimit: 2, maxFixRounds: 1 }, scripts: { u1: (record, run) => {
      h.store.get(record.contractId!)!.units[0]!.fixRounds = 1;
      return keepsFailing(3)(record, run);
    } }, port: routeAnswer('split', asked) }));
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

describe('a merge conflict (7.4)', () => {
  /** Two independent units in one group that both write src/shared.ts, then an integration unit. */
  function conflictingPlan(): DraftPlan {
    const unit = (id: string) => ({
      id, title: `Writer ${id}`, goal: `Write ${id}'s part`, role: 'implement', brief: 'Write src/shared.ts.',
      dependsOn: [], files: ['src/shared.ts'], attempts: undefined,
      criteria: [{ id: `${id}.c1`, text: `${id}'s part is written`, serves: ['c1'] }],
    });
    return {
      goal: 'A shared module',
      criteria: [{ id: 'c1', text: 'A CSV parser module exists', quote: 'Add a CSV parser module' }],
      groups: [
        { id: 'g1', title: 'Writers', goal: 'Both parts', kind: 'work', dependsOn: [], criteria: [], units: [unit('u1'), unit('u2')] },
        {
          id: 'g2', title: 'Integration', goal: 'Join the parts', kind: 'integration', dependsOn: ['g1'], criteria: [],
          units: [{ ...unit('u3'), role: 'integration', files: [], criteria: [{ id: 'u3.c1', text: 'the parts are joined', serves: ['c1'] }] }],
        },
      ],
    };
  }

  test('a unit whose branch conflicts goes to a planned fix without a route reading, and passes on its re-check', async () => {
    const asked: Record<string, unknown>[] = [];
    const planner = stepPlanner(conflictingPlan(), { fix: (prompt) => plannerOutput(fixPlan([{ serves: [/unit (u\d)\)/.exec(prompt)![1]! + '.c1'], files: ['src/shared.ts'] }])) });
    const h = use(makeHarness({
      plan: conflictingPlan(),
      contract: { isolation: 'auto' },
      planner: planner.runner,
      scripts: scriptsWith(
        { u1: finishes('u1 wrote its part', 'src/shared.ts'), u2: finishes('u2 wrote its part', 'src/shared.ts'), u3: finishes('joined the parts', 'src/index.ts') },
        (unitId) => (unitId.endsWith('.f1.u1') ? finishes('resolved both parts', 'src/shared.ts') : undefined),
      ),
      port: answers(fixedOutputsMeet, routeAnswer('owner', asked)),
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 20_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    const conflicts = eventsOf(h, 'CONTRACT_MERGE_CONFLICT');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.files).toEqual(['src/shared.ts']);
    const conflicted = conflicts[0]!.unitId;
    expect(asked).toHaveLength(0);
    expect(eventsOf(h, 'CONTRACT_STALLED').map((event) => [event.targetId, event.route])).toEqual([[conflicted, 'split']]);
    expect(eventsOf(h, 'CONTRACT_FIX_PLANNED').map((event) => event.groupId)).toEqual([`${conflicted}.f1`]);
    expect(planner.of('fix')[0]!.userPrompt).toContain('## Merge conflict');
    expect(done.units.find((unit) => unit.id === conflicted)!.checks.at(-1)).toMatchObject({ trigger: 'fix-passed', result: 'pass' });
    expect(git(h.root, 'show', 'HEAD:src/shared.ts')).toBe('resolved both parts\n');
  }, 30_000);
});

/** A one-unit plan whose group has a criterion of its own. */
function groupCriterionPlan(): DraftPlan {
  const plan = oneUnitPlan(1);
  return { ...plan, groups: [{ ...plan.groups[0]!, criteria: [{ id: 'g1.c1', text: 'the parser is exported', serves: ['c1'] }] }] };
}

/** Content approval cannot repair the first rejected work; actual changed source or fix evidence can. */
function failsUntilRepairedWork(kind: 'group' | 'deliverable') {
  let rejectedBasis: string | undefined;
  return (context: AnswerContext): unknown => {
    if (judgeOf(context) !== kind) return undefined;
    const { finalAnswerReview: _review, previousFulfillmentAssessment: _previous, ...work } = context.state['evidence'] as Record<string, unknown>;
    // Content approval changes the verifier phase and attaches actual execution
    // provenance. The original prepared-evidence digest still binds the same
    // work; a new phase label is not an implementation repair.
    const full = work['fullSourceEvidence'] as { digest?: string } | undefined;
    const basis = JSON.stringify({ output: context.state['output'], work: full?.digest ?? work });
    rejectedBasis ??= basis;
    return noulAnswer(basis === rejectedBasis ? UNMET : MET);
  };
}

describe('groups and the deliverable (6.4)', () => {
  test('a repair after a budget reset runs with new identities and preserves the earlier accepted group', async () => {
    const planner = stepPlanner(oneUnitPlan(1), { fix: () => plannerOutput(fixPlan([{ serves: ['c1'], files: ['src/cli.ts'] }])) });
    const failing = failsUntilRepairedWork('deliverable'); let id = ''; let retained = ''; let seeded = false;
    const h = use(makeHarness({ plan: oneUnitPlan(1), planner: planner.runner,
      scripts: scriptsWith({ u1: finishes('parser written') }, unitId => unitId.endsWith('.f2.u1') ? finishes('wired the parser', 'src/cli.ts') : undefined),
      port: context => {
        if (!seeded && judgeOf(context) === 'deliverable' && context.name === 'goal') {
          seeded = true;
          const contract = h.store.get(id)!;
          const group = makeGroup({ id: `${id}.f1`, kind: 'fix', status: 'passed', unitIds: [`${id}.f1.u1`],
            repairs: { scope: 'deliverable', targetId: id, criterionIds: ['c1'] } });
          const unit = makeUnit({ id: `${id}.f1.u1`, groupId: group.id, status: 'passed', criteria: [], answer: 'Accepted earlier work' });
          contract.groups.push(group); contract.units.push(unit); contract.fixRounds = 0;
          retained = JSON.stringify({ group, unit });
        }
        return failing(context);
      },
    }));
    id = startContract(h).contract.id;
    await waitFor(() => terminal(h, id), 'the new repair to finish', 15_000);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(JSON.stringify({ group: done.groups.find(group => group.id === `${id}.f1`), unit: done.units.find(unit => unit.id === `${id}.f1.u1`) })).toBe(retained);
    expect(done.units.find(unit => unit.id === `${id}.f2.u1`)!.status).toBe('passed');
    expect(done.fixRounds).toBe(1);
    expect(new Set(done.units.map(unit => unit.id)).size).toBe(done.units.length);
  }, 20_000);

  test('a passed answer repair replaces the rejected draft without repeating the completed implementation', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const plan = oneUnitPlan(1);
    const repair = fixPlan([{ serves: ['c1'], files: [] }]);
    repair.groups[0]!.units[0]!.role = 'research';
    const planner = stepPlanner(plan, { fix: () => plannerOutput(repair) });
    const corrected = 'The parser is implemented in src/csv.ts. No runtime verification is claimed.';
    const decoded = `  ${corrected}\n`;
    const report = '```json\n' + JSON.stringify({ version: 1, archetype: 'research', summary: 'Corrected the final response.', result: 'Supporting context retained.', finalAnswer: decoded }) + '\n```';
    const sources: unknown[] = [];
    const h = use(makeHarness({ plan, planner: planner.runner, decisionLog: log,
      scripts: scriptsWith({ u1: finishes('OLD_UNSUPPORTED_CRC') }, id => id.endsWith('.f1.u1') ? () => [{ text: report }] : undefined),
      port: context => {
        if (context.state['output'] === corrected && (context.name === 'unfinished' || context.name === 'goal' && judgeOf(context) === 'deliverable')) {
          const evidence = context.state['evidence'] as { orchestration: { currentAnswerSource: unknown } };
          sources.push(evidence.orchestration.currentAnswerSource);
        }
        if (context.name === 'role' && (context.state['unit'] as { title?: string })?.title === 'Fix 1') return choiceAnswer(context.question, 'research', 0.98);
        if (context.name === 'unsupported') return noulAnswer(String(context.state['output']).includes('OLD_UNSUPPORTED_CRC') ? 0.98 : 0.03);
        return undefined;
      },
    }));
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the repaired answer to pass', 15_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    expect(h.agentsOf('u1')).toHaveLength(1);
    expect(done.units[0]!.answer).toContain('OLD_UNSUPPORTED_CRC');
    expect(done.units.find(unit => unit.id.endsWith('.f1.u1'))!.status).toBe('passed');
    expect(h.manager.getStatus(done.ownerAgentId!)!.fullOutput).toBe(corrected);
    expect(planner.of('fix')).toHaveLength(1);
    const fixed = done.units.find(unit => unit.id.endsWith('.f1.u1'))!;
    expect(fixed.checks.at(-1)!.decisionIds.length).toBeGreaterThan(0);
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source).toMatchObject({ unitId: fixed.id, rawReportDigest: hashState(fixed.answer!),
        reportAt: { storage: 'native-contract-store', contractId: done.id, unitId: fixed.id, field: 'answer' },
        reportMetadata: { summary: 'Corrected the final response.', result: 'Supporting context retained.' },
        field: 'finalAnswer', decodedFieldDigest: hashState(decoded), outputDigest: hashState(corrected),
        nativeUnitCheck: { id: fixed.checks.at(-1)!.id, result: 'pass', decisionIds: fixed.checks.at(-1)!.decisionIds } });
      expect((source as { reportMetadata: unknown }).reportMetadata).not.toHaveProperty('finalAnswer');
      expect(source).not.toHaveProperty('rootPassed');
    }
  }, 20_000);

  test('a group check that fails is repaired by a planned fix, then passes on its re-check', async () => {
    const planner = stepPlanner(groupCriterionPlan(), { fix: () => plannerOutput(fixPlan([{ serves: ['g1.c1'], files: ['src/index.ts'] }])) });
    const h = use(makeHarness({
      plan: groupCriterionPlan(),
      planner: planner.runner,
      scripts: { u1: finishes('parser written'), 'g1.f1.u1': finishes('exported the parser', 'src/index.ts') },
      port: failsUntilRepairedWork('group'),
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
      port: failsUntilRepairedWork('deliverable'),
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
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { maxFixRounds: 1 }, scripts: { u1: finishes('parser written') }, port: failsUntilRepairedWork('deliverable') }));
    const { contract } = startContract(h);
    h.store.get(contract.id)!.fixRounds = 1;
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
