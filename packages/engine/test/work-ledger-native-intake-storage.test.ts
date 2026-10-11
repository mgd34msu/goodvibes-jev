/** Owned synthetic fixtures only: no settings, real tokens, providers or executors. */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { loadSqlJsEngine, SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import type { SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import {
  nativeConversationSourceId, nativeConversationSourceRevision, nativeConversationProposalRevision, nativeConversationDecisionBinding,
  parseNativeConversationCapture, validateNativeConversationProposal,
  type NativeConversationCapture, type NativeConversationStorage,
} from '../sdk/src/platform/workflow/work-ledger/native-intake-types.js';
import type { WorkLedgerSubmission } from '../sdk/src/platform/workflow/work-ledger/types.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const key = { principalId: 'owner', inputId: 'input' };
const clock = { now: () => 100, newId: (kind: string) => `${kind}-${randomUUID()}` };
function capture(changes: Partial<NativeConversationCapture> = {}): NativeConversationCapture {
  const value = { version: 1 as const, projectId: 'project', ...key, requestId: 'request', text: '  Same 😀 task\nSame 😀 task  ', unsupportedSources: [], sessionId: 'session',
    owner: { authorityId: 'owner', authorityRevision: 'token', authorityScopes: ['read:work-ledger', 'write:work-ledger'], scopeId: 'scope', scopeRevision: 'scope-generation', projectRoot: '/owned-fixture' },
    generation: 1, state: 'captured' as const, stage: null, route: null, reason: null, proposalsSpent: 0, proposal: null, decisions: [], association: null, ...changes };
  return parseNativeConversationCapture({ ...value, sourceId: nativeConversationSourceId(value.projectId, value.principalId, value.inputId), sourceRevision: nativeConversationSourceRevision(value) });
}
async function open(file?: string, project = 'project') {
  if (!file) { const root = fs.mkdtempSync(join(tmpdir(), 'native-intake-storage-')); roots.push(root); file = join(root, 'knowledge.sqlite'); }
  const store = new KnowledgeStore({ dbPath: file }); stores.push(store);
  return { file, store, storage: await store.openNativeConversationStorage(project) };
}
async function begin(storage: NativeConversationStorage, initial = capture()) {
  await storage.transaction(key, () => ({ next: initial, value: undefined }));
  const processing = { ...initial, generation: 2, state: 'processing' as const, stage: 'extracting' as const, route: 'contract' as const };
  await storage.transaction(key, () => ({ next: processing, value: undefined })); return processing;
}
async function ready(storage: NativeConversationStorage) {
  const current = await begin(storage);
  const first = current.text.indexOf('Same'), second = current.text.lastIndexOf('Same');
  const proposal = { sourceRevision: current.sourceRevision, spans: [{ partId: 'input' as const, start: first, end: first + 'Same 😀 task'.length }, { partId: 'input' as const, start: second, end: second + 'Same 😀 task'.length }] };
  const binding = nativeConversationDecisionBinding({ ...current, proposalsSpent: 1, proposal }, 'publish-work');
  const context = { decisionId: 'admission-decision', binding, judgmentDecisionIds: ['recorded-admission'], evidence: [{ id: current.sourceId, revision: current.sourceRevision }], continuations: [], resumeConditions: [] };
  const decision = { schemaVersion: 1 as const, outcome: 'act' as const, summary: 'Synthetic recorded decision fixture.', decisionId: context.decisionId, binding, judgmentDecisionIds: context.judgmentDecisionIds, evidence: context.evidence };
  const next = parseNativeConversationCapture({ ...current, stage: 'deciding', proposalsSpent: 1, proposal, decisions: [{ decision, context }] });
  await storage.transaction(key, () => ({ next, value: undefined })); return next;
}
function command(value: NativeConversationCapture, expectedRevision = 0) {
  const proposal = value.proposal!, decision = value.decisions.at(-1)!.decision;
  return { type: 'submit_native', requestId: value.requestId, expectedRevision, title: value.text.trim(), goal: value.text, criteria: proposal.spans.map(span => value.text.slice(span.start, span.end)),
    source: { version: 2, sourceId: value.sourceId, sourceRevision: value.sourceRevision, inputId: value.inputId, sessionId: value.sessionId,
      extraction: { version: 1, offsetEncoding: 'utf16', spans: proposal.spans, proposalRevision: nativeConversationProposalRevision(proposal), admissionDecisionId: decision.decisionId, judgmentDecisionIds: decision.judgmentDecisionIds } } };
}
function finish(current: NativeConversationCapture, event: WorkLedgerSubmission): NativeConversationCapture {
  return { ...current, state: 'associated', stage: null, association: { workId: event.workId, attemptId: event.attemptId, ledgerRevision: event.sequence } };
}
function publisher(storage: NativeConversationStorage, expected: NativeConversationCapture, suffix = '') {
  const adapter = storage.publicationStorage(key, current => { if (current.generation !== expected.generation) throw new Error('stale generation'); }, finish);
  let id = 0; const ledger = createWorkLedger({ projectId: 'project', storage: adapter, clock: { now: () => 100, newId: kind => `${kind}${suffix}-${++id}` } });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: key.principalId, role: 'coordinator' }); return { ...ledger, actor, adapter };
}
async function mutate(file: string, callback: (db: SqlDatabase) => void) {
  const SQL = await loadSqlJsEngine(); const db = new SQL.Database(fs.readFileSync(file));
  try { callback(db); fs.writeFileSync(file, db.export()); } finally { db.close(); }
}

