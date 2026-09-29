/**
 * Planning end to end with a fake port and a fake planner runner (design
 * sections 3.1, 3.2 and 3.5): shaping, acceptance into the contract tree, the
 * repair loop sending every problem and stopping at its limit, the owner
 * escalation, dispositions, the tool contract under forbids_writing, and
 * planner failure failing the contract with `planning`, with no single-item
 * fallback.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import {
  acceptEscalatedPlan,
  buildContractPlannerPrompt,
  planContract,
  readPlannerBounds,
  shapeContract,
  withOwnerWritingDecision,
  type ContractPlannerDeps,
} from '../../sdk/src/platform/contract/planner.js';
import { NoRouteError } from '../../sdk/src/platform/routing/route-planner.js';
import { parseContractPlan, unitToolContract } from '../../sdk/src/platform/contract/plan-schema.js';
import type { ContractEvent } from '../../sdk/src/events/contract.js';
import type { Contract } from '../../sdk/src/platform/contract/index.js';
import { makeContract } from './fixtures.js';
import {
  ASK,
  configReader,
  planningPort,
  plannerOutput,
  PLANNER_ROUTE,
  scriptedRunner,
  shapeOf,
  singleUnitPlan,
  unitTitleOf,
  validPlan,
  type AnswerContext,
} from './plan-support.js';

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

/** A contract fresh from the queue: no plan yet. */
function queuedContract(overrides: Partial<Contract> = {}): Contract {
  return makeContract({ ask: ASK, status: 'queued', goal: '', criteria: [], groups: [], units: [], ...overrides });
}

function shapedContract(shape = shapeOf(), overrides: Partial<Contract> = {}): Contract {
  return queuedContract({ status: 'shaping', shape, ...overrides });
}

function harness(outputs: Parameters<typeof scriptedRunner>[0], contractSettings: Record<string, unknown> = {}) {
  const events: ContractEvent[] = [];
  const scripted = scriptedRunner(outputs);
  const routeRequests: string[] = [];
  const deps: ContractPlannerDeps = {
    decompositionRunner: scripted.runner,
    routeSelector: async (request) => {
      routeRequests.push(request.purpose);
      return PLANNER_ROUTE;
    },
    configManager: configReader(contractSettings, { 'planner.maxTurns': 9 }),
    emit: (event) => events.push(event),
    repositoryMap: async () => 'Repository map: src/ (3 files)',
    now: () => 5_000,
  };
  return { deps, events, requests: scripted.requests, routeRequests };
}

const ofType = <T extends ContractEvent['type']>(events: readonly ContractEvent[], type: T) =>
  events.filter((event): event is Extract<ContractEvent, { type: T }> => event.type === type);

