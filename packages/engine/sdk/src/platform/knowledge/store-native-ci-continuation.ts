/** One durable transaction publishes native continuation claim and its exact ledger successor. */
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import type { DurableContractKey } from '../contract/durable-admission.js';
import type { NativeWorkExecutionTransaction } from '../workflow/work-ledger/native-execution-types.js';
import { reduceWorkLedgerContinuation } from '../workflow/work-ledger/service.js';
import { nativeCiDigest, parseNativeCiContinuation, type NativeCiContinuationRecord, type NativeCiContinuationStorage, type NativeCiContinuationTransaction } from '../workflow/work-ledger/native-ci-continuation-types.js';

type Reader = Pick<SqlDatabase, 'exec'>;
export function createNativeCiContinuationTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS native_ci_continuations (project_id TEXT NOT NULL, continuation_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, continuation_id))');
}
export function validateNativeCiContinuationTable(db: Reader): void {
  const columns = db.exec('PRAGMA table_info(native_ci_continuations)')[0]?.values;
  const expected = [['project_id', 'TEXT', 1, 1], ['continuation_id', 'TEXT', 1, 2], ['format_version', 'INTEGER', 1, 0], ['state_json', 'TEXT', 1, 0]] as const;
  if (!columns || columns.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = columns.find(value => value[1] === name); return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new Error('Invalid native CI continuation table');
  for (const row of db.exec('SELECT project_id, continuation_id, format_version, state_json FROM native_ci_continuations')[0]?.values ?? []) {
    const record = parseNativeCiContinuation(JSON.parse(String(row[3])));
    if (record.issue.projectId !== row[0] || record.id !== row[1] || row[2] !== 1) throw new Error('Invalid native CI continuation row');
  }
}
export function createNativeCiContinuationStorage(sqlite: SQLiteStore, projectId: string, refresh: () => void,
  readOriginal: (db: Reader, key: DurableContractKey) => NativeWorkExecutionTransaction): NativeCiContinuationStorage {
  function row(db: Reader, id: string): NativeCiContinuationRecord | null {
    const stored = db.exec('SELECT format_version, state_json FROM native_ci_continuations WHERE project_id = ? AND continuation_id = ?', [projectId, id])[0]?.values[0];
    if (!stored) return null;
    const record = parseNativeCiContinuation(JSON.parse(String(stored[1])));
    if (stored[0] !== 1 || record.id !== id || record.issue.projectId !== projectId) throw new Error('Invalid native CI continuation row');
    return record;
  }
  function current(db: Reader, id: string, key?: DurableContractKey): NativeCiContinuationTransaction {
    const record = row(db, id); const originalKey = record?.issue.originalKey ?? key;
    if (!originalKey || (key && record && nativeCiDigest(key) !== nativeCiDigest(originalKey))) throw new Error('Native CI continuation is missing or changed');
    return { record, original: readOriginal(db, originalKey) };
  }
  function put(db: Pick<SqlDatabase, 'run'>, record: NativeCiContinuationRecord): void {
    db.run('INSERT INTO native_ci_continuations(project_id,continuation_id,format_version,state_json) VALUES (?,?,?,?) ON CONFLICT(project_id,continuation_id) DO UPDATE SET state_json=excluded.state_json',
      [projectId, record.id, 1, JSON.stringify(record)]);
  }
  return {
    current: (id, key) => sqlite.readPersisted(db => current(db, id, key)),
    async transaction(id, key, decide, assertCurrent) {
      const result = await sqlite.transactPersisted(db => {
        const before = current(db, id, key); const change = decide(structuredClone(before));
        if (change && typeof (change as unknown as { then?: unknown }).then === 'function') throw new Error('Asynchronous continuation mutation');
        const next = change.next ? parseNativeCiContinuation(change.next) : null;
        if (next) {
          if (next.id !== id || next.issue.projectId !== projectId || nativeCiDigest(next.issue.originalKey) !== nativeCiDigest(key)) throw new Error('Invalid native continuation mutation');
          if (before.record && (nativeCiDigest(before.record.issue) !== nativeCiDigest(next.issue)
            || nativeCiDigest(before.record.grant) !== nativeCiDigest(next.grant)
            || (before.record.watch !== null && nativeCiDigest(before.record.watch) !== nativeCiDigest(next.watch))
            || (before.record.state !== 'issued' && next.state !== before.record.state && next.state !== 'cancelled')
            || nativeCiDigest(before.record.successor) !== nativeCiDigest(next.successor)
            || before.record.failureRevision !== next.failureRevision)) throw new Error('Native continuation identity changed');
          if (!before.record && (next.state !== 'issued' || next.watch !== null)) throw new Error('Invalid native continuation issuance');
        }
        assertCurrent(); if (next) put(db, next); assertCurrent();
        return { changed: next !== null, value: change.value };
      }, refresh);
      if (result.kind !== 'completed') throw new Error('Native continuation publication is indeterminate'); return result.value;
    },
    async claim(id, failureRevision, assertCurrent) {
      const result = await sqlite.transactPersisted(db => {
        const before = current(db, id); const record = before.record;
        if (!record || !record.watch || record.state === 'cancelled') throw new Error('Native continuation is unavailable');
        assertCurrent(before);
        if (record.state === 'claimed') {
          if (record.failureRevision !== failureRevision) throw new Error('Native continuation was already claimed for different CI evidence');
          return { changed: false, value: record };
        }
        const original = before.original.record;
        if (!original || original.state === 'cancelled') throw new Error('Native continuation original execution is unavailable');
        const reduced = reduceWorkLedgerContinuation(before.original.ledger, {
          target: before.original.settlement?.targetAfterReport ?? original.target,
          actorId: record.issue.principalId, continuationId: id, successorId: `attempt-ci-${nativeCiDigest(record.grant).slice(0, 40)}`,
        }, { now: Date.now, newId: () => { throw new Error('Unexpected native continuation identity'); } });
        const next = parseNativeCiContinuation({ ...record, state: 'claimed', failureRevision, successor: reduced.target });
        assertCurrent(before);
        db.run('INSERT INTO work_ledgers(project_id,format_version,revision,state_json) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET format_version=excluded.format_version,revision=excluded.revision,state_json=excluded.state_json',
          [projectId, reduced.state.version, reduced.state.revision, JSON.stringify(reduced.state)]);
        put(db, next);
        return { changed: true, value: next };
      }, refresh);
      if (result.kind !== 'completed') throw new Error('Native continuation claim is indeterminate'); return result.value;
    },
  };
}