test('capture parser preserves exact input and bounded proposal occurrences; rejects malformed data without invoking accessors', () => {
  const value = capture(), parsed = parseNativeConversationCapture(value); expect(parsed).toEqual(value);
  const first = value.text.indexOf('Same'), second = value.text.lastIndexOf('Same');
  const proposal = { sourceRevision: value.sourceRevision, spans: [{ partId: 'input', start: first, end: first + 4 }, { partId: 'input', start: second, end: second + 4 }] };
  expect(validateNativeConversationProposal(proposal, value.text, value.sourceRevision).spans).toHaveLength(2);
  let reads = 0;
  for (const bad of [{ ...value, unexpected: true }, { ...value, text: value.text + ' ' }, { ...value, get state() { reads++; return 'captured'; } }, { ...value, decisions: new Array(1) }, { ...value, owner: { ...value.owner, authorityScopes: ['same', 'same'] } }, { ...value, proposalsSpent: 4 }, { ...value, generation: 0 }]) expect(() => parseNativeConversationCapture(bad)).toThrow();
  expect(reads).toBe(0);
  const emoji = value.text.indexOf('😀');
  for (const spans of [[{ partId: 'input', start: emoji, end: emoji + 1 }], [{ partId: 'input', start: emoji + 1, end: emoji + 2 }], [{ partId: 'input', start: 0, end: 2 }], [{ partId: 'input', start: second, end: second + 4 }, { partId: 'input', start: first, end: first + 4 }], [{ partId: 'input', start: first, end: first + 4 }, { partId: 'input', start: first, end: first + 4 }]]) expect(() => validateNativeConversationProposal({ ...proposal, spans }, value.text, value.sourceRevision)).toThrow();
});

