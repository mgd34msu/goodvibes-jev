/** Owned synthetic SQLite fixtures; these tests never read user settings or pairing tokens. */
import * as nativeFs from 'node:fs';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { SQLiteStore, loadSqlJsEngine, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import type { SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { workLedgerStateSchema, type LedgerWork, type WorkLedgerEvent } from '../sdk/src/platform/workflow/work-ledger/types.js';
import { parseNativeWorkExecutionIntent, parseNativeWorkExecutionRecord, type NativeWorkExecutionIntent } from '../sdk/src/platform/workflow/work-ledger/native-execution-types.js';
import { criteriaSetIdForWork, durableKeyHash, freezeDurableRequest } from '../sdk/src/platform/contract/durable-admission.js';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'native-intent-storage-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function open(file: string, projectId = 'project') {
  const store = new KnowledgeStore({ dbPath: file }); stores.push(store);
  return { store, storage: await store.openNativeWorkExecutionStorage(projectId) };
}
async function fixture() {
  const file = path(); const opened = await open(file);
  const storage = await opened.store.openWorkLedgerStorage('project');
  let id = 0;
  const ledger = createWorkLedger({ projectId: 'project', storage, clock: { now: () => 100, newId: kind => `${kind}-${++id}` } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: 'fixture-owner', role: 'coordinator' });
  const created = await ledger.service.execute({ type: 'create', requestId: 'create', expectedRevision: 0, title: 'Owned fixture', goal: 'Original fixture goal', criteria: ['Exact first', 'Exact second'] }, actor);
  if (created.kind !== 'accepted' || created.event.type === 'import_legacy') throw new Error('fixture create');
  const claimed = await ledger.service.execute({ type: 'claim', requestId: 'claim', expectedRevision: 1, workId: created.event.workId }, actor);
  if (claimed.kind !== 'accepted' || claimed.event.type === 'import_legacy') throw new Error('fixture claim');
  const work = claimed.event.work; const attempt = claimed.event.attempts[0]!;
  const target = { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision };
  const key = { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id };
  const binding = { sourceId: 'fixture-source', inputRevision: 'fixture-input', actionId: 'fixture-action', actionRevision: 'fixture-action-revision', authorityId: 'fixture-authority', authorityRevision: 'fixture-authority-revision', scopeId: 'fixture-scope', scopeRevision: 'fixture-scope-revision' };
  const request = freezeDurableRequest({ key, binding, input: { ask: work.title, sessionId: 'fixture-session', projectRoot: join(file, '..'), origin: 'external', isolation: 'auto', nativeSource: { sourceId: binding.sourceId, sourceRevision: 'fixture-source-revision', inputRevision: binding.inputRevision, criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision, goal: work.goal, criteria: work.criteria } } });
  const intent: NativeWorkExecutionIntent = parseNativeWorkExecutionIntent({ version: 1, projectId: 'project', target, authorityScopes: ['write:fleet', 'read:work-ledger'], request, generation: 1, state: 'admitting' });
  const decisionContext = { decisionId: 'fixture-decision', binding, judgmentDecisionIds: ['fixture-reading'], evidence: [{ id: 'fixture-evidence', revision: 'fixture-evidence-revision' }], continuations: [], resumeConditions: [] };
  const record = parseNativeWorkExecutionRecord({ version: 1, projectId: 'project', target, authorityScopes: intent.authorityScopes, request, decisionContext, decision: { schemaVersion: 1, decisionId: decisionContext.decisionId, binding, judgmentDecisionIds: decisionContext.judgmentDecisionIds, evidence: decisionContext.evidence, summary: 'Owned parser fixture only.', outcome: 'act' }, receipt: null, state: 'prepared' });
  return { ...opened, file, intent, record, key, ledger, actor, work };
}
async function reserve(f: Awaited<ReturnType<typeof fixture>>) {
  await f.storage.transaction(f.key, () => ({ next: null, nextIntent: f.intent, value: undefined }));
}
async function associate(f: Awaited<ReturnType<typeof fixture>>) {
  await reserve(f);
  await f.storage.transaction(f.key, () => ({ next: f.record, nextIntent: { ...f.intent, state: 'associated' }, value: undefined }));
}
async function mutateImage(file: string, mutate: (db: SqlDatabase) => void) {
  const SQL = await loadSqlJsEngine(); const db = new SQL.Database(readFileSync(file));
  try { mutate(db); nativeFs.writeFileSync(file, db.export()); } finally { db.close(); }
}
function downgradeLedgerRows(db: SqlDatabase): void {
  const withoutSource = (work: LedgerWork) => { const { source: _source, ...old } = work; return old; };
  for (const row of db.exec('SELECT project_id, state_json FROM work_ledgers')[0]?.values ?? []) {
    const state = workLedgerStateSchema.parse(JSON.parse(String(row[1])));
    const event = (value: WorkLedgerEvent) => value.type === 'import_legacy' ? { ...value, works: value.works.map(withoutSource) } : { ...value, work: withoutSource(value.work) };
    const legacy = { ...state, version: 1, works: state.works.map(withoutSource), history: state.history.map(event),
      receipts: state.receipts.map(receipt => ({ ...receipt, event: event(receipt.event) })) };
    db.run('UPDATE work_ledgers SET format_version = 1, state_json = ? WHERE project_id = ?', [JSON.stringify(legacy), String(row[0])]);
  }
}
async function raw(file: string, version = 7) {
  const db = new SQLiteStore(file); await db.init(() => {}, { schemaVersion: version }); return db;
}

test('intent parser is exact, detached, and contains no decision or runner receipt facts', async () => {
  const f = await fixture(); const value = { ...f.intent, target: { ...f.intent.target } }; const parsed = parseNativeWorkExecutionIntent(value);
  value.target.workId = 'mutated'; expect(parsed.target.workId).toBe(f.key.workId);
  expect(Object.keys(parsed).sort()).toEqual(['authorityScopes', 'generation', 'projectId', 'request', 'state', 'target', 'version']);
  for (const extra of ['decision', 'receipt', 'contractId', 'ownerAgentId']) expect(() => parseNativeWorkExecutionIntent({ ...f.intent, [extra]: 'forbidden' })).toThrow('invalid');
  for (const generation of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '1']) expect(() => parseNativeWorkExecutionIntent({ ...f.intent, generation })).toThrow('invalid');
  expect(() => parseNativeWorkExecutionIntent({ ...f.intent, target: { ...f.intent.target, criteriaRevision: 90 } })).toThrow('invalid');
  expect(() => parseNativeWorkExecutionIntent({ ...f.intent, authorityScopes: ['read', 'read'] })).toThrow('invalid');
  // A named property must not substitute for a missing array index.
  expect(() => parseNativeWorkExecutionIntent({ ...f.intent, authorityScopes: Object.assign(new Array(1), { extra: 'read:work-ledger' }) })).toThrow('invalid');
  expect(() => parseNativeWorkExecutionIntent({ ...f.intent, authorityScopes: Object.assign(new Array(2), { 1: 'read:work-ledger', extra: 'write:fleet' }) })).toThrow('invalid');
  expect(() => parseNativeWorkExecutionIntent({ ...f.intent, state: { toString: () => 'admitting' } })).toThrow('invalid');
  expect(() => parseNativeWorkExecutionRecord({ ...f.record, generation: 1 })).toThrow('invalid');
  expect(() => parseNativeWorkExecutionIntent({ ...f.intent, [Symbol('receipt')]: 'hidden' })).toThrow('invalid');
  expect(() => parseNativeWorkExecutionIntent(Object.defineProperty({ ...f.intent }, 'receipt', { value: 'hidden' }))).toThrow('invalid');
  let getterCalls = 0;
  expect(() => parseNativeWorkExecutionIntent({ ...f.intent, get state() { getterCalls++; return 'admitting'; } })).toThrow('invalid');
  expect(getterCalls).toBe(0);
});

