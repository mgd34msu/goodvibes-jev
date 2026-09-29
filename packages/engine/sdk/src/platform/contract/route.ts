/**
 * The runner's route selector over the routing subsystem's route planner
 * (docs/design/contract-runner.md 2.2 and 6.1): the planner and every unit get
 * the model the route planner picks from the whole catalog for that piece of
 * work, with the other fitting models as the failover chain. No rule here
 * names a vendor or a model; the reason string is the planner's own account of
 * the tier the work needs, the tier it chose from, the model it chose and the
 * pick's confidence, and is copied onto the unit and its agent record.
 *
 * A planner failure (NoRouteError when no configured, healthy model fits, or a
 * Jev outage) is the selector's failure: nothing picks a model in its place,
 * and the runner fails the contract with the planner's message.
 */
import type { PlannedRoute, RoutePlanRequest } from '../routing/route-planner.js';
import type { ContractRouteSelector, UnitRoute } from './types.js';

/** What the selector reads from the route planner's answer. */
export type ContractPlannedRoute = Pick<PlannedRoute, 'model' | 'provider' | 'fallbackModels' | 'reason'>;

/** The route planner as the selector uses it (`createRoutePlanner` in `routing/route-planner.ts`). */
export interface ContractRoutePlanner {
  planRoute(request: RoutePlanRequest): Promise<ContractPlannedRoute>;
}

type RouteRequest = Parameters<ContractRouteSelector>[0];

/**
 * The purpose the route planner is told. An integration unit is integration
 * work whichever agent does it (its first agent, a fresh agent after a stall,
 * or one of its attempts), so the routing policy's floor for integration holds
 * for each of them.
 */
function routingPurpose(request: RouteRequest): string {
  return request.unit?.role === 'integration' ? 'integration' : request.purpose;
}

/** What the route planner reads for each purpose: the work itself, in the contract's own words. */
function briefFor(request: RouteRequest): string {
  const { contract, unit } = request;
  if (request.purpose === 'planner') {
    return `Plan this work into units with acceptance criteria, reading the repository with read-only tools.\n\nThe request:\n${contract.ask}`;
  }
  if (unit === undefined) return contract.goal.length > 0 ? contract.goal : contract.ask;
  return [`${unit.title}: ${unit.goal}`, unit.brief].filter((part) => part.length > 0).join('\n\n');
}

export function createRoutePlannerContractSelector(planner: ContractRoutePlanner): ContractRouteSelector {
  return async (request) => {
    const planned = await planner.planRoute({ purpose: routingPurpose(request), brief: briefFor(request), requires: { toolCalling: true } });
    const route: UnitRoute = {
      model: planned.model,
      provider: planned.provider,
      ...(planned.fallbackModels.length === 0 ? {} : { fallbackModels: [...planned.fallbackModels] }),
      reason: planned.reason,
    };
    return route;
  };
}
