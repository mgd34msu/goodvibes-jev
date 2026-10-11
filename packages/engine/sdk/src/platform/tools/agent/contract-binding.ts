/**
 * How a spawn is bound to a contract (docs/design/contract-runner.md 4.1 and
 * 6.5). Never model-supplied: neither binding is part of AgentInput.
 */
import { setAgentProgress } from '../../agents/progress-audience.js';
import { emitAgentProgress, emitAgentRunning } from '../../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { ContractInputAuthority } from '../../contract/input-authority.js';
import type { AgentRecord } from './record.js';
import type { AutonomousToolSource } from '../../permissions/autonomous.js';
import type { JudgmentPort } from '@goodvibes-jev/judgment';

const actionSignals = new WeakMap<object, AbortSignal>();
export function bindContractActionSignal<T extends object>(target: T, signal: AbortSignal | undefined): T { if (signal) actionSignals.set(target, signal); return target; }
export function getContractActionSignal(target: object): AbortSignal | undefined { return actionSignals.get(target); }
const actionSources = new WeakMap<object, () => AutonomousToolSource>();
export type ContractActionPort = (port: JudgmentPort) => JudgmentPort;
const actionPorts = new WeakMap<object, ContractActionPort>();
/** Construction metadata is never recovered from serialized AgentInput or AgentRecord fields. */
export function bindContractActionSource<T extends object>(target: T, sourceOf: (() => AutonomousToolSource) | undefined, port?: ContractActionPort): T {
  if (sourceOf !== undefined) actionSources.set(target, sourceOf);
  if (port !== undefined) actionPorts.set(target, port);
  return target;
}
export function getContractActionSource(target: object): (() => AutonomousToolSource) | undefined {
  return actionSources.get(target);
}
export function getContractActionPort(target: object): ContractActionPort | undefined { return actionPorts.get(target); }

/** Binds a spawn to a contract unit: the turn loop calls the contract hooks for it. */
export interface ContractPlannerBinding {
  readonly autonomousPort?: ContractActionPort | undefined;
  readonly inputReadAuthority: ContractInputAuthority;
  readonly autonomousSource?: (() => AutonomousToolSource) | undefined;
}

export interface NativePlannerBinding {
  readonly autonomousSignal?: AbortSignal | undefined;
  readonly autonomousPort?: ContractActionPort | undefined;
  readonly autonomousSource: () => AutonomousToolSource;
  readonly inputReadAuthority?: ContractInputAuthority | undefined;
}

export type AgentConstructionBinding = ContractUnitBinding | ContractOwnerBinding | ContractPlannerBinding | NativePlannerBinding;

export interface ContractUnitBinding {
  readonly autonomousPort?: ContractActionPort | undefined;
  readonly autonomousSource?: (() => AutonomousToolSource) | undefined;
  readonly inputReadAuthority?: ContractInputAuthority | undefined;
  /** Trusted, nonserialized native execution fence, invoked after spawning hooks and on every wake. */
  readonly withCurrentExecution?: ((execute: () => Promise<void>) => Promise<void>) | undefined;
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