test('association publishes record and intent atomically before the durable callback', async () => {
  const f = await fixture(); await reserve(f);
  expect(f.storage.current(f.key)).toMatchObject({ intent: f.intent, record: null });
  await expect(f.storage.transaction(f.key, () => ({ next: f.record, value: undefined }))).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.storage.transaction(f.key, () => ({ next: null, nextIntent: { ...f.intent, state: 'associated' }, value: undefined }))).rejects.toMatchObject({ code: 'recovery-required' });
  let boundary = 0;
  await f.storage.transaction(f.key, () => ({ next: f.record, nextIntent: { ...f.intent, state: 'associated' }, value: 7 }), (value, current) => {
    boundary++; expect(value).toBe(7); expect(current()).toMatchObject({ intent: { state: 'associated' }, record: f.record });
  });
  expect(boundary).toBe(1);
  const reopened = await open(f.file); expect(reopened.storage.currentByAttempt(f.key.attemptId)).toMatchObject({ intent: { state: 'associated' }, record: f.record });
});

test('earliest attempt cancellation persists an irreversible tombstone without execution', async () => {
  const f = await fixture();
  await f.storage.transactionByAttempt(f.key.attemptId, () => ({ next: null, nextIntent: { ...f.intent, state: 'cancelled' }, value: undefined }));
  const reopened = await open(f.file);
  expect(reopened.storage.current(f.key)).toMatchObject({ intent: { state: 'cancelled' }, record: null });
  const bytes = readFileSync(f.file);
  for (const state of ['admitting', 'refused', 'associated'] as const) await expect(reopened.storage.transaction(f.key, () => ({ next: state === 'associated' ? f.record : null, nextIntent: { ...f.intent, state }, value: undefined }))).rejects.toThrow();
  await expect(reopened.storage.transactionByAttempt(f.key.attemptId, () => ({ next: null, nextIntent: { ...f.intent, generation: 2, state: 'cancelled' }, value: undefined }))).rejects.toThrow();
  await reopened.storage.transaction(f.key, () => ({ next: null, nextIntent: null, value: undefined }));
  await reopened.storage.transaction(f.key, () => ({ next: null, value: undefined }));
  expect(readFileSync(f.file)).toEqual(bytes); expect(reopened.storage.currentByAttempt(f.key.attemptId).intent?.state).toBe('cancelled');
});