test('capture text/request/owner identity and cancellation survive restart; request keys are principal-scoped', async () => {
  const f = await open(); const initial = await begin(f.storage); const before = fs.readFileSync(f.file);
  for (const changed of [{ ...initial, requestId: 'other' }, capture({ ...initial, text: `${initial.text} changed` }), { ...initial, owner: { ...initial.owner, authorityRevision: 'other' } }, { ...initial, generation: 9 }]) await expect(f.storage.transaction(key, () => ({ next: changed, value: undefined }))).rejects.toThrow();
  expect(fs.readFileSync(f.file)).toEqual(before);
  await expect(f.storage.transaction({ ...key, inputId: 'other' }, () => ({ next: capture({ inputId: 'other' }), value: undefined }))).rejects.toMatchObject({ code: 'conflict' });
  const cancelled = { ...initial, generation: 3, state: 'cancelled' as const, stage: null };
  await f.storage.transaction(key, () => ({ next: cancelled, value: undefined }));
  const reopened = await open(f.file); expect(reopened.storage.current(key)).toEqual(cancelled);
  await expect(reopened.storage.transaction(key, () => ({ next: { ...initial, generation: 4 }, value: undefined }))).rejects.toMatchObject({ code: 'cancelled' });
  const other = capture({ principalId: 'other-owner' }); await reopened.storage.transaction({ principalId: other.principalId, inputId: other.inputId }, () => ({ next: other, value: undefined }));
  expect((await open(f.file, 'other-project')).storage.current(key)).toBeNull();
});

test('one publication atomically creates work, claim, receipt and exact source association; replay survives restart', async () => {
  const f = await open(), source = await ready(f.storage), p = publisher(f.storage, source);
  const result = await p.service.execute(command(source), p.actor); expect(result.kind).toBe('accepted');
  const associated = f.storage.current(key)!; expect(associated.state).toBe('associated');
  expect(await p.adapter.read()).toMatchObject({ revision: 1, works: [{ goal: source.text, criteria: ['Same 😀 task', 'Same 😀 task'], source: command(source).source }], attempts: [{ ownerId: 'owner', state: 'active' }], receipts: [{ requestId: 'request' }] });
  const reopened = await open(f.file); expect(reopened.storage.current(key)).toEqual(associated);
  const again = publisher(reopened.storage, source, '-replay'); const bytes = fs.readFileSync(f.file);
  expect(await again.service.execute(command(source), again.actor)).toMatchObject({ kind: 'accepted', replayed: true }); expect(fs.readFileSync(f.file)).toEqual(bytes);
  await expect(reopened.storage.transaction(key, () => ({ next: { ...associated, state: 'cancelled', generation: 3, association: null }, value: undefined }))).rejects.toThrow();
});

test('ordinary storage and invalid source metadata cannot create an unassociated extracted work', async () => {
  const f = await open(), source = await ready(f.storage); const before = fs.readFileSync(f.file);
  const ordinary = createWorkLedger({ projectId: 'project', storage: await f.store.openWorkLedgerStorage('project'), clock });
  const actor = ordinary.authority.issueActor({ projectId: 'project', actorId: 'owner', role: 'coordinator' });
  expect(await ordinary.service.execute(command(source), actor)).toMatchObject({ kind: 'indeterminate' });
  const p = publisher(f.storage, source), original = command(source);
  const changed = { ...original, source: { ...original.source, extraction: { ...original.source.extraction, admissionDecisionId: 'route-decision' } } };
  expect(await p.service.execute(changed, p.actor)).toMatchObject({ kind: 'indeterminate' });
  expect(fs.readFileSync(f.file)).toEqual(before); expect(f.storage.current(key)?.association).toBeNull();
});

test('cancellation racing a paused admission wins before publication and creates zero ledger records', async () => {
  const f = await open(), source = await ready(f.storage), p = publisher(f.storage, source); const second = await open(f.file);
  await second.storage.transaction(key, current => ({ next: { ...current!, state: 'cancelled', generation: 3, stage: null }, value: undefined }));
  expect(await p.service.execute(command(source), p.actor)).toMatchObject({ kind: 'indeterminate' });
  expect(await p.adapter.read()).toMatchObject({ revision: 0, history: [], receipts: [], works: [], attempts: [] });
});