describe('shapeContract', () => {
  test('stores the four readings, records the decision and emits CONTRACT_SHAPED', async () => {
    const fake = install(({ name }) => (name === 'requests_parallel_agents' ? noulAnswer(0.95) : undefined));
    const contract = queuedContract();
    const { deps, events } = harness([]);
    const outcome = await shapeContract(contract, deps);
    expect(outcome.kind).toBe('shaped');
    expect(contract.status).toBe('shaping');
    expect(contract.shape?.requests_parallel_agents).toEqual({ verdict: 'yes', probability: 0.95, outcome: 'act' });
    expect(contract.shape?.forbids_writing.verdict).toBe('no');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.state).toEqual({ request: ASK });
    expect(contract.decisions.map((decision) => decision.action)).toEqual(['shaped']);
    expect(contract.judgmentUsage).toEqual({ calls: 1, inputTokens: 1, outputTokens: 1 });
    expect(ofType(events, 'CONTRACT_SHAPED')[0]!.requestsParallelAgents.verdict).toBe('yes');
  });

  test('an unsettled forbids-writing reading asks the owner before planning', async () => {
    install(({ name }) => (name === 'forbids_writing' ? noulAnswer(0.5) : undefined));
    const contract = queuedContract();
    const { deps, events } = harness([]);
    const outcome = await shapeContract(contract, deps);
    expect(outcome.kind).toBe('awaiting-owner');
    expect(contract.status).toBe('awaiting-owner');
    expect(contract.escalations).toHaveLength(1);
    expect(contract.escalations[0]!.reason).toBe('writing-unclear');
    expect(contract.escalations[0]!.scope).toBe('shape');
    expect(contract.escalations[0]!.question).toContain('may change files');
    expect(ofType(events, 'CONTRACT_ESCALATED')).toHaveLength(1);
  });

  test('a forbids-writing yes below act also asks the owner', async () => {
    install(({ name }) => (name === 'forbids_writing' ? noulAnswer(0.7) : undefined));
    const outcome = await shapeContract(queuedContract(), harness([]).deps);
    expect(outcome.kind).toBe('awaiting-owner');
  });

  test('the owner deciding about writing makes a reading code acts on', () => {
    const shape = withOwnerWritingDecision(shapeOf([], { forbids_writing: { verdict: 'uncertain', probability: 0.5, outcome: 'escalate' } }), true);
    expect(unitToolContract('implement', shape).readOnly).toBe(true);
  });

  test('no port fails the contract as judgment-unavailable', async () => {
    const contract = queuedContract();
    const { deps, events } = harness([]);
    const outcome = await shapeContract(contract, deps);
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'judgment-unavailable' });
    expect(contract.status).toBe('failed');
    expect(contract.failureKind).toBe('judgment-unavailable');
    expect(ofType(events, 'CONTRACT_FAILED')[0]!.failureKind).toBe('judgment-unavailable');
  });
});

