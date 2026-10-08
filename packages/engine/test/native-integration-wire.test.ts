/** Lightweight protocol/lifecycle fences. Actual native engine proof lives in contract tests. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import type { GatewayMethodInvocation } from '../sdk/src/platform/control-plane/method-catalog-shared.js';
import { registerNativeWorkExecutionGatewayMethods } from '../sdk/src/platform/control-plane/routes/native-work-execution.js';
import { createNativeWorkExecutionHost, type NativePairedExecutionSnapshot, type NativePairedExecutionAuthority, type NativeWorkExecutionStatus } from '../sdk/src/platform/workflow/work-ledger/native-execution.js';
import type { NativeWorkExecutionStorage, NativeWorkExecutionRecord, NativeWorkExecutionTransaction } from '../sdk/src/platform/workflow/work-ledger/native-execution-types.js';
import { createOperatorNativeWorkExecutionClient } from '../sdk/src/platform/workflow/work-ledger/native-execution-client.js';
import { nativeWorkExecutionSnapshotSchema, NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES, type NativeWorkExecutionExecutionSnapshot } from '../sdk/src/platform/workflow/work-ledger/native-execution-wire.js';
import type { ContractRunner } from '../sdk/src/platform/contract/runner.js';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { makeContract } from './contract/fixtures.js';
import { createEmptyWorkLedgerState } from '../sdk/src/platform/workflow/work-ledger/index.js';
import { firstJsonSchemaFailure } from '../transport-http/src/index.js';

const identity = { projectId: 'project', workId: 'work', attemptId: 'attempt', expectedRevision: { work: 1, criteria: 1, attempt: 1 } };
const selection = { workId: identity.workId, attemptId: identity.attemptId, expectedRevision: identity.expectedRevision };
function snapshot(): NativeWorkExecutionExecutionSnapshot {
  return { kind: 'execution', ...identity, currentRevision: identity.expectedRevision, currentAttempt: true, stale: false,
    state: 'launch-claimed', recovery: 'available', receipt: { contractId: 'ctr-11111111', ownerAgentId: 'owner' },
    progress: { status: 'running', sessionMode: false, semanticState: null, stage: null, retrying: false,
      units: { total: 1, passed: 1, failed: 0 }, criteria: { total: 1, met: 1, unmet: 0, unshown: 0 } },
    integration: { state: 'live', contractId: 'ctr-11111111', isolation: 'worktree', units: [{ unitId: 'u1', groupId: 'g1', unitStatus: 'passed',
      latestCheck: { id: 'u1.k1', at: 1, trigger: 'fix-passed', result: 'pass' }, item: { state: 'recorded', itemId: 'item-real', workstreamId: 'g1', integration: 'conflict', conflictFiles: ['actual.ts'] } }] } };
}
function client(value: unknown) {
  return createOperatorNativeWorkExecutionClient({ invoke: async <T>() => value as T }, 'project');
}
const target = { workId: 'work', attemptId: 'attempt', workRevision: 1, criteriaRevision: 1, attemptRevision: 1 };
const key = { workId: 'work', attemptId: 'attempt', criteriaId: 'criteria', criteriaRevision: '1' };

function authorityFixture() {
  let current: NativePairedExecutionSnapshot | null = { kind: 'pairing-token', principalId: 'principal', authorityId: 'principal', authorityRevision: 'incarnation', tokenId: 'incarnation', scopes: ['read:work-ledger', 'write:fleet'] };
  const authority: NativePairedExecutionAuthority = { current: () => current,
    async withCurrent(expected, callback) { if (current !== expected) throw new Error('changed'); return callback(() => { if (!current) throw new Error('revoked'); return current; }); } };
  return { authority, get current() { return current; }, set current(value) { current = value; } };
}

test('integration wire accepts detached truthful facts through the strict client and live catalog schema', async () => {
  const value = snapshot(); const parsed = await client(value).status(selection);
  expect(parsed).toEqual(value); expect(parsed).not.toBe(value);
  if (parsed.kind !== 'execution' || parsed.integration?.state !== 'live') throw new Error('Expected live');
  expect(parsed.integration.units).not.toBe(value.integration?.state === 'live' ? value.integration.units : null);
  const schema = new GatewayMethodCatalog().get('workLedger.execution.status')!.outputSchema!;
  expect(firstJsonSchemaFailure(schema, value)).toBeUndefined();
  expect(nativeWorkExecutionSnapshotSchema.safeParse({ ...value, integration: { ...value.integration, resolve: true } }).success).toBe(false);
});

test('forged live integration cannot cross receipt, attempt, revision, lifecycle or item joins', async () => {
  const mutate: Array<(value: NativeWorkExecutionExecutionSnapshot) => void> = [
    value => { value.receipt = null; }, value => { value.receipt!.contractId = 'ctr-22222222'; },
    value => { value.currentAttempt = false; }, value => { value.stale = true; },
    value => { value.currentRevision = { ...value.expectedRevision, attempt: 2 }; },
    value => { value.state = 'cancelled'; }, value => { value.state = 'prepared'; },
    value => { value.recovery = 'required'; }, value => { value.recovery = 'terminal'; },
    value => { value.progress = null; }, value => { value.progress!.status = 'passed'; }, value => { value.progress!.sessionMode = true; },
    value => { if (value.integration?.state === 'live') value.integration.units.push({ ...value.integration.units[0]! }); },
    value => { if (value.integration?.state === 'live') value.integration.units[0]!.attemptOf = 'missing-parent'; },
    value => { if (value.integration?.state === 'live') value.integration.units[0]!.attemptIndex = 0; },
    value => { if (value.integration?.state === 'live' && value.integration.units[0]!.item.state === 'recorded') value.integration.units[0]!.item.workstreamId = 'other-group'; },
    value => { if (value.integration?.state === 'live' && value.integration.units[0]!.item.state === 'recorded') value.integration.units[0]!.item.mergeHash = 'invented-merge'; },
  ];
  for (const change of mutate) { const value = snapshot(); change(value); await expect(client(value).status(selection)).rejects.toMatchObject({ code: 'invalid_response' }); }
  for (const extra of [{ contractId: 'ctr-11111111' }, { unitId: 'u1' }, { integration: true }]) {
    await expect(client(snapshot()).status({ ...selection, ...extra })).rejects.toMatchObject({ code: 'invalid_request' });
  }
});

function gatewayFixture(integration = snapshot().integration!, acquireEffect: () => void = () => {}) {
  const auth = authorityFixture(); const catalog = new GatewayMethodCatalog(); let acquisitions = 0; let reads = 0; let effects = 0;
  const forbidden = async () => { effects++; throw new Error('Status invoked an effect'); };
  // This transport-only fixture supplies the fields project() reads; actual
  // durable record construction is covered by the source-bound host tests.
  const execution = { projectId: 'project', target, state: 'launch-claimed', receipt: snapshot().receipt } as unknown as NativeWorkExecutionRecord;
  const status: NativeWorkExecutionStatus = { kind: 'execution', execution,
    contract: makeContract({ id: 'ctr-11111111', isolation: 'worktree' }), currentTarget: target, currentAttempt: true, recovery: 'available', integration };
  registerNativeWorkExecutionGatewayMethods(catalog, { projectId: 'project', acquire: async () => { acquisitions++; acquireEffect();
    return { start: forbidden, resume: forbidden, cancel: forbidden, cancelTarget: forbidden, settle: forbidden, statusByAttempt() { reads++; return status; } }; } });
  const invocation: GatewayMethodInvocation = { context: { admin: true, principalKind: 'token', principalId: 'principal', scopes: ['read:work-ledger', 'write:fleet'] },
    nativeExecutionAuthority: auth.authority, isAuthorized: () => auth.current !== null, body: identity };
  return { auth, catalog, invocation, status, get acquisitions() { return acquisitions; }, get reads() { return reads; }, get effects() { return effects; } };
}

test('existing status returns bounded limit availability instead of truncating integration or broadening transport', async () => {
  const value = snapshot().integration!; if (value.state !== 'live' || value.units[0]!.item.state !== 'recorded') throw new Error('Expected recorded');
  value.units[0]!.item.conflictFiles = ['x'.repeat(8000), 'y'.repeat(8000), 'z'.repeat(8000)];
  const f = gatewayFixture(value); const result = await f.catalog.invoke('workLedger.execution.status', f.invocation);
  expect(result).toMatchObject({ kind: 'execution', receipt: snapshot().receipt, integration: { state: 'unavailable', reason: 'limit' } });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES);
  expect(f.reads).toBe(1); expect(f.effects).toBe(0); expect(value.units[0]!.item.conflictFiles[0]).toHaveLength(8000);
});

test('integration limits count UTF-8 bytes and the entire status envelope, not JavaScript string length', async () => {
  const value = snapshot();
  if (value.integration?.state !== 'live' || value.integration.units[0]!.item.state !== 'recorded') throw new Error('Expected recorded');
  value.integration.units[0]!.item.conflictFiles = ['☃'.repeat(5600)];
  expect(JSON.stringify(value).length).toBeLessThan(NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES);
  expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES);
  await expect(client(value).status(selection)).rejects.toMatchObject({ code: 'invalid_response' });
  const unicode = gatewayFixture(value.integration);
  expect(await unicode.catalog.invoke('workLedger.execution.status', unicode.invocation)).toMatchObject({ integration: { state: 'unavailable', reason: 'limit' } });
  expect(value.integration.units[0]!.item.conflictFiles).toEqual(['☃'.repeat(5600)]);

  const integration = snapshot().integration!;
  if (integration.state !== 'live' || integration.units[0]!.item.state !== 'recorded') throw new Error('Expected recorded');
  integration.units[0]!.item.conflictFiles = ['', ''];
  const remaining = NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES - 100 - new TextEncoder().encode(JSON.stringify(integration)).byteLength;
  integration.units[0]!.item.conflictFiles = ['x'.repeat(Math.floor(remaining / 2)), 'y'.repeat(remaining - Math.floor(remaining / 2))];
  expect(new TextEncoder().encode(JSON.stringify(integration)).byteLength).toBe(NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES - 100);
  const envelope = gatewayFixture(integration);
  const result = await envelope.catalog.invoke('workLedger.execution.status', envelope.invocation);
  expect(result).toMatchObject({ receipt: snapshot().receipt, integration: { state: 'unavailable', reason: 'limit' } });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES);
});

test('an oversized inherited status envelope still fails unavailable after integration is removed', async () => {
  const f = gatewayFixture();
  Object.assign(f.status, { contract: makeContract({ nativeProgress: { schemaVersion: 1, state: 'deciding', targetId: 'u1', stage: '☃'.repeat(6000) } }) });
  await expect(f.catalog.invoke('workLedger.execution.status', f.invocation)).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_UNAVAILABLE', status: 503 });
  expect(NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES).toBe(16384); expect(f.effects).toBe(0);
});

test('integration status preserves pre/post-acquisition pairing scopes, project and strict identity gates', async () => {
  for (const override of [ { context: { admin: true, principalKind: 'user' as const, principalId: 'principal', scopes: ['*'] } },
    { context: { admin: true, principalKind: 'token' as const, principalId: 'principal', scopes: ['read:work-ledger'] } },
    { body: { ...identity, projectId: 'other-project' } }, { body: { ...identity, contractId: 'forged' } } ]) {
    const f = gatewayFixture(); await expect(f.catalog.invoke('workLedger.execution.status', { ...f.invocation, ...override })).rejects.toThrow();
    expect(f.acquisitions).toBe(0); expect(f.reads).toBe(0); expect(f.effects).toBe(0);
  }
  let f!: ReturnType<typeof gatewayFixture>; f = gatewayFixture(snapshot().integration!, () => { f.auth.current = null; });
  await expect(f.catalog.invoke('workLedger.execution.status', f.invocation)).rejects.toThrow();
  expect(f.acquisitions).toBe(1); expect(f.reads).toBe(0); expect(f.effects).toBe(0);
});

function hostFixture() {
  const root = realpathSync(process.cwd()); const auth = authorityFixture(); const contract = makeContract({ id: 'ctr-11111111', isolation: 'worktree' });
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let generation = 'generation'; let reads = 0; let effects = 0;
  const record = { version: 1, projectId: 'project', target, authorityScopes: auth.current!.scopes, state: 'launch-claimed', receipt: { contractId: contract.id, ownerAgentId: contract.ownerAgentId },
    request: { key, input: { projectRoot: root }, binding: { authorityId: hash({ pairedPrincipal: 'principal' }), authorityRevision: hash({ pairedIncarnation: 'incarnation' }), scopeId: hash({ workspaceScope: 'scope' }), scopeRevision: hash({ workspaceGeneration: 'generation' }) } } } as NativeWorkExecutionRecord;
  const ledger = createEmptyWorkLedgerState('project');
  ledger.works.push({ id: 'work', title: '', goal: '', criteria: [], source: null, revision: 1, criteriaRevision: 1, reportedState: 'in_progress', currentAttemptId: 'attempt', createdAt: 1, updatedAt: 1 });
  ledger.attempts.push({ id: 'attempt', workId: 'work', predecessorId: null, ownerId: 'principal', revision: 1, state: 'active', report: null, blocker: null, createdAt: 1, updatedAt: 1 });
  let current: NativeWorkExecutionTransaction = { ledger, record, intent: null };
  const forbidden = () => { effects++; throw new Error('Read-only host inspection invoked an effect'); };
  const storage: NativeWorkExecutionStorage = { current: () => current, currentByAttempt: () => current, transaction: forbidden, transactionByAttempt: forbidden, close: async () => {} };
  const host = createNativeWorkExecutionHost({ projectId: 'project', projectRoot: root, sessionId: 'session', storage, scopes: {
    currentScope: () => ({ root, scopeId: 'scope', scopeRevision: generation }), withCurrentScope: forbidden }, port: {} as JudgmentPort, decisionLog: { get: forbidden } });
  const runner: Pick<ContractRunner, 'get' | 'list' | 'startDurable' | 'resumeDurable' | 'cancel' | 'join' | 'inspectIntegration'> = {
    get: () => contract, list: () => [], startDurable: forbidden, resumeDurable: forbidden, cancel: forbidden, join: forbidden,
    inspectIntegration() { reads++; return snapshot().integration!; },
  };
  host.attachRunner(runner);
  return { host, auth, contract, ledger, runner, get current() { return current; }, set current(value) { current = value; }, set generation(value: string) { generation = value; }, get reads() { return reads; }, get effects() { return effects; } };
}

test('native host status after restart is unavailable without implicit recovery, and stale/no-receipt states expose no unit IDs', async () => {
  const f = hostFixture();
  expect(f.host.status(key, f.auth.authority)).toMatchObject({ recovery: 'required', integration: { state: 'unavailable', reason: 'recovery-required' } });
  f.ledger.works[0]!.currentAttemptId = 'new-attempt';
  expect(f.host.statusByAttempt('work', 'attempt', f.auth.authority)).toMatchObject({ currentAttempt: false, integration: { state: 'unavailable', reason: 'stale-attempt' } });
  f.current = { ...f.current, record: { ...f.current.record!, receipt: null, state: 'prepared' } };
  expect(f.host.status(key, f.auth.authority).integration).toEqual({ state: 'unavailable', reason: 'no-receipt' });
  expect(f.reads).toBe(0); expect(f.effects).toBe(0); await f.host.close();
  expect(() => f.host.status(key, f.auth.authority)).toThrow('closed');
});

test('native host denies revoked pairing, changed incarnation/scope/project and post-read revocation before disclosure', async () => {
  for (const change of [
    (f: ReturnType<typeof hostFixture>) => { f.auth.current = null; },
    (f: ReturnType<typeof hostFixture>) => { f.auth.current = { ...f.auth.current!, tokenId: 'new', authorityRevision: 'new' }; },
    (f: ReturnType<typeof hostFixture>) => { f.auth.current = { ...f.auth.current!, scopes: ['read:work-ledger'] }; },
    (f: ReturnType<typeof hostFixture>) => { f.generation = 'replacement'; },
    (f: ReturnType<typeof hostFixture>) => { f.current = { ...f.current, record: { ...f.current.record!, projectId: 'other' } }; },
    (f: ReturnType<typeof hostFixture>) => { f.runner.get = () => { f.auth.current = null; return f.contract; }; },
  ]) {
    const f = hostFixture(); change(f); expect(() => f.host.status(key, f.auth.authority)).toThrow();
    expect(f.reads).toBe(0); expect(f.effects).toBe(0); await f.host.close();
  }
});
