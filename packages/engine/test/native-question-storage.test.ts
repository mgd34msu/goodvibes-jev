/** Storage-only synthetic fixtures; no semantic evaluator or execution continuation. */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createNativeQuestionTable } from '../sdk/src/platform/knowledge/store-native-question.js';
import { acceptNativeQuestionReply, parseNativeQuestionRecord } from '../sdk/src/platform/workflow/work-ledger/native-question-types.js';
import type { LedgerWork, WorkLedgerEvent, WorkLedgerState } from '../sdk/src/platform/workflow/work-ledger/types.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { inspectQuestionImage, mutateQuestionImage, questionHarness, questionPersistence, readAuthorityRows, seedQuestion } from './helpers/native-question.js';

const harness = questionHarness();
afterEach(() => harness.close());

test('acceptance and exact replay survive independent owners and restart without changing existing authorities', async () => {
  const f = await harness.fixture(), authorities = await readAuthorityRows(f.file);
  const accepted = await f.host.accept(f.reply, f.authority), bytes = fs.readFileSync(f.file);
  expect(accepted).toMatchObject({ state: 'answered', answer: { requestId: f.reply.requestId, answer: f.reply.answer } });
  expect(accepted.answer?.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.host.accept(f.reply, f.authority)).toEqual(accepted);
  const reopened = await harness.open(f.file);
  expect(reopened.storage.current(f.identity).question).toEqual(accepted);
  expect(await reopened.storage.transaction(f.identity, current => acceptNativeQuestionReply(current.question!, f.reply), () => {})).toEqual(accepted);
  expect(fs.readFileSync(f.file)).toEqual(bytes);
  expect(await readAuthorityRows(f.file)).toEqual(authorities);
});

test('concurrent exact duplicates on independent owners retain one immutable receipt', async () => {
  const f = await harness.fixture(), other = await harness.open(f.file);
  const accepted = await Promise.all([f.storage, other.storage].map(storage => storage.transaction(f.identity,
    current => acceptNativeQuestionReply(current.question!, f.reply), () => {})));
  expect(accepted[0]).toEqual(accepted[1]);
  expect(await inspectQuestionImage(f.file, db => db.exec('SELECT COUNT(*), COUNT(request_id) FROM native_work_questions')[0]?.values)).toEqual([[1, 1]]);
});

test('a newer question revision requires the prior revision to be terminal and cannot move backward', async () => {
  const f = await harness.fixture(), next = parseNativeQuestionRecord({ ...f.question, identity: { ...f.identity, questionRevision: 2 } });
  const before = fs.readFileSync(f.file);
  await expect(seedQuestion(f.storage, next)).rejects.toMatchObject({ code: 'conflict' });
  expect(fs.readFileSync(f.file)).toEqual(before);
  const superseded = parseNativeQuestionRecord({ ...f.question, state: 'superseded' });
  await f.storage.transaction(f.identity, () => ({ next: superseded, value: superseded }), () => {});
  await seedQuestion(f.storage, next);
  expect((await harness.open(f.file)).storage.current(f.identity).question).toEqual(superseded);
  expect(f.storage.current(next.identity).question).toEqual(next);
  const older = parseNativeQuestionRecord({ ...f.question, identity: { ...f.identity, questionRevision: 0 } });
  await expect(seedQuestion(f.storage, older)).rejects.toMatchObject({ code: 'conflict' });
});