describe('planContract: acceptance', () => {
  test('a clean plan becomes the contract tree', async () => {
    install();
    const contract = shapedContract();
    const { deps, events, requests, routeRequests } = harness([plannerOutput(validPlan())]);
    const outcome = await planContract(contract, deps);
    expect(outcome.kind).toBe('accepted');
    expect(contract.status).toBe('checking-plan');
    expect(contract.goal).toBe(validPlan().goal);
    expect(contract.criteria.map((criterion) => [criterion.id, criterion.origin, criterion.disposition, criterion.status])).toEqual([
      ['c1', 'stated', 'judged', 'unread'], ['c2', 'stated', 'judged', 'unread'], ['c3', 'stated', 'judged', 'unread'],
    ]);
    expect(contract.criteria[0]!.quote).toBe('Add a CSV parser');
    expect(contract.groups.map((group) => [group.id, group.kind, group.status, group.unitIds])).toEqual([
      ['g1', 'work', 'pending', ['u1', 'u2']], ['g2', 'integration', 'blocked', ['u3']],
    ]);
    expect(contract.groups[0]!.criteria[0]!.origin).toBe('derived');
    expect(contract.units.map((unit) => [unit.id, unit.groupId, unit.role, unit.status, unit.attempts])).toEqual([
      ['u1', 'g1', 'implement', 'pending', 1], ['u2', 'g1', 'implement', 'pending', 1], ['u3', 'g2', 'integration', 'pending', 1],
    ]);
    expect(contract.units[2]!.criteria[0]!.origin).toBe('integration');
    expect(contract.units[0]!.criteria[0]!.serves).toEqual(['c1']);

    expect(routeRequests).toEqual(['planner']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.route).toEqual(PLANNER_ROUTE);
    expect(requests[0]!.attempt).toBe('initial');
    expect(requests[0]!.bounds.maxTurns).toBe(9);
    expect(requests[0]!.systemPrompt).toBe(buildContractPlannerPrompt());
    expect(requests[0]!.userPrompt).toContain(`<request>\n${ASK}\n</request>`);
    expect(requests[0]!.userPrompt).toContain('Repository map: src/ (3 files)');
    expect(contract.plannerAgentIds).toEqual(['planner-1']);

    expect(contract.decisions.map((decision) => decision.action)).toEqual(['spawned', 'planned', 'plan-accepted']);
    expect(contract.decisions[0]!.route).toEqual(PLANNER_ROUTE);
    expect(contract.decisions[2]!.reason).toContain('3 units in 2 groups');
    expect(contract.judgmentUsage.calls).toBe(10);
    expect(ofType(events, 'CONTRACT_PLAN_CHECKED').map((event) => [event.check, event.passed])).toEqual([
      ['structure', true], ['criterion-trace', true], ['plan-coverage', true], ['criterion-shape', true], ['unit-shape', true],
    ]);
    const planned = ofType(events, 'CONTRACT_PLANNED');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.repair).toBe(0);
    expect(planned[0]!.units.map((unit) => unit.id)).toEqual(['u1', 'u2', 'u3']);
    expect(ofType(events, 'CONTRACT_STATUS_CHANGED').map((event) => `${event.from}>${event.to}`)).toEqual(['shaping>planning', 'planning>checking-plan']);
  });

  test('proposed units and the shape reach the planner', async () => {
    install();
    const contract = shapedContract(shapeOf(['requests_parallel_agents', 'asks_for_attempts']));
    const { deps, requests } = harness([plannerOutput(validPlan())]);
    await planContract(contract, deps, { proposedUnits: [{ task: 'Write the CSV parser', template: 'engineer' }] });
    const prompt = requests[0]!.userPrompt;
    expect(prompt).toContain('- Write the CSV parser (template: engineer)');
    expect(prompt).toContain('separate agents working in parallel');
    expect(prompt).toContain('several attempts');
  });

  test('a unit without attempts runs contract.defaultAttempts', async () => {
    install();
    const contract = shapedContract();
    const { deps } = harness([plannerOutput(validPlan())], { defaultAttempts: 2 });
    await planContract(contract, deps);
    expect(contract.units.map((unit) => unit.attempts)).toEqual([2, 2, 2]);
  });

  test('excluded and met-by-structure dispositions reach the tree and the plan event', async () => {
    install(({ name, state }) => (name === 'topology_only' && String(state['criterion']).includes('convert') ? noulAnswer(0.95) : undefined));
    const excluded = shapedContract();
    const run = harness([plannerOutput(validPlan())]);
    await planContract(excluded, run.deps);
    const c3 = excluded.criteria.find((criterion) => criterion.id === 'c3')!;
    expect(c3.disposition).toBe('excluded');
    expect(c3.dispositionReason).toBe('requires an agent arrangement this plan does not use');
    expect(c3.status).toBe('unread');
    expect(ofType(run.events, 'CONTRACT_PLANNED')[0]!.criteria[2]!.disposition).toBe('excluded');
    expect(excluded.decisions.at(-1)!.reason).toContain('1 criterion excluded: requires an agent arrangement');

    const structural = shapedContract(shapeOf(['requests_parallel_agents']));
    await planContract(structural, harness([plannerOutput(validPlan())]).deps);
    const met = structural.criteria.find((criterion) => criterion.id === 'c3')!;
    expect(met.disposition).toBe('met-by-structure');
    expect(met.status).toBe('met');
    expect(met.dispositionReason).toContain('group g1');
  });

  test('under forbids_writing every accepted unit is read-only and the planner is told so', async () => {
    install();
    const shape = shapeOf(['forbids_writing']);
    const contract = shapedContract(shape);
    const { deps, requests } = harness([plannerOutput(validPlan())]);
    await planContract(contract, deps);
    expect(contract.units.map((unit) => unitToolContract(unit.role, shape).readOnly)).toEqual([true, true, true]);
    expect(requests[0]!.userPrompt).toContain('does not allow changing files');
  });

  test('without forbids_writing implementation units keep their tools', async () => {
    install();
    const shape = shapeOf();
    const contract = shapedContract(shape);
    await planContract(contract, harness([plannerOutput(validPlan())]).deps);
    expect(contract.units.map((unit) => unitToolContract(unit.role, shape).readOnly)).toEqual([false, false, false]);
  });
});

