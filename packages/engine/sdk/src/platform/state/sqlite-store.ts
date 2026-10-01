import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { openVersionedSchema, sqlJsVersionHandle } from './store-versioning.js';
import { restoreStoreSnapshot, snapshotStoreFile } from './store-snapshots.js';
import { imageDigest, SQLiteStorePersistence } from './sqlite-store-persistence.js';

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
  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array | Buffer) => SqlDatabase;
}

function isEphemeralDbPath(path: string | null | undefined): boolean {
  if (!path) return true;
  if (path === ':memory:') return true;
  return /^file:.*(?:^|[?&])mode=memory(?:&|$)/.test(path);
}

export interface SqliteStoreInitOptions {
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
  private cleanImage: string | null = null;
  private sqlEngine: SqlJsStatic | null = null;
  private schema: ((db: SqlDatabase) => void) | null = null;
  private schemaVersion = 1;
  private imageEpoch = 0;

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
    this.getDb().run(sql, params);
  }

  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> {
    return this.getDb().exec(sql, params);
  }

  /** Read one current persisted image without replacing pending local state. */
  readPersisted<T>(read: (db: SqlDatabase) => T): T {
    if (!this.coordinated) throw new Error('SQLiteStore: persisted reads require coordinated storage');
    if (!this.persistence) return read(this.getDb());
    const current = this.openCurrentImage();
    try { return read(current); } finally { current.close(); }
  }

  /**
   * Compare and mutate one fresh image synchronously under file ownership.
   * Local/batched changes are never discarded to make a guarded write fit.
   * The commit callback refreshes mirrors before another operation can enter.
   */
  async transactPersisted<T>(
    operation: (db: SqlDatabase) => { readonly changed: boolean; readonly value: T },
    onCommit: () => void,
  ): Promise<{ readonly kind: 'local-changes' } | { readonly kind: 'completed'; readonly value: T }> {
    if (!this.coordinated) throw new Error('SQLiteStore: guarded persistence requires coordinated storage');
    const release = this.persistence ? await this.persistence.lock() : () => {};
    let current: SqlDatabase | null = null;
    try {
      if (this.saveBatchDepth > 0 || imageDigest(this.getDb().export()) !== this.cleanImage) {
        return { kind: 'local-changes' };
      }
      current = this.openCurrentImage();
      const result = operation(current);
      if (result.changed) {
        const data = current.export();
        this.persistence?.write(data);
        const previous = this.db;
        this.db = current;
        current = null;
        this.imageEpoch += 1;
        this.cleanImage = imageDigest(data);
        previous?.close();
        onCommit();
      }
      return { kind: 'completed', value: result.value };
    } finally {
      current?.close();
      release();
    }
  }

  async batch<T>(operation: () => Promise<T>): Promise<T> {
    this.saveBatchDepth += 1;
    try {
      return await operation();
    } finally {
      this.saveBatchDepth -= 1;
      if (this.saveBatchDepth === 0 && this.saveDirty) {
        this.saveDirty = false;
        await this.save();
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
      if (this.coordinated) this.cleanImage = imageDigest(this.db.export());
      return false;
    }

    if (this.persistence) {
      // Capture at admission. Later same-handle writes may already be queued;
      // they must not change which image this particular save publishes.
      const data = this.db.export();
      const epoch = this.imageEpoch;
      const release = await this.persistence.lock();
      try {
        this.getDb(); // Closing a handle also cancels its pending saves.
        if (this.imageEpoch !== epoch) {
          throw new Error('SQLiteStore: persisted state changed; captured image was superseded');
        }
        this.persistence.writeIfCurrent(data);
        this.cleanImage = imageDigest(data);
        return true;
      } finally { release(); }
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
      if (this.coordinated && this.dbPath && !isEphemeralDbPath(this.dbPath)) {
        this.persistence = new SQLiteStorePersistence(this.dbPath);
        release = await this.persistence.lock();
      }
      const dbPath = this.persistence?.path ?? this.dbPath;
      const persistent = Boolean(dbPath && !isEphemeralDbPath(dbPath));
      const existedOnDisk = persistent && existsSync(dbPath!);
      const original = this.persistence?.read() ?? (existedOnDisk ? readFileSync(dbPath!) : null);
      this.persistence?.acceptBaseline(original);

      if (existedOnDisk) {
        this.db = new SQL.Database(original!);
        logger.info('SQLiteStore: loaded from disk', { path: dbPath });
      } else {
        this.db = new SQL.Database();
        logger.info('SQLiteStore: initialized in-memory');
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
              restoreStoreSnapshot(dbPath!, snapshotPath);
              if (this.coordinated) this.db?.close();
              this.db = new SQL.Database(readFileSync(dbPath!));
            }
          : undefined,
      });
      // The base schema always runs (it is IF NOT EXISTS-idempotent) so a
      // store already at the target version still gets any session tables.
      schema(this.getDb());
      // Persist a freshly-stamped version so the next open skips migration,
      // but only for a store that already lived on disk: a brand-new store
      // keeps the long-standing contract of touching disk on first save().
      if (result.applied.length > 0 && existedOnDisk) {
        if (this.persistence) this.persistence.writeIfCurrent(this.getDb().export());
        else await this.save();
      }
      if (this.coordinated) this.cleanImage = imageDigest(this.getDb().export());
    } catch (err) {
      if (this.coordinated) this.db?.close();
      this.db = null;
      logger.error('SQLiteStore: failed to initialize', {
        error: summarizeError(err),
      });
      throw err;
    } finally {
      release?.();
    }
  }

  private openCurrentImage(): SqlDatabase {
    this.getDb();
    const data = this.persistence ? this.persistence.read() : this.getDb().export();
    const current = new this.sqlEngine!.Database(data ?? undefined);
    try {
      if (data === null) {
        this.schema!(current);
        sqlJsVersionHandle(current).setUserVersion(this.schemaVersion);
      } else if (sqlJsVersionHandle(current).getUserVersion() !== this.schemaVersion) {
        throw new Error('SQLiteStore: persisted schema changed; reopen the store before writing');
      }
      this.schema!(current);
      return current;
    } catch (error) { current.close(); throw error; }
  }

  private getDb(): SqlDatabase {
    if (!this.db) {
      throw new Error('SQLiteStore: not initialized, call init() first');
    }
    return this.db;
  }
}