test('associated cancellation is paired and cannot revive either persisted record', async () => {
  const f = await fixture(); await associate(f);
  await expect(f.storage.transaction(f.key, () => ({ next: null, nextIntent: { ...f.intent, state: 'cancelled' }, value: undefined }))).rejects.toThrow();
  await f.storage.transactionByAttempt(f.key.attemptId, current => ({ next: { ...current.record!, state: 'cancelled' }, nextIntent: { ...current.intent!, state: 'cancelled' }, value: undefined }));
  await expect(f.storage.transaction(f.key, () => ({ next: f.record, value: undefined }))).rejects.toThrow();
  expect((await open(f.file)).storage.current(f.key)).toMatchObject({ intent: { state: 'cancelled' }, record: { state: 'cancelled' } });
});

test('only a new evaluation epoch on identical persisted workflow facts may resume a pending intent', async () => {
  const f = await fixture(); await reserve(f);
  await f.storage.transaction(f.key, () => ({ next: null, nextIntent: { ...f.intent, state: 'refused' }, value: undefined }));
  await expect(f.storage.transaction(f.key, () => ({ next: null, nextIntent: f.intent, value: undefined }))).rejects.toThrow();
  await expect(f.storage.transaction(f.key, () => ({ next: null, nextIntent: { ...f.intent, generation: 3 }, value: undefined }))).rejects.toThrow();
  const second = { ...f.intent, generation: 2 };
  await f.storage.transaction(f.key, () => ({ next: null, nextIntent: second, value: undefined }));
  expect(f.storage.current(f.key).intent?.generation).toBe(2);
  for (const changed of [
    { ...second, generation: 3, target: { ...second.target, workRevision: second.target.workRevision + 1 } },
    { ...second, generation: 3, authorityScopes: ['*'] },
    { ...second, generation: 3, request: { ...second.request, binding: { ...second.request.binding, authorityRevision: 'new-authority' } } },
    { ...second, generation: 3, request: { ...second.request, binding: { ...second.request.binding, scopeRevision: 'new-scope' } } },
  ]) await expect(f.storage.transaction(f.key, () => ({ next: null, nextIntent: changed, value: undefined }))).rejects.toThrow();
  await f.ledger.service.execute({ type: 'revise', requestId: 'revise', expectedRevision: 2, workId: f.work.id, title: f.work.title, goal: f.work.goal, criteria: [...f.work.criteria].reverse() }, f.actor);
  await expect(f.storage.transaction(f.key, () => ({ next: null, nextIntent: { ...second, generation: 3 }, value: undefined }))).rejects.toMatchObject({ code: 'stale' });
});

