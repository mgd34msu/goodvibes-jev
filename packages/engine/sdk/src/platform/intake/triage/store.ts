import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { loadSqlJsEngine, type SqlDatabase } from '../../state/sqlite-store.js';
import { captureTriageData, checkTriageReceipt } from './evidence.js';
import type { TriageEvidence, TriageReceipt, TriageStoredRecord, TriageStore } from './types.js';

const SCHEMA_VERSION = 1;
const STORE_FILE = 'inbox-triage.sqlite';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

// All owners in this process share one admission queue, including aliases of
// a working directory. The store deliberately makes no cross-process claim:
// a working directory must have a single process owner.
const tails = new Map<string, Promise<void>>();

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function abortIfRequested(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Resolve existing ancestors without creating the working directory. */
function canonicalDirectory(directory: string): string {
  if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) {
    throw new TypeError('SqliteTriageStore requires a working directory.');
  }
  let existing = resolve(directory);
  const missing: string[] = [];
  while (true) {
    try {
      // lstat distinguishes a dangling symlink from an absent directory.
      lstatSync(existing);
      return join(realpathSync(existing), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A dangling link must never be treated as a creatable directory.
      try {
        if (lstatSync(existing).isSymbolicLink()) {
          throw new Error('SqliteTriageStore refuses a dangling directory symlink.');
        }
      } catch (statError) {
        if (!isMissing(statError)) throw statError;
      }
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

/** Managed directories and the database itself must never follow symlinks. */
function checkPath(path: string): void {
  const root = parse(path).root;
  const components = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('SqliteTriageStore refuses a symlink in its store path.');
    const final = index === components.length - 1;
    if (final ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error('SqliteTriageStore requires regular store files and directories.');
    }
  }
}

function readImage(path: string): Buffer | undefined {
  checkPath(path);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('SqliteTriageStore requires a regular database file.');
    const image = readFileSync(fd);
    if (image.byteLength < 100 || !image.subarray(0, 16).equals(SQLITE_HEADER)) {
      throw new Error('SqliteTriageStore: corrupt existing database; refusing replacement.');
    }
    return image;
  } finally {
    closeSync(fd);
  }
}

function initializeSchema(db: SqlDatabase): void {
  db.run(`CREATE TABLE triage_receipts (
    id TEXT PRIMARY KEY NOT NULL,
    latest TEXT NOT NULL,
    settled TEXT
  )`);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function decodeRecord(row: unknown[]): readonly [string, TriageStoredRecord] {
  const [id, latestJson, settledJson] = row;
  if (typeof id !== 'string' || typeof latestJson !== 'string'
    || (settledJson !== null && typeof settledJson !== 'string')) {
    throw new Error('SqliteTriageStore: invalid persisted receipt row.');
  }
  const latest = checkTriageReceipt(JSON.parse(latestJson) as unknown);
  const checkedSettled = settledJson === null ? null : checkTriageReceipt(JSON.parse(settledJson) as unknown);
  if (latest.id !== id || (checkedSettled !== null && (checkedSettled.id !== id || checkedSettled.status !== 'settled'))) {
    throw new Error('SqliteTriageStore: persisted receipt identity/status mismatch.');
  }
  const settled = checkedSettled as TriageEvidence | null;
  if (latest.status === 'settled' && JSON.stringify(latest) !== JSON.stringify(settled)) {
    throw new Error('SqliteTriageStore: inconsistent settled receipt.');
  }
  return [id, Object.freeze({ latest, settled })];
}

/** Validate, never repair, an existing image. Rejected images stay byte-for-byte intact. */
function readRecords(db: SqlDatabase): Map<string, TriageStoredRecord> {
  if (db.exec('PRAGMA user_version')[0]?.values[0]?.[0] !== SCHEMA_VERSION
    || db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0] !== 'ok') {
    throw new Error('SqliteTriageStore: invalid or unsupported existing database.');
  }
  const columns = db.exec('PRAGMA table_info(triage_receipts)')[0]?.values;
  if (!columns || columns.length !== 3
    || columns[0]?.[1] !== 'id' || columns[0]?.[2] !== 'TEXT' || columns[0]?.[3] !== 1 || columns[0]?.[5] !== 1
    || columns[1]?.[1] !== 'latest' || columns[1]?.[2] !== 'TEXT' || columns[1]?.[3] !== 1
    || columns[2]?.[1] !== 'settled' || columns[2]?.[2] !== 'TEXT') {
    throw new Error('SqliteTriageStore: invalid existing schema.');
  }
  // Unknown tables/triggers/views are not silently executed or overwritten.
  const objects = db.exec("SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")[0]?.values ?? [];
  if (objects.length !== 1 || objects[0]?.[0] !== 'table' || objects[0]?.[1] !== 'triage_receipts') {
    throw new Error('SqliteTriageStore: unexpected existing schema objects.');
  }
  return new Map((db.exec('SELECT id, latest, settled FROM triage_receipts')[0]?.values ?? []).map(decodeRecord));
}

function publishImage(path: string, image: Uint8Array, signal?: AbortSignal): void {
  abortIfRequested(signal);
  checkPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  checkPath(path);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let ownsTemporary = false;
  try {
    abortIfRequested(signal);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    ownsTemporary = true;
    try {
      writeFileSync(fd, image);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Cancellation after preparation cannot publish a partial/new receipt.
    abortIfRequested(signal);
    checkPath(path);
    renameSync(temporary, path);
    ownsTemporary = false;
  } finally {
    if (ownsTemporary) unlinkSync(temporary);
  }
}

/**
 * Atomic latest-attempt and last-settled storage for the bounded triage pass.
 * Construction, reads, and close are read-only. Every commit reloads the latest
 * disk image under the shared canonical-path process queue; separate instances
 * therefore cannot overwrite each other's admitted updates. The directory must
 * have one process owner; external writers and hostile filesystem races are not
 * covered by this process-local coordination contract.
 */
export class SqliteTriageStore implements TriageStore {
  private readonly path: string;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(workingDirectory: string) {
    this.path = join(canonicalDirectory(workingDirectory), '.goodvibes', 'tui', 'operator', STORE_FILE);
  }

  get dbPath(): string {
    return this.path;
  }

  readBatch(ids: readonly string[]): Promise<ReadonlyMap<string, TriageStoredRecord>> {
    if (this.closed) return Promise.reject(new Error('SqliteTriageStore is closed.'));
    let requested: Set<string>;
    try {
      const captured = captureTriageData(ids);
      if (!Array.isArray(captured) || captured.some(id => typeof id !== 'string' || !id.trim() || id.length > 500)) {
        throw new TypeError('SqliteTriageStore requires nonempty receipt ids.');
      }
      requested = new Set(captured as string[]);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(async () => {
      const SQL = await loadSqlJsEngine();
      const image = readImage(this.path);
      if (!image) return new Map<string, TriageStoredRecord>();
      const db = new SQL.Database(image);
      try {
        const records = readRecords(db);
        return new Map([...records].filter(([id]) => requested.has(id)));
      } finally {
        db.close();
      }
    });
  }

  commit(receipts: readonly TriageReceipt[], signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error('SqliteTriageStore is closed.'));
    let checked: TriageReceipt[];
    try {
      abortIfRequested(signal);
      const captured = captureTriageData(receipts);
      if (!Array.isArray(captured)) throw new TypeError('SqliteTriageStore requires a receipt array.');
      // Validate the complete batch and detach it from caller-owned mutable
      // objects before admission, engine loading, mkdir, or any disk write.
      checked = captured.map(checkTriageReceipt);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(async () => {
      abortIfRequested(signal);
      if (checked.length === 0) return;
      const SQL = await loadSqlJsEngine();
      abortIfRequested(signal);
      const image = readImage(this.path);
      const db = new SQL.Database(image);
      try {
        if (!image) initializeSchema(db);
        const records = readRecords(db);
        abortIfRequested(signal);
        db.run('BEGIN TRANSACTION');
        for (const receipt of checked) {
          const settled = receipt.status === 'settled' ? receipt : records.get(receipt.id)?.settled ?? null;
          db.run('INSERT OR REPLACE INTO triage_receipts (id, latest, settled) VALUES (?, ?, ?)', [
            receipt.id, JSON.stringify(receipt), settled === null ? null : JSON.stringify(settled),
          ]);
          records.set(receipt.id, { latest: receipt, settled });
        }
        db.run('COMMIT');
        abortIfRequested(signal);
        publishImage(this.path, db.export(), signal);
      } finally {
        db.close();
      }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.allSettled([...this.pending]).then(() => {});
    return this.closing;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('SqliteTriageStore is closed.'));
    const result = (tails.get(this.path) ?? Promise.resolve()).then(operation);
    const tail = result.then(() => {}, () => {});
    tails.set(this.path, tail);
    this.pending.add(result);
    void tail.then(() => {
      this.pending.delete(result);
      if (tails.get(this.path) === tail) tails.delete(this.path);
    });
    return result;
  }
}
