/** Real DaemonServer source2 admission -> native graph HTTP proof and unchanged browser replay captures. */
import { expect, spyOn, test } from 'bun:test';
import * as ledger from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { MintedPairingToken } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import { nativeConversationIntakeLookupResultSchema, type NativeConversationIntakeCaptureRequest } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { nativeWorkExecutionSnapshotSchema, NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES, type NativeWorkExecutionRequest, type NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { createNativeIntakeExecutionHttpFixture, type NativeIntakeExecutionHttpWire } from '../helpers/native-intake-execution-http-fixture.js';
import { intakeBarrier, intakeProposalResponse } from '../helpers/native-intake-http-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const TEXT = '  Answer this request yourself without delegation. 🌻\nSay native execution is complete.\nSay native execution is complete.  ';
const source = (name: string): NativeConversationIntakeCaptureRequest => ({
  requestId: `webui-native-execution-${name}-request`, inputId: `webui-native-execution-${name}-input`, text: TEXT, unsupportedSources: [],
});
type Fixture = Awaited<ReturnType<typeof createNativeIntakeExecutionHttpFixture>>;
function parse(wire: NativeIntakeExecutionHttpWire) {
  expect(wire.status, wire.body).toBe(200);
  const value: unknown = JSON.parse(wire.body);
  const schema = operatorContract.operator.methods.find(entry => entry.id === wire.methodId)?.outputSchema;
  expect(schema).toBeDefined();
  expect(firstJsonSchemaFailure(schema!, value)).toBeUndefined();
  return value;
}
function intake(wire: NativeIntakeExecutionHttpWire) { return nativeConversationIntakeLookupResultSchema.parse(parse(wire)); }
function execution(wire: NativeIntakeExecutionHttpWire) {
  expect(new TextEncoder().encode(wire.body).byteLength).toBeLessThanOrEqual(NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES);
  expect(wire.body).not.toContain(JSON.stringify(TEXT).slice(1, -1));
  for (const forbidden of ['authorityId', 'authorityRevision', 'scopeId', 'scopeRevision', 'decisionContext', 'nativeSource', 'projectRoot', 'judgmentDecisionIds']) expect(wire.body).not.toContain(forbidden);
  return nativeWorkExecutionSnapshotSchema.parse(parse(wire));
}
function exportCapture(name: string, capture: Record<string, unknown>) {
  const directory = process.env.GOODVIBES_TEST_NATIVE_EXECUTION_FIXTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify({ source: 'owned-synthetic-provider; real paired DaemonServer intake and native execution graph HTTP', name, ...capture }, null, 2)}\n`);
}
async function admitted(f: Fixture, name: string) {
  const input = source(name);
  const auth = await f.wire('control.auth.current'), project = await f.wire('workLedger.project');
  expect(parse(auth)).toMatchObject({ authenticated: true, authMode: 'session', principalKind: 'token', admin: true, principalId: `pairing:${f.paired.id}` });
  const lookupBefore = await f.wire('workLedger.intake.get', { inputId: input.inputId });
  expect(intake(lookupBefore)).toEqual({ kind: 'not-found' });
  const capture = await f.wire('workLedger.intake.capture', input);
  const captured = intake(capture);
  if (captured.kind !== 'captured') throw new Error(`Expected original source capture: ${capture.body}`);
  expect(parse(project)).toEqual({ projectId: captured.projectId });
  const transition = { inputId: input.inputId, sourceRevision: captured.sourceRef.sourceRevision };
  const getCaptured = await f.wire('workLedger.intake.get', { inputId: input.inputId });
  expect(getCaptured.body).toBe(capture.body);
  expect(f.requests).toHaveLength(0); expect(f.judgmentRequests).toHaveLength(0);
  const admit = await f.wire('workLedger.intake.admit', transition);
  const result = intake(admit);
  if (result.kind !== 'work') throw new Error(`Expected admitted source2 work: ${admit.body}`);
  expect(result.receipt.goal).toBe(TEXT); expect(result.receipt.criteria).toEqual([TEXT]);
  expect(result.receipt.source).toMatchObject({ version: 2, sourceId: captured.sourceRef.sourceId, sourceRevision: transition.sourceRevision,
    spans: [{ partId: 'input', start: 0, end: TEXT.length }] });
  expect(result.receipt.expectedRevision).toEqual({ work: 1, criteria: 1, attempt: 1 });
  const identity: NativeWorkExecutionRequest = { projectId: result.projectId, workId: result.receipt.workId,
    attemptId: result.receipt.attemptId, expectedRevision: result.receipt.expectedRevision };
  const readings = f.judgmentRequests.length;
  const get = await f.wire('workLedger.intake.get', { inputId: input.inputId });
  expect(get.body).toBe(admit.body);
  const notStarted = await f.wire('workLedger.execution.status', identity);
  expect(notStarted.status).toBe(404); expect(notStarted.body).toContain('NATIVE_EXECUTION_NOT_FOUND');
  expect(f.requests).toHaveLength(1); expect(f.judgmentRequests).toHaveLength(readings);
  expect(f.daemon.services.agentManager.list()).toHaveLength(0);
  expect(f.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
  return { input, auth, project, lookupBefore, capture, getCaptured, transition, admit, get, identity, notStarted };
}
async function waitStatus(f: Fixture, identity: NativeWorkExecutionRequest, predicate: (snapshot: NativeWorkExecutionSnapshot) => boolean) {
  const deadline = Date.now() + 15_000;
  while (true) {
    const status = await f.wire('workLedger.execution.status', identity);
    const snapshot = execution(status);
    if (predicate(snapshot)) return status;
    if (Date.now() >= deadline || (snapshot.kind === 'execution' && ['failed', 'cancelled'].includes(snapshot.progress?.status ?? ''))) {
      throw new Error(`Native execution did not reach the expected outcome: ${status.body}; contracts: ${JSON.stringify(f.contracts().map(contract => ({ status: contract.status, failureKind: contract.failureKind, error: contract.error })))}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const unitRequests = (f: Fixture) => f.requests.filter(request => request.systemPrompt?.includes('Execute this existing native work unit yourself'));

test('generated criteria digest with a card-shaped digit span executes through the real native daemon graph', async () => {
  const workId = 'work-a73a83d8-d064-4be3-8217-012ebfe72275';
  const criteriaId = 'criteria:d6b72d9f28026994604091a0bbac8dfa87467c68300f6960922429de420bbdfb';
  const create = ledger.createWorkLedger;
  // Control only the host's generated work identity; all storage, source,
  // authority, admission, decision, runner and HTTP paths remain production code.
  const generated = spyOn(ledger, 'createWorkLedger').mockImplementation(options => create({ ...options,
    clock: { ...options.clock, newId: kind => kind === 'work' ? workId : options.clock.newId(kind) },
  }));
  let f: Fixture | undefined;
  try {
    f = await createNativeIntakeExecutionHttpFixture();
    const base = await admitted(f, 'criteria-reference');
    expect(base.identity.workId).toBe(workId);
    execution(await f.wire('workLedger.execution.start', base.identity));
    const terminal = await waitStatus(f, base.identity, value => value.kind === 'execution'
      && value.progress?.status === 'passed' && value.settlement?.state === 'published');
    expect(execution(terminal)).toMatchObject({ kind: 'execution', progress: { status: 'passed' }, settlement: { state: 'published' } });
    expect(unitRequests(f)).toHaveLength(1);
    const contract = f.contracts()[0]!;
    expect(contract.nativeSource!.criteriaId).toBe(criteriaId);
    expect(contract.durableAdmission!.key).toMatchObject({ workId, criteriaId });
    const plans = contract.nativeDecisions!.history.filter(record => record.stage === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]!.decision.outcome).toBe('act');
    expect(plans[0]!.decision.evidence).toContainEqual({ id: criteriaId.slice('criteria:'.length), revision: '1' });
    expect(plans[0]!.decision.judgmentDecisionIds.length).toBeGreaterThan(0);
    expect(f.judgmentRequests.some(request => request.context?.site === 'contract.native.plan')).toBe(true);
  } finally { try { await f?.stop(); } finally { generated.mockRestore(); } }
}, 30_000);