test('same-attempt key collision and cross-project or cross-attempt writes are rejected', async () => {
  const f = await fixture(); await reserve(f);
  const key = { ...f.key, criteriaRevision: '99' };
  const request = freezeDurableRequest({ ...f.intent.request, key, input: { ...f.intent.request.input, nativeSource: { ...f.intent.request.input.nativeSource!, criteriaRevision: key.criteriaRevision } } });
  const collision = { ...f.intent, target: { ...f.intent.target, criteriaRevision: 99 }, request };
  expect(f.storage.current(key).intent).toEqual(f.intent);
  await expect(f.storage.transaction(key, () => ({ next: null, nextIntent: collision, value: undefined }))).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.storage.transaction(f.key, () => ({ next: null, nextIntent: { ...f.intent, projectId: 'other' }, value: undefined }))).rejects.toMatchObject({ code: 'invalid' });
  await expect(f.storage.transactionByAttempt('other-attempt', () => ({ next: null, nextIntent: f.intent, value: undefined }))).rejects.toMatchObject({ code: 'invalid' });
  expect(f.storage.currentByAttempt(f.key.attemptId).intent).toEqual(f.intent);
});

test('mutation callbacks cannot change the comparison baseline or regress an associated intent', async () => {
  const f = await fixture();
  await expect(f.storage.transaction(f.key, () => ({ next: null, nextIntent: { ...f.intent, generation: 2 }, value: undefined }))).rejects.toThrow();
  await reserve(f);
  await expect(f.storage.transaction(f.key, current => {
    const mutable = current.intent as unknown as { authorityScopes: string[] };
    mutable.authorityScopes.push('*');
    return { next: null, nextIntent: current.intent, value: undefined };
  })).rejects.toMatchObject({ code: 'conflict' });
  await f.storage.transaction(f.key, current => ({ next: f.record, nextIntent: { ...current.intent!, state: 'associated' }, value: undefined }));
  const bytes = readFileSync(f.file);
  for (const state of ['admitting', 'refused'] as const) await expect(f.storage.transaction(f.key, current => ({ next: null, nextIntent: { ...current.intent!, state }, value: undefined }))).rejects.toThrow();
  await expect(f.storage.transaction(f.key, current => ({ next: null, nextIntent: { ...current.intent!, generation: 2 }, value: undefined }))).rejects.toThrow();
  expect(readFileSync(f.file)).toEqual(bytes);
});

test('independent owners serialize cancellation against association without reviving a tombstone', async () => {
  const f = await fixture(); await reserve(f); const other = await open(f.file);
  const cancelled = f.storage.transactionByAttempt(f.key.attemptId, current => ({ next: current.record ? { ...current.record, state: 'cancelled' } : null, nextIntent: { ...current.intent!, state: 'cancelled' }, value: undefined }));
  const associated = other.storage.transaction(f.key, () => ({ next: f.record, nextIntent: { ...f.intent, state: 'associated' }, value: undefined }));
  const results = await Promise.allSettled([cancelled, associated]);
  expect(results[0]?.status).toBe('fulfilled');
  const current = other.storage.currentByAttempt(f.key.attemptId);
  expect(current.intent?.state).toBe('cancelled');
  expect(current.record === null || current.record.state === 'cancelled').toBe(true);
  await expect(other.storage.transaction(f.key, () => ({ next: f.record, nextIntent: { ...f.intent, state: 'associated' }, value: undefined }))).rejects.toThrow();
});

