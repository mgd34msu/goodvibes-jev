import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort, JudgmentRequest, Questions } from '@goodvibes-jev/judgment';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { emitToolReceived, emitToolValidated, emitToolPrehooked, emitToolExecuting, emitToolMapped, emitToolPosthooked, emitToolPermissioned, emitToolSucceeded, emitToolFailed, emitToolCancelled } from '../sdk/src/platform/runtime/emitters/index.ts';
import { AgentExecutionLedger, forgetLedgerArgRoles } from '../sdk/src/platform/gate/policy/execution-ledger.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';

const ctx = { sessionId: 'ledger', traceId: 'ledger', source: 'test' };
const call = (callId: string, tool = 'read_everything') => ({ callId, turnId: 'turn', tool });
const receive = (bus: RuntimeEventBus, id: string, args: Record<string, unknown> = {}, tool = 'read_everything') => emitToolReceived(bus, ctx, { ...call(id, tool), args });
const stateObject = (request: JudgmentRequest<Questions>): Record<string, unknown> => {
  if (!request.state || typeof request.state !== 'object' || Array.isArray(request.state)) throw new Error('Expected object fixture state');
  return request.state;
};
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function answers() {
  return fakePort((name, question, state) => {
    const argument = (state as { argument?: string }).argument;
    if (name === 'kind') return choiceAnswer(question, 'network', 0.99);
    if (name === 'holds_credential') return noulAnswer(argument === 'pat' || argument === 'cmd' ? 0.999 : argument === 'maybe' ? 0.5 : 0.001);
    return noulAnswer(argument === 'destination' ? 0.999 : 0.001);
  });
}
let previous: ReturnType<typeof installJudgmentPort>;
const ledgers: AgentExecutionLedger[] = [];
beforeEach(() => { forgetLedgerArgRoles(); previous = installJudgmentPort(answers().port); });
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.dispose(); installJudgmentPort(previous); forgetLedgerArgRoles(); });
function ledger(bus: RuntimeEventBus, limit?: number) { const value = new AgentExecutionLedger(bus, limit); ledgers.push(value); return value; }

/** A non-cooperative port deliberately ignores AbortSignal. */
function heldPort(match: (request: JudgmentRequest<Questions>) => boolean) {
  const gate = deferred();
  const scripted = answers();
  const requests: JudgmentRequest<Questions>[] = [];
  const port: JudgmentPort = { model: scripted.port.model, async ask(request) {
    requests.push(request as JudgmentRequest<Questions>);
    if (match(request as JudgmentRequest<Questions>)) await gate.promise;
    return scripted.port.ask(request);
  } };
  installJudgmentPort(port);
  return { gate, requests };
}

