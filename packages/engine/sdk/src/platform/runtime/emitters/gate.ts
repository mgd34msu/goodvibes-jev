/**
 * Gate emitters, typed emission wrappers for the GateEvent domain.
 */
import type { GateEvent } from '../../../events/gate.js';
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';

type Data<T extends GateEvent['type']> = Omit<Extract<GateEvent, { type: T }>, 'type'>;

function emitGate<T extends GateEvent['type']>(bus: RuntimeEventBus, ctx: EmitterContext, type: T, data: Data<T>): void {
  bus.emit('gate', createEventEnvelope(type, { type, ...data } as Extract<GateEvent, { type: T }>, ctx));
}

/** Emit GATE_REQUESTED when a tool call reaches the gate. */
export function emitGateRequested(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'GATE_REQUESTED'>): void {
  emitGate(bus, ctx, 'GATE_REQUESTED', data);
}

/** Emit RULES_COLLECTED after all policy rules are gathered. */
export function emitRulesCollected(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'RULES_COLLECTED'>): void {
  emitGate(bus, ctx, 'RULES_COLLECTED', data);
}

/** Emit INPUT_NORMALIZED after tool args are normalised for policy evaluation. */
export function emitInputNormalized(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'INPUT_NORMALIZED'>): void {
  emitGate(bus, ctx, 'INPUT_NORMALIZED', data);
}

/** Emit POLICY_EVALUATED after user and managed policy rules are checked. */
export function emitPolicyEvaluated(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'POLICY_EVALUATED'>): void {
  emitGate(bus, ctx, 'POLICY_EVALUATED', data);
}

/** Emit SESSION_OVERRIDE_EVALUATED after remembered approvals are checked. */
export function emitSessionOverrideEvaluated(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'SESSION_OVERRIDE_EVALUATED'>): void {
  emitGate(bus, ctx, 'SESSION_OVERRIDE_EVALUATED', data);
}

/** Emit BOUNDARY_CHECKED after the deterministic boundary runs. */
export function emitBoundaryChecked(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'BOUNDARY_CHECKED'>): void {
  emitGate(bus, ctx, 'BOUNDARY_CHECKED', data);
}

/** Emit STAKES_READ after Jev reads a call's stakes. */
export function emitStakesRead(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'STAKES_READ'>): void {
  emitGate(bus, ctx, 'STAKES_READ', data);
}

/** Emit PRESET_EVALUATED after the active preset maps the stakes to an action. */
export function emitPresetEvaluated(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'PRESET_EVALUATED'>): void {
  emitGate(bus, ctx, 'PRESET_EVALUATED', data);
}

/** Emit PRESET_CHANGED when the active preset changes. */
export function emitPresetChanged(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'PRESET_CHANGED'>): void {
  emitGate(bus, ctx, 'PRESET_CHANGED', data);
}

/** Emit DECISION_EMITTED when the gate's final decision is made. */
export function emitGateDecision(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'DECISION_EMITTED'>): void {
  emitGate(bus, ctx, 'DECISION_EMITTED', data);
}