describe('planContract: the repair loop', () => {
  test('sends every problem back with the previous plan, then accepts the repaired plan', async () => {
    install(({ name, state }) => (name === 'narrows' && unitTitleOf(state) === 'Narrow parser' ? noulAnswer(0.9) : undefined));
    const broken = validPlan();
    broken.criteria[1]!.quote = 'a YAML formatter';
    broken.groups[0]!.units[1]!.criteria[0]!.serves = ['c1'];
    const narrowed = validPlan();
    narrowed.groups[0]!.units[0]!.title = 'Narrow parser';
    const contract = shapedContract();
    const { deps, requests, events } = harness([plannerOutput(broken), plannerOutput(narrowed), plannerOutput(validPlan())]);
    const outcome = await planContract(contract, deps);

    expect(outcome.kind).toBe('accepted');
    expect(requests.map((request) => request.attempt)).toEqual(['initial', 'repair', 'repair']);
    const first = requests[1]!.userPrompt;
    expect(first).toContain('[uncovered-criterion c2]');
    expect(first).toContain('[quote-not-found c2]');
    expect(first).toContain('a YAML formatter');
    const second = requests[2]!.userPrompt;
    expect(second).toContain('[narrows u1]');
    expect(second).toContain('"title": "Narrow parser"');
    expect(second).not.toContain('[quote-not-found');
    expect(contract.decisions.map((decision) => decision.action)).toEqual(['spawned', 'planned', 'plan-repaired', 'planned', 'plan-repaired', 'planned', 'plan-accepted']);
    expect(ofType(events, 'CONTRACT_PLANNED').map((event) => event.repair)).toEqual([1, 2]);
    expect(routeRequestsOnce(requests)).toBe(true);
  });

  test('an unparseable answer is repaired like any other problem', async () => {
    install();
    const contract = shapedContract();
    const { deps, requests } = harness(['I will plan this later.', plannerOutput(validPlan())]);
    const outcome = await planContract(contract, deps);
    expect(outcome.kind).toBe('accepted');
    expect(requests[1]!.userPrompt).toContain('[unparseable]');
  });

  test('stops at contract.planRepairLimit and asks the owner with every problem and the plan', async () => {
    install(({ name }) => (name === 'uncovered_requirement' ? noulAnswer(0.9) : undefined));
    const contract = shapedContract();
    const { deps, requests, events } = harness([plannerOutput(validPlan())], { planRepairLimit: 2 });
    const outcome = await planContract(contract, deps);
    expect(requests).toHaveLength(3);
    expect(outcome.kind).toBe('awaiting-owner');
    expect(contract.status).toBe('awaiting-owner');
    const escalation = contract.escalations[0]!;
    expect(escalation.reason).toBe('plan-unresolved');
    expect(escalation.scope).toBe('plan');
    expect(escalation.question).toContain('[uncovered-requirement]');
    expect(escalation.question).toContain('Reply to approve accepting the plan as it stands');
    const shown = parseContractPlan(escalation.question);
    expect(shown.ok && shown.plan.goal).toBe(validPlan().goal);
    expect(ofType(events, 'CONTRACT_ESCALATED')[0]!.reason).toBe('plan-unresolved');
    expect(contract.units).toEqual([]);
  });

  test('a repair limit of zero asks the owner after the first plan', async () => {
    install(({ name }) => (name === 'uncovered_requirement' ? noulAnswer(0.9) : undefined));
    const { deps, requests } = harness([plannerOutput(validPlan())], { planRepairLimit: 0 });
    const outcome = await planContract(shapedContract(), deps);
    expect(requests).toHaveLength(1);
    expect(outcome.kind).toBe('awaiting-owner');
  });

  test('an owner instruction amends the previous plan', async () => {
    install();
    const contract = shapedContract(shapeOf(), { status: 'awaiting-owner' });
    const { deps, requests } = harness([plannerOutput(validPlan())]);
    const outcome = await planContract(contract, deps, { ownerInstruction: 'Drop the JSON tests requirement.', previousPlan: '{"goal":"old"}' });
    expect(outcome.kind).toBe('accepted');
    expect(requests[0]!.userPrompt).toContain("## The owner's instruction");
    expect(requests[0]!.userPrompt).toContain('Drop the JSON tests requirement.');
    expect(requests[0]!.userPrompt).toContain('{"goal":"old"}');
  });
});