describe('shared execution ledger delivery and privacy', () => {
  test('captures at subscription delivery before the first reading awaits; role requests contain names only', async () => {
    const bus = new RuntimeEventBus();
    const subject = ledger(bus);
    const { gate, requests } = heldPort(() => true);
    const args = { destination: 'initial-safe-target', nested: { pat: 'SYNTHETIC_OPAQUE_CREDENTIAL' }, maybe: 'SYNTHETIC_UNCERTAIN', commands: [{ cmd: 'SYNTHETIC_COMMAND_SECRET' }] };
    receive(bus, 'a', args);
    await tick();
    expect(subject.getSnapshot().records[0]?.argsPreview).toBe('[judgment pending: values withheld]');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => Object.keys(stateObject(request)).sort().join(',') === 'argument,tool')).toBe(true);
    args.destination = 'mutated-after-delivery'; args.nested.pat = 'MUTATED_SECRET';
    gate.resolve(); await subject.settled();
    const serializedRequests = JSON.stringify(requests); const serializedRecord = JSON.stringify(subject.getSnapshot());
    for (const marker of ['SYNTHETIC_OPAQUE_CREDENTIAL', 'SYNTHETIC_UNCERTAIN', 'SYNTHETIC_COMMAND_SECRET', 'MUTATED_SECRET', 'mutated-after-delivery']) {
      expect(serializedRequests).not.toContain(marker); expect(serializedRecord).not.toContain(marker);
    }
    const record = subject.getSnapshot().records[0]!;
    expect(record.routeKind).toBe('network');
    expect(record.targetPreview).toBe('initial-safe-target'); expect(record.commandPreview).toBeUndefined();
    expect(requests.at(-1)?.context?.battery).toBe('engine.gate.side-effect');
  });

  test('redacts credential keys beyond all preview limits before route classification', async () => {
    const scripted = answers(); installJudgmentPort(scripted.port);
    const bus = new RuntimeEventBus(); const subject = ledger(bus);
    const fields = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ordinary${i}`, i]));
    receive(bus, 'a', { ...fields, deep: { a: { b: { c: { pat: 'SYNTHETIC_DEEP' } } } }, list: Array.from({ length: 12 }, (_, i) => ({ pat: `SYNTHETIC_LIST_${i}` })) });
    await subject.settled();
    expect(JSON.stringify(scripted.requests)).not.toContain('SYNTHETIC_');
    expect(JSON.stringify(scripted.requests)).toContain('"argument":"pat"');
    expect(subject.getSnapshot().records[0]?.routeKind).toBe('network');
  });

  test('receipt order and retention do not depend on judgment completion order', async () => {
    const bus = new RuntimeEventBus(); const subject = ledger(bus, 2);
    const { gate } = heldPort((request) => (request.state as { tool?: string }).tool === 'slow');
    receive(bus, 'old', {}, 'slow'); receive(bus, 'new'); await tick();
    expect(subject.getSnapshot().records.map((record) => record.callId)).toEqual(['new', 'old']);
    receive(bus, 'newest'); await tick(); await subject.settled();
    expect(subject.getSnapshot().records.map((record) => record.callId)).toEqual(['newest', 'new']);
    gate.resolve(); await tick();
    expect(subject.getSnapshot().records.map((record) => record.callId)).toEqual(['newest', 'new']);
  });

  test('an older delayed answer does not move its record ahead of a newer completed answer', async () => {
    const bus = new RuntimeEventBus(); const subject = ledger(bus);
    const { gate } = heldPort((request) => (request.state as { tool?: string }).tool === 'slow');
    receive(bus, 'old', {}, 'slow'); receive(bus, 'new'); await tick();
    expect(subject.getSnapshot().records[0]?.routeKind).toBe('network');
    expect(subject.getSnapshot().records[1]?.routeKind).toBe('other');
    gate.resolve(); await subject.settled();
    expect(subject.getSnapshot().records.map((record) => record.callId)).toEqual(['new', 'old']);
    expect(subject.getSnapshot().records[1]?.routeKind).toBe('network');
  });

  for (const phase of ['roles', 'route'] as const) test(`cancellation settles ${phase} judgment even when provider ignores abort; late answer cannot resurrect`, async () => {
    const bus = new RuntimeEventBus(); const subject = ledger(bus);
    const { gate, requests } = heldPort((request) => phase === 'roles' ? 'argument' in stateObject(request) : 'arguments' in stateObject(request));
    receive(bus, 'a', { destination: 'ordinary' }); await tick();
    expect(requests.some((request) => phase === 'roles' ? 'argument' in stateObject(request) : 'arguments' in stateObject(request))).toBe(true);
    emitToolPermissioned(bus, ctx, { ...call('a'), approved: false });
    emitToolCancelled(bus, ctx, { ...call('a'), reason: 'owner cancelled' });
    await subject.settled();
    expect(requests.every((request) => request.signal?.aborted)).toBe(true);
    const snapshot = subject.getSnapshot();
    expect(snapshot.records[0]).toEqual(expect.objectContaining({ status: 'cancelled', permissionApproved: false, cancelReason: 'owner cancelled' }));
    expect(snapshot.records[0]?.argsReadingError).toContain('cancelled');
    gate.resolve(); await tick(); emitToolSucceeded(bus, ctx, { ...call('a'), durationMs: 7 });
    receive(bus, 'a', { destination: 'late duplicate' }); await tick(); expect(subject.getSnapshot()).toEqual(snapshot);
    if (phase === 'roles') expect(requests.some((request) => 'arguments' in stateObject(request))).toBe(false);
    const roleRequests = requests.filter((request) => 'argument' in stateObject(request)).length;
    receive(bus, 'fresh', { destination: 'safe fresh target' }); await subject.settled();
    if (phase === 'roles') expect(requests.filter((request) => 'argument' in stateObject(request)).length).toBeGreaterThan(roleRequests);
  });

  test('all normal lifecycle fields survive pending judgment and terminal outcomes remain terminal', async () => {
    const bus = new RuntimeEventBus(); const subject = ledger(bus); const { gate } = heldPort(() => true);
    receive(bus, 'a', { destination: 'target' });
    emitToolValidated(bus, ctx, call('a')); emitToolPrehooked(bus, ctx, call('a'));
    emitToolPermissioned(bus, ctx, { ...call('a'), approved: true });
    emitToolExecuting(bus, ctx, { ...call('a'), startedAt: Date.now() });
    emitToolMapped(bus, ctx, call('a')); emitToolPosthooked(bus, ctx, call('a'));
    emitToolSucceeded(bus, ctx, { ...call('a'), durationMs: 42, result: { kind: 'text', byteSize: 2, preview: 'ok' } });
    receive(bus, 'b'); emitToolFailed(bus, ctx, { ...call('b'), durationMs: 3, error: 'ordinary failure' }); await tick();
    expect(subject.getSnapshot().succeeded).toBe(1); expect(subject.getSnapshot().failed).toBe(1);
    const completion = subject.getSnapshot().records[1]?.completedAt;
    gate.resolve(); await subject.settled();
    expect(subject.getSnapshot().records[1]).toEqual(expect.objectContaining({ status: 'succeeded', phase: 'TOOL_SUCCEEDED', durationMs: 42, completedAt: completion, permissionApproved: true, resultSummary: { kind: 'text', byteSize: 2, preview: 'ok' }, targetPreview: 'target' }));
    emitToolPermissioned(bus, ctx, { ...call('a'), approved: false }); await tick();
    expect(subject.getSnapshot().records[1]?.permissionApproved).toBe(true);
  });

  test('provider error echoes never enter snapshots or logger diagnostics and failed roles do not invoke route', async () => {
    const marker = 'SYNTHETIC_PROVIDER_ECHO'; const logged: unknown[][] = [];
    const warn = spyOn(logger, 'warn').mockImplementation((...args) => { logged.push(args); });
    try {
      const requests: unknown[] = [];
      installJudgmentPort({ model: 'jev-1.13.0', async ask(request) { requests.push(request.state); throw new Error(marker); } });
      const bus = new RuntimeEventBus(); const subject = ledger(bus);
      receive(bus, 'a', { pat: marker }); await subject.settled();
      expect(subject.getSnapshot().records[0]?.argsReadingError).toContain('unavailable');
      expect(subject.getSnapshot().records[0]?.commandPreview).toBeUndefined();
      expect(JSON.stringify([requests, logged, subject.getSnapshot()])).not.toContain(marker);
      expect(requests).toEqual([{ tool: 'read_everything', argument: 'pat' }]);
    } finally { warn.mockRestore(); }
  });

  test('uncertain route choice is visible as uncertainty rather than a confident kind', async () => {
    const port = fakePort((_name, question) => choiceAnswer(question, 'network', 0.5)); installJudgmentPort(port.port);
    const bus = new RuntimeEventBus(); const subject = ledger(bus); receive(bus, 'a'); await subject.settled();
    expect(subject.getSnapshot().records[0]?.routeKind).toBe('other');
    expect(subject.getSnapshot().records[0]?.routeKindError).toContain('uncertain');
  });

  test('dispose settles a pending non-cooperative reader, isolates subscribers and never enriches afterward', async () => {
    const bus = new RuntimeEventBus(); const subject = ledger(bus); const { gate } = heldPort(() => true); let notices = 0;
    subject.subscribe(() => { throw new Error('SYNTHETIC_SUBSCRIBER_ERROR'); }); subject.subscribe(() => { notices++; });
    receive(bus, 'a'); await tick(); expect(notices).toBe(1);
    subject.dispose(); await subject.settled(); const snapshot = subject.getSnapshot();
    gate.resolve(); await tick(); expect(subject.getSnapshot()).toEqual(snapshot); expect(notices).toBe(1);
  });
});

test('decision receipts survive permission/result projection as passive, detached provenance', async () => {
  const { toToolResultSummary } = await import('../sdk/src/platform/runtime/emitters/tools.ts');
  const decision: import('@goodvibes-jev/judgment/decisions').JevDecision = {
    schemaVersion: 1, decisionId: 'fixture-decision', outcome: 'act', summary: 'Synthetic recorded decision',
    binding: { sourceId: 'source', inputRevision: '1', actionId: 'action', actionRevision: '1', authorityId: 'authority', authorityRevision: '1', scopeId: 'scope', scopeRevision: '1' },
    judgmentDecisionIds: ['fixture-reading'], evidence: [],
  };
  const result = toToolResultSummary({ success: true, output: 'ok', autonomousDecision: decision });
  expect(result.autonomousDecision).toEqual(decision); expect(result.autonomousDecision).not.toBe(decision);
  const bus = new RuntimeEventBus(); const subject = ledger(bus); receive(bus, 'a');
  emitToolPermissioned(bus, ctx, { ...call('a'), approved: false, autonomousDecision: decision }); await tick();
  expect(subject.getSnapshot().records[0]?.autonomousDecision).toEqual(decision);
  expect(subject.getSnapshot().records[0]?.permissionApproved).toBe(false);
  emitToolFailed(bus, ctx, { ...call('a'), error: 'denied', durationMs: 1, result: toToolResultSummary({ success: false, error: 'denied', autonomousDecision: decision }) }); await subject.settled();
  const snapshot = subject.getSnapshot(); expect(snapshot.records[0]?.resultSummary?.autonomousDecision).toEqual(decision); expect(snapshot.records[0]?.status).toBe('failed');
  (snapshot.records[0]!.autonomousDecision!.binding as { actionId: string }).actionId = 'mutated';
  (snapshot.records[0]!.resultSummary!.autonomousDecision!.binding as { actionId: string }).actionId = 'mutated';
  expect(subject.getSnapshot().records[0]?.autonomousDecision?.binding.actionId).toBe('action');
  expect(subject.getSnapshot().records[0]?.resultSummary?.autonomousDecision?.binding.actionId).toBe('action');
});

test('argument role cache keeps exact tool/name pairs even when they contain delimiters', async () => {
  const scripted = fakePort((name, question, state) => {
    if (name === 'kind') return choiceAnswer(question, 'other', 0.99);
    const argument = (state as { argument?: string }).argument;
    return noulAnswer(name === 'holds_credential' && argument === 'b\u0000c' ? 0.999 : 0.001);
  });
  installJudgmentPort(scripted.port);
  const bus = new RuntimeEventBus(); const subject = ledger(bus);
  receive(bus, 'first', { c: 'ordinary' }, 'a\u0000b'); await subject.settled();
  receive(bus, 'second', { ['b\u0000c']: 'SYNTHETIC_CACHE_COLLISION' }, 'a'); await subject.settled();
  expect(JSON.stringify(scripted.requests)).not.toContain('SYNTHETIC_CACHE_COLLISION');
  expect(JSON.stringify(subject.getSnapshot())).not.toContain('SYNTHETIC_CACHE_COLLISION');
});
