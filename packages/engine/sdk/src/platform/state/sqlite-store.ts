import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { openVersionedSchema, sqlJsVersionHandle } from './store-versioning.js';
import { restoreStoreSnapshot, snapshotStoreFile } from './store-snapshots.js';
import { imageDigest, SQLiteStorePersistence } from './sqlite-store-persistence.js';
import { sqliteLocalObservation } from './sqlite-local-observation.js';

// The sql.js engine loads exactly once per process, however many stores open.
// Its WASM loader is not re-entrant: two concurrent initSqlJs() calls race the
// module's internal resolver and one of them dies with "resolveModule is not a
// function". A failed load clears the memo so the next open can retry.
let sqlJsEnginePromise: Promise<SqlJsStatic> | null = null;

// Internal shared loader for the distinct daemon handler store; deliberately
// omitted from the public state barrel.
export function loadSqlJsEngine(): Promise<SqlJsStatic> {
  if (!sqlJsEnginePromise) {
    sqlJsEnginePromise = import('sql.js')
      .then((mod) => mod.default() as Promise<SqlJsStatic>)
      .catch((err: unknown) => {
        sqlJsEnginePromise = null;
        throw err;
      });
  }
  return sqlJsEnginePromise;
}

export interface SqlDatabase {
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
  exec(sql: string, params?: (string | number)[], config?: { useBigInt: boolean }): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array | Buffer) => SqlDatabase;
}

interface OwnedSqlDatabase {
  readonly raw: SqlDatabase;
  readonly identity: bigint;
  revision: bigint;
  inFlight: number;
  memo?: { readonly revision: bigint; readonly probe: string; readonly digest: string } | undefined;
  cleanMemo?: { readonly revision: bigint; readonly probe: string; readonly digest: string } | undefined;
}
let nextDatabaseIdentity = 0n;
const ownedDatabases = new WeakMap<SqlDatabase, OwnedSqlDatabase>();
const unownedIdentities = new WeakMap<SqlDatabase, bigint>();

/** Never return sql.js's chainable run result or a native property/statement.
 * Every supported callback receives the same immutable four-method facade. */
function ownDatabase(raw: SqlDatabase): SqlDatabase {
  const state: OwnedSqlDatabase = { raw, identity: ++nextDatabaseIdentity, revision: 0n, inFlight: 0 };
  const operation = <T>(run: () => T): T => {
    state.revision++; state.inFlight++; state.memo = undefined; state.cleanMemo = undefined;
    try { return run(); }
    finally { state.revision++; state.inFlight--; state.memo = undefined; state.cleanMemo = undefined; }
  };
  const facade: SqlDatabase = Object.freeze({
    run(sql: string, params?: (string | number | Uint8Array | null)[]) {
      operation(() => { raw.run(sql, params); });
    },
    exec(sql: string, params?: (string | number)[], config?: { useBigInt: boolean }) {
      return operation(() => raw.exec(sql, params, config));
    },
    export() { return operation(() => raw.export()); },
    close() { operation(() => { raw.close(); }); },
  });
  ownedDatabases.set(facade, state);
  return facade;
}

/** This path is only for fixed internal SQL, never caller SQL or callbacks. */
function readDatabaseRow(db: SqlDatabase, sql: string, params: string[]) {
  const state = ownedDatabases.get(db);
  if (state?.inFlight) throw new SQLiteObservationRetiredError();
  return (state?.raw ?? db).exec(sql, params);
}

function databaseProbe(raw: SqlDatabase): { readonly signature: string | null; readonly cacheable: boolean } {
  const query = (sql: string) => raw.exec(sql, undefined, { useBigInt: true })[0]?.values;
  const mode = query('PRAGMA read_uncommitted')?.[0]?.[0];
  const databases = query('PRAGMA database_list');
  if ((mode !== 0n && mode !== 1n) || !databases?.length) return { signature: null, cacheable: false };
  const identities: Array<readonly string[]> = [];
  for (const row of databases) {
    const [sequence, name, file] = row;
    if (typeof sequence !== 'bigint' || typeof name !== 'string' || typeof file !== 'string'
      || [name, file].some(value => value.includes('\0') || value.includes('\ufffd') || Buffer.from(value).toString('utf8') !== value)) {
      return { signature: null, cacheable: false };
    }
    const schema = `"${name.replaceAll('"', '""')}"`;
    const version = query(`PRAGMA ${schema}.data_version`)?.[0]?.[0];
    const schemaVersion = query(`PRAGMA ${schema}.schema_version`)?.[0]?.[0];
    if (typeof version !== 'bigint' || typeof schemaVersion !== 'bigint') return { signature: null, cacheable: false };
    identities.push([String(sequence), name, file, String(version), String(schemaVersion)]);
  }
  return { signature: JSON.stringify([String(mode), identities]), cacheable: mode === 0n };
}

