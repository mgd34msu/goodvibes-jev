/** Durable conversation capture in the same coordinated image as its native ledger publication. */
import { isDeepStrictEqual } from 'node:util';
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import { createEmptyWorkLedgerState, readWorkLedgerState } from '../workflow/work-ledger/service.js';
import type { WorkLedgerState, WorkLedgerSubmission } from '../workflow/work-ledger/types.js';
import {
  NativeConversationStorageError, parseNativeConversationCapture, nativeConversationProposalRevision, nativeConversationDecisionBinding,
  type NativeConversationCapture, type NativeConversationKey, type NativeConversationMutation, type NativeConversationStorage,
} from '../workflow/work-ledger/native-intake-types.js';
import { createKnowledgeWorkLedgerStorage, readKnowledgeWorkLedger } from './store-work-ledger.js';

type SqlReader = Pick<SqlDatabase, 'exec'>;
export function createNativeConversationCaptureTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_conversation_captures (project_id TEXT NOT NULL, principal_id TEXT NOT NULL, input_id TEXT NOT NULL, request_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, principal_id, input_id), UNIQUE(project_id, principal_id, request_id))');
}
export function validateNativeConversationCaptureTable(db: SqlReader): void {
  const expected = [['project_id', 'TEXT', 1, 1], ['principal_id', 'TEXT', 1, 2], ['input_id', 'TEXT', 1, 3], ['request_id', 'TEXT', 1, 0], ['format_version', 'INTEGER', 1, 0], ['state_json', 'TEXT', 1, 0]];
  const rows = db.exec('PRAGMA table_info(native_conversation_captures)')[0]?.values;
  if (!rows || rows.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = rows.find(value => value[1] === name); return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new NativeConversationStorageError('invalid');
  const indexes = db.exec('PRAGMA index_list(native_conversation_captures)')[0]?.values ?? [];
  if (!indexes.some(index => index[2] === 1 && index[4] === 0
    && isDeepStrictEqual(db.exec(`PRAGMA index_info('${String(index[1]).replaceAll("'", "''")}')`)[0]?.values.map(row => row[2]), ['project_id', 'principal_id', 'request_id']))) throw new NativeConversationStorageError('invalid');
  for (const row of db.exec('SELECT project_id, principal_id, input_id, request_id, format_version, state_json FROM native_conversation_captures')[0]?.values ?? []) {
    const capture = parseRow(row); validateAssociation(db, capture);
  }
  for (const row of db.exec('SELECT project_id, state_json FROM work_ledgers')[0]?.values ?? []) {
    const raw = JSON.parse(String(row[1])) as Partial<WorkLedgerState>;
    if (!Array.isArray(raw.history) || !raw.history.some(event => event?.type === 'submit_native' && event.work?.source?.version === 2)) continue;
    const ledger = readWorkLedgerState(raw, String(row[0]));
    for (const event of ledger.history) {
      if (event.type !== 'submit_native' || event.work.source?.version !== 2) continue;
      const capture = read(db, ledger.projectId, { principalId: event.actorId, inputId: event.work.source.inputId });
      if (!capture?.association || capture.association.ledgerRevision !== event.sequence) throw new NativeConversationStorageError('invalid');
    }
  }
}
/** Validate all DB5 authorities before adding the new table and schema epoch. */
export function migrateNativeConversationCaptureTable(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  for (const row of db.exec('SELECT project_id, format_version, revision, state_json FROM work_ledgers')[0]?.values ?? []) {
    if (typeof row[0] !== 'string' || row[1] !== 2 || typeof row[3] !== 'string') throw new NativeConversationStorageError('invalid');
    const ledger = readWorkLedgerState(JSON.parse(row[3]), row[0]);
    if (ledger.revision !== row[2] || ledger.works.some(work => work.source?.version === 2)) throw new NativeConversationStorageError('invalid');
  }
  if ((db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='native_conversation_captures'")[0]?.values.length ?? 0) > 0
    && (db.exec('SELECT input_id FROM native_conversation_captures LIMIT 1')[0]?.values.length ?? 0) > 0) throw new NativeConversationStorageError('invalid');
  createNativeConversationCaptureTable(db);
  validateNativeConversationCaptureTable(db);
}
function parseRow(row: readonly unknown[]): NativeConversationCapture {
  try {
    if (row[4] !== 1 || typeof row[5] !== 'string') throw new Error();
    const value = parseNativeConversationCapture(JSON.parse(row[5]));
    if (row[0] !== value.projectId || row[1] !== value.principalId || row[2] !== value.inputId || row[3] !== value.requestId) throw new Error();
    return value;
  } catch { throw new NativeConversationStorageError('invalid'); }
}
function keySnapshot(key: NativeConversationKey): NativeConversationKey {
  if (!key || typeof key.principalId !== 'string' || !key.principalId || key.principalId.length > 200
    || typeof key.inputId !== 'string' || !key.inputId || key.inputId.length > 200) throw new NativeConversationStorageError('invalid');
  return { principalId: key.principalId, inputId: key.inputId };
}
function read(db: SqlReader, projectId: string, key: NativeConversationKey): NativeConversationCapture | null {
  const row = db.exec('SELECT project_id, principal_id, input_id, request_id, format_version, state_json FROM native_conversation_captures WHERE project_id = ? AND principal_id = ? AND input_id = ?', [projectId, key.principalId, key.inputId])[0]?.values[0];
  if (!row) return null;
  const capture = parseRow(row); validateAssociation(db, capture); return capture;
}
function assertPublication(capture: NativeConversationCapture, event: WorkLedgerSubmission): void {
  const source = event.work.source, final = capture.decisions.at(-1);
  if (capture.route !== 'contract' || capture.unsupportedSources.length > 0 || event.actorId !== capture.principalId || event.requestId !== capture.requestId || source.version !== 2
    || source.sourceId !== capture.sourceId || source.sourceRevision !== capture.sourceRevision || source.inputId !== capture.inputId || source.sessionId !== capture.sessionId
    || event.work.goal !== capture.text || !capture.proposal || !final || final.decision.outcome !== 'act'
    || !isDeepStrictEqual(final.decision.binding, nativeConversationDecisionBinding(capture, 'publish-work'))
    || source.extraction.admissionDecisionId !== final.decision.decisionId
    || !isDeepStrictEqual(source.extraction.judgmentDecisionIds, final.decision.judgmentDecisionIds)
    || !isDeepStrictEqual(source.extraction.spans, capture.proposal.spans)
    || source.extraction.proposalRevision !== nativeConversationProposalRevision(capture.proposal)
    || !isDeepStrictEqual(event.work.criteria, capture.proposal.spans.map(span => capture.text.slice(span.start, span.end)))
    || !event.attemptId || event.attempts.length !== 1 || event.attempts[0]?.id !== event.attemptId
    || event.attempts[0]?.ownerId !== capture.principalId || event.attempts[0]?.state !== 'active') throw new NativeConversationStorageError('invalid');
}
function validateAssociation(db: SqlReader, capture: NativeConversationCapture): void {
  if (!capture.association) return;
  const ledger = readKnowledgeWorkLedger(db, capture.projectId);
  const event = ledger.history[capture.association.ledgerRevision - 1];
  if (!event || event.type !== 'submit_native' || event.work.source?.version !== 2 || !event.attemptId
    || event.workId !== capture.association.workId || event.attemptId !== capture.association.attemptId
    || event.sequence !== capture.association.ledgerRevision) throw new NativeConversationStorageError('invalid');
  assertPublication(capture, event as WorkLedgerSubmission);
}
function immutable(capture: NativeConversationCapture): unknown {
  const { generation: _generation, state: _state, stage: _stage, route: _route, reason: _reason,
    proposalsSpent: _spent, proposal: _proposal, decisions: _decisions, association: _association, ...facts } = capture;
  return facts;
}
function validateTransition(current: NativeConversationCapture | null, next: NativeConversationCapture, publication = false): void {
  if (!current) {
    if (next.generation !== 1 || !['captured', 'cancelled'].includes(next.state) || next.proposalsSpent !== 0 || next.proposal || next.decisions.length || next.association) throw new NativeConversationStorageError('conflict');
    return;
  }
  if (!isDeepStrictEqual(immutable(current), immutable(next))) throw new NativeConversationStorageError('conflict');
  if (current.state === 'cancelled' && !isDeepStrictEqual(current, next)) throw new NativeConversationStorageError('cancelled');
  if (['blocked', 'refused'].includes(current.state) && next.state !== 'cancelled' && !isDeepStrictEqual(current, next)) throw new NativeConversationStorageError('conflict');
  if (current.state !== 'cancelled' && next.state === 'cancelled' && (next.generation !== current.generation + 1
    || !isDeepStrictEqual({ ...current, generation: next.generation, state: 'cancelled', stage: null }, next))) throw new NativeConversationStorageError('conflict');
  if ((current.state === 'associated' || current.state === 'turn') && !isDeepStrictEqual(current, next)) throw new NativeConversationStorageError('conflict');
  if (next.generation !== current.generation && (next.generation !== current.generation + 1
    || (next.state !== 'cancelled' && (next.state !== 'processing' || !['captured', 'processing'].includes(current.state))))) throw new NativeConversationStorageError('conflict');
  if (next.state === 'captured' && current.state !== 'captured') throw new NativeConversationStorageError('conflict');
  if (['blocked', 'refused'].includes(current.state) && ![current.state, 'cancelled'].includes(next.state)) throw new NativeConversationStorageError('conflict');
  if (current.state === 'captured' && !['captured', 'processing', 'cancelled'].includes(next.state)) throw new NativeConversationStorageError('conflict');
  if (current.state !== 'processing' && next.state === 'processing' && next.generation === current.generation) throw new NativeConversationStorageError('conflict');
  if (next.proposalsSpent < current.proposalsSpent || next.proposalsSpent > current.proposalsSpent + 1
    || next.decisions.length < current.decisions.length || next.decisions.length > current.decisions.length + 1
    || !isDeepStrictEqual(next.decisions.slice(0, current.decisions.length), current.decisions)) throw new NativeConversationStorageError('conflict');
  if (!isDeepStrictEqual(current.association, next.association) && !(publication && !current.association && next.state === 'associated')) throw new NativeConversationStorageError('conflict');
  if (next.state === 'associated' && current.state !== 'associated' && (!publication || current.state !== 'processing')) throw new NativeConversationStorageError('conflict');
}
function write(db: Pick<SqlDatabase, 'exec' | 'run'>, projectId: string, key: NativeConversationKey, current: NativeConversationCapture | null, next: NativeConversationCapture, publication = false): void {
  if (next.projectId !== projectId || next.principalId !== key.principalId || next.inputId !== key.inputId) throw new NativeConversationStorageError('invalid');
  validateTransition(current, next, publication);
  const duplicate = db.exec('SELECT input_id FROM native_conversation_captures WHERE project_id = ? AND principal_id = ? AND request_id = ?', [projectId, key.principalId, next.requestId])[0]?.values[0];
  if (duplicate && duplicate[0] !== key.inputId) throw new NativeConversationStorageError('conflict');
  db.run('INSERT INTO native_conversation_captures(project_id, principal_id, input_id, request_id, format_version, state_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, principal_id, input_id) DO UPDATE SET state_json=excluded.state_json', [projectId, key.principalId, key.inputId, next.requestId, 1, JSON.stringify(next)]);
}
function synchronous(value: unknown): void {
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    if (value instanceof Promise) void value.catch(() => {});
    throw new NativeConversationStorageError('invalid');
  }
}
export function createNativeConversationStorage(sqlite: SQLiteStore, projectId: string, refresh: () => void): NativeConversationStorage {
  createEmptyWorkLedgerState(projectId);
  let closed = false, closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const publishers = new Set<ReturnType<typeof createKnowledgeWorkLedgerStorage>>();
  function assertOpen() { if (closed) throw new NativeConversationStorageError('closed'); }
  function track<T>(work: Promise<T>): Promise<T> { pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work; }
  return {
    current(key) { assertOpen(); const lookup = keySnapshot(key); return sqlite.readPersisted(db => read(db, projectId, lookup)); },
    transaction<T>(key: NativeConversationKey, decide: (current: NativeConversationCapture | null) => NativeConversationMutation<T>): Promise<T> {
      assertOpen(); const lookup = keySnapshot(key);
      return track(sqlite.transactPersisted(db => {
        const current = read(db, projectId, lookup), result = decide(structuredClone(current)); synchronous(result);
        if (!result || !Object.hasOwn(result, 'next')) throw new NativeConversationStorageError('invalid');
        const next = result.next === null ? null : parseNativeConversationCapture(result.next);
        if (next) write(db, projectId, lookup, current, next);
        return { changed: next !== null && !isDeepStrictEqual(next, current), value: result.value };
      }, refresh).then(result => { if (result.kind !== 'completed') throw new NativeConversationStorageError('unavailable'); return result.value; }));
    },
    publicationStorage(key, assertCurrent, finish) {
      assertOpen(); const lookup = keySnapshot(key);
      const publisher = createKnowledgeWorkLedgerStorage(sqlite, projectId, refresh, {
        beforeDecision(db) {
          const current = read(db, projectId, lookup);
          if (!current) throw new NativeConversationStorageError('not-found');
          if (current.state === 'cancelled') throw new NativeConversationStorageError('cancelled');
          synchronous(assertCurrent(structuredClone(current)));
        },
        beforeCommit(db, currentLedger: WorkLedgerState, nextLedger: WorkLedgerState) {
          const current = read(db, projectId, lookup);
          if (!current || current.state !== 'processing') throw new NativeConversationStorageError('conflict');
          if (nextLedger.revision !== currentLedger.revision + 1 || nextLedger.history.length !== currentLedger.history.length + 1) throw new NativeConversationStorageError('invalid');
          const event = nextLedger.history.at(-1);
          if (event?.type !== 'submit_native' || !event.attemptId || event.work.source?.version !== 2) throw new NativeConversationStorageError('invalid');
          // The full ordinary reducer replay is already validated by the ledger adapter.
          const nextValue = finish(structuredClone(current), structuredClone(event) as WorkLedgerSubmission); synchronous(nextValue);
          const next = parseNativeConversationCapture(nextValue);
          if (next.state !== 'associated' || next.generation !== current.generation
            || next.proposalsSpent !== current.proposalsSpent || !isDeepStrictEqual(next.proposal, current.proposal) || !isDeepStrictEqual(next.decisions, current.decisions)
            || !isDeepStrictEqual(next.association, { workId: event.workId, attemptId: event.attemptId, ledgerRevision: event.sequence })) throw new NativeConversationStorageError('invalid');
          assertPublication(next, event as WorkLedgerSubmission);
          synchronous(assertCurrent(structuredClone(current)));
          write(db, projectId, lookup, current, next, true);
        },
      });
      publishers.add(publisher);
      return { read: () => { assertOpen(); return publisher.read(); }, transaction: decide => { assertOpen(); return publisher.transaction(decide); },
        subscribe: listener => { assertOpen(); return publisher.subscribe(listener); }, close: () => publisher.close().then(() => { publishers.delete(publisher); }) };
    },
    close() { closed = true; return closing ??= Promise.allSettled([...pending, ...[...publishers].map(publisher => publisher.close())]).then(() => {}); },
  };
}
