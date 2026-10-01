import type { ContractView, ContractUnitView } from '@goodvibes-jev/engine/sdk/platform/contract';
import type { AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { RuntimeAgent } from '@goodvibes-jev/engine/sdk/platform/runtime/store';

type AgentRecord = NonNullable<ReturnType<AgentManager['getStatus']>>;
export type ProcessSummaryAgent = Pick<AgentRecord, 'id'> & Partial<Pick<AgentRecord, 'progress' | 'status' | 'contractRole'>>;
export type RuntimeProcessSummaryAgent = Pick<RuntimeAgent, 'id'> & Partial<Pick<RuntimeAgent, 'latestProgress' | 'status' | 'contractRef'>>;
export type RunningAgentSummary = { readonly count: number; readonly progress?: string };

function terminal(status: string | undefined): boolean {
  return status === 'passed' || status === 'completed' || status === 'failed' || status === 'cancelled';
}

function memberIds(contract: ContractView): Set<string> {
  const ids = new Set(contract.plannerAgentIds);
  const unit = (value: ContractUnitView): void => {
    for (const id of value.agentIds) ids.add(id);
    if (value.activeAgentId) ids.add(value.activeAgentId);
    for (const attempt of value.attemptUnits ?? []) unit(attempt);
  };
  for (const value of contract.units) unit(value);
  return ids;
}

/** Count actual agents once; contract owner records and group/unit rollups are not extra workers. */
export function summarizeRunningAgents(
  managerAgents: readonly ProcessSummaryAgent[],
  runtimeAgents: readonly RuntimeProcessSummaryAgent[],
  contracts: readonly ContractView[],
): RunningAgentSummary {
  const owners = new Set(contracts.map((contract) => contract.ownerAgentId));
  const ended = new Set<string>();
  for (const contract of contracts) if (terminal(contract.status)) {
    ended.add(contract.ownerAgentId);
    for (const id of memberIds(contract)) ended.add(id);
  }
  const runningAgentIds = new Set<string>();
  let progress: string | undefined;
  for (const agent of managerAgents) {
    if (owners.has(agent.id) || agent.contractRole === 'owner' || ended.has(agent.id) || terminal(agent.status)) continue;
    runningAgentIds.add(agent.id);
    if (!progress && agent.progress) progress = agent.progress;
  }
  for (const agent of runtimeAgents) {
    if (owners.has(agent.id) || agent.contractRef?.contractRole === 'owner' || ended.has(agent.id) || terminal(agent.status)) continue;
    runningAgentIds.add(agent.id);
    if (!progress && agent.latestProgress) progress = agent.latestProgress;
  }
  if (!progress) for (const contract of contracts) {
    if (terminal(contract.status)) continue;
    const members = memberIds(contract);
    if ([...members].some((id) => runningAgentIds.has(id))) { progress = `Contract ${contract.status}`; break; }
  }
  return { count: runningAgentIds.size, progress };
}
