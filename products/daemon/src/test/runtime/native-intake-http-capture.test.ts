/** Real route captures for browser replay. Only proposer/Jev readings are synthetic. */
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import { nativeConversationIntakeLookupResultSchema, type NativeConversationIntakeCaptureRequest } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { createNativeIntakeHttpFixture, fullInputProposal, intakeBarrier, type NativeIntakeHttpWire } from '../helpers/native-intake-http-fixture.js';

// HTML textareas expose LF line endings; the existing native-conversation test
// separately proves byte-for-byte CRLF preservation for non-browser clients.
const TEXT = '  Add JSON export.\nKeep CSV output unchanged. 🌻\nKeep CSV output unchanged.  ';
const source = (name: string, unsupported = false): NativeConversationIntakeCaptureRequest => ({
  requestId: `webui-native-${name}-request`, inputId: `webui-native-${name}-input`, text: TEXT,
  unsupportedSources: unsupported ? [{ kind: 'file', label: 'referenced-specification.pdf' }] : [],
});
function parse(wire: NativeIntakeHttpWire) {
  expect(wire.status).toBe(200);
  const value: unknown = JSON.parse(wire.body);
  const schema = operatorContract.operator.methods.find(entry => entry.id === wire.methodId)?.outputSchema;
  expect(schema).toBeDefined();
  expect(firstJsonSchemaFailure(schema!, value)).toBeUndefined();
  return value;
}
function result(wire: NativeIntakeHttpWire) { return nativeConversationIntakeLookupResultSchema.parse(parse(wire)); }
function exportCapture(name: string, capture: Record<string, unknown>) {
  const directory = process.env.GOODVIBES_TEST_NATIVE_INTAKE_FIXTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify({ source: 'owned-synthetic-provider; real authenticated DaemonServer HTTP', name, ...capture }, null, 2)}\n`);
}
async function begin(f: Awaited<ReturnType<typeof createNativeIntakeHttpFixture>>, input: NativeConversationIntakeCaptureRequest) {
  const auth = await f.wire('control.auth.current'), project = await f.wire('workLedger.project');
  expect(parse(auth)).toMatchObject({ authenticated: true, authMode: 'session', principalKind: 'token', admin: true, principalId: `pairing:${f.paired.id}` });
  parse(project);
  const lookupBefore = await f.wire('workLedger.intake.get', { inputId: input.inputId });
  expect(result(lookupBefore)).toEqual({ kind: 'not-found' });
  const capture = await f.wire('workLedger.intake.capture', input);
  const captured = result(capture);
  expect(captured.kind).toBe('captured');
  if (captured.kind === 'not-found') throw new Error('Missing captured source');
  const transition = { inputId: input.inputId, sourceRevision: captured.sourceRef.sourceRevision };
  const getCaptured = await f.wire('workLedger.intake.get', { inputId: input.inputId });
  expect(getCaptured.body).toBe(capture.body);
  expect(f.requests).toHaveLength(0); expect(f.fake.requests).toHaveLength(0);
  return { input, auth, project, lookupBefore, capture, getCaptured, transition };
}

test('native HTTP auth requires current paired ownership and both declared ledger scopes', async () => {
  const f = await createNativeIntakeHttpFixture();
  try {
    const input = source('auth');
    const denied = [];
    for (const token of [null, 'invalid-owned-fixture-token']) {
      const wire = await f.wire('workLedger.intake.capture', input, token);
      expect(wire.status).toBe(401); denied.push(wire);
    }
    const shared = await f.wire('workLedger.intake.capture', input, f.daemon.token);
    expect(shared.status).toBe(403); denied.push(shared);
    const login = await fetch(`${f.daemon.baseUrl}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
    expect(login.status).toBe(200);
    const user = await login.json() as { token: string };
    const session = await f.wire('workLedger.intake.capture', input, user.token);
    expect(session.status).toBe(403); denied.push(session);
    for (const operation of ['capture', 'get', 'admit', 'resume', 'cancel'] as const) {
      expect(f.daemon.services.gatewayMethods.get(`workLedger.intake.${operation}`)?.scopes).toEqual(['read:work-ledger', 'write:work-ledger']);
    }
    const catalog = f.daemon.services.gatewayMethods;
    const original = catalog.getAllScopes.bind(catalog);
    // Explicit test boundary: reduce otherwise real paired-token scope grants.
    // The real HTTP authorization gate must reject each missing required scope.
    for (const missing of ['read:work-ledger', 'write:work-ledger']) {
      const grant = spyOn(catalog, 'getAllScopes').mockImplementation(options => original(options).filter(scope => scope !== missing));
      try {
        for (const operation of ['capture', 'get', 'admit', 'resume', 'cancel'] as const) {
          const wire = await f.wire(`workLedger.intake.${operation}`, operation === 'capture' ? input
            : operation === 'get' ? { inputId: input.inputId } : { inputId: input.inputId, sourceRevision: 'not-yet-captured' });
          expect(wire.status).toBe(403); denied.push(wire);
        }
      } finally { grant.mockRestore(); }
    }
    for (const field of ['projectId', 'actorId', 'sessionId', 'sourceId', 'criteria', 'decisionId']) {
      const wire = await f.wire('workLedger.intake.capture', { ...input, [field]: 'injected' });
      expect(wire.status).toBe(400); denied.push(wire);
    }
    expect(f.requests).toHaveLength(0); expect(f.fake.requests).toHaveLength(0);
    exportCapture('auth-denied', { denied });
  } finally { await f.stop(); }
}, 30_000);