test('concurrent exact duplicates publish one source association and one immutable receipt', async () => {
  const f = await open(), source = await ready(f.storage), second = await open(f.file);
  const a = publisher(f.storage, source, 'a'), b = publisher(second.storage, source, 'b');
  const results = await Promise.all([a.service.execute(command(source), a.actor), b.service.execute(command(source), b.actor)]);
  expect(results.filter(result => result.kind === 'accepted')).toHaveLength(2);
  expect(results.filter(result => result.kind === 'accepted' && result.replayed)).toHaveLength(1);
  expect(await a.adapter.read()).toMatchObject({ revision: 1 }); expect(second.storage.current(key)).toEqual(f.storage.current(key));
});

for (const phase of ['before', 'after'] as const) test(`${phase}-publication I/O ambiguity keeps source association and ledger indivisible`, async () => {
  const f = await open(), source = await ready(f.storage), p = publisher(f.storage, source), before = fs.readFileSync(f.file);
  const persistence = (f.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
  let fail = true;
  persistence.io = { ...fs, renameSync(from, to) { if (phase === 'before' && fail) { fail = false; throw new Error('owned write failure'); } fs.renameSync(from, to); },
    fsyncSync(fd) { if (phase === 'after' && fail && fs.fstatSync(fd).isDirectory()) { fail = false; throw new Error('owned durability ambiguity'); } fs.fsyncSync(fd); } };
  expect(await p.service.execute(command(source), p.actor)).toMatchObject({ kind: 'indeterminate' });
  const visible = f.storage.current(key)!; expect(visible.state).toBe(phase === 'before' ? 'processing' : 'associated');
  if (phase === 'before') expect(fs.readFileSync(f.file)).toEqual(before);
  expect(await p.service.execute(command(source), p.actor)).toMatchObject({ kind: 'accepted', replayed: phase === 'after' });
  expect(await p.adapter.read()).toMatchObject({ revision: 1 }); expect(f.storage.current(key)?.state).toBe('associated');
});

test('DB5 upgrade preserves source1 exactly and old readers/writers fail closed at DB7', async () => {
  const f = await open(); const storage = await f.store.openWorkLedgerStorage('project'), ledger = createWorkLedger({ projectId: 'project', storage, clock });
  const actor = ledger.authority.issueActor({ projectId: 'project', actorId: 'owner', role: 'coordinator' });
  const explicit = { type: 'submit_native', requestId: 'explicit', expectedRevision: 0, title: 'Explicit', goal: ' Exact goal ', criteria: [' same ', ' same '], source: { version: 1, sourceId: 'old-source', sourceRevision: 'old-revision', inputId: 'explicit-input', sessionId: 'session' } };
  expect(await ledger.service.execute(explicit, actor)).toMatchObject({ kind: 'accepted' }); const original = await storage.read(); await f.store.close();
  await mutate(f.file, db => { db.run('DROP TABLE native_conversation_captures'); db.run('PRAGMA user_version = 5'); });
  const old = new SQLiteStore(f.file, { coordinated: true }); await old.init(() => {}, { schemaVersion: 5 });
  const upgraded = await open(f.file); expect(await (await upgraded.store.openWorkLedgerStorage('project')).read()).toEqual(original);
  old.run('UPDATE work_ledgers SET revision=999'); await expect(old.save()).rejects.toThrow('persisted state changed'); old.close();
  const oldReader = new SQLiteStore(f.file); await expect(oldReader.init(() => {}, { schemaVersion: 5 })).rejects.toThrow('newer version'); oldReader.close();
  const SQL = await loadSqlJsEngine(), db = new SQL.Database(fs.readFileSync(f.file)); expect(db.exec('PRAGMA user_version')[0]?.values).toEqual([[9]]); db.close();
});

test('DB7 never repairs missing capture tables, missing association rows or contradictory source lineage', async () => {
  for (const mutation of [(db: SqlDatabase) => db.run('DROP TABLE native_conversation_captures'), (db: SqlDatabase) => db.run('DELETE FROM native_conversation_captures'), (db: SqlDatabase) => db.run("UPDATE native_conversation_captures SET state_json = replace(state_json, 'recorded-admission', 'forged-record')")]) {
    const f = await open(), source = await ready(f.storage), p = publisher(f.storage, source); expect(await p.service.execute(command(source), p.actor)).toMatchObject({ kind: 'accepted' }); await f.store.close();
    await mutate(f.file, mutation); const bytes = fs.readFileSync(f.file); await expect(open(f.file)).rejects.toThrow(); expect(fs.readFileSync(f.file)).toEqual(bytes);
  }
});

test('DB6 captured source and extracted work upgrade to DB7 without rewriting either authority', async () => {
  const f = await open(), source = await ready(f.storage), publication = publisher(f.storage, source);
  expect(await publication.service.execute(command(source), publication.actor)).toMatchObject({ kind: 'accepted' });
  await f.store.close();
  const SQL = await loadSqlJsEngine();
  const old = new SQL.Database(fs.readFileSync(f.file));
  old.run('DROP TABLE native_work_execution_settlements'); old.run('PRAGMA user_version = 6');
  const captures = old.exec('SELECT state_json FROM native_conversation_captures')[0]?.values;
  const ledgers = old.exec('SELECT state_json FROM work_ledgers')[0]?.values;
  fs.writeFileSync(f.file, old.export()); old.close();
  const upgraded = await open(f.file); expect(upgraded.storage.current(key)?.state).toBe('associated');
  const current = new SQL.Database(fs.readFileSync(f.file));
  expect(current.exec('PRAGMA user_version')[0]?.values).toEqual([[9]]);
  expect(current.exec('SELECT state_json FROM native_conversation_captures')[0]?.values).toEqual(captures);
  expect(current.exec('SELECT state_json FROM work_ledgers')[0]?.values).toEqual(ledgers);
  expect(current.exec('SELECT COUNT(*) FROM native_work_execution_settlements')[0]?.values).toEqual([[0]]);
  current.close();
  const older = new SQLiteStore(f.file); await expect(older.init(() => {}, { schemaVersion: 6 })).rejects.toThrow('newer version'); await older.close();
});

test('retained semantic lineage and proposal budgets cannot be erased or rewritten on resume', async () => {
  const f = await open(), source = await ready(f.storage), before = fs.readFileSync(f.file);
  const final = source.decisions[0]!;
  for (const changed of [
    { ...source, proposalsSpent: 0 },
    { ...source, proposalsSpent: 3 },
    { ...source, decisions: [] },
    { ...source, decisions: [{ ...final, decision: { ...final.decision, summary: 'rewritten history' } }] },
    { ...source, decisions: [{ ...final, decision: { ...final.decision, judgmentDecisionIds: ['unrecorded-call'] } }] },
    { ...source, decisions: [{ ...final, context: { ...final.context, binding: { ...final.context.binding, authorityRevision: 'replaced-owner' } } }] },
  ]) await expect(f.storage.transaction(key, () => ({ next: changed as NativeConversationCapture, value: undefined }))).rejects.toThrow();
  expect(fs.readFileSync(f.file)).toEqual(before);
  const refused = { ...source, state: 'refused' as const, stage: null, reason: 'semantic' as const };
  await f.storage.transaction(key, () => ({ next: refused, value: undefined }));
  await expect(f.storage.transaction(key, () => ({ next: { ...source, generation: 2 }, value: undefined }))).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.storage.transaction(key, () => ({ next: { ...source, generation: 3 }, value: undefined }))).rejects.toMatchObject({ code: 'conflict' });
  const interrupted = await open(), interruptedSource = await ready(interrupted.storage);
  const resumed = { ...interruptedSource, generation: 3, stage: 'routing' as const };
  await interrupted.storage.transaction(key, () => ({ next: resumed, value: undefined }));
  expect((await open(interrupted.file)).storage.current(key)).toMatchObject({ generation: 3, proposalsSpent: 1, decisions: source.decisions });
  const publisherWithOldDecision = publisher(interrupted.storage, resumed);
  expect(await publisherWithOldDecision.service.execute(command(resumed), publisherWithOldDecision.actor)).toMatchObject({ kind: 'indeterminate' });
  expect(await publisherWithOldDecision.adapter.read()).toMatchObject({ revision: 0 });
});

