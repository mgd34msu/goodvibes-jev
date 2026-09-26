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

const CTR = 'ctr-0a1b2c3d';
const shape = { verdict: 'no', probability: 0.08, outcome: 'act' } as const;

/** One event of every type, with every optional field present. Keyed by type, so a missing type does not compile. */
const SAMPLES: { readonly [T in ContractEventType]: Extract<ContractEvent, { type: T }> } = {
  CONTRACT_CREATED: { type: 'CONTRACT_CREATED', contractId: CTR, sessionId: 's1', origin: 'turn', ask: 'Add a parser', ownerAgentId: 'a-owner' },
  CONTRACT_STATUS_CHANGED: { type: 'CONTRACT_STATUS_CHANGED', contractId: CTR, from: 'queued', to: 'shaping' },
  CONTRACT_SHAPED: {
    type: 'CONTRACT_SHAPED', contractId: CTR, forbidsDelegation: shape, requestsParallelAgents: { verdict: 'yes', probability: 0.91, outcome: 'act' },
    forbidsWriting: { verdict: 'uncertain', probability: 0.5, outcome: 'escalate' }, asksForAttempts: shape, decisionIds: ['d1', 'd2'],
  },
  CONTRACT_PLANNED: {
    type: 'CONTRACT_PLANNED', contractId: CTR, goal: 'A parser',
    criteria: [
      { id: 'c1', text: 'Parses dates', origin: 'stated', quote: 'parse dates', serves: [], disposition: 'judged' },
      { id: 'c2', text: 'One agent per file', origin: 'stated', quote: 'one agent per file', serves: [], disposition: 'met-by-structure', dispositionReason: 'group g1 runs one unit per file' },
    ],
    groups: [{ id: 'g1', title: 'Parsing', kind: 'work', dependsOn: [], unitIds: ['u1'] }],
    units: [{ id: 'u1', groupId: 'g1', title: 'Parser', role: 'implement', dependsOn: [], attempts: 1 }],
    repair: 0,
  },
  CONTRACT_PLAN_CHECKED: {
    type: 'CONTRACT_PLAN_CHECKED', contractId: CTR, check: 'criterion-trace', targetId: 'c1', passed: false,
    problems: [{ code: 'quote-not-found', targetId: 'c1', message: 'The quote is not in the request.' }], decisionIds: ['d3'],
  },
  CONTRACT_GROUP_STATUS_CHANGED: { type: 'CONTRACT_GROUP_STATUS_CHANGED', contractId: CTR, groupId: 'g1', from: 'pending', to: 'running' },
  CONTRACT_UNIT_STATUS_CHANGED: { type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: CTR, groupId: 'g1', unitId: 'u1', from: 'held', to: 'nudged', agentId: 'a1' },
  CONTRACT_UNIT_SPAWNED: {
    type: 'CONTRACT_UNIT_SPAWNED', contractId: CTR, unitId: 'u1', agentId: 'a1',
    route: { model: 'm', provider: 'p', reasoningEffort: 'high', reason: 'implementation tier' }, purpose: 'unit',
  },
  CONTRACT_CHECKED: {
    type: 'CONTRACT_CHECKED', contractId: CTR, scope: 'unit', targetId: 'u1', checkId: 'u1.k1', trigger: 'completion', result: 'nudge',
    criteria: [{ criterionId: 'u1.c1', verdict: 'unmet', probabilityUnmet: 0.83, outcome: 'act' }],
    goal: { verdict: 'unshown', outcome: 'confirm' },
    quality: [{ item: 'placeholder', verdict: 'yes', outcome: 'act' }],
    gates: [{ gate: 'test', passed: false, skipped: false }], claims: 'files_verified', decisionIds: ['d4'],
  },
  CONTRACT_NUDGED: {
    type: 'CONTRACT_NUDGED', contractId: CTR, unitId: 'u1', nudgeId: 'u1.n1', checkId: 'u1.k1',
    kinds: ['unmet', 'gate'], criterionIds: ['u1.c1'], delivery: 'hold', agentId: 'a1',
  },
  CONTRACT_NUDGE_CONSUMED: { type: 'CONTRACT_NUDGE_CONSUMED', contractId: CTR, unitId: 'u1', nudgeId: 'u1.n1', agentId: 'a1', turn: 4 },
  CONTRACT_CRITERION_REGRESSED: { type: 'CONTRACT_CRITERION_REGRESSED', contractId: CTR, unitId: 'u1', criterionId: 'u1.c2', metAtCheckId: 'u1.k1', checkId: 'u1.k2' },
  CONTRACT_STALLED: {
    type: 'CONTRACT_STALLED', contractId: CTR, scope: 'unit', targetId: 'u1', route: 'split', unmetCriterionIds: ['u1.c1'],
    reason: 'three checks without progress', decisionId: 'd5',
  },
  CONTRACT_FIX_PLANNED: { type: 'CONTRACT_FIX_PLANNED', contractId: CTR, scope: 'unit', targetId: 'u1', groupId: 'u1.f1', unitIds: ['u1.f1.u1'], round: 1 },
  CONTRACT_ESCALATED: {
    type: 'CONTRACT_ESCALATED', contractId: CTR, escalationId: 'e1', scope: 'unit', targetId: 'u1', reason: 'unsettled',
    question: 'Contract needs your decision.', unmetCriterionIds: [],
  },
  CONTRACT_OWNER_REPLIED: { type: 'CONTRACT_OWNER_REPLIED', contractId: CTR, escalationId: 'e1', reading: 'approve', outcome: 'act', action: 'unit passed on owner confirmation' },
  CONTRACT_GATE_RESULT: { type: 'CONTRACT_GATE_RESULT', contractId: CTR, targetId: 'u1', gate: 'lint', passed: true, skipped: true, durationMs: 0 },
  CONTRACT_UNIT_SILENT: { type: 'CONTRACT_UNIT_SILENT', contractId: CTR, unitId: 'u1', agentId: 'a1', silentMs: 120_000, action: 'retried' },
  CONTRACT_MERGE_CONFLICT: { type: 'CONTRACT_MERGE_CONFLICT', contractId: CTR, unitId: 'u1', branch: 'ws/ab/cd', path: '/tmp/wt', files: ['src/a.ts'] },
  CONTRACT_ATTEMPTS_SELECTED: {
    type: 'CONTRACT_ATTEMPTS_SELECTED', contractId: CTR, unitId: 'u1', candidateIds: ['u1#1', 'u1#2'], chosen: null, outcome: 'escalate', decisionId: 'd6',
  },
  CONTRACT_COMMITTED: { type: 'CONTRACT_COMMITTED', contractId: CTR, status: 'committed', hash: 'abc123', note: 'committed on main' },
  CONTRACT_PASSED: { type: 'CONTRACT_PASSED', contractId: CTR, criteriaMet: 4, criteriaJudged: 4, excluded: 1, nudges: 2 },
  CONTRACT_FAILED: {
    type: 'CONTRACT_FAILED', contractId: CTR, reason: 'unit u1 spent its turn budget', failureKind: 'max_turns',
    membersSettled: true, turnLimit: 40, turnLimitSource: 'policy-bound',
  },
  CONTRACT_CANCELLED: { type: 'CONTRACT_CANCELLED', contractId: CTR, reason: 'stopped by the owner', filesModified: 3 },
  CONTRACT_SPAWN_GUARD_TRIGGERED: {
    type: 'CONTRACT_SPAWN_GUARD_TRIGGERED', contractId: CTR, agentId: 'a1', depth: 2, activeAgents: 5, reason: 'units are leaves; the contract plans sub-work',
  },
};

const ALL = CONTRACT_EVENT_TYPES.map((type) => SAMPLES[type] as ContractEvent);

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
});
