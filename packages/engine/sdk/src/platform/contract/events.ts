import { randomUUID } from 'node:crypto';
/**
 * Emitting contract events (docs/design/contract-runner.md section 8.1). Every
 * event goes out on the `contracts` runtime domain through its typed emitter
 * (runtime/emitters/contract.ts), with the contract's context: its session, a
 * trace id of `<sessionId>:contract:<contractId>`, and source `contract-runner`.
 */
import type { ContractEvent, ContractEventType } from '../../events/contract.js';
import type { EmitterContext } from '../runtime/emitters/index.js';
import {
  emitContractAttemptsSelected,
  emitContractCancelled,
  emitContractChecked,
  emitContractCommitted,
  emitContractCreated,
  emitContractCriterionRegressed,
  emitContractEscalated,
  emitContractFailed,
  emitContractFixPlanned,
  emitContractGateResult,
  emitContractGroupStatusChanged,
  emitContractMergeConflict,
  emitContractNudgeConsumed,
  emitContractNudged,
  emitContractOwnerReplied,
  emitContractPassed,
  emitContractPlanChecked,
  emitContractPlanned,
  emitContractShaped,
  emitContractSpawnGuardTriggered,
  emitContractStalled,
  emitContractStatusChanged,
  emitContractUnitSilent,
  emitContractUnitSpawned,
  emitContractUnitStatusChanged,
  type ContractEventData,
} from '../runtime/emitters/contract.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

/** The `source` every contract event carries. */
export const CONTRACT_EVENT_SOURCE = 'contract-runner';

/** `<sessionId>:contract:<contractId>`; `<sessionId>:contract` for an event that belongs to no contract. */
export function contractTraceId(sessionId: string, contractId?: string): string {
  return contractId === undefined ? `${sessionId}:contract` : `${sessionId}:contract:${contractId}`;
}

export function contractEmitterContext(sessionId: string, contractId?: string): EmitterContext {
  return { sessionId, traceId: contractTraceId(sessionId, contractId), source: CONTRACT_EVENT_SOURCE };
}

type Emitter<T extends ContractEventType> = (bus: RuntimeEventBus, ctx: EmitterContext, data: ContractEventData<T>) => void;

/** One emitter per event type; exhaustive, so a new event type cannot be emitted without its emitter. */
const EMITTERS: { readonly [T in ContractEventType]: Emitter<T> } = {
  CONTRACT_CREATED: emitContractCreated,
  CONTRACT_STATUS_CHANGED: emitContractStatusChanged,
  CONTRACT_SHAPED: emitContractShaped,
  CONTRACT_PLANNED: emitContractPlanned,
  CONTRACT_PLAN_CHECKED: emitContractPlanChecked,
  CONTRACT_GROUP_STATUS_CHANGED: emitContractGroupStatusChanged,
  CONTRACT_UNIT_STATUS_CHANGED: emitContractUnitStatusChanged,
  CONTRACT_UNIT_SPAWNED: emitContractUnitSpawned,
  CONTRACT_CHECKED: emitContractChecked,
  CONTRACT_NUDGED: emitContractNudged,
  CONTRACT_NUDGE_CONSUMED: emitContractNudgeConsumed,
  CONTRACT_CRITERION_REGRESSED: emitContractCriterionRegressed,
  CONTRACT_STALLED: emitContractStalled,
  CONTRACT_FIX_PLANNED: emitContractFixPlanned,
  CONTRACT_ESCALATED: emitContractEscalated,
  CONTRACT_OWNER_REPLIED: emitContractOwnerReplied,
  CONTRACT_GATE_RESULT: emitContractGateResult,
  CONTRACT_UNIT_SILENT: emitContractUnitSilent,
  CONTRACT_MERGE_CONFLICT: emitContractMergeConflict,
  CONTRACT_ATTEMPTS_SELECTED: emitContractAttemptsSelected,
  CONTRACT_COMMITTED: emitContractCommitted,
  CONTRACT_PASSED: emitContractPassed,
  CONTRACT_FAILED: emitContractFailed,
  CONTRACT_CANCELLED: emitContractCancelled,
  CONTRACT_SPAWN_GUARD_TRIGGERED: emitContractSpawnGuardTriggered,
};

/** Emits one contract event on the `contracts` domain with its contract's context. */
export function emitContractEvent(bus: RuntimeEventBus, sessionId: string, event: ContractEvent): ContractEvent {
  // A source occurrence is new even when an imported snapshot reuses its entity id.
  const occurrence = { ...event, occurrenceId: randomUUID() };
  const { type, ...data } = occurrence;
  // The table is keyed by type, so the emitter found is the one for this
  // event's payload; the union cannot express that pairing, hence the widening.
  const emitter = EMITTERS[type] as (bus: RuntimeEventBus, ctx: EmitterContext, data: unknown) => void;
  emitter(bus, contractEmitterContext(sessionId, event.contractId), data);
  return occurrence;
}
