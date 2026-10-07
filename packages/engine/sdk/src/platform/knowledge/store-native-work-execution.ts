import { nativeSettlementDigest, nativeWorkAttestationSchema, nativeWorkSettlementSchema, type NativeWorkSettlementReceipt } from '../workflow/work-ledger/native-settlement-types.js';
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import { durableKeyHash, durablePayloadRevision, type DurableContractKey } from '../contract/durable-admission.js';
import { readWorkLedgerState, createEmptyWorkLedgerState, reduceWorkLedgerSettlement } from '../workflow/work-ledger/service.js';
import { NativeWorkExecutionError, parseNativeWorkExecutionRecord, parseNativeWorkExecutionIntent, type NativeWorkExecutionIntent, type NativeWorkExecutionRecord, type NativeWorkExecutionMutation, type NativeWorkExecutionStorage, type NativeWorkExecutionTransaction } from '../workflow/work-ledger/native-execution-types.js';

type Lookup = DurableContractKey | { readonly attemptId: string };
type SqlReader = Pick<SqlDatabase, 'exec'>;
export function createNativeWorkExecutionTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_work_executions (project_id TEXT NOT NULL, key_hash TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, attempt_id TEXT NOT NULL, PRIMARY KEY(project_id, key_hash), UNIQUE(project_id, attempt_id))');
}
export function createNativeWorkExecutionIntentTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_work_execution_intents (project_id TEXT NOT NULL, attempt_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, attempt_id))');
}
/** DB settlement migration composes after the intake schema. Existing execution/intent formats are unchanged. */
export function createNativeWorkSettlementTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_work_execution_settlements (project_id TEXT NOT NULL, key_hash TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, key_hash))');
}
export function validateNativeWorkSettlementTable(db: SqlReader): void {
  validateColumns(db, 'native_work_execution_settlements', [['project_id', 'TEXT', 1, 1], ['key_hash', 'TEXT', 1, 2], ['format_version', 'INTEGER', 1, 0], ['state_json', 'TEXT', 1, 0]]);
  for (const row of db.exec('SELECT project_id, key_hash, format_version, state_json FROM native_work_execution_settlements')[0]?.values ?? []) {
    const receipt = nativeWorkSettlementSchema.parse(JSON.parse(String(row[3])));
    if (row[0] !== receipt.projectId || row[1] !== receipt.keyHash || row[2] !== 1) throw new NativeWorkExecutionError('invalid');
    const current = read(db, receipt.projectId, { attemptId: receipt.target.attemptId });
    if (!current.settlement || nativeSettlementDigest(current.settlement) !== nativeSettlementDigest(receipt)) throw new NativeWorkExecutionError('invalid');
  }
}
/** Validate every existing authority row before admitting the additive schema. */
export function migrateNativeWorkSettlementTable(db: Pick<SqlDatabase, 'exec' | 'run'>): void {
  for (const row of db.exec('SELECT project_id,format_version,revision,state_json FROM work_ledgers')[0]?.values ?? []) {
    const ledger = readWorkLedgerState(JSON.parse(String(row[3])), String(row[0]));
    if (row[1] !== ledger.version || row[2] !== ledger.revision) throw new NativeWorkExecutionError('invalid');
  }
  validateNativeWorkExecutionTable(db); validateNativeWorkExecutionIntentTable(db);
  createNativeWorkSettlementTable(db); validateNativeWorkSettlementTable(db);
  for (const row of db.exec('SELECT project_id,attempt_id FROM native_work_executions')[0]?.values ?? []) read(db, String(row[0]), { attemptId: String(row[1]) });
}
function validateColumns(db: SqlReader, table: string, expected: readonly (readonly (string | number)[])[]): void {
  const rows = db.exec(`PRAGMA table_info(${table})`)[0]?.values;
  if (!rows || rows.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = rows.find(value => value[1] === name); return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new NativeWorkExecutionError('invalid');
}
export function validateNativeWorkExecutionTable(db: SqlReader): void {
  validateColumns(db, 'native_work_executions', [['project_id', 'TEXT', 1, 1], ['key_hash', 'TEXT', 1, 2], ['format_version', 'INTEGER', 1, 0], ['state_json', 'TEXT', 1, 0], ['attempt_id', 'TEXT', 1, 0]]);
  // A same-shaped table without attempt uniqueness is not an execution authority.
  const indexes = db.exec('PRAGMA index_list(native_work_executions)')[0]?.values ?? [];
  if (!indexes.some(index => index[2] === 1 && index[4] === 0
    && JSON.stringify(db.exec(`PRAGMA index_info('${String(index[1]).replaceAll("'", "''")}')`)[0]?.values.map(row => row[2])) === JSON.stringify(['project_id', 'attempt_id']))) throw new NativeWorkExecutionError('invalid');
}
export function validateNativeWorkExecutionIntentTable(db: SqlReader): void {
  validateColumns(db, 'native_work_execution_intents', [['project_id', 'TEXT', 1, 1], ['attempt_id', 'TEXT', 1, 2], ['format_version', 'INTEGER', 1, 0], ['state_json', 'TEXT', 1, 0]]);
  for (const row of db.exec('SELECT project_id, attempt_id, format_version, state_json FROM native_work_execution_intents')[0]?.values ?? []) {
    const intent = parseNativeWorkExecutionIntent(JSON.parse(String(row[3])));
    if (row[0] !== intent.projectId || row[1] !== intent.target.attemptId || row[2] !== 1) throw new NativeWorkExecutionError('invalid');
  }
}
function readRecord(db: SqlReader, projectId: string, key: Lookup): NativeWorkExecutionRecord | null {
  const keyHash = 'workId' in key ? durableKeyHash(key) : null;
  const rows = db.exec(`SELECT format_version, state_json, attempt_id, key_hash FROM native_work_executions WHERE project_id = ? AND ${keyHash === null ? 'attempt_id' : 'key_hash'} = ?`, [projectId, keyHash ?? key.attemptId])[0]?.values ?? [];
  if (rows.length > 1) throw new NativeWorkExecutionError('invalid');
  const row = rows[0];
  const record = row ? parseNativeWorkExecutionRecord(JSON.parse(String(row[1]))) : null;
  if (record && (row?.[0] !== 1 || row?.[2] !== record.target.attemptId || record.target.attemptId !== key.attemptId || record.projectId !== projectId || durableKeyHash(record.request.key) !== row?.[3] || (keyHash !== null && row?.[3] !== keyHash))) throw new NativeWorkExecutionError('invalid');
  return record;
}
const sameScopes = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((scope, index) => scope === [...b].sort()[index]);
function sameFacts(a: NativeWorkExecutionIntent | NativeWorkExecutionRecord, b: NativeWorkExecutionIntent | NativeWorkExecutionRecord): boolean {
  return a.projectId === b.projectId && durablePayloadRevision(a.request) === durablePayloadRevision(b.request)
    && Object.keys(a.target).every(key => a.target[key as keyof typeof a.target] === b.target[key as keyof typeof b.target]) && sameScopes(a.authorityScopes, b.authorityScopes);
}
function read(db: SqlReader, projectId: string, key: Lookup): NativeWorkExecutionTransaction {
  const ledgerRow = db.exec('SELECT format_version, revision, state_json FROM work_ledgers WHERE project_id = ?', [projectId])[0]?.values[0];
  const ledger = ledgerRow ? readWorkLedgerState(JSON.parse(String(ledgerRow[2])), projectId) : createEmptyWorkLedgerState(projectId);
  if (ledgerRow && (ledgerRow[0] !== ledger.version || ledgerRow[1] !== ledger.revision)) throw new NativeWorkExecutionError('invalid');
  const record = readRecord(db, projectId, key);
  const rows = db.exec('SELECT format_version, state_json FROM native_work_execution_intents WHERE project_id = ? AND attempt_id = ?', [projectId, key.attemptId])[0]?.values ?? [];
  if (rows.length > 1) throw new NativeWorkExecutionError('invalid');
  const row = rows[0];
  const intent = row ? parseNativeWorkExecutionIntent(JSON.parse(String(row[1]))) : null;
  if (intent && (row?.[0] !== 1 || intent.projectId !== projectId || intent.target.attemptId !== key.attemptId)) throw new NativeWorkExecutionError('invalid');
  if (intent && record && (!sameFacts(intent, record) || !['associated', 'cancelled'].includes(intent.state) || (intent.state === 'cancelled' && record.state !== 'cancelled'))) throw new NativeWorkExecutionError('invalid');
  // An associated intent with a missing execution is preserved for explicit host recovery.
  const settlementRow = record ? db.exec('SELECT format_version,state_json FROM native_work_execution_settlements WHERE project_id = ? AND key_hash = ?', [projectId, durableKeyHash(record.request.key)])[0]?.values[0] : undefined;
  const settlement = settlementRow ? nativeWorkSettlementSchema.parse(JSON.parse(String(settlementRow[1]))) : null;
  if (settlement) {
    if (!record?.receipt || settlementRow?.[0] !== 1 || settlement.projectId !== projectId || settlement.keyHash !== durableKeyHash(record.request.key)
      || settlement.receiptDigest !== nativeSettlementDigest(record.receipt) || settlement.payloadRevision !== durablePayloadRevision(record.request)
      || nativeSettlementDigest(settlement.target) !== nativeSettlementDigest(record.target) || settlement.contractId !== record.receipt.contractId
      || settlement.evidenceSequence !== settlement.reportSequence + 1) throw new NativeWorkExecutionError('invalid');
    const report = ledger.history[settlement.reportSequence - 1]; const evidence = ledger.history[settlement.evidenceSequence - 1];
    if (!report || report.type !== 'report' || report.requestId !== settlement.reportRequestId || report.workId !== record.target.workId
      || !evidence || evidence.type !== 'record_evidence' || evidence.requestId !== settlement.evidenceRequestId || evidence.evidence?.id !== settlement.evidenceId
      || nativeSettlementDigest(evidence.evidence.target) !== nativeSettlementDigest(settlement.targetAfterReport)
      || nativeSettlementDigest({ outcome: evidence.evidence.outcome, reason: evidence.evidence.reason, references: evidence.evidence.references, source: evidence.evidence.source, criteriaResults: evidence.evidence.criteriaResults }) !== nativeSettlementDigest(settlement.attestation)
      || settlement.targetAfterReport.workRevision !== record.target.workRevision + 1 || settlement.targetAfterReport.attemptRevision !== record.target.attemptRevision + 1
      || settlement.targetAfterReport.criteriaRevision !== record.target.criteriaRevision || settlement.targetAfterReport.workId !== record.target.workId || settlement.targetAfterReport.attemptId !== record.target.attemptId
      || report.actorId !== evidence.actorId || report.requestId !== `native-report:${settlement.keyHash}` || evidence.requestId !== `native-evidence:${settlement.keyHash}`
      || settlement.evidenceId !== `native-evidence-${settlement.keyHash}` || settlement.attestation.source !== 'host_check'
      || settlement.attestation.criteriaResults.length !== record.request.input.nativeSource!.criteria.length || settlement.attestation.criteriaResults.some((item, index) => item.criterionIndex !== index)
      || !settlement.attestation.references.some(item => item.ref === `execution:${settlement.contractId}` && item.digest === settlement.contractDigest)
      || !settlement.attestation.references.some(item => item.ref === `receipt:${settlement.contractId}` && item.digest === settlement.receiptDigest)
      || report.work.goal !== record.request.input.nativeSource!.goal || JSON.stringify(report.work.criteria) !== JSON.stringify(record.request.input.nativeSource!.criteria)
      || report.work.revision !== settlement.targetAfterReport.workRevision || report.attempts[0]?.revision !== settlement.targetAfterReport.attemptRevision
      || nativeSettlementDigest({ report: report.attempts[0]?.report, attestation: settlement.attestation, receiptDigest: settlement.receiptDigest, contractDigest: settlement.contractDigest, actorId: report.actorId }) !== settlement.publicationDigest) throw new NativeWorkExecutionError('invalid');
  }
  return { ledger, record, intent, settlement };
}
function assertCurrentTarget(current: NativeWorkExecutionTransaction, intent: NativeWorkExecutionIntent): void {
  const target = intent.target;
  const work = current.ledger.works.find(item => item.id === target.workId);
  const attempt = current.ledger.attempts.find(item => item.id === target.attemptId);
  if (!work || !attempt || attempt.workId !== work.id || work.currentAttemptId !== attempt.id
    || work.revision !== target.workRevision || work.criteriaRevision !== target.criteriaRevision || attempt.revision !== target.attemptRevision
    || attempt.state !== 'active' || work.reportedState === 'cancelled' || work.reportedState === 'complete'
    || work.title !== intent.request.input.ask || work.goal !== intent.request.input.nativeSource?.goal
    || JSON.stringify(work.criteria) !== JSON.stringify(intent.request.input.nativeSource.criteria)
    || (work.source !== null && (work.source.sourceId !== intent.request.input.nativeSource.sourceId
      || work.source.sourceRevision !== intent.request.input.nativeSource.sourceRevision
      || work.source.sessionId !== intent.request.input.sessionId))) throw new NativeWorkExecutionError('stale');
}
function validateIntentTransition(current: NativeWorkExecutionTransaction, next: NativeWorkExecutionIntent): void {
  const previous = current.intent;
  if (!previous) {
    if (next.generation !== 1 || !['admitting', 'cancelled'].includes(next.state) || current.record) throw new NativeWorkExecutionError('conflict');
    assertCurrentTarget(current, next);
    return;
  }
  if (!sameFacts(previous, next)) throw new NativeWorkExecutionError('conflict');
  if (previous.state === 'cancelled' && (next.state !== 'cancelled' || next.generation !== previous.generation)) throw new NativeWorkExecutionError('prevented-before-admission');
  if (next.generation !== previous.generation) {
    if (next.generation !== previous.generation + 1 || next.state !== 'admitting' || !['admitting', 'refused'].includes(previous.state)) throw new NativeWorkExecutionError('conflict');
    assertCurrentTarget(current, next);
  } else if ((previous.state === 'associated' && !['associated', 'cancelled'].includes(next.state))
    || (previous.state === 'refused' && !['refused', 'cancelled'].includes(next.state))) throw new NativeWorkExecutionError('conflict');
}
/** One owner and one existing KnowledgeStore database; no observer launches work. */
export function createNativeWorkExecutionStorage(sqlite: SQLiteStore, projectId: string, refresh: () => void): NativeWorkExecutionStorage {
  createEmptyWorkLedgerState(projectId);
  let closed = false; const pending = new Set<Promise<unknown>>(); let closing: Promise<void> | undefined;
  function transaction<T>(key: Lookup, decide: (current: NativeWorkExecutionTransaction) => NativeWorkExecutionMutation<T>, afterDurable?: (value: T, current: () => NativeWorkExecutionTransaction) => void): Promise<T> {
    if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
    const lookup = { ...key };
    if (!lookup.attemptId || typeof lookup.attemptId !== 'string') return Promise.reject(new NativeWorkExecutionError('invalid'));
    const work = sqlite.transactPersisted(db => {
      const current = read(db, projectId, lookup);
      // Callers may construct a mutation from their snapshot but cannot mutate the comparison baseline.
      const result = decide(structuredClone(current));
      if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
        if (result instanceof Promise) void result.catch(() => {});
        throw new NativeWorkExecutionError('invalid');
      }
      if (!result || !('next' in result)) throw new NativeWorkExecutionError('invalid');
      const next = result.next === null ? null : parseNativeWorkExecutionRecord(result.next);
      const nextIntent = result.nextIntent == null ? null : parseNativeWorkExecutionIntent(result.nextIntent);
      for (const item of [next, nextIntent]) {
        if (item && (item.projectId !== projectId || item.target.attemptId !== lookup.attemptId || ('workId' in lookup && durableKeyHash(item.request.key) !== durableKeyHash(lookup)))) throw new NativeWorkExecutionError('invalid');
      }
      const bound = readRecord(db, projectId, { attemptId: lookup.attemptId });
      if (next && bound && durableKeyHash(bound.request.key) !== durableKeyHash(next.request.key)) throw new NativeWorkExecutionError('conflict');
      if (nextIntent && bound && !current.intent) throw new NativeWorkExecutionError('conflict');
      if (nextIntent) validateIntentTransition(current, nextIntent);
      if (nextIntent?.state === 'associated' && current.intent?.state === 'admitting') assertCurrentTarget(current, nextIntent);
      const resultingIntent = nextIntent ?? current.intent;
      const resultingRecord = next ?? current.record;
      if (next && current.record && (!sameFacts(current.record, next) || (current.record.state === 'cancelled' && next.state !== 'cancelled'))) throw new NativeWorkExecutionError('conflict');
      if (next && !current.record && (!nextIntent || nextIntent.state !== 'associated' || current.intent?.state !== 'admitting')) throw new NativeWorkExecutionError(current.intent?.state === 'associated' ? 'recovery-required' : 'conflict');
      if (resultingIntent && resultingRecord && (!sameFacts(resultingIntent, resultingRecord) || !['associated', 'cancelled'].includes(resultingIntent.state)
        || (resultingIntent.state === 'cancelled' && resultingRecord.state !== 'cancelled'))) throw new NativeWorkExecutionError('conflict');
      if (nextIntent?.state === 'associated' && !resultingRecord) throw new NativeWorkExecutionError('recovery-required');
      if (nextIntent) db.run('INSERT INTO native_work_execution_intents(project_id,attempt_id,format_version,state_json) VALUES (?,?,?,?) ON CONFLICT(project_id,attempt_id) DO UPDATE SET format_version=excluded.format_version,state_json=excluded.state_json', [projectId, nextIntent.target.attemptId, 1, JSON.stringify(nextIntent)]);
      if (next) db.run('INSERT INTO native_work_executions(project_id,key_hash,format_version,state_json,attempt_id) VALUES (?,?,?,?,?) ON CONFLICT(project_id,key_hash) DO UPDATE SET format_version=excluded.format_version,state_json=excluded.state_json', [projectId, durableKeyHash(next.request.key), 1, JSON.stringify(next), next.target.attemptId]);
      return { changed: next !== null || nextIntent !== null, value: result.value };
    }, refresh, afterDurable ? (value, db) => afterDurable(value, () => read(db, projectId, lookup)) : undefined).then(result => {
      if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value;
    });
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  return {
    current(key) { if (closed) throw new NativeWorkExecutionError('closed'); return sqlite.readPersisted(db => read(db, projectId, key)); },
    currentByAttempt(attemptId) { if (closed) throw new NativeWorkExecutionError('closed'); if (!attemptId || typeof attemptId !== 'string') throw new NativeWorkExecutionError('invalid'); return sqlite.readPersisted(db => read(db, projectId, { attemptId })); },
    transaction,
    transactionByAttempt(attemptId, decide, afterDurable) { return transaction({ attemptId }, decide, afterDurable); },
    settle(key, decide, assertCurrent) {
      if (closed) return Promise.reject(new NativeWorkExecutionError('closed'));
      const lookup = { ...key }; durableKeyHash(lookup);
      const operation = sqlite.transactPersisted(db => {
        const current = read(db, projectId, lookup);
        const proposed = decide(structuredClone(current));
        if (proposed && typeof (proposed as unknown as { then?: unknown }).then === 'function') throw new NativeWorkExecutionError('invalid');
        if (current.settlement) {
          if (proposed !== null && nativeSettlementDigest(proposed) !== current.settlement.publicationDigest) throw new NativeWorkExecutionError('conflict');
          return { changed: false, value: current.settlement };
        }
        const record = current.record;
        if (!proposed || !record?.receipt || record.state !== 'launch-claimed' || (current.intent !== null && current.intent.state !== 'associated')) throw new NativeWorkExecutionError('stale');
        const publication = { ...structuredClone(proposed), attestation: nativeWorkAttestationSchema.parse(proposed.attestation) };
        if (publication.receiptDigest !== nativeSettlementDigest(record.receipt) || !/^[0-9a-f]{64}$/.test(publication.contractDigest)) throw new NativeWorkExecutionError('conflict');
        assertCurrent();
        const keyHash = durableKeyHash(record.request.key);
        const reportRequestId = `native-report:${keyHash}`; const evidenceRequestId = `native-evidence:${keyHash}`;
        const at = Math.max(Date.now(), current.ledger.history.at(-1)?.at ?? 0);
        const reduced = reduceWorkLedgerSettlement(current.ledger, { target: record.target, report: publication.report, attestation: publication.attestation,
          actorId: publication.actorId, reportRequestId, evidenceRequestId }, { now: () => at, newId: () => `native-evidence-${keyHash}` });
        const receipt = nativeWorkSettlementSchema.parse({ version: 1, projectId, keyHash, receiptDigest: publication.receiptDigest,
          payloadRevision: durablePayloadRevision(record.request), target: record.target, contractId: record.receipt.contractId,
          contractDigest: publication.contractDigest, publicationDigest: nativeSettlementDigest(publication), reportRequestId, evidenceRequestId,
          reportSequence: reduced.report.sequence, evidenceSequence: reduced.evidence.sequence,
          evidenceId: reduced.evidence.evidence!.id, targetAfterReport: reduced.evidence.evidence!.target, attestation: publication.attestation });
        // Last owner/cancellation/artifact observation follows every reducer/clock/read callback.
        assertCurrent();
        db.run('INSERT INTO work_ledgers(project_id,format_version,revision,state_json) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET format_version=excluded.format_version,revision=excluded.revision,state_json=excluded.state_json', [projectId, reduced.state.version, reduced.state.revision, JSON.stringify(reduced.state)]);
        db.run('INSERT INTO native_work_execution_settlements(project_id,key_hash,format_version,state_json) VALUES (?,?,?,?)', [projectId, keyHash, 1, JSON.stringify(receipt)]);
        read(db, projectId, lookup); // Validate the adjacent events and immutable receipt before committing the image.
        assertCurrent();
        return { changed: true, value: receipt };
      }, refresh).then(result => { if (result.kind !== 'completed') throw new NativeWorkExecutionError('unavailable'); return result.value; });
      pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
    },
    close() { closed = true; return closing ??= Promise.allSettled([...pending]).then(() => {}); },
  };
}

/** Internal same-image reader for adjacent native host storage; never opens another database. */
export { read as readNativeWorkExecutionTransaction };