test('asynchronous mutations, callback mutation, or a false association cannot evade the source transaction', async () => {
  const f = await open(), source = await ready(f.storage), before = fs.readFileSync(f.file);
  await expect(f.storage.transaction(key, (async () => ({ next: null, value: undefined })) as never)).rejects.toThrow();
  await expect(f.storage.transaction(key, current => { (current!.owner as { authorityRevision: string }).authorityRevision = 'forged'; return { next: current, value: undefined }; })).rejects.toMatchObject({ code: 'invalid' });
  await expect(f.storage.transaction(key, () => ({ next: { ...source, state: 'associated', stage: null, association: { workId: 'invented-work', attemptId: 'invented-attempt', ledgerRevision: 1 } }, value: undefined }))).rejects.toMatchObject({ code: 'conflict' });
  expect(fs.readFileSync(f.file)).toEqual(before);
});

test('an aggregate conflict leaves capture untouched until the same source publishes against the current revision', async () => {
  const f = await open(), source = await ready(f.storage), p = publisher(f.storage, source);
  const unrelated = createWorkLedger({ projectId: 'project', storage: await f.store.openWorkLedgerStorage('project'), clock });
  const otherActor = unrelated.authority.issueActor({ projectId: 'project', actorId: 'other-owner', role: 'coordinator' });
  expect(await unrelated.service.execute({ type: 'create', requestId: 'other-request', expectedRevision: 0, title: 'Other', goal: 'Other goal', criteria: ['Other requirement'] }, otherActor)).toMatchObject({ kind: 'accepted' });
  const before = fs.readFileSync(f.file);
  expect(await p.service.execute(command(source), p.actor)).toMatchObject({ kind: 'rejected', code: 'conflict', revision: 1 });
  expect(fs.readFileSync(f.file)).toEqual(before); expect(f.storage.current(key)?.state).toBe('processing');
  expect(await p.service.execute(command(source, 1), p.actor)).toMatchObject({ kind: 'accepted', replayed: false });
  expect(f.storage.current(key)?.association?.ledgerRevision).toBe(2); expect(await p.adapter.read()).toMatchObject({ revision: 2 });
});