test('schema3 migration preserves exact nine-field execution JSON and leaves intents empty', async () => {
  const f = await fixture(); const stateJson = JSON.stringify(f.record, null, 2); await f.store.close();
  await mutateImage(f.file, db => {
    db.run('DROP TABLE native_work_execution_intents');
    db.run('INSERT INTO native_work_executions VALUES (?,?,?,?,?)', ['project', durableKeyHash(f.key), 1, stateJson, f.key.attemptId]);
    downgradeLedgerRows(db);
    db.run('PRAGMA user_version = 3');
  });
  const migrated = await open(f.file); expect(migrated.storage.current(f.key)).toMatchObject({ record: f.record, intent: null });
  const db = await raw(f.file);
  expect(db.exec('SELECT state_json FROM native_work_executions')[0]?.values).toEqual([[stateJson]]);
  expect(db.exec('SELECT COUNT(*) FROM native_work_execution_intents')[0]?.values).toEqual([[0]]);
  expect(db.exec('PRAGMA user_version')[0]?.values).toEqual([[7]]); db.close();
  await migrated.storage.transaction(f.key, current => ({ next: { ...current.record!, state: 'cancelled' }, value: undefined }));
  expect(migrated.storage.currentByAttempt(f.key.attemptId)).toMatchObject({ record: { state: 'cancelled' }, intent: null });
});

test('schema4 migration preserves exact execution and intent rows while removing no historical records', async () => {
  const f = await fixture(); await associate(f); await f.store.close();
  const executionJson = JSON.stringify(f.record, null, 2); const intentJson = JSON.stringify({ ...f.intent, state: 'associated' }, null, 2);
  await mutateImage(f.file, db => {
    downgradeLedgerRows(db); db.run('UPDATE native_work_executions SET state_json = ?', [executionJson]);
    db.run('UPDATE native_work_execution_intents SET state_json = ?', [intentJson]); db.run('PRAGMA user_version = 4');
  });
  const migrated = await open(f.file); const current = migrated.storage.current(f.key);
  expect(current).toMatchObject({ record: f.record, intent: { ...f.intent, state: 'associated' }, ledger: { version: 2, revision: 2 } });
  expect(current.ledger.works[0]?.source).toBeNull();
  const db = await raw(f.file);
  expect(db.exec('SELECT state_json FROM native_work_executions')[0]?.values).toEqual([[executionJson]]);
  expect(db.exec('SELECT state_json FROM native_work_execution_intents')[0]?.values).toEqual([[intentJson]]); db.close();
});

test('schema2 migration chains through execution and intent creation without inventing rows', async () => {
  const f = await fixture(); await f.store.close();
  await mutateImage(f.file, db => { db.run('DROP TABLE native_work_executions'); db.run('DROP TABLE native_work_execution_intents'); downgradeLedgerRows(db); db.run('PRAGMA user_version = 2'); });
  const migrated = await open(f.file); expect(migrated.storage.current(f.key)).toMatchObject({ intent: null, record: null, ledger: { revision: 2 } });
  const db = await raw(f.file); expect(db.exec('PRAGMA user_version')[0]?.values).toEqual([[7]]); db.close();
});

for (const table of ['work_ledgers', 'native_work_executions']) test(`schema3 migration validates ${table} before creating any intent table`, async () => {
  const f = await fixture(); await f.store.close();
  await mutateImage(f.file, db => { db.run('DROP TABLE native_work_execution_intents'); db.run(`DROP TABLE ${table}`); db.run('PRAGMA user_version = 3'); });
  const bytes = readFileSync(f.file);
  await expect(open(f.file)).rejects.toThrow(); expect(readFileSync(f.file)).toEqual(bytes);
});

