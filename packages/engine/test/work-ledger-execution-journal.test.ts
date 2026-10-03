import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { createWorkExecutionJournal } from '../sdk/src/platform/workflow/work-ledger/execution-journal.js';
import type { WorkExecution } from '../sdk/src/platform/workflow/work-ledger/execution-types.js';
import type { WorkLedgerStorage } from '../sdk/src/platform/workflow/work-ledger/types.js';
import type { JevDecisionContext, JevDecision } from '@goodvibes-jev/judgment/decisions';

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'native-journal-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function open(file = path()) {
  const store = new KnowledgeStore({ dbPath: file });
  const storage = await store.openWorkLedgerStorage('project');
  let loseResponse = false;
  const forwarding: WorkLedgerStorage = { read: () => storage.read(), subscribe: callback => storage.subscribe(callback), transaction: async decide => {
    const value = await storage.transaction(decide);
    if (loseResponse) { loseResponse = false; throw new Error('lost acknowledgement'); }
    return value;
  } };
  let id = 0;
  const core = createWorkLedger({ projectId: 'project', storage: forwarding, clock: { now: () => 100, newId: kind => `${kind}-${++id}` } });
  const actor = core.authority.issueActor({ actorId: 'owner', projectId: 'project', role: 'coordinator' });
  const journal = createWorkExecutionJournal({ projectId: 'project', storage: forwarding, authority: core.authority });
  const close = async () => { await journal.close(); await core.service.close(); await storage.close(); await store.close(); };
  cleanups.push(close);
  return { ...core, actor, journal, storage, close, loseNextResponse: () => { loseResponse = true; } };
}
async function fixture(file?: string) {
  const f = await open(file);
  expect((await f.service.execute({ type: 'create', requestId: 'create', expectedRevision: 0, title: 'Work', goal: 'Original goal', criteria: ['Original criterion'] }, f.actor)).kind).toBe('accepted');
  expect((await f.service.execute({ type: 'claim', requestId: 'claim', expectedRevision: 1, workId: 'work-1' }, f.actor)).kind).toBe('accepted');
  const input = { id: 'execution', target: { workId: 'work-1', workRevision: 2, criteriaRevision: 1, attemptId: 'attempt-2', attemptRevision: 1 }, sessionId: 'session', projectRoot: '/synthetic-project' };
  const execution = await f.journal.prepare(input, f.actor);
  return { ...f, input, execution };
}
function context(entry: Readonly<WorkExecution>, authorityRevision = '1'): JevDecisionContext {
  return { decisionId: 'decision', binding: { sourceId: entry.target.workId, inputRevision: entry.inputDigest, actionId: entry.id, actionRevision: entry.inputDigest, authorityId: entry.actorId, authorityRevision, scopeId: entry.projectId, scopeRevision: '1' }, judgmentDecisionIds: ['reading'], evidence: [{ id: 'captured', revision: '1' }], continuations: [{ id: 'retry', revision: '1', kind: 'reconsider' }], resumeConditions: [{ id: 'ready', revision: '1' }] };
}
function decision(entry: WorkExecution, outcome: JevDecision['outcome'] = 'act'): JevDecision {
  const { decisionId, binding, judgmentDecisionIds, evidence } = context(entry);
  return { schemaVersion: 1, decisionId, binding, judgmentDecisionIds, evidence, summary: outcome, outcome,
    ...(outcome === 'revise' ? { next: { id: 'retry', revision: '1', kind: 'reconsider' } } : {}),
    ...(outcome === 'defer' ? { until: { id: 'ready', revision: '1' } } : {}),
  } as JevDecision;
}
const publication = { expectedRevision: 2, report: 'Completed original work', attestation: { outcome: 'verified', reason: 'Recorded host check', source: 'host_check', references: [{ kind: 'test', ref: 'test:recorded', digest: 'abc' }], criteriaResults: [{ criterionIndex: 0, status: 'satisfied', references: ['test:recorded'] }] } };
async function admitted() {
  const f = await fixture();
  await f.journal.admitDecision(f.execution.id, decision(f.execution), context, f.actor);
  // Synthetic receipt only: the real durable runner adapter remains unwired.
  await f.journal.recordRunnerReceipt(f.execution.id, { contractId: 'ctr-12345678', key: 'synthetic' }, f.actor);
  return f;
}

test('SQLite outbox survives response loss and reopen without changing its frozen identity', async () => {
  const file = path(); const f = await fixture(file);
  f.loseNextResponse();
  await expect(f.journal.prepare(f.input, f.actor)).rejects.toThrow('lost acknowledgement');
  await f.close();
  const reopened = await open(file);
  expect(await reopened.journal.prepare(f.input, reopened.actor)).toEqual(f.execution);
  expect(await reopened.journal.list(reopened.actor)).toHaveLength(1);
  await expect(reopened.journal.prepare({ ...f.input, sessionId: 'changed' }, reopened.actor)).rejects.toThrow('identity conflict');
});

