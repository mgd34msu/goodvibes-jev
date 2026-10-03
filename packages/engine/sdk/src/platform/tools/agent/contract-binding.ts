/**
 * How a spawn is bound to a contract (docs/design/contract-runner.md 4.1 and
 * 6.5). Never model-supplied: neither binding is part of AgentInput.
 */
import { setAgentProgress } from '../../agents/progress-audience.js';
import { emitAgentProgress, emitAgentRunning } from '../../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { ContractInputAuthority } from '../../contract/input-authority.js';
import type { AgentRecord } from './record.js';

/** Binds a spawn to a contract unit: the turn loop calls the contract hooks for it. */
export interface ContractPlannerBinding {
  readonly inputReadAuthority: ContractInputAuthority;
}

export type AgentConstructionBinding = ContractUnitBinding | ContractOwnerBinding | ContractPlannerBinding;

export interface ContractUnitBinding {
  readonly inputReadAuthority?: ContractInputAuthority | undefined;
  readonly contractId: string;
  readonly contractUnitId: string;
  /** The route selector's reason for the unit's model, copied to AgentRecord.routeReason. */
  readonly routeReason?: string | undefined;
}

/**
 * Makes a spawn a contract's owner record: the record parents and surfaces
 * wait on. It runs no executor; the contract runner keeps it running and
 * settles it (status, answer, usage) when the contract ends.
 */
export interface ContractOwnerBinding {
  readonly contractId: string;
  readonly contractRole: 'owner';
  /** Actual contract lifetime, reserved before the owner is published. */
  readonly settled?: Promise<void> | undefined;
  /** The owner's first progress line, for operator surfaces. */
  readonly progress: string;
}

/** Which of the two bindings a spawn carries, if any. */
export function splitContractBinding(binding: AgentConstructionBinding | undefined): {
  readonly unit: ContractUnitBinding | undefined;
  readonly owner: ContractOwnerBinding | undefined;
} {
  if (binding !== undefined && 'contractRole' in binding) return { unit: undefined, owner: binding };
  return { unit: binding !== undefined && 'contractUnitId' in binding ? binding : undefined, owner: undefined };
}

/** Marks a freshly spawned owner record running, announces it, and returns it without running an executor. */
export function startContractOwner(record: AgentRecord, binding: ContractOwnerBinding, runtimeBus: RuntimeEventBus | null | undefined): AgentRecord {
  if (record.status === 'cancelled') return record;
  record.status = 'running';
  setAgentProgress(record, binding.progress, 'operator');
  if (runtimeBus) {
    const ctx = { sessionId: 'agent-manager', traceId: `agent-manager:${record.id}:contract-owner`, source: 'agent-manager', agentId: record.id };
    emitAgentRunning(runtimeBus, ctx, { agentId: record.id, contractId: binding.contractId, contractRole: 'owner' });
    emitAgentProgress(runtimeBus, ctx, { agentId: record.id, progress: binding.progress, audience: 'operator', contractId: binding.contractId, contractRole: 'owner' });
  }
  return record;
}