test('source2 work executes once in the production native graph and reconciles lost start and settlement responses', async () => {
  const entered = intakeBarrier(), release = intakeBarrier();
  const f = await createNativeIntakeExecutionHttpFixture({ execute: async () => {
    entered.resolve(); await release.promise; return intakeProposalResponse('native execution is complete');
  } });
  try {
    const base = await admitted(f, 'running');
    const start = await f.wire('workLedger.execution.start', base.identity);
    const started = execution(start);
    expect(started).toMatchObject({ kind: 'execution', expectedRevision: base.identity.expectedRevision, currentRevision: base.identity.expectedRevision, stale: false, currentAttempt: true });
    if (started.kind !== 'execution' || !started.receipt) throw new Error('Expected genuine native execution receipt');
    await entered.promise;
    const status = await f.wire('workLedger.execution.status', base.identity);
    expect(execution(status)).toMatchObject({ kind: 'execution', receipt: started.receipt, progress: { sessionMode: true } });
    // A caller lost start's HTTP response. Inspection and exact repeated delivery
    // recover this same real owner; no extra execution body is created.
    const repeatStart = await f.wire('workLedger.execution.start', base.identity);
    expect(execution(repeatStart)).toMatchObject({ kind: 'execution', receipt: started.receipt });
    expect(unitRequests(f)).toHaveLength(1);
    expect(f.contracts()).toHaveLength(1);
    expect(f.contracts()[0]!.id).toBe(started.receipt.contractId);
    const admittedWork = intake(base.admit);
    if (admittedWork.kind !== 'work') throw new Error('Expected original admitted work');
    expect(f.contracts()[0]!.nativeSource).toMatchObject({ goal: TEXT, criteria: [TEXT],
      sourceId: admittedWork.sourceRef.sourceId,
      sourceRevision: base.transition.sourceRevision });
    const nativeReadings = f.judgmentRequests.filter(request => request.context?.site === 'work-ledger.native-start');
    expect(nativeReadings).toHaveLength(1);
    expect(nativeReadings[0]!.state).toMatchObject({ input: { originalSource: { goal: TEXT, criteria: [TEXT] }, revisions: base.identity.expectedRevision } });
    expect(unitRequests(f)[0]!.messages.some(message => JSON.stringify(message).includes(JSON.stringify(TEXT).slice(1, -1)))).toBe(true);
    expect(unitRequests(f)[0]!.tools?.some(tool => ['agent', 'workflow', 'registry'].includes(tool.name))).toBe(false);
    const cancelIntake = await f.wire('workLedger.intake.cancel', base.transition);
    expect(cancelIntake.body).toBe(base.admit.body);
    const afterIntakeCancel = await f.wire('workLedger.execution.status', base.identity);
    expect(execution(afterIntakeCancel)).toMatchObject({ kind: 'execution', receipt: started.receipt, state: 'launch-claimed', recovery: 'available' });
    exportCapture('running', { ...base, start, status, repeatStart, cancelIntake, afterIntakeCancel });
    release.resolve();
    const terminal = await waitStatus(f, base.identity, value => value.kind === 'execution' && value.progress?.status === 'passed' && value.settlement?.state === 'published');
    const settled = execution(terminal);
    expect(settled).toMatchObject({ kind: 'execution', receipt: started.receipt, expectedRevision: base.identity.expectedRevision,
      progress: { status: 'passed', sessionMode: true, units: { total: 1, passed: 1, failed: 0 } }, settlement: { state: 'published' }, stale: true, currentAttempt: false });
    expect(settled.currentRevision).not.toEqual(base.identity.expectedRevision);
    const readings = f.judgmentRequests.length, providers = f.requests.length;
    const resume = await f.wire('workLedger.execution.resume', base.identity);
    const afterResume = await f.wire('workLedger.execution.status', base.identity);
    expect(resume.body).toBe(terminal.body); expect(afterResume.body).toBe(terminal.body);
    expect(f.judgmentRequests).toHaveLength(readings); expect(f.requests).toHaveLength(providers);
    expect(unitRequests(f)).toHaveLength(1);
    const wrongRevision = await f.wire('workLedger.execution.resume', { ...base.identity, expectedRevision: settled.currentRevision });
    expect(wrongRevision.status).toBe(409);
    expect(f.daemon.services.agentManager.list()).toHaveLength(0);
    expect(f.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    exportCapture('terminal', { ...base, start, status: terminal, resume, afterResume, wrongRevision });
  } finally { release.resolve(); await f.stop(); }
}, 30_000);

test('target-aware cancellation prevents a first start and never invents receipt or progress', async () => {
  const f = await createNativeIntakeExecutionHttpFixture();
  try {
    const base = await admitted(f, 'prevented');
    const readings = f.judgmentRequests.length, providers = f.requests.length;
    const cancel = await f.wire('workLedger.execution.cancel', base.identity);
    expect(execution(cancel)).toMatchObject({ kind: 'prevented-before-admission', state: 'cancelled', recovery: 'cancelled' });
    const start = await f.wire('workLedger.execution.start', base.identity);
    const status = await f.wire('workLedger.execution.status', base.identity);
    const resume = await f.wire('workLedger.execution.resume', base.identity);
    const repeatCancel = await f.wire('workLedger.execution.cancel', base.identity);
    for (const wire of [start, status, resume, repeatCancel]) {
      expect(wire.body).toBe(cancel.body);
      const value = execution(wire); expect('receipt' in value).toBe(false); expect('progress' in value).toBe(false);
    }
    expect(f.judgmentRequests).toHaveLength(readings); expect(f.requests).toHaveLength(providers);
    exportCapture('prevented', { ...base, cancel, start, status, resume, repeatCancel });
  } finally { await f.stop(); }
}, 30_000);

test('pending admission cancellation persists prevention before joining a held Jev call', async () => {
  const entered = intakeBarrier(), aborted = intakeBarrier(), release = intakeBarrier();
  const f = await createNativeIntakeExecutionHttpFixture({ beforeJudgment: async request => {
    if (request.context?.site !== 'work-ledger.native-start') return;
    entered.resolve();
    request.signal!.addEventListener('abort', () => aborted.resolve(), { once: true });
    // Deliberately ignore abort until cleanup is released. The host owns drainage.
    await release.promise;
  } });
  try {
    const base = await admitted(f, 'pending-intent');
    const starting = f.wire('workLedger.execution.start', base.identity);
    await entered.promise;
    const pending = await f.wire('workLedger.execution.status', base.identity);
    expect(execution(pending)).toMatchObject({ kind: 'pending-intent', state: 'admitting', recovery: 'pending' });
    let finished = false;
    const cancelling = f.wire('workLedger.execution.cancel', base.identity).finally(() => { finished = true; });
    await aborted.promise; expect(finished).toBe(false);
    const prevented = await f.wire('workLedger.execution.status', base.identity);
    expect(execution(prevented).kind).toBe('prevented-before-admission');
    expect(unitRequests(f)).toHaveLength(0); expect(f.requests).toHaveLength(1);
    release.resolve();
    const cancel = await cancelling, start = await starting;
    expect(execution(cancel).kind).toBe('prevented-before-admission');
    expect(execution(start).kind).toBe('prevented-before-admission');
    const status = await f.wire('workLedger.execution.status', base.identity);
    expect(status.body).toBe(cancel.body); expect(unitRequests(f)).toHaveLength(0);
    exportCapture('pending-intent', { ...base, pending, prevented, start, cancel, status });
  } finally { release.resolve(); await f.stop(); }
}, 30_000);

for (const kind of ['required', 'refused'] as const) test(`${kind} execution intent only continues through explicit exact-target resume`, async () => {
  let first = true;
  const f = await createNativeIntakeExecutionHttpFixture({ beforeJudgment: async request => {
    if (kind === 'required' && request.context?.site === 'work-ledger.native-start' && first) {
      first = false; throw new Error('Owned synthetic initial execution interruption');
    }
  } });
  try {
    const base = await admitted(f, kind);
    f.controls.refuseExecution = kind === 'refused';
    const start = await f.wire('workLedger.execution.start', base.identity);
    expect(start.status).toBe(kind === 'refused' ? 422 : 503);
    const status = await f.wire('workLedger.execution.status', base.identity);
    expect(execution(status)).toMatchObject({ kind: 'pending-intent', state: kind === 'refused' ? 'refused' : 'admitting', recovery: 'required' });
    const readings = f.judgmentRequests.length, providers = f.requests.length;
    const repeatStart = await f.wire('workLedger.execution.start', base.identity);
    if (kind === 'refused') expect(repeatStart.status).toBe(422);
    else expect(repeatStart.body).toBe(status.body);
    const inspectAgain = await f.wire('workLedger.execution.status', base.identity);
    expect(inspectAgain.body).toBe(status.body);
    expect((await f.wire('workLedger.intake.get', { inputId: base.input.inputId })).body).toBe(base.admit.body);
    expect(f.judgmentRequests).toHaveLength(readings); expect(f.requests).toHaveLength(providers);
    const staleResume = await f.wire('workLedger.execution.resume', { ...base.identity, expectedRevision: { ...base.identity.expectedRevision, criteria: 2 } });
    expect(staleResume.status).toBe(409); expect(f.judgmentRequests).toHaveLength(readings);
    f.controls.refuseExecution = false;
    const resume = await f.wire('workLedger.execution.resume', base.identity);
    expect(execution(resume).kind).toBe('execution');
    const afterResume = await waitStatus(f, base.identity, value => value.kind === 'execution' && value.settlement?.state === 'published');
    expect(execution(afterResume)).toMatchObject({ expectedRevision: base.identity.expectedRevision, progress: { status: 'passed' } });
    expect(unitRequests(f)).toHaveLength(1);
    expect(f.judgmentRequests.filter(request => request.context?.site === 'work-ledger.native-start')).toHaveLength(2);
    exportCapture(kind, { ...base, start, status, repeatStart, inspectAgain, staleResume, resume, afterResume });
  } finally { await f.stop(); }
}, 30_000);

test('an admitted execution cancellation joins actual foreground provider cleanup', async () => {
  const entered = intakeBarrier(), aborted = intakeBarrier(), cleanup = intakeBarrier();
  const f = await createNativeIntakeExecutionHttpFixture({ execute: async request => {
    entered.resolve();
    await new Promise<void>(resolve => {
      if (request.signal!.aborted) { aborted.resolve(); resolve(); }
      else request.signal!.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true });
    });
    await cleanup.promise;
    request.signal!.throwIfAborted(); return intakeProposalResponse('No post-cancellation output');
  } });
  try {
    const base = await admitted(f, 'cancelled-execution');
    const start = await f.wire('workLedger.execution.start', base.identity);
    const started = execution(start);
    if (started.kind !== 'execution' || !started.receipt) throw new Error('Expected execution association');
    await entered.promise;
    const status = await f.wire('workLedger.execution.status', base.identity);
    let finished = false;
    const cancelling = f.wire('workLedger.execution.cancel', base.identity).finally(() => { finished = true; });
    await aborted.promise; expect(finished).toBe(false);
    cleanup.resolve();
    const cancel = await cancelling;
    expect(execution(cancel)).toMatchObject({ kind: 'execution', state: 'cancelled', recovery: 'cancelled', receipt: started.receipt, progress: { status: 'cancelled' } });
    const afterCancel = await f.wire('workLedger.execution.status', base.identity);
    expect(afterCancel.body).toBe(cancel.body);
    const resume = await f.wire('workLedger.execution.resume', base.identity);
    expect(resume.status).toBe(409); expect(unitRequests(f)).toHaveLength(1);
    exportCapture('cancelled-execution', { ...base, start, status, cancel, afterCancel, resume });
  } finally { cleanup.resolve(); await f.stop(); }
}, 30_000);