for (const name of ['work', 'turn', 'blocked', 'refused'] as const) {
  test(`capture exact native ${name} responses without execution or fallback`, async () => {
    const f = await createNativeIntakeHttpFixture({ route: name === 'turn' ? 'converse' : 'contract', final: name === 'blocked' || name === 'refused' ? 'reject' : 'act' });
    try {
      const base = await begin(f, source(name, name === 'blocked'));
      const admit = await f.wire('workLedger.intake.admit', base.transition);
      const admitted = result(admit); expect(admitted.kind).toBe(name);
      if (admitted.kind === 'work') {
        expect(admitted.receipt.goal).toBe(TEXT); expect(admitted.receipt.criteria).toEqual([TEXT]);
        expect(admitted.receipt.source.version).toBe(2);
      }
      if (admitted.kind === 'turn') expect(admitted.text).toBe(TEXT);
      const readings = f.fake.requests.length, proposals = f.requests.length;
      const get = await f.wire('workLedger.intake.get', { inputId: base.input.inputId });
      const resume = await f.wire('workLedger.intake.resume', base.transition);
      expect(get.body).toBe(admit.body); expect(resume.body).toBe(admit.body);
      const replay = await f.wire('workLedger.intake.capture', base.input);
      expect(replay.body).toBe(admit.body);
      expect(f.fake.requests).toHaveLength(readings); expect(f.requests).toHaveLength(proposals);
      const cancel = await f.wire('workLedger.intake.cancel', base.transition);
      const cancelled = result(cancel);
      expect(cancelled.kind).toBe(name === 'work' || name === 'turn' ? name : 'cancelled');
      expect(f.daemon.services.agentManager.list()).toHaveLength(0);
      expect(f.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
      exportCapture(name, { ...base, admit, get, resume, replay, cancel });
    } finally { await f.stop(); }
  }, 30_000);
}

test('capture live cancellation while proposer cleanup is held', async () => {
  const entered = intakeBarrier(), aborted = intakeBarrier(), cleanup = intakeBarrier();
  const f = await createNativeIntakeHttpFixture({ propose: async request => {
    entered.resolve();
    await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
    await cleanup.promise; request.signal!.throwIfAborted(); return fullInputProposal(request);
  } });
  try {
    const base = await begin(f, source('cancelled'));
    const admission = f.wire('workLedger.intake.admit', base.transition);
    await entered.promise;
    const pending = await f.wire('workLedger.intake.get', { inputId: base.input.inputId });
    expect(result(pending)).toMatchObject({ kind: 'processing', recovery: 'pending' });
    let finished = false;
    const cancellation = f.wire('workLedger.intake.cancel', base.transition).finally(() => { finished = true; });
    await aborted.promise; expect(finished).toBe(false);
    cleanup.resolve();
    const cancel = await cancellation, admit = await admission;
    expect(result(cancel).kind).toBe('cancelled'); expect(admit.status).toBeGreaterThanOrEqual(400);
    const get = await f.wire('workLedger.intake.get', { inputId: base.input.inputId });
    const resume = await f.wire('workLedger.intake.resume', base.transition);
    expect(get.body).toBe(cancel.body); expect(resume.body).toBe(cancel.body);
    expect(f.requests).toHaveLength(1); expect(f.daemon.services.agentManager.list()).toHaveLength(0);
    exportCapture('cancelled', { ...base, pending, admit, get, resume, cancel });
  } finally { cleanup.resolve(); await f.stop(); }
}, 30_000);

test('capture interrupted admission requiring explicit resume, never get or repeated admit', async () => {
  const f = await createNativeIntakeHttpFixture({ propose: async (request, attempt) => {
    if (attempt === 1) throw new Error('Owned synthetic proposer interruption');
    return fullInputProposal(request);
  } });
  try {
    const base = await begin(f, source('recovery'));
    const admit = await f.wire('workLedger.intake.admit', base.transition);
    expect(admit.status).toBeGreaterThanOrEqual(400);
    const get = await f.wire('workLedger.intake.get', { inputId: base.input.inputId });
    expect(result(get)).toMatchObject({ kind: 'processing', recovery: 'required' });
    const proposals = f.requests.length, readings = f.fake.requests.length;
    const repeatAdmit = await f.wire('workLedger.intake.admit', base.transition);
    expect(repeatAdmit.body).toBe(get.body);
    expect(f.requests).toHaveLength(proposals); expect(f.fake.requests).toHaveLength(readings);
    const resume = await f.wire('workLedger.intake.resume', base.transition);
    expect(result(resume).kind).toBe('work'); expect(f.requests).toHaveLength(2);
    const afterResume = await f.wire('workLedger.intake.get', { inputId: base.input.inputId });
    const cancel = await f.wire('workLedger.intake.cancel', base.transition);
    expect(afterResume.body).toBe(resume.body); expect(cancel.body).toBe(resume.body);
    expect(f.daemon.services.agentManager.list()).toHaveLength(0);
    exportCapture('recovery', { ...base, admit, get, repeatAdmit, resume, afterResume, cancel });
  } finally { await f.stop(); }
}, 30_000);