test.each(['revise', 'defer', 'reject'] as const)('shared %s decision records typed outcome without launch', async outcome => {
  const f = await fixture();
  const entry = await f.journal.admitDecision(f.execution.id, decision(f.execution, outcome), context, f.actor);
  expect(entry.status).toBe(({ revise: 'revising', defer: 'deferred', reject: 'rejected' } as const)[outcome]);
  let launches = 0;
  await expect(f.journal.dispatch(entry.id, f.actor, () => { launches++; }, context)).rejects.toThrow();
  expect(launches).toBe(0);
  expect((await f.service.readSnapshot(f.actor)).works[0]?.verification.state).toBe('unverified');
});

test('atomic report and evidence publication replays after lost response', async () => {
  const f = await admitted();
  await f.journal.stagePublication(f.execution.id, publication, f.actor);
  f.loseNextResponse();
  expect(await f.authority.publishExecution(f.execution.id, f.actor, { current: context })).toMatchObject({ kind: 'indeterminate' });
  const abort = AbortSignal.abort();
  expect(await f.authority.publishExecution(f.execution.id, f.actor, { current: context, signal: abort })).toMatchObject({ kind: 'accepted', replayed: true });
  const view = (await f.service.readSnapshot(f.actor)).works[0]!;
  expect(view.verification.state).toBe('verified');
  expect(view.execution?.status).toBe('settled');
  expect(await f.service.history(0, f.actor)).toHaveLength(4);
});

test.each(['revise', 'cancel', 'revoke'] as const)('%s invalidates publication and launch', async action => {
  const f = await admitted();
  await f.journal.stagePublication(f.execution.id, publication, f.actor);
  if (action === 'revoke') f.authority.revokeActor(f.actor);
  else await f.service.execute(action === 'cancel'
    ? { type: 'cancel', requestId: 'change', expectedRevision: 2, workId: 'work-1', reason: 'cancel' }
    : { type: 'revise', requestId: 'change', expectedRevision: 2, workId: 'work-1', title: 'Changed', goal: 'Changed', criteria: ['Changed'] }, f.actor);
  let launches = 0;
  await expect(f.journal.dispatch(f.execution.id, f.actor, () => { launches++; }, context)).rejects.toThrow();
  expect(launches).toBe(0);
  expect((await f.authority.publishExecution(f.execution.id, f.actor, { current: context })).kind).toBe('rejected');
});

test('live authority generation and reentrant final cancellation fence publication', async () => {
  const f = await admitted();
  await f.journal.stagePublication(f.execution.id, publication, f.actor);
  await expect(f.journal.dispatch(f.execution.id, f.actor, () => {}, entry => context(entry, '2'))).rejects.toThrow();
  expect(await f.authority.publishExecution(f.execution.id, f.actor, { current: entry => context(entry, '2') })).toMatchObject({ kind: 'rejected', code: 'host_error' });
  const abort = new AbortController(); let reads = 0;
  expect(await f.authority.publishExecution(f.execution.id, f.actor, { signal: abort.signal, current: entry => {
    if (++reads === 2) abort.abort(); return context(entry);
  } })).toMatchObject({ kind: 'rejected', code: 'cancelled' });
  expect(await f.service.history(0, f.actor)).toHaveLength(2);
});

test('journal validates core receipt history and rejects unrecorded decision lineage', async () => {
  const f = await fixture();
  await expect(f.journal.admitDecision(f.execution.id, { ...decision(f.execution), judgmentDecisionIds: ['invented'] }, context, f.actor)).rejects.toThrow();
  await f.storage.transaction(raw => { const state = raw as Awaited<ReturnType<typeof f.storage.read>> & { receipts: { signature: string }[] }; state.receipts[0]!.signature = '{}'; return { next: state as never, value: undefined }; });
  await expect(f.journal.list(f.actor)).rejects.toThrow();
});

test('revocation listeners and close fence admissions', async () => {
  const f = await fixture(); let revoked = 0;
  f.authority.onActorRevoked(f.actor, () => { revoked++; });
  f.authority.revokeActor(f.actor); f.authority.revokeActor(f.actor);
  expect(revoked).toBe(1);
  await f.journal.close();
  await expect(f.journal.list(f.actor)).rejects.toThrow('closed');
});

test('reentrant scope change is checked before synchronous launch', async () => {
  const f = await admitted(); let calls = 0;
  await expect(f.journal.dispatch(f.execution.id, f.actor, () => { calls++; }, entry => {
    f.authority.revokeActor(f.actor); return context(entry);
  })).rejects.toThrow();
  expect(calls).toBe(0);
});

test('journal-only progress wakes readers without fabricating ledger history', async () => {
  const f = await fixture(); const revisions: number[] = [];
  const stop = f.service.subscribe(f.actor, snapshot => { revisions.push(snapshot.executionRevision ?? 0); });
  await f.service.readSnapshot(f.actor);
  await f.journal.admitDecision(f.execution.id, decision(f.execution, 'defer'), context, f.actor);
  await new Promise(resolve => setTimeout(resolve, 150));
  stop();
  expect(revisions.at(-1)).toBeGreaterThan(1);
  expect(await f.service.history(0, f.actor)).toHaveLength(2);
});

test('reentrant revocation listener observes the same owned close promise', async () => {
  const f = await fixture(); let nested: Promise<void> | undefined;
  f.authority.onActorRevoked(f.actor, () => { nested = f.service.close(); });
  const closing = f.service.close();
  expect(nested).toBe(closing);
  await closing;
});