test('terminal settlement failure stays distinct and explicit resume verifies without running the body again', async () => {
  const f = await createNativeIntakeExecutionHttpFixture();
  try {
    const base = await admitted(f, 'settlement');
    f.controls.failSettlement = true;
    const start = await f.wire('workLedger.execution.start', base.identity);
    const failed = await waitStatus(f, base.identity, value => value.kind === 'execution' && value.progress?.status === 'passed' && value.settlement?.state === 'failed');
    expect(execution(failed)).toMatchObject({ kind: 'execution', expectedRevision: base.identity.expectedRevision, currentAttempt: true, stale: false,
      progress: { status: 'passed' }, settlement: { state: 'failed' } });
    const providers = f.requests.length, readings = f.judgmentRequests.length;
    const inspectAgain = await f.wire('workLedger.execution.status', base.identity);
    expect(inspectAgain.body).toBe(failed.body); expect(f.judgmentRequests).toHaveLength(readings);
    f.controls.failSettlement = false;
    const resume = await f.wire('workLedger.execution.resume', base.identity);
    expect(execution(resume)).toMatchObject({ kind: 'execution', progress: { status: 'passed' }, settlement: { state: 'published' }, expectedRevision: base.identity.expectedRevision, currentAttempt: false, stale: true });
    expect(f.requests).toHaveLength(providers); expect(unitRequests(f)).toHaveLength(1);
    const afterResume = await f.wire('workLedger.execution.status', base.identity);
    const repeatResume = await f.wire('workLedger.execution.resume', base.identity);
    expect(afterResume.body).toBe(resume.body); expect(repeatResume.body).toBe(resume.body);
    exportCapture('settlement', { ...base, start, status: failed, inspectAgain, resume, afterResume, repeatResume });
  } finally { await f.stop(); }
}, 30_000);

