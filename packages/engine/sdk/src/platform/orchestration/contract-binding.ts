/**
 * A work item's contract binding (docs/design/contract-runner.md section 4.1):
 * the engine copies it from the spec onto the item, and the phase runner turns
 * it into the unit agent's spawn input and its ContractUnitBinding.
 */
import type { AgentInput } from '../tools/agent/schema.js';
import type { ContractUnitBinding } from '../tools/agent/manager.js';
import type { WorkItem, WorkItemContractFields } from './types.js';

/** The contract fields a spec sets, copied (arrays and route included) so the item never aliases the spec. */
export function copyContractFields(spec: WorkItemContractFields): WorkItemContractFields {
  return {
    ...(spec.contractId !== undefined ? { contractId: spec.contractId } : {}),
    ...(spec.contractUnitId !== undefined ? { contractUnitId: spec.contractUnitId } : {}),
    ...(spec.route !== undefined ? { route: { ...spec.route, ...(spec.route.fallbackModels ? { fallbackModels: [...spec.route.fallbackModels] } : {}) } } : {}),
    ...(spec.tools !== undefined ? { tools: [...spec.tools] } : {}),
    ...(spec.restrictTools !== undefined ? { restrictTools: spec.restrictTools } : {}),
    ...(spec.template !== undefined ? { template: spec.template } : {}),
  };
}

/** True when the item is one contract unit: both ids are set. */
export function isContractUnitItem(item: WorkItemContractFields): item is WorkItemContractFields & { readonly contractId: string; readonly contractUnitId: string } {
  return typeof item.contractId === 'string' && item.contractId.length > 0
    && typeof item.contractUnitId === 'string' && item.contractUnitId.length > 0;
}

/**
 * The spawn input fields and binding for a contract unit's agent: the route's
 * model, provider, fallbacks, routing and effort; the item's tool contract and
 * template. Null for an item that is not a contract unit.
 */
export function contractUnitSpawn(item: WorkItem): { readonly input: Partial<AgentInput>; readonly binding: ContractUnitBinding } | null {
  if (!isContractUnitItem(item)) return null;
  const route = item.route;
  return {
    input: {
      ...(item.template !== undefined ? { template: item.template } : {}),
      ...(item.tools !== undefined ? { tools: [...item.tools] } : {}),
      ...(item.restrictTools !== undefined ? { restrictTools: item.restrictTools } : {}),
      ...(route ? { model: route.model, provider: route.provider } : {}),
      ...(route?.fallbackModels?.length ? { fallbackModels: [...route.fallbackModels] } : {}),
      ...(route?.routing ? { routing: route.routing } : {}),
      ...(route?.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    },
    binding: {
      contractId: item.contractId,
      contractUnitId: item.contractUnitId,
      ...(route ? { routeReason: route.reason } : {}),
    },
  };
}
