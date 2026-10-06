import { randomUUID } from 'node:crypto';
/**
 * Contract emitters, one typed emission wrapper per `contracts` domain event
 * (docs/design/contract-runner.md section 8.1). The contract runner calls these
 * through platform/contract/events.ts, which supplies the contract's context.
 */
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { ContractEvent, ContractEventType } from '../../../events/contract.js';
import type { EmitterContext } from './index.js';

/** The payload of one contract event type, without its `type` discriminant. */
export type ContractEventData<T extends ContractEventType> = Omit<Extract<ContractEvent, { type: T }>, 'type'>;

/** Forward declared source provenance; a direct new emission mints it once. */
function emitContract<T extends ContractEventType>(bus: RuntimeEventBus, ctx: EmitterContext, type: T, data: ContractEventData<T>): void {
  const event = { type, ...data, occurrenceId: data.occurrenceId ?? randomUUID() } as unknown as Extract<ContractEvent, { type: T }>;
  bus.emit('contracts', createEventEnvelope(type, event, ctx));
}

export function emitContractCreated(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_CREATED'>): void {
  emitContract(bus, ctx, 'CONTRACT_CREATED', data);
}

export function emitContractStatusChanged(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_STATUS_CHANGED'>): void {
  emitContract(bus, ctx, 'CONTRACT_STATUS_CHANGED', data);
}

export function emitContractShaped(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_SHAPED'>): void {
  emitContract(bus, ctx, 'CONTRACT_SHAPED', data);
}

export function emitContractPlanned(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_PLANNED'>): void {
  emitContract(bus, ctx, 'CONTRACT_PLANNED', data);
}

export function emitContractPlanChecked(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_PLAN_CHECKED'>): void {
  emitContract(bus, ctx, 'CONTRACT_PLAN_CHECKED', data);
}

export function emitContractGroupStatusChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: ContractEventData<'CONTRACT_GROUP_STATUS_CHANGED'>,
): void {
  emitContract(bus, ctx, 'CONTRACT_GROUP_STATUS_CHANGED', data);
}

export function emitContractUnitStatusChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: ContractEventData<'CONTRACT_UNIT_STATUS_CHANGED'>,
): void {
  emitContract(bus, ctx, 'CONTRACT_UNIT_STATUS_CHANGED', data);
}

export function emitContractUnitSpawned(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_UNIT_SPAWNED'>): void {
  emitContract(bus, ctx, 'CONTRACT_UNIT_SPAWNED', data);
}

export function emitContractChecked(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_CHECKED'>): void {
  emitContract(bus, ctx, 'CONTRACT_CHECKED', data);
}

export function emitContractNudged(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_NUDGED'>): void {
  emitContract(bus, ctx, 'CONTRACT_NUDGED', data);
}

export function emitContractNudgeConsumed(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_NUDGE_CONSUMED'>): void {
  emitContract(bus, ctx, 'CONTRACT_NUDGE_CONSUMED', data);
}

export function emitContractCriterionRegressed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: ContractEventData<'CONTRACT_CRITERION_REGRESSED'>,
): void {
  emitContract(bus, ctx, 'CONTRACT_CRITERION_REGRESSED', data);
}

export function emitContractStalled(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_STALLED'>): void {
  emitContract(bus, ctx, 'CONTRACT_STALLED', data);
}

export function emitContractFixPlanned(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_FIX_PLANNED'>): void {
  emitContract(bus, ctx, 'CONTRACT_FIX_PLANNED', data);
}

export function emitContractEscalated(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_ESCALATED'>): void {
  emitContract(bus, ctx, 'CONTRACT_ESCALATED', data);
}

export function emitContractOwnerReplied(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_OWNER_REPLIED'>): void {
  emitContract(bus, ctx, 'CONTRACT_OWNER_REPLIED', data);
}

export function emitContractGateResult(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_GATE_RESULT'>): void {
  emitContract(bus, ctx, 'CONTRACT_GATE_RESULT', data);
}

export function emitContractUnitSilent(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_UNIT_SILENT'>): void {
  emitContract(bus, ctx, 'CONTRACT_UNIT_SILENT', data);
}

export function emitContractMergeConflict(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_MERGE_CONFLICT'>): void {
  emitContract(bus, ctx, 'CONTRACT_MERGE_CONFLICT', data);
}

export function emitContractAttemptsSelected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: ContractEventData<'CONTRACT_ATTEMPTS_SELECTED'>,
): void {
  emitContract(bus, ctx, 'CONTRACT_ATTEMPTS_SELECTED', data);
}

export function emitContractCommitted(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_COMMITTED'>): void {
  emitContract(bus, ctx, 'CONTRACT_COMMITTED', data);
}

export function emitContractPassed(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_PASSED'>): void {
  emitContract(bus, ctx, 'CONTRACT_PASSED', data);
}

export function emitContractFailed(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_FAILED'>): void {
  emitContract(bus, ctx, 'CONTRACT_FAILED', data);
}

export function emitContractCancelled(bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<'CONTRACT_CANCELLED'>): void {
  emitContract(bus, ctx, 'CONTRACT_CANCELLED', data);
}

export function emitContractSpawnGuardTriggered(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: ContractEventData<'CONTRACT_SPAWN_GUARD_TRIGGERED'>,
): void {
  emitContract(bus, ctx, 'CONTRACT_SPAWN_GUARD_TRIGGERED', data);
}