function routeRequestsOnce(requests: readonly { readonly route?: unknown }[]): boolean {
  return requests.every((request) => request.route === PLANNER_ROUTE);
}

describe('planContract: failure, with no single-item fallback', () => {
  for (const [label, result] of [
    ['a spawn failure', { status: 'failed', detail: 'spawn refused' }],
    ['a cancelled or bounded-out planner', { status: 'cancelled', detail: 'wall-timeout 120000ms' }],
  ] as const) {
    test(`${label} fails the contract with planning`, async () => {
      install();
      const contract = shapedContract();
      const { deps, events, requests } = harness([result]);
      const outcome = await planContract(contract, deps);
      expect(outcome.kind).toBe('failed');
      expect(requests).toHaveLength(1);
      expect(contract.status).toBe('failed');
      expect(contract.failureKind).toBe('planning');
      expect(contract.error).toContain(result.detail);
      expect(contract.units).toEqual([]);
      expect(contract.groups).toEqual([]);
      expect(ofType(events, 'CONTRACT_FAILED')[0]).toMatchObject({ failureKind: 'planning' });
    });
  }

  test('a planner that never writes a readable plan fails with planning after the repair budget', async () => {
    install();
    const contract = shapedContract();
    const { deps, requests } = harness(['no plan here'], { planRepairLimit: 1 });
    const outcome = await planContract(contract, deps);
    expect(requests).toHaveLength(2);
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'planning' });
    expect(contract.error).toContain('not a readable plan after 1 repairs');
    expect(contract.units).toEqual([]);
  });

  test('no route for the planner fails the contract with planning and the route planner\'s reason, and no planner agent runs', async () => {
    install();
    const contract = shapedContract();
    const { deps, requests } = harness([plannerOutput(validPlan())]);
    const noRoute = new NoRouteError('No configured, healthy provider serves a model that meets this work\'s requirements (tool calling, context window, image input).');
    const outcome = await planContract(contract, { ...deps, routeSelector: async () => { throw noRoute; } });
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'planning' });
    expect(contract.error).toBe(`no route for the planner: ${noRoute.message}`);
    expect(requests).toHaveLength(0);
  });

  test('a Jev outage while routing the planner fails the contract as judgment-unavailable', async () => {
    install();
    const contract = shapedContract();
    const { deps, requests } = harness([plannerOutput(validPlan())]);
    const outcome = await planContract(contract, { ...deps, routeSelector: async () => { throw new JudgmentError('unavailable', 'endpoint down'); } });
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'judgment-unavailable' });
    expect(contract.error).toBe('no route for the planner: Jev could not answer: endpoint down');
    expect(requests).toHaveLength(0);
  });

  test('a Jev outage during the checks fails the contract as judgment-unavailable', async () => {
    install(() => { throw new JudgmentError('unavailable', 'endpoint down'); });
    const contract = shapedContract();
    const outcome = await planContract(contract, harness([plannerOutput(validPlan())]).deps);
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'judgment-unavailable' });
  });

  test('no port during the checks fails the contract as judgment-unavailable', async () => {
    const contract = shapedContract();
    const outcome = await planContract(contract, harness([plannerOutput(validPlan())]).deps);
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'judgment-unavailable' });
    expect(contract.error).toContain('No judgment port');
  });

  test('an aborted signal ends planning as cancelled without failing the contract', async () => {
    install();
    const controller = new AbortController();
    controller.abort();
    const contract = shapedContract();
    const outcome = await planContract(contract, harness([plannerOutput(validPlan())]).deps, { signal: controller.signal });
    expect(outcome.kind).toBe('cancelled');
    expect(contract.status).toBe('planning');
  });

  test('the planner never reaches the heuristic decomposition or a single-item proposal', () => {
    const source = readFileSync(join(import.meta.dir, '../../sdk/src/platform/contract/planner.ts'), 'utf8');
    const imports = source.match(/^import[\s\S]*?from '[^']+';$/gm)!.join('\n');
    expect(imports).toContain('DecompositionRunner,');
    for (const name of ['decomposeGoal', 'singleItemProposal', 'assemblePlanProposal', 'AdaptivePlanner']) expect(imports).not.toContain(name);
  });

  test('planning without a shape is a programming error', async () => {
    await expect(planContract(queuedContract(), harness([]).deps)).rejects.toThrow('no request shape');
  });
});

