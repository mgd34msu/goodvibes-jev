/**
 * The runner's route selector over the route planner (contract/route.ts): the
 * planner is asked about the work in the contract's own words, for the purpose
 * the runner names (integration for every agent of an integration unit), and
 * its choice, failover chain and reason become the route. A planner failure is
 * the selector's failure, the same error, with no route made up in its place,
 * and the runner fails the contract with it wherever a route is asked for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { RoutePlanRequest } from '../../sdk/src/platform/routing/route-planner.js';
import { NoRouteError } from '../../sdk/src/platform/routing/route-planner.js';
import { createRoutePlannerContractSelector, type ContractPlannedRoute, type ContractRoutePlanner, type ContractRouteSelector } from '../../sdk/src/platform/contract/index.js';
import { makeContract, makeUnit } from './fixtures.js';
import { eventsOf, makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { amendmentOutput, answers, contractOf, keepsFailing, replyAnswers, routeAnswer, stepPlanner, terminal } from './steps-support.js';

/** The reason the route planner writes: the tier the work needs, the tier chosen from, the choice and the pick's confidence. */
const PLANNER_REASON = 'tier standard (tier reading standard at act); intent code_change, domain software, language english, difficulty 1.0/3, risk 1.0/3; no fitting standard model is configured, so the premium tier was used; chose alpha:model-1 from 2 premium candidates of 3 eligible models (pick 0.91, act)';

function fakePlanner(fallbacks: readonly string[]): { readonly planner: ContractRoutePlanner; readonly asked: RoutePlanRequest[] } {
  const asked: RoutePlanRequest[] = [];
  const planned: ContractPlannedRoute = { model: 'alpha:model-1', provider: 'alpha', fallbackModels: fallbacks, reason: PLANNER_REASON };
  return {
    asked,
    planner: {
      planRoute: async (request) => {
        asked.push(request);
        return planned;
      },
    },
  };
}

describe('createRoutePlannerContractSelector', () => {
  test('a unit is routed on its title, goal and brief, with the planner\'s choice, failover chain and reason', async () => {
    const { planner, asked } = fakePlanner(['beta:model-2', 'gamma:model-3']);
    const unit = makeUnit({ title: 'CSV parser', goal: 'Parse CSV', brief: 'Write src/csv.ts.' });
    const route = await createRoutePlannerContractSelector(planner)({ purpose: 'unit', contract: makeContract(), unit });
    expect(route).toEqual({ model: 'alpha:model-1', provider: 'alpha', fallbackModels: ['beta:model-2', 'gamma:model-3'], reason: PLANNER_REASON });
    expect(asked).toEqual([{ purpose: 'unit', brief: 'CSV parser: Parse CSV\n\nWrite src/csv.ts.', requires: { toolCalling: true } }]);
  });

  test('the planner agent is routed on the request, and a route without failover carries none', async () => {
    const { planner, asked } = fakePlanner([]);
    const route = await createRoutePlannerContractSelector(planner)({ purpose: 'planner', contract: makeContract({ ask: 'Add a --json flag.' }) });
    expect(route.fallbackModels).toBeUndefined();
    expect(route.reason).toBe(PLANNER_REASON);
    expect(asked[0]!.purpose).toBe('planner');
    expect(asked[0]!.brief).toContain('Add a --json flag.');
  });

  test('a fresh agent for an implementation unit is routed as a fresh unit on the unit\'s own work', async () => {
    const { planner, asked } = fakePlanner([]);
    await createRoutePlannerContractSelector(planner)({ purpose: 'fresh-unit', contract: makeContract(), unit: makeUnit() });
    expect(asked[0]!.purpose).toBe('fresh-unit');
    expect(asked[0]!.brief).toBe('Parser: Parse every documented input form\n\nWrite src/parser.ts and its tests.');
  });

  test('every agent of an integration unit is routed as integration work: its first agent, a fresh agent, and an attempt', async () => {
    const { planner, asked } = fakePlanner([]);
    const select = createRoutePlannerContractSelector(planner);
    const integration = makeUnit({ id: 'u3', role: 'integration', title: 'Wire the CLI' });
    await select({ purpose: 'integration', contract: makeContract(), unit: integration });
    await select({ purpose: 'fresh-unit', contract: makeContract(), unit: integration });
    await select({ purpose: 'unit', contract: makeContract(), unit: makeUnit({ id: 'u3#a1', role: 'integration', attemptOf: 'u3', attemptIndex: 1 }) });
    expect(asked.map((request) => request.purpose)).toEqual(['integration', 'integration', 'integration']);
  });

  test('no fitting model is the selector\'s failure, the planner\'s own error, and no default route is made up', async () => {
    const noRoute = new NoRouteError('No configured model fits this work: none of the 3 eligible models read as able to do it in any tier.');
    const failing: ContractRoutePlanner = { planRoute: async () => { throw noRoute; } };
    await expect(createRoutePlannerContractSelector(failing)({ purpose: 'unit', contract: makeContract(), unit: makeUnit() })).rejects.toBe(noRoute);
  });
});

describe('the runner when the route planner finds no route', () => {
  let harness: Harness | undefined;
  afterEach(() => {
    harness?.dispose();
    harness = undefined;
  });

  const noRoute = new NoRouteError('No configured model fits this work: none of the 3 eligible models read as able to do it in any tier.');
  const PLANNER_ROUTE = { model: 'provider-a:planner', provider: 'provider-a', reason: 'planner route' } as const;

  test('no route for a unit fails the contract when its group starts, and no unit agent is spawned', async () => {
    const routeSelector: ContractRouteSelector = async ({ purpose }) => {
      if (purpose === 'planner') return PLANNER_ROUTE;
      throw noRoute;
    };
    const h = makeHarness({ plan: oneUnitPlan(1), scripts: {}, routeSelector });
    harness = h;
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end');
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('failed');
    expect(done.failureKind).toBe('other');
    expect(done.error).toContain(`group g1 could not start: ${noRoute.message}`);
    expect(done.units[0]!.route).toBeUndefined();
    expect(eventsOf(h, 'CONTRACT_UNIT_SPAWNED')).toEqual([]);
  });

  test('no route for the planner an owner\'s amendment needs fails the contract, rather than leaving it waiting on a reply already given', async () => {
    let plannerRoutes = 0;
    const routeSelector: ContractRouteSelector = async ({ purpose }) => {
      if (purpose !== 'planner') return { model: 'provider-a:unit', provider: 'provider-a', reason: 'unit route' };
      plannerRoutes += 1;
      if (plannerRoutes === 1) return PLANNER_ROUTE;
      throw noRoute;
    };
    const planner = stepPlanner(oneUnitPlan(1), { amend: () => amendmentOutput([{ id: 'u1.c1', text: 'parser property 1, relaxed' }]) });
    const h = makeHarness({
      plan: oneUnitPlan(1),
      contract: { stallLimit: 2 },
      planner: planner.runner,
      scripts: { u1: keepsFailing(3) },
      port: answers(routeAnswer('owner'), replyAnswers([{ reading: 'amend' }])),
      routeSelector,
    });
    harness = h;
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner' || terminal(h, contract.id), 'the stalled escalation', 15_000);
    const escalation = contractOf(h, contract.id).escalations.at(-1)!;
    expect(escalation.reason).toBe('stalled');
    await expect(h.runner.reply(contract.id, escalation.id, 'Relax the first property.')).rejects.toBe(noRoute);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('failed');
    expect(done.failureKind).toBe('other');
    expect(done.error).toContain(`the owner's reply to ${escalation.id} could not be acted on: ${noRoute.message}`);
    expect(planner.of('amend')).toEqual([]);
  });
});