test('independent owners racing distinct revisions cannot register two open versions of one question', async () => {
  const f = await harness.fixture({ seed: false }), other = await harness.open(f.file);
  const next = parseNativeQuestionRecord({ ...f.question, identity: { ...f.identity, questionRevision: 2 } });
  const outcomes = await Promise.allSettled([seedQuestion(f.storage, f.question), seedQuestion(other.storage, next)]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(await inspectQuestionImage(f.file, db => db.exec('SELECT COUNT(*) FROM native_work_questions')[0]?.values)).toEqual([[1]]);
});

test('conflicting duplicate answers and reuse of a request on another question preserve the winner', async () => {
  const f = await harness.fixture();
  const second = parseNativeQuestionRecord({ ...f.question, identity: { ...f.identity, questionId: 'question-2' } });
  await seedQuestion(f.storage, second);
  await f.host.accept(f.reply, f.authority);
  const bytes = fs.readFileSync(f.file);
  await expect(f.host.accept({ ...f.reply, answer: 'different' }, f.authority)).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.host.accept({ ...f.reply, requestId: 'different-request' }, f.authority)).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.host.accept({ ...f.reply, ...second.identity }, f.authority)).rejects.toMatchObject({ code: 'conflict' });
  expect(fs.readFileSync(f.file)).toEqual(bytes);
});

for (const phase of ['before', 'after'] as const) test(`${phase}-publication failure never splits answer and replay receipt; exact retry reconciles`, async () => {
  const f = await harness.fixture(), original = fs.readFileSync(f.file), persistence = questionPersistence(f.store);
  let fail = true;
  const synced: string[] = [];
  persistence.io = { ...fs,
    renameSync(from, to) { if (phase === 'before' && fail) { fail = false; throw new Error('fixture before publication'); } fs.renameSync(from, to); },
    fsyncSync(fd) {
      const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'; synced.push(kind);
      if (phase === 'after' && fail && kind === 'directory') { fail = false; throw new Error('fixture after publication'); }
      fs.fsyncSync(fd);
    },
  };
  await expect(f.host.accept(f.reply, f.authority)).rejects.toMatchObject({ phase: phase === 'before' ? 'before-publication' : 'indeterminate' });
  const visible = f.storage.current(f.identity).question;
  if (phase === 'before') { expect(fs.readFileSync(f.file)).toEqual(original); expect(visible).toEqual(f.question); }
  else expect(visible).toMatchObject({ state: 'answered', answer: { requestId: f.reply.requestId } });
  const visibleBytes = fs.readFileSync(f.file); synced.length = 0;
  const accepted = await f.host.accept(f.reply, f.authority);
  expect(accepted).toMatchObject({ state: 'answered', answer: { requestId: f.reply.requestId, answer: f.reply.answer } });
  if (phase === 'after') {
    const expected = ['file'];
    for (let directory = dirname(f.file);; directory = dirname(directory)) { expected.push('directory'); if (dirname(directory) === directory) break; }
    expect(synced).toEqual(expected); expect(fs.readFileSync(f.file)).toEqual(visibleBytes);
  }
  expect((await harness.open(f.file)).storage.current(f.identity).question).toEqual(accepted);
});