describe('acceptEscalatedPlan', () => {
  async function escalated() {
    install(({ name }) => (name === 'uncovered_requirement' ? noulAnswer(0.9) : undefined));
    const contract = shapedContract();
    const run = harness([plannerOutput(validPlan())], { planRepairLimit: 0 });
    await planContract(contract, run.deps);
    return { contract, run };
  }

  test('an owner approval accepts exactly the plan the owner was shown', async () => {
    const { contract, run } = await escalated();
    install(({ name, state }) => (name === 'topology_only' && String(state['criterion']).includes('convert') ? noulAnswer(0.95) : undefined));
    const outcome = await acceptEscalatedPlan(contract, contract.escalations[0]!, run.deps);
    expect(outcome.kind).toBe('accepted');
    expect(contract.units.map((unit) => unit.id)).toEqual(['u1', 'u2', 'u3']);
    expect(contract.criteria.find((criterion) => criterion.id === 'c3')!.disposition).toBe('excluded');
    expect(contract.decisions.at(-1)!.action).toBe('plan-accepted');
    expect(contract.decisions.at(-1)!.reason).toContain('approved by the owner');
  });

  test('a plan the engine cannot run is refused even with approval', async () => {
    const { contract, run } = await escalated();
    const cyclic = validPlan();
    cyclic.groups[0]!.units[0]!.dependsOn = ['u2'];
    cyclic.groups[0]!.units[1]!.dependsOn = ['u1'];
    const question = contract.escalations[0]!.question.replace(/```json[\s\S]*```/, '```json\n' + JSON.stringify(cyclic) + '\n```');
    const outcome = await acceptEscalatedPlan(contract, { ...contract.escalations[0]!, question }, run.deps);
    expect(outcome.kind).toBe('unrunnable');
    if (outcome.kind === 'unrunnable') expect(outcome.problems.map((problem) => problem.code)).toEqual(['cycle']);
    expect(contract.units).toEqual([]);
  });

  test('only a plan escalation can be approved this way', async () => {
    const contract = shapedContract();
    const escalation = { id: 'e1', at: 1, scope: 'shape' as const, targetId: contract.id, reason: 'writing-unclear' as const, question: 'q', unmetCriterionIds: [] };
    await expect(acceptEscalatedPlan(contract, escalation, harness([]).deps)).rejects.toThrow('not about the plan');
  });
});

test('a single-unit plan is accepted without an integration group', async () => {
  install(({ name, question }) => (name === 'role' ? choiceAnswer(question, 'implement', 0.95) : undefined));
  const contract = shapedContract(shapeOf(['forbids_delegation']));
  const { deps, requests } = harness([plannerOutput(singleUnitPlan())]);
  const outcome = await planContract(contract, deps);
  expect(outcome.kind).toBe('accepted');
  expect(contract.groups.map((group) => group.kind)).toEqual(['work']);
  expect(requests[0]!.userPrompt).toContain('plan exactly one unit');
});

test('the planner bounds come from planner.* settings with a finite guard', () => {
  expect(readPlannerBounds(configReader({}, { 'planner.maxTurns': 4, 'planner.tokenCeiling': Number.NaN }))).toEqual({
    maxTurns: 4, tokenCeiling: 120_000, wallTimeoutMs: 120_000,
  });
});