test('blocked and refused immutable input cannot resume unchanged semantic readings; cancellation remains available', async () => {
  for (const state of ['blocked', 'refused'] as const) {
    const f = await open(), source = await ready(f.storage);
    const stopped = { ...source, state, stage: null, reason: state === 'blocked' ? 'missing-context' as const : 'semantic' as const };
    await f.storage.transaction(key, () => ({ next: stopped, value: undefined })); const bytes = fs.readFileSync(f.file);
    for (const generation of [source.generation, source.generation + 1]) await expect(f.storage.transaction(key, () => ({ next: { ...source, generation }, value: undefined }))).rejects.toMatchObject({ code: 'conflict' });
    expect(fs.readFileSync(f.file)).toEqual(bytes);
    await f.storage.transaction(key, () => ({ next: { ...stopped, state: 'cancelled', generation: source.generation + 1 }, value: undefined }));
    expect(f.storage.current(key)?.state).toBe('cancelled');
  }
});

test('owner close drains an already admitted publication while refusing later storage work', async () => {
  const f = await open(), source = await ready(f.storage), p = publisher(f.storage, source);
  const release = await acquireCrossProcessLock(`${f.file}.knowledge-lock`, { strictOwnership: true });
  const writing = p.service.execute(command(source), p.actor);
  await new Promise(resolve => setTimeout(resolve, 10));
  let settled = false; const closing = f.store.close().then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
  expect(() => f.storage.current(key)).toThrow('closed');
  release(); expect(await writing).toMatchObject({ kind: 'accepted' }); await closing;
  expect((await open(f.file)).storage.current(key)?.state).toBe('associated');
});
