/**
 * Usage roll-up (docs/design/contract-runner.md section 2.3): unit, group,
 * contract, owner record, and the contract's judgment usage. All of it is
 * arithmetic over recorded counts, so it is code.
 *
 * - A unit's usage is the phase runner's per-agent usage record
 *   (`usageFromRecord`) merged with `mergeWorkItemUsage` across every agent
 *   the unit ever ran. An agent woken several times is one record whose
 *   counts already include every run, so each agent counts once.
 * - A group's usage is the merge of its units; the contract's is the merge of
 *   its groups plus its planner agents.
 * - The owner record's `usage` and `toolCallCount` are the sums over the same
 *   agents, so an operator surface reading the owner sees the contract's real
 *   totals rather than the spawn-time zeros (the owner never runs a model).
 */
import { usageFromRecord } from '../orchestration/phase-runner.js';
import { emptyWorkItemUsage, mergeWorkItemUsage, type PriceProvenanceFn, type WorkItemUsage } from '../orchestration/types.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { Contract, JudgmentUsage } from './types.js';

/** Prices a usage record for a model; null when the model has no price. */
export type PriceUsageFn = (model: string | undefined, usage: WorkItemUsage) => number | null;

export interface UsagePricing {
  readonly priceUsage: PriceUsageFn;
  readonly priceProvenance: PriceProvenanceFn;
}

export type AgentLookup = (agentId: string) => AgentRecord | null;

/**
 * Merges usage records. Folding starts from the first record, not from an
 * empty one: an empty record carries no price, and merging a priced record
 * with it would read as partly priced.
 */
export function mergeAll(records: readonly WorkItemUsage[]): WorkItemUsage {
  const [first, ...rest] = records;
  return first === undefined ? emptyWorkItemUsage() : rest.reduce(mergeWorkItemUsage, first);
}

/** The merged, priced usage of the given agents; an agent whose record is gone adds nothing. */
export function agentsUsage(agentIds: readonly string[], getStatus: AgentLookup, pricing: UsagePricing): WorkItemUsage {
  const records: WorkItemUsage[] = [];
  for (const agentId of new Set(agentIds)) {
    const record = getStatus(agentId);
    if (record !== null) records.push(usageFromRecord(record, pricing.priceUsage, pricing.priceProvenance));
  }
  return mergeAll(records);
}

/** Every agent a contract ran: its planners and every agent of every unit. */
export function contractAgentIds(contract: Pick<Contract, 'plannerAgentIds' | 'units'>): string[] {
  return [...new Set([...contract.plannerAgentIds, ...contract.units.flatMap((unit) => unit.agentIds)])];
}

/**
 * Recomputes the usage of every unit, every group and the contract from the
 * agent records. Idempotent: it sums from the records, never adds to what was
 * recorded before.
 */
export function rollUpContractUsage(contract: Contract, getStatus: AgentLookup, pricing: UsagePricing): void {
  for (const unit of contract.units) {
    // A best-of-N unit's agents are its attempts' agents (group-runner records both), so each counts once.
    unit.usage = agentsUsage(unit.agentIds, getStatus, pricing);
    for (const attempt of unit.attemptUnits ?? []) attempt.usage = agentsUsage(attempt.agentIds, getStatus, pricing);
  }
  for (const group of contract.groups) {
    group.usage = agentsUsage(contract.units.filter((unit) => unit.groupId === group.id).flatMap((unit) => unit.agentIds), getStatus, pricing);
  }
  contract.usage = agentsUsage(contractAgentIds(contract), getStatus, pricing);
}

type AgentUsage = NonNullable<AgentRecord['usage']>;

/**
 * The owner record's usage and tool-call count: the sums over every agent the
 * contract ran. Optional counts appear only when some agent reported them.
 */
export function ownerRecordUsage(contract: Pick<Contract, 'plannerAgentIds' | 'units'>, getStatus: AgentLookup): { readonly usage: AgentUsage; readonly toolCallCount: number } {
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0 };
  let reasoningTokens: number | undefined;
  let reasoningSummaryCount: number | undefined;
  let toolCallCount = 0;
  for (const agentId of contractAgentIds(contract)) {
    const record = getStatus(agentId);
    if (record === null) continue;
    toolCallCount += record.toolCallCount;
    const agent = record.usage;
    if (agent === undefined) continue;
    usage.inputTokens += agent.inputTokens;
    usage.outputTokens += agent.outputTokens;
    usage.cacheReadTokens += agent.cacheReadTokens;
    usage.cacheWriteTokens += agent.cacheWriteTokens;
    usage.llmCallCount += agent.llmCallCount;
    usage.turnCount += agent.turnCount;
    if (agent.reasoningTokens !== undefined) reasoningTokens = (reasoningTokens ?? 0) + agent.reasoningTokens;
    if (agent.reasoningSummaryCount !== undefined) reasoningSummaryCount = (reasoningSummaryCount ?? 0) + agent.reasoningSummaryCount;
  }
  return {
    usage: {
      ...usage,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      ...(reasoningSummaryCount === undefined ? {} : { reasoningSummaryCount }),
    },
    toolCallCount,
  };
}

/** Adds one Jev call's (or one batch of calls') usage into the contract's judgment usage. */
export function addJudgmentUsage(target: JudgmentUsage, usage: JudgmentUsage): void {
  target.calls += usage.calls;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
}
