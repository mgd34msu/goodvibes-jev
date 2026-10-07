/** Inert native question foundation; all rows share the existing coordinated image. */
import { isDeepStrictEqual } from 'node:util';
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import { readNativeWorkExecutionTransaction } from './store-native-work-execution.js';
import { readWorkLedgerState } from '../workflow/work-ledger/service.js';
import { NativeQuestionError, parseNativeQuestionIdentity, parseNativeQuestionRecord, acceptNativeQuestionReply,
  type NativeQuestionIdentity, type NativeQuestionRecord } from '../workflow/work-ledger/native-question-types.js';
import type { NativeQuestionStorage, NativeQuestionTransaction } from '../workflow/work-ledger/native-question.js';

type Reader = Pick<SqlDatabase, 'exec'>;
const fields = 'project_id, attempt_id, question_id, question_revision, request_id, format_version, state_json';
export function createNativeQuestionTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_work_questions (project_id TEXT NOT NULL, attempt_id TEXT NOT NULL, question_id TEXT NOT NULL, question_revision INTEGER NOT NULL, request_id TEXT, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, attempt_id, question_id, question_revision), UNIQUE(project_id, request_id))');
}
function parseRow(row: readonly unknown[]): NativeQuestionRecord {
  try {
    const value = parseNativeQuestionRecord(JSON.parse(String(row[6])));
    const identity = value.identity;
    if (row[0] !== identity.projectId || row[1] !== identity.attemptId || row[2] !== identity.questionId || row[3] !== identity.questionRevision
      || row[4] !== (value.answer?.requestId ?? null) || row[5] !== 1) throw new Error();
    return value;
  } catch { throw new NativeQuestionError('invalid'); }
}
function associated(db: Reader, question: NativeQuestionRecord): NativeQuestionTransaction['execution'] {
  const execution = readNativeWorkExecutionTransaction(db, question.identity.projectId, { attemptId: question.identity.attemptId });
  const record = execution.record, receipt = record?.receipt, target = record?.target, binding = record?.request.binding;
  const identity = question.identity, admission = question.admission;
  if (!record || !receipt || !target || !binding || identity.workId !== target.workId || identity.attemptId !== target.attemptId
    || identity.expectedRevision.work !== target.workRevision || identity.expectedRevision.criteria !== target.criteriaRevision
    || identity.expectedRevision.attempt !== target.attemptRevision || admission.contractId !== receipt.contractId
    || admission.ownerAgentId !== receipt.ownerAgentId || admission.payloadRevision !== receipt.payloadRevision
    || admission.authorityId !== binding.authorityId || admission.authorityRevision !== binding.authorityRevision
    || admission.scopeId !== binding.scopeId || admission.scopeRevision !== binding.scopeRevision) throw new NativeQuestionError('invalid');
  return execution;
}
export function validateNativeQuestionTable(db: Reader): void {
  const expected = [['project_id', 'TEXT', 1, 1], ['attempt_id', 'TEXT', 1, 2], ['question_id', 'TEXT', 1, 3], ['question_revision', 'INTEGER', 1, 4], ['request_id', 'TEXT', 0, 0], ['format_version', 'INTEGER', 1, 0], ['state_json', 'TEXT', 1, 0]];
  const columns = db.exec('PRAGMA table_info(native_work_questions)')[0]?.values;
  if (!columns || columns.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = columns.find(value => value[1] === name); return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new NativeQuestionError('invalid');
  const indexes = db.exec('PRAGMA index_list(native_work_questions)')[0]?.values ?? [];
  if (!indexes.some(index => index[2] === 1 && index[4] === 0 && isDeepStrictEqual(
    db.exec(`PRAGMA index_info('${String(index[1]).replaceAll("'", "''")}')`)[0]?.values.map(row => row[2]), ['project_id', 'request_id']))) throw new NativeQuestionError('invalid');
  for (const row of db.exec(`SELECT ${fields} FROM native_work_questions`)[0]?.values ?? []) associated(db, parseRow(row));
}
function validatePriorAuthorities(db: Reader): void {
  for (const row of db.exec('SELECT project_id,format_version,revision,state_json FROM work_ledgers')[0]?.values ?? []) {
    const ledger = readWorkLedgerState(JSON.parse(String(row[3])), String(row[0]));
    if (row[1] !== ledger.version || row[2] !== ledger.revision) throw new NativeQuestionError('invalid');
  }
  for (const row of db.exec('SELECT project_id,attempt_id FROM native_work_executions')[0]?.values ?? [])
    readNativeWorkExecutionTransaction(db, String(row[0]), { attemptId: String(row[1]) });
}
/** DB7 contains no question authority. Never adopt pre-seeded authority on migration. */
export function migrateNativeQuestionTable(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  validatePriorAuthorities(db);
  if ((db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='native_work_questions' COLLATE NOCASE")[0]?.values.length ?? 0) !== 0) throw new NativeQuestionError('invalid');
  createNativeQuestionTable(db); validateNativeQuestionTable(db);
}
function read(db: Reader, identity: NativeQuestionIdentity): NativeQuestionTransaction {
  const rows = db.exec(`SELECT ${fields} FROM native_work_questions WHERE project_id=? AND attempt_id=? AND question_id=? AND question_revision=?`,
    [identity.projectId, identity.attemptId, identity.questionId, identity.questionRevision])[0]?.values ?? [];
  if (rows.length > 1) throw new NativeQuestionError('invalid');
  const question = rows[0] ? parseRow(rows[0]) : null;
  if (question && !isDeepStrictEqual(question.identity, identity)) throw new NativeQuestionError('stale');
  return { question, execution: question ? associated(db, question) : readNativeWorkExecutionTransaction(db, identity.projectId, { attemptId: identity.attemptId }) };
}
function transition(before: NativeQuestionRecord | null, after: NativeQuestionRecord): void {
  if (!before) { if (after.state !== 'open' || after.answer !== null) throw new NativeQuestionError('conflict'); return; }
  if (!isDeepStrictEqual({ ...before, state: after.state, answer: after.answer }, after)) throw new NativeQuestionError('conflict');
  if (isDeepStrictEqual(before, after)) return;
  if (before.state !== 'open') throw new NativeQuestionError('conflict');
  if (after.state === 'answered' && after.answer) {
    const reduced = acceptNativeQuestionReply(before, { ...after.identity, requestId: after.answer.requestId, answer: after.answer.answer });
    if (!isDeepStrictEqual(reduced.next, after)) throw new NativeQuestionError('conflict');
  } else if (!['cancelled', 'superseded'].includes(after.state) || after.answer !== null) throw new NativeQuestionError('conflict');
}
export function createNativeQuestionStorage(sqlite: SQLiteStore, projectId: string, refresh: () => void): NativeQuestionStorage {
  let closed = false;
  const pending = new Set<Promise<NativeQuestionRecord>>();
  function capture(input: NativeQuestionIdentity) {
    if (closed) throw new NativeQuestionError('closed');
    const identity = parseNativeQuestionIdentity(input);
    if (identity.projectId !== projectId) throw new NativeQuestionError('stale');
    return identity;
  }
  return {
    current(input) { const identity = capture(input); return sqlite.readPersisted(db => read(db, identity)); },
    transaction(input, decide, assertCurrent) {
      const identity = capture(input);
      const operation = sqlite.transactPersisted(db => {
        assertCurrent();
        const current = read(db, identity);
        const result = decide(structuredClone(current));
        if (!result || typeof (result as unknown as { then?: unknown }).then === 'function') {
          if (result instanceof Promise) void result.catch(() => {});
          throw new NativeQuestionError('invalid');
        }
        const next = result.next === null ? null : parseNativeQuestionRecord(result.next);
        const value = parseNativeQuestionRecord(result.value);
        if (!isDeepStrictEqual(next ?? current.question, value)) throw new NativeQuestionError('invalid');
        if (next) {
          if (!isDeepStrictEqual(identity, next.identity)) throw new NativeQuestionError('stale');
          associated(db, next); transition(current.question, next);
          if (!current.question && (current.execution.record?.state !== 'launch-claimed' || current.execution.intent?.state !== 'associated')) throw new NativeQuestionError('stale');
          if (!current.question) {
            const prior = db.exec(`SELECT ${fields} FROM native_work_questions WHERE project_id=? AND attempt_id=? AND question_id=?`,
              [projectId, identity.attemptId, identity.questionId])[0]?.values ?? [];
            if (prior.some(row => { const previous = parseRow(row); return previous.state === 'open' || previous.identity.questionRevision >= identity.questionRevision; })) throw new NativeQuestionError('conflict');
          }
          if (next.answer) {
            const prior = db.exec(`SELECT ${fields} FROM native_work_questions WHERE project_id=? AND request_id=?`, [projectId, next.answer.requestId])[0]?.values[0];
            if (prior && !isDeepStrictEqual(parseRow(prior).identity, identity)) throw new NativeQuestionError('conflict');
          }
          db.run('INSERT INTO native_work_questions(project_id,attempt_id,question_id,question_revision,request_id,format_version,state_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,attempt_id,question_id,question_revision) DO UPDATE SET request_id=excluded.request_id,state_json=excluded.state_json',
            [projectId, identity.attemptId, identity.questionId, identity.questionRevision, next.answer?.requestId ?? null, 1, JSON.stringify(next)]);
        }
        assertCurrent();
        return { changed: next !== null, value };
      }, refresh).then(result => {
        if (result.kind !== 'completed') throw new NativeQuestionError('unavailable');
        return result.value;
      });
      pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    async close() { closed = true; await Promise.allSettled([...pending]); },
  };
}
