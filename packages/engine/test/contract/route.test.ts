/**
 * The runner's route selector over the route planner (contract/route.ts): the
 * planner is asked about the work in the contract's own words, for the purpose
 * the runner names, and its choice, failover chain and reason become the route.
 */
import { describe, expect, test } from 'bun:test';
import type { PlannedRoute, RoutePlanner, RoutePlanRequest } from '../../sdk/src/platform/routing/route-planner.js';
import { createRoutePlannerContractSelector } from '../../sdk/src/platform/contract/index.js';
import { makeContract, makeUnit } from './fixtures.js';

function planner(fallbacks: readonly string[]): { readonly planner: RoutePlanner; readonly asked: RoutePlanRequest[] } {
  const asked: RoutePlanRequest[] = [];
  return {
    asked,
    planner: {
      planRoute: async (request) => {
        asked.push(request);
        return { model: 'alpha:model-1', provider: 'alpha', modelId: 'model-1', fallbackModels: fallbacks, reason: 'implementer tier; chose model-1' } as unknown as PlannedRoute;
      },
    },
  };
}

describe('createRoutePlannerContractSelector', () => {
  test('a unit is routed on its title, goal and brief, with the planner\'s failover chain and reason', async () => {
    const { planner: routePlanner, asked } = planner(['beta:model-2']);
    const unit = makeUnit({ title: 'CSV parser', goal: 'Parse CSV', brief: 'Write src/csv.ts.' });
    const route = await createRoutePlannerContractSelector(routePlanner)({ purpose: 'unit', contract: makeContract(), unit });
    expect(route).toEqual({ model: 'alpha:model-1', provider: 'alpha', fallbackModels: ['beta:model-2'], reason: 'implementer tier; chose model-1' });
    expect(asked).toEqual([{ purpose: 'unit', brief: 'CSV parser: Parse CSV\n\nWrite src/csv.ts.', requires: { toolCalling: true } }]);
  });

  test('the planner agent is routed on the request, and a route without failover carries none', async () => {
    const { planner: routePlanner, asked } = planner([]);
    const route = await createRoutePlannerContractSelector(routePlanner)({ purpose: 'planner', contract: makeContract({ ask: 'Add a --json flag.' }) });
    expect(route.fallbackModels).toBeUndefined();
    expect(asked[0]!.purpose).toBe('planner');
    expect(asked[0]!.brief).toContain('Add a --json flag.');
  });

  test('a planner failure is the selector\'s failure; no default route is made up', async () => {
    const failing: RoutePlanner = { planRoute: async () => { throw new Error('no configured provider fits'); } };
    await expect(createRoutePlannerContractSelector(failing)({ purpose: 'unit', contract: makeContract(), unit: makeUnit() })).rejects.toThrow('no configured provider fits');
  });
});