for (const corruption of ['missing', 'shape', 'key']) test(`current-schema ${corruption} intent table is refused on open and persisted reads without reset`, async () => {
  const f = await fixture(); await reserve(f);
  await mutateImage(f.file, db => {
    db.run('DROP TABLE native_work_execution_intents');
    if (corruption === 'shape') db.run('CREATE TABLE native_work_execution_intents (project_id TEXT NOT NULL, attempt_id TEXT NOT NULL, format_version TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id,attempt_id))');
    if (corruption === 'key') db.run('CREATE TABLE native_work_execution_intents (project_id TEXT NOT NULL, attempt_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL)');
  });
  const bytes = readFileSync(f.file);
  expect(() => f.storage.current(f.key)).toThrow(); expect(() => f.storage.currentByAttempt(f.key.attemptId)).toThrow();
  await expect(f.storage.transaction(f.key, () => ({ next: null, value: undefined }))).rejects.toThrow();
  await expect(open(f.file)).rejects.toThrow();
  await expect(f.store.upsertSource({ id: 'must-not-reset', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' })).rejects.toThrow();
  expect(readFileSync(f.file)).toEqual(bytes);
});

test('corrupt intent payload and association mismatch fail closed; a missing execution stays missing', async () => {
  const f = await fixture(); await associate(f);
  await mutateImage(f.file, db => db.run('DELETE FROM native_work_executions'));
  const missing = f.storage.currentByAttempt(f.key.attemptId); expect(missing.intent?.state).toBe('associated'); expect(missing.record).toBeNull();
  const bytes = readFileSync(f.file);
  await expect(f.storage.transaction(f.key, () => ({ next: f.record, nextIntent: { ...f.intent, state: 'associated' }, value: undefined }))).rejects.toMatchObject({ code: 'recovery-required' });
  expect(readFileSync(f.file)).toEqual(bytes);
  await mutateImage(f.file, db => db.run("UPDATE native_work_execution_intents SET state_json = '{}'"));
  expect(() => f.storage.current(f.key)).toThrow('invalid');
  await expect(open(f.file)).rejects.toThrow('invalid');
});

test('old binary refuses schema5 and an already-open schema3 writer cannot erase intent rows', async () => {
  const f = await fixture(); await f.store.close();
  await mutateImage(f.file, db => { db.run('DROP TABLE native_work_execution_intents'); downgradeLedgerRows(db); db.run('PRAGMA user_version = 3'); });
  const old = new SQLiteStore(f.file, { coordinated: true }); await old.init(() => {}, { schemaVersion: 3 });
  const migrated = await open(f.file);
  await migrated.storage.transaction(f.key, () => ({ next: null, nextIntent: f.intent, value: undefined }));
  const bytes = readFileSync(f.file);
  old.run("UPDATE work_ledgers SET revision = 999"); await expect(old.save()).rejects.toThrow('persisted state changed');
  expect(() => old.readPersisted(() => true)).toThrow('persisted schema changed'); old.close();
  const older = new SQLiteStore(f.file); await expect(older.init(createSchema, { schemaVersion: 3 })).rejects.toThrow('newer version'); older.close();
  expect(readFileSync(f.file)).toEqual(bytes); expect(migrated.storage.current(f.key).intent).toEqual(f.intent);
});

for (const phase of ['before', 'after'] as const) test(`${phase}-publication failure cannot expose a half-associated intent or invoke the durable boundary`, async () => {
  const f = await fixture(); await reserve(f); const original = readFileSync(f.file);
  const persistence = (f.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
  let fail = true;
  persistence.io = { ...nativeFs,
    renameSync(from, to) { if (phase === 'before' && fail) { fail = false; throw new Error('owned before-publication fault'); } nativeFs.renameSync(from, to); },
    fsyncSync(fd) { if (phase === 'after' && fail && nativeFs.fstatSync(fd).isDirectory()) { fail = false; throw new Error('owned after-publication fault'); } nativeFs.fsyncSync(fd); },
  };
  let boundary = 0;
  const mutation = () => ({ next: f.record, nextIntent: { ...f.intent, state: 'associated' as const }, value: undefined });
  await expect(f.storage.transaction(f.key, mutation, () => { boundary++; })).rejects.toThrow(); expect(boundary).toBe(0);
  const visible = f.storage.current(f.key);
  if (phase === 'before') { expect(readFileSync(f.file)).toEqual(original); expect(visible).toMatchObject({ intent: { state: 'admitting' }, record: null }); }
  else expect(visible).toMatchObject({ intent: { state: 'associated' }, record: f.record });
  await f.storage.transaction(f.key, current => current.record ? { next: null, value: undefined } : mutation(), (_value, current) => { boundary++; expect(current()).toMatchObject({ intent: { state: 'associated' }, record: f.record }); });
  expect(boundary).toBe(1); expect((await open(f.file)).storage.current(f.key)).toMatchObject({ intent: { state: 'associated' }, record: f.record });
});
