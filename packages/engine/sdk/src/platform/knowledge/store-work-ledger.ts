import { readKnowledgeSourceSnapshot } from './store-source-generation.js';
import type { SQLiteStore, SqlDatabase } from '../state/sqlite-store.js';
import { createEmptyWorkLedgerState } from '../workflow/work-ledger/service.js';
import { workLedgerStateSchema, type WorkLedgerDecision, type WorkLedgerState, type WorkLedgerStorage, type WorkLedgerTransactionContext } from '../workflow/work-ledger/types.js';

export interface KnowledgeWorkLedgerStorage extends WorkLedgerStorage {
  /** Stop observations/admissions and drain admitted storage work. Does not close KnowledgeStore. */
  close(): Promise<void>;
}

export function createWorkLedgerTable(db: Pick<SqlDatabase, 'run'>): void {
  db.run('CREATE TABLE IF NOT EXISTS work_ledgers (project_id TEXT PRIMARY KEY NOT NULL, format_version INTEGER NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL)');
}

/** A current-version file must never be "repaired" into an empty authority. */
export function validateWorkLedgerTable(db: Pick<SqlDatabase, 'exec'>): void {
  const rows = db.exec('PRAGMA table_info(work_ledgers)')[0]?.values;
  const expected = [['project_id', 'TEXT', 1, 1], ['format_version', 'INTEGER', 1, 0], ['revision', 'INTEGER', 1, 0], ['state_json', 'TEXT', 1, 0]];
  if (!rows || rows.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = rows.find(value => value[1] === name);
    return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new Error('KnowledgeStore: current work ledger schema is missing or corrupt; refusing repair');
}

function readLedger(db: Pick<SqlDatabase, 'exec'>, projectId: string): WorkLedgerState {
  const row = db.exec('SELECT format_version, revision, state_json FROM work_ledgers WHERE project_id = ?', [projectId])[0]?.values[0];
  if (!row) return createEmptyWorkLedgerState(projectId);
  if (row[0] !== 1 || typeof row[2] !== 'string') throw new Error('Work ledger persisted format is invalid');
  const state = workLedgerStateSchema.parse(JSON.parse(row[2]));
  if (state.projectId !== projectId || state.revision !== row[1]) throw new Error('Work ledger persisted identity is invalid');
  return state;
}

/** Internal adapter composed exclusively by the existing KnowledgeStore owner. */
export function createKnowledgeWorkLedgerStorage(sqlite: SQLiteStore, projectId: string, refresh: () => void): KnowledgeWorkLedgerStorage {
  createEmptyWorkLedgerState(projectId); // Validate even before the first row exists.
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const listeners = new Map<(state: WorkLedgerState) => void, number>();
  let poll: ReturnType<typeof setInterval> | undefined;
  function observe(): void {
    if (closed || listeners.size === 0) return;
    let state: WorkLedgerState;
    try { state = sqlite.readPersisted(db => readLedger(db, projectId)); } catch { return; }
    for (const [listener, revision] of listeners) {
      if (state.revision <= revision) continue;
      listeners.set(listener, state.revision);
      try { void Promise.resolve(listener(structuredClone(state))).catch(() => {}); } catch { /* Observers cannot fail commits. */ }
    }
  }
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  return {
    read() {
      if (closed) return Promise.reject(new Error('Work ledger storage is closed'));
      return track(Promise.resolve().then(() => sqlite.readPersisted(db => readLedger(db, projectId))));
    },
    transaction<T>(decide: (current: unknown, context?: WorkLedgerTransactionContext) => WorkLedgerDecision<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('Work ledger storage is closed'));
      return track(sqlite.transactPersisted(db => {
        const decision = decide(readLedger(db, projectId), { readSource: id => readKnowledgeSourceSnapshot(db, { id }) });
        if (decision && typeof (decision as unknown as { then?: unknown }).then === 'function') {
          if (decision instanceof Promise) void decision.catch(() => {});
          throw new TypeError('Work ledger decision must be synchronous');
        }
        if (!decision || !('next' in decision)) throw new TypeError('Invalid work ledger decision');
        if (decision.next !== null) {
          const next = workLedgerStateSchema.parse(decision.next);
          if (next.projectId !== projectId) throw new Error('Work ledger project mismatch');
          db.run('INSERT INTO work_ledgers(project_id, format_version, revision, state_json) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET format_version=excluded.format_version, revision=excluded.revision, state_json=excluded.state_json', [projectId, next.version, next.revision, JSON.stringify(next)]);
        }
        return { changed: decision.next !== null, value: decision.value };
      }, refresh).then(result => {
        if (result.kind === 'local-changes') throw new Error('Work ledger admission blocked by pending local changes or active batch; decision was not called');
        // No observer runs between decision and durable publication acceptance.
        queueMicrotask(observe);
        return result.value;
      }));
    },
    subscribe(listener) {
      if (closed) throw new Error('Work ledger storage is closed');
      listeners.set(listener, -1);
      if (!poll) { poll = setInterval(observe, 100); poll.unref?.(); }
      queueMicrotask(observe);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && poll) { clearInterval(poll); poll = undefined; }
      };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      listeners.clear();
      if (poll) clearInterval(poll);
      poll = undefined;
      closePromise = Promise.allSettled([...pending]).then(() => {});
      return closePromise;
    },
  };
}
