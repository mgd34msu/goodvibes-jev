/**
 * The runner's route selector over the routing subsystem's route planner
 * (docs/design/contract-runner.md 2.2 and 6.1): the planner and every unit get
 * the model the route planner picks from the whole catalog for that piece of
 * work, with the other fitting models as the failover chain. No rule here
 * names a vendor or a model; the reason string records the planner's tier and
 * choice and is copied onto the unit and its agent record.
 */
import type { RoutePlanner } from '../routing/route-planner.js';
import type { ContractRouteSelector, UnitRoute } from './types.js';

/** What the route planner reads for each purpose: the work itself, in the contract's own words. */
function briefFor(request: Parameters<ContractRouteSelector>[0]): string {
  const { contract, unit } = request;
  if (request.purpose === 'planner') {
    return `Plan this work into units with acceptance criteria, reading the repository with read-only tools.\n\nThe request:\n${contract.ask}`;
  }
  if (unit === undefined) return contract.goal.length > 0 ? contract.goal : contract.ask;
  return [`${unit.title}: ${unit.goal}`, unit.brief].filter((part) => part.length > 0).join('\n\n');
}

export function createRoutePlannerContractSelector(planner: RoutePlanner): ContractRouteSelector {
  return async (request) => {
    const planned = await planner.planRoute({ purpose: request.purpose, brief: briefFor(request), requires: { toolCalling: true } });
    const route: UnitRoute = {
      model: planned.model,
      provider: planned.provider,
      ...(planned.fallbackModels.length === 0 ? {} : { fallbackModels: planned.fallbackModels }),
      reason: planned.reason,
    };
    return route;
  };
}
