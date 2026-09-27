/**
 * The `contracts` runtime event domain (design 8.1): every event type is
 * registered and validates, every required field is enforced, emission goes
 * out on the `contracts` domain with the contract's context, and the domain
 * and its `runtime.contracts` stream are declared.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONTRACT_EVENT_FIELD_SPECS,
  CONTRACT_EVENT_TYPES,
  RUNTIME_EVENT_DOMAINS,
  isKnownEventType,
  registeredEventTypes,
  validateKnownEvent,
  type ContractEvent,
  type ContractEventType,
} from '../../sdk/src/events/index.js';
import { RuntimeEventBus } from '../../sdk/src/platform/runtime/events/index.js';
import { builtinGatewayEventDescriptors } from '../../sdk/src/platform/control-plane/method-catalog-events.js';
import { CONTRACT_EVENT_SOURCE, contractTraceId, emitContractEvent } from '../../sdk/src/platform/contract/index.js';
import { ALL_CONTRACT_EVENTS, CTR, SAMPLES } from './event-samples.js';

const ALL = ALL_CONTRACT_EVENTS;

describe('contract event validation', () => {
  test('every contract event type is registered and its sample validates', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...CONTRACT_EVENT_TYPES].sort());
    for (const event of ALL) {
      expect(isKnownEventType(event.type)).toBe(true);
      expect(registeredEventTypes()).toContain(event.type);
      expect({ type: event.type, ...validateKnownEvent(event) }).toEqual({ type: event.type, valid: true, violations: [] });
    }
  });

  test('every required field is enforced, and optional fields may be absent', () => {
    for (const event of ALL) {
      for (const field of CONTRACT_EVENT_FIELD_SPECS[event.type]) {
        const without: Record<string, unknown> = { ...event };
        delete without[field.key];
        const result = validateKnownEvent(without);
        expect({ type: event.type, field: field.key, valid: result.valid }).toEqual({ type: event.type, field: field.key, valid: field.optional === true });
      }
    }
  });

  test('a present optional field is still checked', () => {
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_NUDGE_CONSUMED, turn: 'four' }).violations).toEqual(['turn must be a number']);
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_FAILED, turnLimitSource: 'guess' }).valid).toBe(false);
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_CHECKED, claims: 'probably' }).valid).toBe(false);
  });

  test('closed sets, nested objects and arrays of objects are checked element by element', () => {
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_STATUS_CHANGED, to: 'reviewing' }).violations).toEqual([
      'to must be one of: queued, shaping, planning, checking-plan, running, judging, fixing, committing, awaiting-owner, passed, failed, cancelled',
    ]);
    const badCriterion = { ...SAMPLES.CONTRACT_CHECKED, criteria: [{ criterionId: 'u1.c1', verdict: 'fine', probabilityUnmet: '0.1', outcome: 'act' }] };
    expect(validateKnownEvent(badCriterion).violations).toEqual([
      'criteria[0].verdict must be one of: met, unmet, unshown',
      'criteria[0].probabilityUnmet must be a number',
    ]);
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_CHECKED, goal: { verdict: 'met' } }).violations).toEqual([
      'goal.outcome must be one of: act, confirm, escalate',
    ]);
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_NUDGED, kinds: ['unmet', 'style'] }).valid).toBe(false);
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_SHAPED, forbidsWriting: { verdict: 'maybe', probability: 0.5, outcome: 'act' } }).valid).toBe(false);
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_PLANNED, units: ['u1'] }).violations).toEqual(['units[0] must be an object']);
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_ATTEMPTS_SELECTED, chosen: 'u1#2' }).valid).toBe(true);
    expect(validateKnownEvent({ ...SAMPLES.CONTRACT_ATTEMPTS_SELECTED, chosen: 2 }).valid).toBe(false);
  });

  test('the spawn guard may fire outside any contract', () => {
    const { contractId: _omitted, ...outside } = SAMPLES.CONTRACT_SPAWN_GUARD_TRIGGERED;
    expect(validateKnownEvent(outside).valid).toBe(true);
  });
});

describe('emitting contract events', () => {
  test('every type goes out on the contracts domain with the contract context and validates', async () => {
    const bus = new RuntimeEventBus();
    const received: Array<{ type: string; sessionId?: string | undefined; traceId?: string | undefined; source?: string | undefined; payload: unknown }> = [];
    const off = bus.onDomain('contracts', (envelope) => {
      received.push(envelope);
    });
    for (const event of ALL) emitContractEvent(bus, 's1', event);
    await Bun.sleep(10);
    off();

    expect(received.map((envelope) => envelope.type)).toEqual([...CONTRACT_EVENT_TYPES]);
    for (const envelope of received) {
      expect(envelope.payload).toEqual(SAMPLES[envelope.type as ContractEventType]);
      expect(validateKnownEvent(envelope.payload).valid).toBe(true);
      expect(envelope.sessionId).toBe('s1');
      expect(envelope.source).toBe(CONTRACT_EVENT_SOURCE);
      expect(envelope.traceId).toBe(`s1:contract:${CTR}`);
    }
  });

  test('an event with no contract carries the session-level contract trace', async () => {
    const bus = new RuntimeEventBus();
    const traces: Array<string | undefined> = [];
    const off = bus.onDomain('contracts', (envelope) => {
      traces.push(envelope.traceId);
    });
    const { contractId: _omitted, ...outside } = SAMPLES.CONTRACT_SPAWN_GUARD_TRIGGERED;
    emitContractEvent(bus, 's2', outside);
    await Bun.sleep(10);
    off();
    expect(traces).toEqual(['s2:contract']);
    expect(contractTraceId('s2', CTR)).toBe(`s2:contract:${CTR}`);
  });
});

describe('the contracts domain', () => {
  test('is a runtime event domain with its own runtime.contracts stream', () => {
    expect([...RUNTIME_EVENT_DOMAINS]).toContain('contracts');
    const descriptor = builtinGatewayEventDescriptors.find((entry) => entry.id === 'runtime.contracts');
    expect(descriptor).toBeDefined();
    expect(descriptor?.domains).toEqual(['contracts']);
    expect(descriptor?.transport).toEqual(['sse', 'ws']);
  });

  test('replaces the workflows and orchestration domains, which no longer exist', () => {
    expect([...RUNTIME_EVENT_DOMAINS]).not.toContain('workflows');
    expect([...RUNTIME_EVENT_DOMAINS]).not.toContain('orchestration');
    const streams = builtinGatewayEventDescriptors.map((entry) => entry.id);
    expect(streams).not.toContain('runtime.workflows');
    expect(streams).not.toContain('runtime.orchestration');
    for (const type of registeredEventTypes()) {
      expect(type.startsWith('WORKFLOW_') || type.startsWith('ORCHESTRATION_')).toBe(false);
    }
  });
});