test('all execution operations reject foreign, shared, revoked and missing-scope principals before effects', async () => {
  const f = await createNativeIntakeExecutionHttpFixture();
  try {
    const base = await admitted(f, 'auth');
    const foreign = f.daemon.services.pairingTokens.mint({ name: 'Other owned synthetic principal' });
    const denied: NativeIntakeExecutionHttpWire[] = [];
    const readings = f.judgmentRequests.length, providers = f.requests.length;
    for (const operation of ['start', 'status', 'cancel', 'resume'] as const) {
      expect(f.daemon.services.gatewayMethods.get(`workLedger.execution.${operation}`)?.scopes).toEqual(['read:work-ledger', 'write:fleet']);
      const shared = await f.wire(`workLedger.execution.${operation}`, base.identity, f.daemon.token);
      expect(shared.status).toBe(403); denied.push(shared);
      const other = await f.wire(`workLedger.execution.${operation}`, base.identity, foreign.token);
      // Existing-attempt inspections are not allowed to create an association.
      expect([403, 404, 409]).toContain(other.status); denied.push(other);
      const wrongProject = await f.wire(`workLedger.execution.${operation}`, { ...base.identity, projectId: 'foreign-project' });
      expect(wrongProject.status).toBe(403); denied.push(wrongProject);
    }
    const catalog = f.daemon.services.gatewayMethods, original = catalog.getAllScopes.bind(catalog);
    const prevented = await f.wire('workLedger.execution.cancel', base.identity);
    expect(execution(prevented).kind).toBe('prevented-before-admission');
    for (const operation of ['start', 'status', 'cancel', 'resume'] as const) {
      const wire = await f.wire(`workLedger.execution.${operation}`, base.identity, foreign.token);
      expect(wire.status).toBe(409); expect(wire.body).toContain('NATIVE_EXECUTION_STALE'); denied.push(wire);
    }
    for (const missing of ['read:work-ledger', 'write:fleet']) {
      const grant = spyOn(catalog, 'getAllScopes').mockImplementation(options => original(options).filter(scope => scope !== missing));
      try {
        for (const operation of ['start', 'status', 'cancel', 'resume'] as const) {
          const wire = await f.wire(`workLedger.execution.${operation}`, base.identity);
          expect(wire.status).toBe(403); denied.push(wire);
        }
      } finally { grant.mockRestore(); }
    }
    for (const field of ['goal', 'criteria', 'source', 'sourceId', 'actorId', 'sessionId', 'decisionId', 'receipt']) {
      const wire = await f.wire('workLedger.execution.start', { ...base.identity, [field]: 'injected' });
      expect(wire.status).toBe(400); denied.push(wire);
    }
    f.daemon.services.pairingTokens.revoke(f.paired.id);
    for (const operation of ['start', 'status', 'cancel', 'resume'] as const) {
      const wire = await f.wire(`workLedger.execution.${operation}`, base.identity);
      expect(wire.status).toBe(401); denied.push(wire);
    }
    expect(f.judgmentRequests).toHaveLength(readings); expect(f.requests).toHaveLength(providers);
    expect(unitRequests(f)).toHaveLength(0);
    exportCapture('auth-denied', { ...base, prevented, denied });
  } finally { await f.stop(); }
}, 30_000);