/** Reuse only a complete observation owned by an uninterrupted connection.
 * Native data_version fences other SQL connections; facade revisions fence all
 * owner operations, including failed writes, rollback and export/reopen ABA. */
function observeDatabase(db: SqlDatabase, mode: 'observation' | 'clean-content' = 'observation'): string {
  const state = ownedDatabases.get(db);
  if (!state) {
    let identity = unownedIdentities.get(db);
    if (identity === undefined) { identity = ++nextDatabaseIdentity; unownedIdentities.set(db, identity); }
    return JSON.stringify([String(identity), mode === 'observation' ? '0' : 'clean-content', null, sqliteLocalObservation(db, mode)]);
  }
  try {
    if (state.inFlight) throw new SQLiteObservationRetiredError();
    const revision = state.revision, before = databaseProbe(state.raw);
    const memo = mode === 'observation' ? state.memo : state.cleanMemo;
    const digest = before.cacheable && memo?.revision === revision && memo.probe === before.signature
      ? memo.digest : sqliteLocalObservation(state.raw, mode);
    const after = databaseProbe(state.raw);
    if (state.inFlight || state.revision !== revision || before.signature !== after.signature) throw new SQLiteObservationRetiredError();
    const next = before.cacheable && after.cacheable && after.signature !== null
      ? { revision, probe: after.signature, digest } : undefined;
    if (mode === 'observation') state.memo = next; else state.cleanMemo = next;
    return JSON.stringify([String(state.identity), mode === 'observation' ? String(revision) : 'clean-content', after.signature, digest]);
  } catch (error) {
    state.memo = undefined; state.cleanMemo = undefined; state.revision++;
    throw error;
  }
}

function isEphemeralDbPath(path: string | null | undefined): boolean {
  if (!path) return true;
  if (path === ':memory:') return true;
  return /^file:.*(?:^|[?&])mode=memory(?:&|$)/.test(path);
}

function assertSqliteImage(data: Uint8Array): void {
  if (data.byteLength < 100 || Buffer.from(data.subarray(0, 16)).toString('binary') !== 'SQLite format 3\0') {
    throw new Error('SQLiteStore: existing database image is corrupt; refusing initialization');
  }
}

export interface SqliteStoreInitOptions {
  /** Validate an already-current persisted schema before idempotent base-schema repair. */
  readonly validateCurrentSchema?: ((db: SqlDatabase) => void) | undefined;
  /** Human store name for honest versioning messages. */
  readonly storeName?: string | undefined;
  /** Target `PRAGMA user_version` for this store (default 1). */
  readonly schemaVersion?: number | undefined;
  /**
   * Ordered migrations to the target version. When omitted, the base schema
   * function doubles as the single migration to the target version (safe
   * because every base schema here is IF NOT EXISTS-idempotent).
   */
  readonly migrations?: ReadonlyArray<{
    readonly toVersion: number;
    readonly migrate: (db: SqlDatabase) => void;
  }> | undefined;
}

export class SQLiteStore {
  private db: SqlDatabase | null = null;
  private readonly dbPath: string | null;
  private initPromise: Promise<void> | null = null;
  private saveBatchDepth = 0;
  private saveDirty = false;
  private readonly coordinated: boolean;
  private persistence: SQLiteStorePersistence | null = null;
  private cleanContent: string | null = null;
  // Only coordinated ephemeral storage needs retained last-clean image bytes.
  private cleanBytes: Uint8Array | null = null;
  private sqlEngine: SqlJsStatic | null = null;
  private schema: ((db: SqlDatabase) => void) | null = null;
  private schemaVersion = 1;
  private validateCurrentSchema: ((db: SqlDatabase) => void) | undefined;
  private imageEpoch = 0;
  private observationEpoch = 0;
  private persistedReadFrame: { db: SqlDatabase | null; owned: boolean; identity: string | undefined; local: string | undefined; persisted: string | undefined; poisoned: boolean; assertCurrent: () => void } | null = null;
  private admission: Promise<void> = Promise.resolve();
  private readonly activeBatches = new Set<Promise<void>>();
  private fenced = false;

