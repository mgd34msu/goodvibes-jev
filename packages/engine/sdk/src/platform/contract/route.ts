/**
 * Assign planners and units using Jev within the user's captured provider and
 * model family. The same boundary covers every fallback; the session's own
 * model selection is never changed. Wait for catalog discovery before routing.
 */
import type { PlannedRoute, RoutePlanRequest } from '../routing/route-planner.js';
import type { ContractRouteSelector, UnitRoute } from './types.js';
import { nativeContractSourceForAdmission } from './native-source.js';

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

export interface ContractSelectorOptions {
  /** Only for older contracts that predate captured user selections. */
  readonly getSelectedModel?: (() => Pick<import('../providers/registry-types.js').ModelDefinition, 'id' | 'provider' | 'registryKey' | 'displayName'>) | undefined;
  /** Resolves when the catalog the route planner reads has settled (the provider registry's startup model discovery); awaited before every pick. */
  readonly catalogSettled?: (() => Promise<void>) | undefined;
}

export function createRoutePlannerContractSelector(planner: ContractRoutePlanner, options: ContractSelectorOptions = {}): ContractRouteSelector {
  return async (request) => {
    request.signal?.throwIfAborted();
    await options.catalogSettled?.();
    request.signal?.throwIfAborted();
    const planned = await planner.planRoute({ purpose: routingPurpose(request), brief: briefFor(request),
      selectedModel: request.contract.selectedModel ?? options.getSelectedModel?.(),
      originalSource: request.contract.nativeSource === undefined
        ? { goal: request.contract.ask, criteria: request.contract.criteria.map((criterion) => criterion.text) }
        : nativeContractSourceForAdmission(request.contract),
      requires: { toolCalling: true }, signal: request.signal, beforeAttempt: request.beforeAttempt, onRetry: request.onRetry });
    const route: UnitRoute = {
      model: planned.model,
      provider: planned.provider,
      ...(planned.fallbackModels.length === 0 ? {} : { fallbackModels: [...planned.fallbackModels] }),
      reason: planned.reason,
      routing: { providerFailurePolicy: planned.fallbackModels.length ? 'ordered-fallbacks' : 'fail' },
    };
    return route;
  };
}