test('cold daemon status exposes required settlement and explicit resume only publishes the original terminal result', async () => {
  const warm = await createNativeIntakeExecutionHttpFixture();
  let cold: Fixture | undefined;
  try {
    const base = await admitted(warm, 'settlement-required');
    warm.controls.failSettlement = true;
    const start = await warm.wire('workLedger.execution.start', base.identity);
    const failed = await waitStatus(warm, base.identity, value => value.kind === 'execution' && value.progress?.status === 'passed' && value.settlement?.state === 'failed');
    const before = execution(failed);
    if (before.kind !== 'execution') throw new Error('Expected genuine terminal execution');
    expect(unitRequests(warm)).toHaveLength(1);
    await warm.stop();
    cold = await createNativeIntakeExecutionHttpFixture({ root: warm.root, paired: warm.paired });
    const auth = await cold.wire('control.auth.current'), project = await cold.wire('workLedger.project');
    expect(parse(auth)).toMatchObject({ principalId: `pairing:${warm.paired.id}` });
    expect(project.body).toBe(base.project.body);
    const get = await cold.wire('workLedger.intake.get', { inputId: base.input.inputId });
    expect(get.body).toBe(base.admit.body);
    const status = await cold.wire('workLedger.execution.status', base.identity);
    expect(execution(status)).toMatchObject({ kind: 'execution', receipt: before.receipt, progress: { status: 'passed' },
      settlement: { state: 'required' }, expectedRevision: base.identity.expectedRevision, currentAttempt: true, stale: false });
    const inspectAgain = await cold.wire('workLedger.execution.status', base.identity);
    expect(inspectAgain.body).toBe(status.body);
    expect(cold.requests).toHaveLength(0); expect(cold.judgmentRequests).toHaveLength(0);
    const resume = await cold.wire('workLedger.execution.resume', base.identity);
    expect(execution(resume)).toMatchObject({ kind: 'execution', receipt: before.receipt, progress: { status: 'passed' },
      settlement: { state: 'published' }, expectedRevision: base.identity.expectedRevision, currentAttempt: false, stale: true });
    expect(cold.requests).toHaveLength(0);
    expect(cold.judgmentRequests.map(request => request.context?.site).sort()).toEqual(['contract.check.unit-judge', 'contract.check.unit-quality']);
    // Lose resume's acknowledgment, reopen again, and reconcile the original
    // durable settlement without another check or foreground body.
    await cold.stop();
    cold = await createNativeIntakeExecutionHttpFixture({ root: warm.root, paired: warm.paired });
    const afterResume = await cold.wire('workLedger.execution.status', base.identity);
    const repeatResume = await cold.wire('workLedger.execution.resume', base.identity);
    expect(afterResume.body).toBe(resume.body); expect(repeatResume.body).toBe(resume.body);
    expect(cold.requests).toHaveLength(0); expect(cold.judgmentRequests).toHaveLength(0);
    exportCapture('settlement-required', { ...base, auth, project, get, start, failed, status, inspectAgain, resume, afterResume, repeatResume });
  } finally { if (cold) await cold.stop(); else await warm.stop(); }
}, 30_000);

