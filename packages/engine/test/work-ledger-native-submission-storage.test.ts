/** Owned synthetic fixtures; no external source, credentials, runner, or provider. */
import * as nativeFs from 'node:fs';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { SQLiteStore, loadSqlJsEngine, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import type { SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
import { createWorkLedger, migrateLegacyWorkLedgerState, readWorkLedgerState } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { criteriaSetIdForWork, freezeDurableRequest } from '../sdk/src/platform/contract/durable-admission.js';
import { parseNativeWorkExecutionIntent } from '../sdk/src/platform/workflow/work-ledger/native-execution-types.js';
import { NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES, nativeWorkSubmissionRequestSchema } from '../sdk/src/platform/workflow/work-ledger/native-submission-wire.js';
import type { LedgerWork, WorkLedgerEvent, WorkLedgerState } from '../sdk/src/platform/workflow/work-ledger/types.js';

const roots: string[] = []; const stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'native-submission-storage-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function open(file = path(), actorId = 'owner') {
  const store = new KnowledgeStore({ dbPath: file }); stores.push(store); const storage = await store.openWorkLedgerStorage('project');
  if (!store.getSource('fixture')) await store.upsertSource({ id: 'fixture', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
  let id = 0; const ledger = createWorkLedger({ projectId: 'project', storage, clock: { now: () => 100, newId: kind => `${actorId}-${kind}-${++id}` } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId, role: 'coordinator' });
  return { ...ledger, actor, store, storage, file };
}
const command = { type: 'submit_native', requestId: 'request', expectedRevision: 0, title: '  Display title  ',
  goal: '  Exact\n goal\t', criteria: ['  first  ', '\tsecond\n', '  first  '],
  source: { version: 1, sourceId: 'source', sourceRevision: 'exact-source-digest', inputId: 'input', sessionId: 'session' } };
function event(result: Awaited<ReturnType<ReturnType<typeof createWorkLedger>['service']['execute']>>) {
  expect(result.kind).toBe('accepted'); if (result.kind !== 'accepted' || result.event.type === 'import_legacy') throw new Error('Fixture submission rejected'); return result.event;
}
function legacyState(state: WorkLedgerState) {
  const oldWork = (work: LedgerWork) => { const { source: _source, ...old } = work; return old; };
  const oldEvent = (item: WorkLedgerEvent) => item.type === 'import_legacy' ? { ...item, works: item.works.map(oldWork) } : { ...item, work: oldWork(item.work) };
  return { ...state, version: 1, works: state.works.map(oldWork), history: state.history.map(oldEvent), receipts: state.receipts.map(item => ({ ...item, event: oldEvent(item.event) })) };
}
async function mutate(file: string, update: (db: SqlDatabase) => void) {
  const SQL = await loadSqlJsEngine(); const db = new SQL.Database(readFileSync(file));
  try { update(db); writeFileSync(file, db.export()); } finally { db.close(); }
}

test('one durable command creates exact source, claimed attempt and actor receipt; restart lookup and stale exact replay', async () => {
  const f = await open(); const submitted = event(await f.service.execute(command, f.actor));
  expect(submitted.type).toBe('submit_native');
  expect(submitted.work).toMatchObject({ title: 'Display title', goal: command.goal, criteria: command.criteria, source: command.source, revision: 1, criteriaRevision: 1, reportedState: 'in_progress' });
  expect(submitted.attempts).toHaveLength(1); expect(submitted.attempts[0]).toMatchObject({ id: submitted.attemptId, ownerId: 'owner', state: 'active', revision: 1, predecessorId: null });
  expect(await f.storage.read()).toMatchObject({ version: 2, revision: 1, works: [submitted.work], attempts: submitted.attempts, history: [submitted], receipts: [{ actorId: 'owner', requestId: 'request', event: submitted }] });
  event(await f.service.execute({ type: 'report', expectedRevision: 1, requestId: 'report', workId: submitted.workId, attemptId: submitted.attemptId, state: 'in_progress', report: '  Display report  ' }, f.actor));
  const reopened = await open(f.file); const before = readFileSync(f.file);
  const recovered = await reopened.service.lookupSubmission('request', reopened.actor);
  if (recovered === null) throw new Error('Expected the original durable submission receipt');
  expect(submitted).toEqual(recovered);
  expect(await reopened.service.execute(command, reopened.actor)).toEqual({ kind: 'accepted', replayed: true, event: submitted });
  expect(readFileSync(f.file)).toEqual(before);
  expect((await reopened.service.readSnapshot(reopened.actor)).works[0]?.attempt?.report).toBe('Display report');
  const SQL = await loadSqlJsEngine(); const db = new SQL.Database(before);
  expect(db.exec('PRAGMA user_version')[0]?.values).toEqual([[9]]); expect(db.exec('SELECT format_version FROM work_ledgers')[0]?.values).toEqual([[2]]);
  expect(db.exec('SELECT COUNT(*) FROM native_work_executions')[0]?.values).toEqual([[0]]); expect(db.exec('SELECT COUNT(*) FROM native_work_execution_intents')[0]?.values).toEqual([[0]]); db.close();
});

test('the full wire byte budget survives escaped host display text and metadata without truncation', async () => {
  const f = await open();
  const goal = '\u0000'.repeat(19_999) + 'g';
  const input = { requestId: command.requestId, inputId: command.source.inputId, expectedRevision: 0, goal,
    criteria: ['\u0001'.repeat(19_999) + 'c', 'x'.repeat(20_000), 'z'] };
  const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  input.criteria[2] += 'x'.repeat(NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES - byteLength(input));
  expect(byteLength(input)).toBe(NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES);
  expect(nativeWorkSubmissionRequestSchema.safeParse(input).success).toBe(true);
  const enriched = { ...command, title: input.goal, goal: input.goal, criteria: input.criteria };
  expect(byteLength(enriched)).toBeGreaterThan(NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES);
  const submitted = event(await f.service.execute(enriched, f.actor));
  expect(submitted.work).toMatchObject({ title: input.goal, goal: input.goal, criteria: input.criteria, source: command.source });
  const reopened = await open(f.file); const bytes = readFileSync(f.file);
  const recovered = await reopened.service.lookupSubmission(input.requestId, reopened.actor);
  if (recovered === null) throw new Error('Expected the original durable submission receipt');
  expect(submitted).toEqual(recovered);
  expect(await reopened.service.execute(enriched, reopened.actor)).toMatchObject({ kind: 'accepted', replayed: true, event: submitted });
  const oversized = { ...input, criteria: [...input.criteria.slice(0, 2), input.criteria[2] + 'x'] };
  expect(byteLength(oversized)).toBe(NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES + 1);
  expect(nativeWorkSubmissionRequestSchema.safeParse(oversized).success).toBe(false);
  expect(await reopened.service.execute({ ...enriched, criteria: oversized.criteria }, reopened.actor)).toMatchObject({ kind: 'rejected', code: 'invalid_command' });
  expect(readFileSync(f.file)).toEqual(bytes);
});

test('actor/request and actor/input fences survive concurrency and cannot expose another actor receipt', async () => {
  const f = await open(); const second = await open(f.file);
  const results = await Promise.all([f.service.execute(command, f.actor), second.service.execute({ ...command, requestId: 'other-request' }, second.actor)]);
  expect(results.filter(result => result.kind === 'accepted')).toHaveLength(1);
  expect(results.find(result => result.kind !== 'accepted')).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
  expect((await f.service.readSnapshot(f.actor)).works).toHaveLength(1);
  const winnerId = results[0]?.kind === 'accepted' ? command.requestId : 'other-request';
  const different = await open(f.file, 'other-owner'); expect(await different.service.lookupSubmission(winnerId, different.actor)).toBeNull();
  expect(await f.service.lookupSubmission('unknown', f.actor)).toBeNull();
  expect(await f.service.execute({ ...command, requestId: winnerId, goal: `${command.goal} ` }, f.actor)).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
  expect(await f.service.execute({ ...command, requestId: 'third-request', expectedRevision: 1 }, f.actor)).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
  event(await different.service.execute({ ...command, requestId: winnerId, expectedRevision: 1 }, different.actor));
  expect((await f.service.readSnapshot(f.actor)).works).toHaveLength(2);
  f.authority.revokeActor(f.actor); await expect(f.service.lookupSubmission(winnerId, f.actor)).rejects.toMatchObject({ code: 'forbidden' });
  await different.service.close(); await expect(different.service.lookupSubmission(winnerId, different.actor)).rejects.toMatchObject({ code: 'closed' });
});

test('native requirements cannot be revised through legacy API; source-less create/revise remain lossless', async () => {
  const f = await open(); const submitted = event(await f.service.execute(command, f.actor)); const bytes = readFileSync(f.file);
  expect((await f.service.readSnapshot(f.actor)).works[0]?.allowedActions).not.toContain('revise');
  expect(await f.service.execute({ type: 'revise', requestId: 'revise', expectedRevision: 1, workId: submitted.workId, title: 'New title', goal: command.goal, criteria: command.criteria }, f.actor)).toMatchObject({ kind: 'rejected', code: 'invalid_transition' });
  expect(readFileSync(f.file)).toEqual(bytes);
  const created = event(await f.service.execute({ type: 'create', requestId: 'legacy', expectedRevision: 1, title: 'Old API', goal: command.goal, criteria: command.criteria }, f.actor));
  expect(created.work.source).toBeNull();
  const revised = event(await f.service.execute({ type: 'revise', requestId: 'legacy-revise', expectedRevision: 2, workId: created.workId, title: '  New title ', goal: command.goal + ' ', criteria: [...command.criteria, '\nthird\t'] }, f.actor));
  expect(revised.work).toMatchObject({ title: 'New title', goal: command.goal + ' ', criteria: [...command.criteria, '\nthird\t'], source: null });
  expect(await f.service.lookupSubmission('legacy', f.actor)).toBeNull();
});

test('blank, oversized and untrusted native command fields cannot mutate storage', async () => {
  const f = await open(); const bytes = readFileSync(f.file);
  for (const altered of [{ goal: ' \n\t' }, { goal: 'a'.repeat(20_001) }, { criteria: ['\n'] }, { criteria: [] }, { criteria: Array(101).fill('criterion') }, { criteria: Array(100).fill('a'.repeat(20_000)) }, { source: { ...command.source, actorId: 'forged' } }, { source: { ...command.source, version: 2 } }, { actorId: 'forged' }]) {
    expect(await f.service.execute({ ...command, ...altered }, f.actor)).toMatchObject({ kind: 'rejected', code: 'invalid_command' });
  }
  const worker = f.authority.issueActor({ actorId: 'worker', projectId: 'project', role: 'worker' });
  expect(await f.service.execute(command, worker)).toMatchObject({ kind: 'rejected', code: 'forbidden' });
  expect(readFileSync(f.file)).toEqual(bytes);
});

for (const phase of ['before', 'after'] as const) test(`${phase}-publication error never exposes half a submission and exact retry reconciles once`, async () => {
  const f = await open(); const original = readFileSync(f.file);
  const persistence = (f.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
  let fail = true; persistence.io = { ...nativeFs,
    renameSync(from, to) { if (phase === 'before' && fail) { fail = false; throw new Error('owned publication failure'); } nativeFs.renameSync(from, to); },
    fsyncSync(fd) { if (phase === 'after' && fail && nativeFs.fstatSync(fd).isDirectory()) { fail = false; throw new Error('owned durable ambiguity'); } nativeFs.fsyncSync(fd); },
  };
  expect(await f.service.execute(command, f.actor)).toMatchObject({ kind: 'indeterminate' });
  const visible = await f.storage.read() as WorkLedgerState;
  if (phase === 'before') { expect(readFileSync(f.file)).toEqual(original); expect(visible).toMatchObject({ revision: 0, works: [], attempts: [], receipts: [], history: [] }); }
  else expect(visible).toMatchObject({ revision: 1 });
  const retried = await f.service.execute(command, f.actor); expect(retried).toMatchObject({ kind: 'accepted', replayed: phase === 'after' });
  expect(await f.storage.read()).toMatchObject({ revision: 1 }); expect((await f.service.history(0, f.actor))).toHaveLength(1);
});

for (const interruption of ['abort', 'revoke'] as const) test(`${interruption} while issuing the claimed attempt prevents every submission record`, async () => {
  const f = await open(); const bytes = readFileSync(f.file); const controller = new AbortController();
  const ledger = createWorkLedger({ projectId: 'project', storage: f.storage, clock: { now: () => 100, newId: kind => {
    if (kind === 'attempt') { if (interruption === 'abort') controller.abort(); else ledger.authority.revokeActor(actor); }
    return `interrupted-${kind}`;
  } } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: 'owner', role: 'coordinator' });
  expect(await ledger.service.execute(command, actor, { signal: controller.signal })).toMatchObject({ kind: 'rejected', code: interruption === 'abort' ? 'cancelled' : 'forbidden' });
  expect(await f.storage.read()).toMatchObject({ revision: 0, works: [], attempts: [], receipts: [], history: [] }); expect(readFileSync(f.file)).toEqual(bytes);
});

test('receipt replay rejects coordinated snapshot/source/owner/role tampering', async () => {
  const f = await open(); event(await f.service.execute(command, f.actor)); const original = await f.storage.read() as WorkLedgerState;
  for (const mutateState of [
    (state: WorkLedgerState) => { for (const work of [state.works[0]!, (state.history[0] as Exclude<WorkLedgerEvent, { type: 'import_legacy' }>).work]) work.goal += 'forged'; },
    (state: WorkLedgerState) => { for (const work of [state.works[0]!, (state.history[0] as Exclude<WorkLedgerEvent, { type: 'import_legacy' }>).work]) work.source!.sourceRevision = 'forged'; },
    (state: WorkLedgerState) => { state.attempts[0]!.ownerId = 'intruder'; (state.history[0] as Exclude<WorkLedgerEvent, { type: 'import_legacy' }>).attempts[0]!.ownerId = 'intruder'; },
    (state: WorkLedgerState) => { const signature = JSON.parse(state.receipts[0]!.signature); signature.role = 'worker'; state.receipts[0]!.signature = JSON.stringify(signature); },
  ]) {
    const state = structuredClone(original); mutateState(state); state.receipts[0]!.event = structuredClone(state.history[0]!);
    expect(() => readWorkLedgerState(state, 'project')).toThrow();
  }
});

test('new execution intents for native work must bind persisted source identity and session', async () => {
  const f = await open(); const submitted = event(await f.service.execute(command, f.actor)); const work = submitted.work; const attempt = submitted.attempts[0]!;
  const storage = await f.store.openNativeWorkExecutionStorage('project');
  const key = { workId: work.id, criteriaId: criteriaSetIdForWork(work.id), criteriaRevision: String(work.criteriaRevision), attemptId: attempt.id };
  function intent(sourceId = command.source.sourceId, sourceRevision = command.source.sourceRevision, sessionId = command.source.sessionId) {
    const binding = { sourceId, inputRevision: 'input-revision', actionId: 'action', actionRevision: 'action-revision', authorityId: 'authority', authorityRevision: 'authority-revision', scopeId: 'scope', scopeRevision: 'scope-revision' };
    const request = freezeDurableRequest({ key, binding, input: { ask: work.title, sessionId, projectRoot: join(f.file, '..'), origin: 'external', isolation: 'auto', nativeSource: { sourceId, sourceRevision, inputRevision: binding.inputRevision, criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision, goal: work.goal, criteria: work.criteria } } });
    return parseNativeWorkExecutionIntent({ version: 1, projectId: 'project', target: { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision }, authorityScopes: ['write:fleet'], request, generation: 1, state: 'admitting' });
  }
  const bytes = readFileSync(f.file);
  for (const altered of [intent('forged-source'), intent(undefined, 'forged-revision'), intent(undefined, undefined, 'forged-session')]) {
    await expect(storage.transaction(key, () => ({ next: null, nextIntent: altered, value: undefined }))).rejects.toMatchObject({ code: 'stale' });
    expect(readFileSync(f.file)).toEqual(bytes);
  }
  await storage.transaction(key, () => ({ next: null, nextIntent: intent(), value: undefined })); expect(storage.current(key).intent).toEqual(intent());
});

test('schema4 migration validates old authority, adds only null provenance and preserves receipt replay', async () => {
  const f = await open(); const oldCommand = { type: 'create', requestId: 'old', expectedRevision: 0, title: 'Old', goal: 'Old goal', criteria: ['First', 'First', 'Second'] };
  event(await f.service.execute(oldCommand, f.actor)); const old = legacyState(await f.storage.read() as WorkLedgerState); await f.store.close();
  await mutate(f.file, db => { db.run('UPDATE work_ledgers SET format_version = 1, state_json = ?', [JSON.stringify(old)]); db.run('PRAGMA user_version = 4'); });
  const oldWriter = new SQLiteStore(f.file, { coordinated: true }); await oldWriter.init(() => {}, { schemaVersion: 4 });
  const migrated = await open(f.file); const state = await migrated.storage.read() as WorkLedgerState;
  expect(state.version).toBe(2); expect(state.works[0]!.source).toBeNull(); expect(state.receipts[0]!.signature).toBe(old.receipts[0]!.signature);
  expect(await migrated.service.lookupSubmission('old', migrated.actor)).toBeNull();
  expect(await migrated.service.execute(oldCommand, migrated.actor)).toMatchObject({ kind: 'accepted', replayed: true });
  const bytes = readFileSync(f.file); oldWriter.run('UPDATE work_ledgers SET revision = 999'); await expect(oldWriter.save()).rejects.toThrow('persisted state changed'); oldWriter.close();
  const oldBinary = new SQLiteStore(f.file); await expect(oldBinary.init(() => {}, { schemaVersion: 4 })).rejects.toThrow('newer version'); oldBinary.close(); expect(readFileSync(f.file)).toEqual(bytes);
});

test('malformed legacy history cannot acquire null provenance or publish DB5', async () => {
  const f = await open(); event(await f.service.execute({ type: 'create', requestId: 'old', expectedRevision: 0, title: 'Old', goal: 'Old goal', criteria: ['First'] }, f.actor));
  const old = legacyState(await f.storage.read() as WorkLedgerState); old.works[0]!.goal = 'forged';
  const history = old.history[0]!; if (history.type === 'import_legacy') throw new Error('fixture'); history.work.goal = 'forged'; old.receipts[0]!.event = structuredClone(history);
  expect(() => migrateLegacyWorkLedgerState(old, 'project')).toThrow(); await f.store.close();
  await mutate(f.file, db => { db.run('UPDATE work_ledgers SET format_version = 1, state_json = ?', [JSON.stringify(old)]); db.run('PRAGMA user_version = 4'); });
  const bytes = readFileSync(f.file); await expect(open(f.file)).rejects.toThrow('migration'); expect(readFileSync(f.file)).toEqual(bytes);
});