  constructor(dbPath?: string, options: { readonly coordinated?: boolean } = {}) {
    this.dbPath = dbPath ?? null;
    this.coordinated = options.coordinated === true;
  }

  get isReady(): boolean {
    return this.db !== null;
  }

  /** The on-disk database path, or null for an ephemeral/in-memory store. */
  get databasePath(): string | null {
    return this.dbPath;
  }

  async init(schema: (db: SqlDatabase) => void, options: SqliteStoreInitOptions = {}): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize(schema, options);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  run(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    this.observationEpoch += 1;
    this.getDb().run(sql, params);
  }

  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> {
    this.observationEpoch += 1;
    return this.getDb().exec(sql, params);
  }

  /**
   * Restricts a reading to this coordinated image lifetime. Our persistence
   * protocol atomically replaces the canonical file on every publication;
   * metadata also fences in-place external writes. No value-only ABA adoption.
   * This is conservative: unrelated database writes also retire the reading.
   */
  captureObservation(): () => void {
    const epoch = this.observationEpoch, imageEpoch = this.imageEpoch;
    const identity = this.persistence?.observationIdentity();
    const local = observeDatabase(this.getDb());
    return () => {
      if (this.observationEpoch !== epoch || this.imageEpoch !== imageEpoch
        || this.persistence?.observationIdentity() !== identity
        || observeDatabase(this.getDb()) !== local) {
        throw new SQLiteObservationRetiredError();
      }
    };
  }

  /** Read one current persisted image without replacing pending local state.
   * Mutable callbacks always receive an isolated image, never a guard's image. */
  readPersisted<T>(read: (db: SqlDatabase) => T): T {
    if (!this.coordinated) throw new Error('SQLiteStore: persisted reads require coordinated storage');
    // Legacy callbacks may mutate the live ephemeral image without touching our
    // write epochs, including transaction rollback ABA. They retain their old
    // behavior, but can never participate in a successful framed assertion.
    if (this.persistedReadFrame) this.persistedReadFrame.poisoned = true;
    if (!this.persistence) return read(this.getDb());
    const current = this.openCurrentImage();
    try { return read(current); } finally { this.closeReadImage(current); }
  }

  /** Internal knowledge raw-row read. A closed descriptor, never caller SQL or
   * a callback, selects one detached result from the private guard image. */
  readPersistedRow(table: 'knowledge_sources' | 'knowledge_nodes' | 'knowledge_extractions',
    column: 'id' | 'canonical_uri', value: string): Array<{ columns: string[]; values: unknown[][] }> {
    if (!this.coordinated) throw new Error('SQLiteStore: persisted reads require coordinated storage');
    const frame = this.persistedReadFrame;
    try {
      if (!['knowledge_sources', 'knowledge_nodes', 'knowledge_extractions'].includes(table)
        || (column !== 'id' && !(table === 'knowledge_sources' && column === 'canonical_uri'))
        || typeof value !== 'string') {
        throw new TypeError('SQLiteStore: invalid raw record selector');
      }
      const sql = `SELECT * FROM ${table} WHERE ${column} = ? LIMIT 1`, params = [value];
      if (!frame) {
        // Closed internal selectors must not self-retire live ephemeral receipts.
        // Arbitrary legacy callbacks still use the revision-tracked facade.
        if (!this.persistence) return readDatabaseRow(this.getDb(), sql, params);
        const current = this.openCurrentImage();
        try { return readDatabaseRow(current, sql, params); } finally { this.closeReadImage(current); }
      }
      frame.assertCurrent();
      if (!frame.db) {
        frame.identity = this.persistence?.observationIdentity();
        frame.local = observeDatabase(this.getDb());
        const persisted = this.persistence?.read();
        frame.persisted = persisted ? imageDigest(persisted) : undefined;
        frame.db = this.openPrivateReadImage();
        frame.owned = true;
      }
      frame.assertCurrent();
      const result = readDatabaseRow(frame.db, sql, params);
      frame.assertCurrent();
      return result;
    } catch (error) { if (frame) frame.poisoned = true; throw error; }
  }