test('a real queued prepared attempt survives process exit and only explicit resume runs its original body', async () => {
  const root = makeOwnedTempDir('native-intake-prepared-process');
  const input = source('prepared');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../helpers/native-intake-execution-http-child.ts', import.meta.url)), root, JSON.stringify(input)], {
    encoding: 'utf8', timeout: 20_000,
  });
  expect(child.status, child.stderr).toBe(0);
  const prepared = JSON.parse(readFileSync(join(root, 'prepared-child-result.json'), 'utf8')) as {
    paired: MintedPairingToken;
    capture: Awaited<ReturnType<typeof admitted>> & { start: NativeIntakeExecutionHttpWire };
  };
  const base = prepared.capture;
  const started = execution(base.start);
  expect(started).toMatchObject({ kind: 'execution', state: 'prepared', recovery: 'available', expectedRevision: base.identity.expectedRevision });
  if (started.kind !== 'execution' || !started.receipt) throw new Error('Expected genuinely queued native receipt');
  const f = await createNativeIntakeExecutionHttpFixture({ root, paired: prepared.paired, resumedSourceText: input.text });
  try {
    const auth = await f.wire('control.auth.current'), project = await f.wire('workLedger.project');
    const status = await f.wire('workLedger.execution.status', base.identity);
    expect(execution(status)).toMatchObject({ kind: 'execution', state: 'prepared', recovery: 'available', receipt: started.receipt,
      currentRevision: base.identity.expectedRevision, expectedRevision: base.identity.expectedRevision, stale: false, currentAttempt: true });
    const inspectAgain = await f.wire('workLedger.execution.status', base.identity);
    const get = await f.wire('workLedger.intake.get', { inputId: input.inputId });
    expect(inspectAgain.body).toBe(status.body); expect(get.body).toBe(base.admit.body);
    expect(f.requests).toHaveLength(0); expect(f.judgmentRequests).toHaveLength(0);
    const resume = await f.wire('workLedger.execution.resume', base.identity);
    expect(execution(resume)).toMatchObject({ kind: 'execution', receipt: started.receipt, expectedRevision: base.identity.expectedRevision });
    const afterResume = await waitStatus(f, base.identity, value => value.kind === 'execution' && value.settlement?.state === 'published');
    expect(execution(afterResume)).toMatchObject({ kind: 'execution', receipt: started.receipt, progress: { status: 'passed' } });
    expect(unitRequests(f)).toHaveLength(1);
    expect(f.judgmentRequests.filter(request => request.context?.site === 'work-ledger.native-start')).toHaveLength(1);
    exportCapture('prepared', { ...base, auth, project, get, status, inspectAgain, resume, afterResume });
  } finally { await f.stop(); }
}, 40_000);