test('batch admission blocks a question decision without discarding pending local changes', async () => {
  const f = await harness.fixture(); let decisions = 0;
  await f.store.batch(async () => {
    await f.store.upsertSource({ id: 'pending-source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
    await expect(f.storage.transaction(f.identity, current => { decisions++; return acceptNativeQuestionReply(current.question!, f.reply); }, () => {})).rejects.toMatchObject({ code: 'unavailable' });
  });
  expect(decisions).toBe(0); expect(f.storage.current(f.identity).question).toEqual(f.question);
  expect((await harness.open(f.file)).store.getSource('pending-source')).not.toBeNull();
});

test('postpublication mirror failure preserves the accepted receipt and fences ordinary writes', async () => {
  const f = await harness.fixture();
  (f.store as unknown as { refreshSnapshot: () => void }).refreshSnapshot = () => { throw new Error('fixture mirror failure'); };
  const accepted = await f.host.accept(f.reply, f.authority), bytes = fs.readFileSync(f.file);
  expect(accepted.state).toBe('answered');
  expect(await f.host.accept(f.reply, f.authority)).toEqual(accepted);
  await expect(f.store.upsertSource({ id: 'fenced-source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' })).rejects.toThrow('cache fenced');
  expect(fs.readFileSync(f.file)).toEqual(bytes);
  expect((await harness.open(f.file)).storage.current(f.identity).question).toEqual(accepted);
});

test('async and baseline-mutating callbacks cannot alter an open question', async () => {
  const f = await harness.fixture(), before = fs.readFileSync(f.file);
  await expect(f.storage.transaction(f.identity, (async () => ({ next: null, value: f.question })) as never, () => {})).rejects.toMatchObject({ code: 'invalid' });
  await expect(f.storage.transaction(f.identity, current => {
    const mutated = { ...current.question!, question: 'forged replacement' };
    return { next: mutated, value: mutated };
  }, () => {})).rejects.toMatchObject({ code: 'conflict' });
  expect(fs.readFileSync(f.file)).toEqual(before);
});

test('storage close drains an admitted write behind the file lock and rejects later admission', async () => {
  const f = await harness.fixture();
  const release = await acquireCrossProcessLock(`${f.file}.knowledge-lock`);
  const accepted = f.storage.transaction(f.identity, current => acceptNativeQuestionReply(current.question!, f.reply), () => {});
  let closed = false; const closing = f.storage.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  expect(() => f.storage.current(f.identity)).toThrow('closed');
  expect(() => f.storage.transaction(f.identity, () => ({ next: null, value: f.question }), () => {})).toThrow('closed');
  release(); expect(await accepted).toMatchObject({ state: 'answered' }); await closing;
  expect((await harness.open(f.file)).storage.current(f.identity).question?.state).toBe('answered');
});

test('KnowledgeStore ownership closes its question capability only after admitted publication settles', async () => {
  const f = await harness.fixture(), release = await acquireCrossProcessLock(`${f.file}.knowledge-lock`);
  const accepted = f.storage.transaction(f.identity, current => acceptNativeQuestionReply(current.question!, f.reply), () => {});
  let closed = false; const closing = f.store.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  expect(() => f.storage.current(f.identity)).toThrow('closed');
  release(); const receipt = await accepted; await closing;
  expect((await harness.open(f.file)).storage.current(f.identity).question).toEqual(receipt);
});

test('DB7 migration is additive, preserves exact existing rows, and creates no questions', async () => {
  const f = await harness.fixture({ seed: false }); await f.store.close();
  await mutateQuestionImage(f.file, db => { db.run('DROP TABLE native_work_questions'); db.run('PRAGMA user_version=7'); });
  const before = await readAuthorityRows(f.file);
  const migrated = await harness.open(f.file);
  expect(migrated.storage.current(f.identity).question).toBeNull();
  expect(await readAuthorityRows(f.file)).toEqual(before);
  expect(await inspectQuestionImage(f.file, db => [db.exec('PRAGMA user_version')[0]?.values, db.exec('SELECT COUNT(*) FROM native_work_questions')[0]?.values])).toEqual([[[8]], [[0]]]);
});

test('schema3 upgrade preserves original nine-field execution JSON without inventing an intent or question', async () => {
  const f = await harness.fixture({ seed: false }); await f.store.close();
  const executionJson = JSON.stringify(f.record, null, 2);
  await mutateQuestionImage(f.file, db => {
    const withoutSource = (work: LedgerWork) => { const { source: _source, ...old } = work; return old; };
    const oldEvent = (event: WorkLedgerEvent) => event.type === 'import_legacy'
      ? { ...event, works: event.works.map(withoutSource) } : { ...event, work: withoutSource(event.work) };
    for (const row of db.exec('SELECT project_id,state_json FROM work_ledgers')[0]?.values ?? []) {
      const state = JSON.parse(String(row[1])) as WorkLedgerState;
      const old = { ...state, version: 1, works: state.works.map(withoutSource), history: state.history.map(oldEvent),
        receipts: state.receipts.map(receipt => ({ ...receipt, event: oldEvent(receipt.event) })) };
      db.run('UPDATE work_ledgers SET format_version=1,state_json=? WHERE project_id=?', [JSON.stringify(old), String(row[0])]);
    }
    for (const table of ['native_work_questions', 'native_work_execution_intents', 'native_conversation_captures', 'native_work_execution_settlements']) db.run(`DROP TABLE ${table}`);
    db.run('UPDATE native_work_executions SET state_json=?', [executionJson]); db.run('PRAGMA user_version=3');
  });
  const migrated = await harness.open(f.file);
  expect(migrated.storage.current(f.identity)).toMatchObject({ question: null, execution: { record: f.record, intent: null } });
  expect(await inspectQuestionImage(f.file, db => [db.exec('SELECT state_json FROM native_work_executions')[0]?.values,
    db.exec('SELECT COUNT(*) FROM native_work_execution_intents')[0]?.values, db.exec('SELECT COUNT(*) FROM native_work_questions')[0]?.values])).toEqual([[[executionJson]], [[0]], [[0]]]);
});

for (const table of ['work_ledgers', 'native_work_executions', 'native_work_execution_intents']) test(`migration refuses corrupt ${table} and leaves the original DB7 bytes intact`, async () => {
  const f = await harness.fixture({ seed: false }); await f.store.close();
  await mutateQuestionImage(f.file, db => { db.run('DROP TABLE native_work_questions'); db.run('PRAGMA user_version=7'); db.run(`UPDATE ${table} SET state_json='{}'`); });
  const before = fs.readFileSync(f.file);
  await expect(harness.open(f.file)).rejects.toThrow(); expect(fs.readFileSync(f.file)).toEqual(before);
});

test('migration refuses pre-seeded question authority at DB7 instead of adopting it', async () => {
  const f = await harness.fixture(); await f.store.close();
  await mutateQuestionImage(f.file, db => db.run('PRAGMA user_version=7'));
  const before = fs.readFileSync(f.file);
  await expect(harness.open(f.file)).rejects.toThrow(); expect(fs.readFileSync(f.file)).toEqual(before);
});

test('migration recognizes an uppercase pre-seeded question table and refuses it without rewriting DB7', async () => {
  const f = await harness.fixture(); await f.store.close();
  await mutateQuestionImage(f.file, db => {
    db.run('ALTER TABLE native_work_questions RENAME TO temporary_questions');
    db.run('ALTER TABLE temporary_questions RENAME TO NATIVE_WORK_QUESTIONS');
    db.run('PRAGMA user_version=7');
  });
  const before = fs.readFileSync(f.file);
  await expect(harness.open(f.file)).rejects.toThrow('invalid'); expect(fs.readFileSync(f.file)).toEqual(before);
});

for (const corruption of ['missing-table', 'wrong-shape', 'missing-unique', 'invalid-json', 'orphan', 'foreign-project', 'wrong-admission', 'wrong-revision', 'wrong-request-column'] as const) {
  test(`DB8 ${corruption} fails persisted reads and reopen without repair`, async () => {
    const f = await harness.fixture();
    await mutateQuestionImage(f.file, db => {
      if (corruption === 'missing-table') db.run('DROP TABLE native_work_questions');
      else if (corruption === 'wrong-shape') { db.run('DROP TABLE native_work_questions'); db.run('CREATE TABLE native_work_questions (project_id TEXT)'); }
      else if (corruption === 'missing-unique') {
        db.run('DROP TABLE native_work_questions');
        db.run('CREATE TABLE native_work_questions (project_id TEXT NOT NULL, attempt_id TEXT NOT NULL, question_id TEXT NOT NULL, question_revision INTEGER NOT NULL, request_id TEXT, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id,attempt_id,question_id,question_revision))');
      } else if (corruption === 'invalid-json') db.run("UPDATE native_work_questions SET state_json='{}'");
      else if (corruption === 'orphan') { db.run('DELETE FROM native_work_executions'); db.run('DELETE FROM native_work_execution_intents'); }
      else if (corruption === 'foreign-project') db.run("UPDATE native_work_questions SET project_id='other-project'");
      else if (corruption === 'wrong-request-column') db.run("UPDATE native_work_questions SET request_id='invented-receipt'");
      else {
        const question = structuredClone(f.question);
        if (corruption === 'wrong-admission') (question.admission as { contractId: string }).contractId = 'ctr-other';
        else (question.identity.expectedRevision as { work: number }).work++;
        db.run('UPDATE native_work_questions SET state_json=?', [JSON.stringify(question)]);
      }
    });
    const before = fs.readFileSync(f.file);
    expect(() => f.storage.current(f.identity)).toThrow();
    await expect(harness.open(f.file)).rejects.toThrow(); expect(fs.readFileSync(f.file)).toEqual(before);
  });
}

for (const field of ['ownerAgentId', 'payloadRevision', 'authorityId', 'authorityRevision', 'scopeId', 'scopeRevision'] as const) {
  test(`persisted question ${field} must match the exact existing native admission`, async () => {
    const f = await harness.fixture();
    await mutateQuestionImage(f.file, db => {
      const question = { ...f.question, admission: { ...f.question.admission, [field]: field === 'ownerAgentId' ? 'foreign-agent' : 'f'.repeat(64) } };
      db.run('UPDATE native_work_questions SET state_json=?', [JSON.stringify(question)]);
    });
    const before = fs.readFileSync(f.file);
    expect(() => f.storage.current(f.identity)).toThrow('invalid');
    await expect(harness.open(f.file)).rejects.toThrow('invalid'); expect(fs.readFileSync(f.file)).toEqual(before);
  });
}

test('question creation cannot manufacture a missing runner admission receipt', async () => {
  const f = await harness.fixture({ seed: false });
  await mutateQuestionImage(f.file, db => db.run('UPDATE native_work_executions SET state_json=?', [JSON.stringify({ ...f.record, state: 'prepared', receipt: null })]));
  const before = fs.readFileSync(f.file), fresh = await harness.open(f.file);
  await expect(seedQuestion(fresh.storage, f.question)).rejects.toMatchObject({ code: 'invalid' });
  expect(fs.readFileSync(f.file)).toEqual(before);
});

test('old binaries and already-open schema7 writers cannot erase schema8 question storage', async () => {
  const f = await harness.fixture({ seed: false }); await f.store.close();
  await mutateQuestionImage(f.file, db => { db.run('DROP TABLE native_work_questions'); db.run('PRAGMA user_version=7'); });
  const old = new SQLiteStore(f.file, { coordinated: true }); await old.init(() => {}, { schemaVersion: 7 });
  const upgraded = await harness.open(f.file); await seedQuestion(upgraded.storage, f.question);
  const before = fs.readFileSync(f.file);
  old.run('UPDATE work_ledgers SET revision=999');
  await expect(old.save()).rejects.toThrow('persisted state changed');
  expect(() => old.readPersisted(() => true)).toThrow('persisted schema changed'); old.close();
  const older = new SQLiteStore(f.file);
  await expect(older.init(() => {}, { schemaVersion: 7 })).rejects.toThrow('newer version'); older.close();
  expect(fs.readFileSync(f.file)).toEqual(before);
});

test('current schema does not silently repair a missing question table through base-schema creation', async () => {
  const f = await harness.fixture(); await f.store.close();
  await mutateQuestionImage(f.file, db => { db.run('DROP TABLE native_work_questions'); });
  const before = fs.readFileSync(f.file);
  await expect(harness.open(f.file)).rejects.toThrow(); expect(fs.readFileSync(f.file)).toEqual(before);
  // Creation is kept explicit for trusted migration fixtures, never a read-time repair.
  await mutateQuestionImage(f.file, createNativeQuestionTable);
  expect((await harness.open(f.file)).storage.current(f.identity).question).toBeNull();
});