  /** Internal synchronous guard boundary. Nested guards share only this call's
   * fresh image. Callbacks must perform assertions, not publish or schedule work.
   * Rejecting an async return cannot undo effects its callback already scheduled. */
  assertPersistedReadFrame(assertion: () => undefined): void {
    const invoke = () => {
      const result: unknown = assertion();
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => {});
        throw new TypeError('SQLiteStore: persisted read assertions must be synchronous and return no value');
      }
    };
    // Ephemeral reads already use the current live image without opening SQL
    // databases. Preserve those semantics, including previously exposed handles.
    if (!this.persistence) { invoke(); return; }
    const active = this.persistedReadFrame;
    if (active) {
      const assertNestedCurrent = () => {
        active.assertCurrent();
        if (active.db && observeDatabase(this.getDb()) !== active.local) throw new SQLiteObservationRetiredError();
      };
      try { assertNestedCurrent(); invoke(); assertNestedCurrent(); }
      catch (error) { active.poisoned = true; throw error; }
      return;
    }
    const observationEpoch = this.observationEpoch, imageEpoch = this.imageEpoch;
    const frame = {
      db: null as SqlDatabase | null, owned: false, identity: undefined as string | undefined,
      local: undefined as string | undefined, persisted: undefined as string | undefined, poisoned: false,
      assertCurrent: () => {
        if (frame.poisoned || this.observationEpoch !== observationEpoch || this.imageEpoch !== imageEpoch
          || (frame.db !== null && this.persistence?.observationIdentity() !== frame.identity)) {
          throw new SQLiteObservationRetiredError();
        }
      },
    };
    this.persistedReadFrame = frame;
    try {
      invoke();
      frame.assertCurrent();
      if (frame.db) {
        // Full-state fences run once per outer assertion, not once per row. No
        // data from this frame can authorize the next await or publication.
        const persisted = this.persistence?.read();
        if (observeDatabase(this.getDb()) !== frame.local
          || (persisted ? imageDigest(persisted) : undefined) !== frame.persisted) {
          throw new SQLiteObservationRetiredError();
        }
        frame.assertCurrent();
      }
    } finally {
      this.persistedReadFrame = null;
      if (frame.owned && frame.db) this.closeReadImage(frame.db);
    }
  }

  /**
   * Compare and mutate one fresh image synchronously under file ownership.
   * Local/batched changes are never discarded to make a guarded write fit.
   * The commit callback refreshes mirrors before another operation can enter.
   */
  transactPersisted<T>(
    operation: (db: SqlDatabase) => { readonly changed: boolean; readonly value: T },
    onCommit: () => void,
    afterDurable?: ((value: T, db: SqlDatabase) => void) | undefined,
  ): Promise<{ readonly kind: 'local-changes' } | { readonly kind: 'completed'; readonly value: T }> {
    if (!this.coordinated) return Promise.reject(new Error('SQLiteStore: guarded persistence requires coordinated storage'));
    // Batch callers must not wait for their own save boundary.
    if (this.saveBatchDepth > 0) return Promise.resolve({ kind: 'local-changes' });
    return this.enqueue(async () => {
      const release = this.persistence ? await this.persistence.lock() : () => {};
      let current: SqlDatabase | null = null;
      try {
        if (this.saveBatchDepth > 0 || (this.cleanContent === null || observeDatabase(this.getDb(true), 'clean-content') !== this.cleanContent)) {
          return { kind: 'local-changes' };
        }
        current = this.openCurrentImage();
        const result = operation(current);
        if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
          // A foreign thenable is not a decision. Attach rejection handling to
          // native promises only; never run a hostile then getter/callback.
          if (result instanceof Promise) void result.catch(() => {});
          throw new TypeError('SQLiteStore: decision must be synchronous');
        }
        if (!result || typeof result.changed !== 'boolean') throw new TypeError('SQLiteStore: invalid decision');
        if ((this.cleanContent === null || observeDatabase(this.getDb(true), 'clean-content') !== this.cleanContent)) {
          throw new Error('SQLiteStore: reentrant local changes prevented publication');
        }
        if (result.changed) {
          const data = current.export();
          const cleanContent = this.readCleanContent(current);
          this.persistence?.write(data);
          const previous = this.db;
          this.db = current;
          current = null;
          this.imageEpoch += 1;
          this.cleanContent = cleanContent;
          this.cleanBytes = this.persistence ? null : data;
          // Publication already succeeded. Cleanup/observation may fence the
          // cache but cannot change the acknowledged durable outcome.
          this.fenced = false;
          try { previous?.close(); } catch { /* The replaced image cannot affect the current cache. */ }
          try { onCommit(); } catch { this.fenced = true; }
        } else {
          this.persistence?.confirmDurable();
        }
        // Trusted owners may invoke a synchronous execution boundary only after
        // durable publication/replay confirmation, while file ownership remains held.
        if (afterDurable) {
          if (this.fenced) throw new Error('SQLiteStore: publication mirror is fenced');
          const outcome: unknown = afterDurable(result.value, current ?? this.getDb(true));
          if (outcome && typeof (outcome as { then?: unknown }).then === 'function') {
            if (outcome instanceof Promise) void outcome.catch(() => {});
            throw new TypeError('SQLiteStore: durable boundary must be synchronous');
          }
        }
        return { kind: 'completed', value: result.value };
      } finally {
        try { current?.close(); } catch { /* Detached image cleanup. */ }
        try { release(); } catch { this.fenced = true; }
      }
    });
  }

  /** Drain admitted persistence operations before owner teardown. */
  async settled(): Promise<void> {
    while (this.activeBatches.size > 0) await Promise.all([...this.activeBatches]);
    await this.admission;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admission.then(operation);
    this.admission = result.then(() => {}, () => {});
    return result;
  }

  async batch<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const owned = new Promise<void>(resolve => { release = resolve; });
    this.activeBatches.add(owned);
    this.saveBatchDepth += 1;
    try {
      return await operation();
    } finally {
      try {
        this.saveBatchDepth -= 1;
        if (this.saveBatchDepth === 0 && this.saveDirty) {
          this.saveDirty = false;
          await this.save();
        }
      } finally {
        this.activeBatches.delete(owned);
        release();
      }
    }
  }

  async save(): Promise<boolean> {
    const dbPath = this.dbPath;
    if (!this.db) return false;
    if (!this.coordinated && (isEphemeralDbPath(dbPath) || !dbPath)) return false;
    if (this.saveBatchDepth > 0) {
      this.saveDirty = true;
      return false;
    }
    if (isEphemeralDbPath(dbPath) || !dbPath) {
      if (this.coordinated) {
        const data = this.db.export();
        this.cleanContent = this.readCleanContent(this.db);
        this.cleanBytes = data;
      }
      return false;
    }

    if (this.persistence) {
      // Capture at admission. Later same-handle writes may already be queued;
      // they must not change which image this particular save publishes.
      const data = this.db.export();
      const cleanContent = this.readCleanContent(this.db);
      const epoch = this.imageEpoch;
      return this.enqueue(async () => {
        const release = await this.persistence!.lock();
        try {
          this.getDb();
          if (this.imageEpoch !== epoch) {
            throw new Error('SQLiteStore: persisted state changed; captured image was superseded');
          }
          this.persistence!.writeIfCurrent(data);
          this.cleanContent = cleanContent;
          this.cleanBytes = this.persistence ? null : data;
          return true;
        } finally { try { release(); } catch { this.fenced = true; } }
      });
    }

    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      const data = this.db.export();
      writeFileSync(dbPath, Buffer.from(data));
      logger.debug('SQLiteStore: saved to disk', { path: dbPath });
      return true;
    } catch (err) {
      logger.error('SQLiteStore: failed to save', {
        error: summarizeError(err),
      });
      throw err;
    }
  }

  close(): void {
    if (!this.db) return;
    this.imageEpoch += 1;
    this.db.close();
    this.db = null;
  }

  private async initialize(schema: (db: SqlDatabase) => void, options: SqliteStoreInitOptions): Promise<void> {
    let release: (() => void) | undefined;
    try {
      const SQL = await loadSqlJsEngine();
      this.imageEpoch += 1;
      this.sqlEngine = SQL;
      this.schema = schema;
      this.schemaVersion = options.schemaVersion ?? 1;
      this.validateCurrentSchema = options.validateCurrentSchema;
      if (this.coordinated && this.dbPath && !isEphemeralDbPath(this.dbPath)) {
        this.persistence = new SQLiteStorePersistence(this.dbPath);
        release = await this.persistence.lock();
      }
      const dbPath = this.persistence?.path ?? this.dbPath;
      const persistent = Boolean(dbPath && !isEphemeralDbPath(dbPath));
      const existedOnDisk = persistent && existsSync(dbPath!);
      const original = this.persistence?.read() ?? (existedOnDisk ? readFileSync(dbPath!) : null);
      if (this.coordinated && original !== null) assertSqliteImage(original);
      this.persistence?.acceptBaseline(original);

      if (existedOnDisk) {
        this.db = ownDatabase(new SQL.Database(original!));
        logger.info('SQLiteStore: loaded from disk', { path: dbPath });
      } else {
        this.db = ownDatabase(new SQL.Database());
        logger.info('SQLiteStore: initialized in-memory');
      }

      if (existedOnDisk && sqlJsVersionHandle(this.getDb()).getUserVersion() === this.schemaVersion) {
        this.validateCurrentSchema?.(this.getDb());
      }

      // Schema versioning: PRAGMA user_version + ordered migrations, with an
      // automatic pre-migration snapshot, auto-restore on failure, and a
      // downgrade guard (an older binary refuses a newer schema honestly).
      const result = openVersionedSchema({
        storeName: options.storeName ?? 'sqlite store',
        dbPath: persistent ? dbPath! : ':memory:',
        handle: sqlJsVersionHandle(this.db),
        targetVersion: options.schemaVersion ?? 1,
        migrations: options.migrations?.map((migration) => ({
          toVersion: migration.toVersion,
          migrate: () => migration.migrate(this.getDb()),
        })) ?? [{ toVersion: options.schemaVersion ?? 1, migrate: () => schema(this.getDb()) }],
        snapshot: persistent ? (reason) => snapshotStoreFile(dbPath!, reason) : undefined,
        restore: persistent
          ? (snapshotPath) => {
              if (!this.coordinated) restoreStoreSnapshot(dbPath!, snapshotPath);
              if (this.coordinated) this.db?.close();
              this.db = ownDatabase(new SQL.Database(readFileSync(dbPath!)));
            }
          : undefined,
      });
      // The base schema always runs (it is IF NOT EXISTS-idempotent) so a
      // store already at the target version still gets any session tables.
      schema(this.getDb());
      this.validateCurrentSchema?.(this.getDb());
      // Persist a freshly-stamped version so the next open skips migration,
      // but only for a store that already lived on disk: a brand-new store
      // keeps the long-standing contract of touching disk on first save().
      if (result.applied.length > 0 && existedOnDisk) {
        if (this.persistence) this.persistence.writeIfCurrent(this.getDb().export());
        else await this.save();
      }
      if (this.coordinated) {
        const data = this.getDb().export();
        this.cleanContent = this.readCleanContent(this.getDb());
        this.cleanBytes = this.persistence ? null : data;
      }
    } catch (err) {
      if (this.coordinated) this.db?.close();
      this.db = null;
      logger.error('SQLiteStore: failed to initialize', {
        error: summarizeError(err),
      });
      throw err;
    } finally {
      try { release?.(); } catch { this.fenced = true; }
    }
  }

  /** Unsupported observation shapes must not break ordinary init/save. They
   * remain usable there, but cannot authorize a guarded clean-image write. */
  private readCleanContent(db: SqlDatabase): string | null {
    try { return observeDatabase(db, 'clean-content'); }
    catch { return null; }
  }

  private closeReadImage(db: SqlDatabase): void { db.close(); }

  /** Initialization/validation callbacks may retain their input database. The
   * private guard image must therefore be a clone never passed to a callback. */
  private openPrivateReadImage(): SqlDatabase {
    const exposed = this.openCurrentImage();
    try { return ownDatabase(new this.sqlEngine!.Database(exposed.export())); }
    finally { this.closeReadImage(exposed); }
  }

  private openCurrentImage(): SqlDatabase {
    this.getDb(true);
    if (!this.persistence && (this.cleanContent === null || this.cleanBytes === null
      || observeDatabase(this.getDb(), 'clean-content') !== this.cleanContent)) {
      throw new Error('SQLiteStore: no proven clean ephemeral image is available');
    }
    const data = this.persistence ? this.persistence.read() : this.cleanBytes;
    if (data !== null) assertSqliteImage(data);
    const current = ownDatabase(new this.sqlEngine!.Database(data ?? undefined));
    try {
      if (data === null) {
        this.schema!(current);
        sqlJsVersionHandle(current).setUserVersion(this.schemaVersion);
      } else if (sqlJsVersionHandle(current).getUserVersion() !== this.schemaVersion) {
        throw new Error('SQLiteStore: persisted schema changed; reopen the store before writing');
      }
      this.validateCurrentSchema?.(current);
      return current;
    } catch (error) { current.close(); throw error; }
  }

  private getDb(allowFenced = false): SqlDatabase {
    if (this.fenced && !allowFenced) throw new Error('SQLiteStore: cache fenced; reopen owner before ordinary writes');
    if (!this.db) {
      throw new Error('SQLiteStore: not initialized, call init() first');
    }
    return this.db;
  }
}

export class SQLiteObservationRetiredError extends Error {
  constructor() { super('SQLiteStore: observed publication is no longer current'); }
}
