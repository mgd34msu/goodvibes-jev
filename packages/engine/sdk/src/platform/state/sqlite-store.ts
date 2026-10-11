import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { openVersionedSchema, sqlJsVersionHandle } from './store-versioning.js';
import { restoreStoreSnapshot, snapshotStoreFile } from './store-snapshots.js';
import { imageDigest, SQLitePublicationError, SQLiteStorePersistence } from './sqlite-store-persistence.js';
import { sqliteLocalObservation } from './sqlite-local-observation.js';
import { nativeKnowledgeSchemaReadPlanMatches, validateNativeKnowledgeReadSchema, type NativeKnowledgeSchemaReadPlan } from './knowledge-schema-read-plan.js';

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

export interface PersistedKnowledgeRecordSelector {
  readonly kind: 'source' | 'node' | 'extraction';
  readonly id: string;
}

function captureRecordSelectors(value: readonly PersistedKnowledgeRecordSelector[]): PersistedKnowledgeRecordSelector[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('SQLiteStore: invalid record generation selectors');
  const array: object = value;
  const descriptors = Object.getOwnPropertyDescriptors(array);
  const length: unknown = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || Reflect.ownKeys(descriptors).length !== length + 1) throw new TypeError('SQLiteStore: invalid record generation selectors');
  const captured: PersistedKnowledgeRecordSelector[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) throw new TypeError('SQLiteStore: invalid record generation selector');
    const selector: unknown = descriptor.value;
    if (!selector || typeof selector !== 'object' || (Object.getPrototypeOf(selector) !== Object.prototype && Object.getPrototypeOf(selector) !== null)) {
      throw new TypeError('SQLiteStore: invalid record generation selector');
    }
    const fields = Object.getOwnPropertyDescriptors(selector);
    if (Reflect.ownKeys(fields).length !== 2 || !fields.kind || !fields.id || !('value' in fields.kind) || !('value' in fields.id)) {
      throw new TypeError('SQLiteStore: invalid record generation selector');
    }
    const kind: unknown = fields.kind.value, id: unknown = fields.id.value;
    if ((kind !== 'source' && kind !== 'node' && kind !== 'extraction') || typeof id !== 'string') throw new TypeError('SQLiteStore: invalid record generation selector');
    captured.push({ kind, id });
  }
  return captured;
}

interface NativeSqlStatement {
  step(): boolean;
  get(params?: (string | number)[] | null, config?: { useBigInt: boolean }): unknown[];
  getColumnNames(): string[];
  reset(): boolean;
  free(): boolean;
}

interface NativeSqlDatabase extends SqlDatabase {
  prepare(sql: string): NativeSqlStatement;
  create_function(name: string, callback: (...args: unknown[]) => unknown): void;
}

interface SqlJsStatic {
  Database: { new (data?: Uint8Array | Buffer): NativeSqlDatabase; readonly prototype: NativeSqlDatabase };
}

interface NativeProbePlans {
  readonly raw: NativeSqlDatabase;
  readonly identities: string;
  readonly statement: NativeSqlStatement;
  readonly dispose: () => void;
  readonly retired: boolean;
}

const nativeProbeSql = `SELECT r.read_uncommitted,d.seq,d.name,d.file,v.data_version,s.schema_version,
 EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name COLLATE NOCASE IN
 ('pragma_read_uncommitted','pragma_database_list','pragma_data_version','pragma_schema_version')) AS shadowed
 FROM main.pragma_read_uncommitted() AS r CROSS JOIN main.pragma_database_list() AS d
 CROSS JOIN main.pragma_data_version() AS v CROSS JOIN main.pragma_schema_version() AS s ORDER BY d.seq`;
const nativeProbeColumns = ['read_uncommitted', 'seq', 'name', 'file', 'data_version', 'schema_version', 'shadowed'];

interface OwnedSqlDatabase {
  readonly raw: NativeSqlDatabase;
  readonly identity: bigint;
  revision: bigint;
  inFlight: number;
  probePlans?: NativeProbePlans | undefined;
  memo?: { readonly revision: bigint; readonly probe: string; readonly digest: string } | undefined;
  cleanMemo?: { readonly revision: bigint; readonly probe: string; readonly digest: string } | undefined;
}
let nextDatabaseIdentity = 0n;
const ownedDatabases = new WeakMap<SqlDatabase, OwnedSqlDatabase>();
const unownedIdentities = new WeakMap<SqlDatabase, bigint>();

/** Never return sql.js's chainable run result or a native property/statement.
 * Every supported callback receives the same immutable four-method facade. */
function retireDatabaseProbe(state: OwnedSqlDatabase): void {
  const plans = state.probePlans;
  state.probePlans = undefined;
  plans?.dispose();
}

function ownDatabase(raw: NativeSqlDatabase): SqlDatabase {
  const state: OwnedSqlDatabase = { raw, identity: ++nextDatabaseIdentity, revision: 0n, inFlight: 0 };
  const operation = <T>(run: () => T): T => {
    state.revision++; state.inFlight++; state.memo = undefined; state.cleanMemo = undefined;
    try { retireDatabaseProbe(state); return run(); }
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

interface DatabaseProbe {
  readonly signature: string | null;
  readonly cacheable: boolean;
  readonly isolated: boolean;
  readonly guarded: boolean;
  readonly identities: readonly (readonly string[])[];
}

function executeProbePlans(statements: readonly NativeSqlStatement[]): ReturnType<SqlDatabase['exec']> {
  const results: ReturnType<SqlDatabase['exec']> = [];
  for (const statement of statements) {
    if (!statement.reset()) throw new SQLiteObservationRetiredError();
    try {
      const values: unknown[][] = [];
      while (statement.step()) values.push(statement.get(null, { useBigInt: true }));
      if (values.length) results.push({ columns: statement.getColumnNames(), values });
    } finally {
      if (!statement.reset()) throw new SQLiteObservationRetiredError();
    }
  }
  return results;
}

/** Only executable plans survive within the private synchronous frame. Every
 * probe steps fresh values, including native alias data_version changes. */
function installDatabaseProbe(state: OwnedSqlDatabase, identities: readonly (readonly string[])[]): void {
  retireDatabaseProbe(state);
  // This sql.js build's table-valued version PRAGMAs report main only.
  // Other database sets retain the complete schema-qualified PRAGMA path.
  if (identities.length !== 1 || identities[0]?.[0] !== '0' || identities[0]?.[1] !== 'main') return;
  let statement: NativeSqlStatement;
  try { statement = state.raw.prepare(nativeProbeSql); } catch { return; }
  let retired = false;
  const plans: NativeProbePlans = {
    raw: state.raw, identities: JSON.stringify(identities), statement,
    get retired() { return retired; },
    dispose() {
      if (retired) return;
      retired = true;
      if (!statement.free()) throw new SQLiteObservationRetiredError();
    },
  };
  state.probePlans = plans;
}

function databaseProbe(raw: SqlDatabase, plans?: NativeProbePlans): DatabaseProbe {
  const unsupported: DatabaseProbe = { signature: null, cacheable: false, isolated: false, guarded: false, identities: [] };
  if (plans?.retired) plans = undefined;
  if (plans) {
    let result: ReturnType<SqlDatabase['exec']> | undefined;
    if (raw === plans.raw) {
      try { result = executeProbePlans([plans.statement]); } catch { /* Use the original full probe below. */ }
    }
    const columns = result?.[0]?.columns, rows = result?.[0]?.values;
    const row = rows?.[0];
    if (result?.length === 1 && columns?.length === nativeProbeColumns.length
      && nativeProbeColumns.every((name, index) => columns[index] === name)
      && rows?.length === 1 && row?.length === 7) {
      const [mode, sequence, name, file, version, schemaVersion, shadowed] = row;
      if (mode === 0n && sequence === 0n && name === 'main' && typeof file === 'string'
        && !file.includes('\0') && !file.includes('\ufffd') && Buffer.from(file).toString('utf8') === file
        && typeof version === 'bigint' && typeof schemaVersion === 'bigint' && shadowed === 0n) {
        const identities = [[String(sequence), name, file]];
        if (JSON.stringify(identities) === plans.identities) {
          return { signature: JSON.stringify([String(mode), [[...identities[0]!, String(version), String(schemaVersion)]]]),
            cacheable: true, isolated: file === '', guarded: true, identities };
        }
      }
    }
    plans.dispose();
    return databaseProbe(raw);
  }
  let initial: ReturnType<SqlDatabase['exec']>;
  initial = raw.exec('PRAGMA read_uncommitted;PRAGMA database_list', undefined, { useBigInt: true });
  const mode = initial[0]?.values[0]?.[0];
  const databases = initial[1]?.values;
  if ((mode !== 0n && mode !== 1n) || !databases?.length) {
    return unsupported;
  }
  const identities: Array<readonly string[]> = [];
  const schemas: string[] = [];
  for (const row of databases) {
    const [sequence, name, file] = row;
    if (typeof sequence !== 'bigint' || typeof name !== 'string' || typeof file !== 'string'
      || [name, file].some(value => value.includes('\0') || value.includes('\ufffd') || Buffer.from(value).toString('utf8') !== value)) {
      return unsupported;
    }
    const schema = `"${name.replaceAll('"', '""')}"`;
    schemas.push(`PRAGMA ${schema}.data_version;PRAGMA ${schema}.schema_version`);
    identities.push([String(sequence), name, file]);
  }
  let versions: ReturnType<SqlDatabase['exec']>;
  versions = raw.exec(schemas.join(';'), undefined, { useBigInt: true });
  if (versions.length !== identities.length * 2) {
    return unsupported;
  }
  const observed = identities.map((identity, index) => {
    const version = versions[index * 2]?.values[0]?.[0], schemaVersion = versions[index * 2 + 1]?.values[0]?.[0];
    return typeof version === 'bigint' && typeof schemaVersion === 'bigint' ? [...identity, String(version), String(schemaVersion)] : null;
  });
  if (observed.some(identity => identity === null)) {
    return unsupported;
  }
  const guarded = mode === 0n && identities.filter(row => row[1] === 'main').length === 1
    && identities.every(row => row[1] === 'main' || row[1] === 'temp');
  return { signature: JSON.stringify([String(mode), observed]), cacheable: mode === 0n,
    isolated: guarded && identities.every(row => row[2] === ''), guarded, identities };
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
    const revision = state.revision, before = databaseProbe(state.raw, state.probePlans);
    const memo = mode === 'observation' ? state.memo : state.cleanMemo;
    const digest = before.cacheable && memo?.revision === revision && memo.probe === before.signature
      ? memo.digest : sqliteLocalObservation(state.raw, mode);
    const after = databaseProbe(state.raw, state.probePlans);
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
  /** Authentic source-defined plan; arbitrary validation callbacks retain their clone boundary. */
  readonly nativeSchemaReadPlan?: NativeKnowledgeSchemaReadPlan | undefined;
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

const frameImageStampBrand: unique symbol = Symbol('native-frame-image');
interface NativeFrameImageStamp { readonly [frameImageStampBrand]: true }
const frameImageStamps = new WeakMap<NativeFrameImageStamp, {
  readonly store: SQLiteStore;
  readonly frame: object;
  readonly data: Uint8Array;
  readonly persistence: SQLiteStorePersistence;
  readonly plan: NativeKnowledgeSchemaReadPlan;
  readonly validator: SqliteStoreInitOptions['validateCurrentSchema'];
  readonly schemaVersion: number;
  readonly imageEpoch: number;
  readonly observationEpoch: number;
  readonly digest: string;
}>();

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
  private nativeSchemaReadPlan: NativeKnowledgeSchemaReadPlan | undefined;
  private readonly privateSchemaImages = new WeakSet<SqlDatabase>();
  private imageEpoch = 0;
  private observationEpoch = 0;
  private persistedReadFrame: { db: SqlDatabase | null; owned: boolean; identity: string | undefined; local: string | undefined; persisted: string | undefined; poisoned: boolean; localState: OwnedSqlDatabase | undefined; localRevision: bigint | undefined; localProbe: string | undefined; localIsolated: boolean; rows: Map<string, ReturnType<SqlDatabase['exec']>>; generations: Map<string, string | null>; assertCurrent: (verifyNative?: boolean) => void } | null = null;
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
  readPersistedRow(table: 'knowledge_sources' | 'knowledge_nodes' | 'knowledge_extractions' | 'knowledge_edges',
    column: 'id' | 'canonical_uri', value: string): Array<{ columns: string[]; values: unknown[][] }> {
    try {
      if (!['knowledge_sources', 'knowledge_nodes', 'knowledge_extractions', 'knowledge_edges'].includes(table)
        || (column !== 'id' && !(table === 'knowledge_sources' && column === 'canonical_uri'))
        || typeof value !== 'string') {
        throw new TypeError('SQLiteStore: invalid raw record selector');
      }
      return this.readPrivatePersistedRows(`SELECT * FROM ${table} WHERE ${column} = ? LIMIT 1`, [value]);
    } catch (error) { if (this.persistedReadFrame) this.persistedReadFrame.poisoned = true; throw error; }
  }

  /** Complete raw values, with a primitive memo only in one certified frame. */
  readPersistedRowGeneration(table: 'knowledge_sources' | 'knowledge_nodes' | 'knowledge_extractions' | 'knowledge_edges',
    column: 'id' | 'canonical_uri', value: string): string | null {
    const frame = this.persistedReadFrame;
    try {
      if (!['knowledge_sources', 'knowledge_nodes', 'knowledge_extractions', 'knowledge_edges'].includes(table)
        || (column !== 'id' && !(table === 'knowledge_sources' && column === 'canonical_uri'))
        || typeof value !== 'string') throw new TypeError('SQLiteStore: invalid raw record selector');
      const key = JSON.stringify([table, column, value]);
      if (frame?.localState && frame.generations.has(key)) {
        frame.assertCurrent();
        return frame.generations.get(key)!;
      }
      const row = this.readPersistedRow(table, column, value)[0], values = row?.values[0];
      const entries = row && values ? row.columns.map((column, index) => [column, values[index]] as const)
        .sort(([left], [right]) => table === 'knowledge_sources' ? left < right ? -1 : left > right ? 1 : 0 : left.localeCompare(right)) : null;
      const generation = entries ? createHash('sha256').update(JSON.stringify(entries)).digest('hex') : null;
      frame?.assertCurrent();
      if (frame?.localState) frame.generations.set(key, generation);
      return generation;
    } catch (error) { if (frame) frame.poisoned = true; throw error; }
  }

  /** A closed primitive readset has no caller code between its physical fences. */
  readPersistedRecordGenerations(selectors: readonly PersistedKnowledgeRecordSelector[]): readonly (string | null)[] {
    let generations: readonly (string | null)[] = [];
    try {
      const captured = captureRecordSelectors(selectors);
      const read = (): undefined => {
        const frame = this.persistedReadFrame;
        frame?.assertCurrent();
        const values: (string | null)[] = [];
        for (const selector of captured) {
          const table = selector.kind === 'source' ? 'knowledge_sources' : selector.kind === 'node' ? 'knowledge_nodes' : 'knowledge_extractions';
          const key = JSON.stringify([table, 'id', selector.id]);
          if (frame?.localState && frame.generations.has(key)) {
            values.push(frame.generations.get(key)!);
            continue;
          }
          const row = this.readPrivatePersistedRows(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [selector.id], frame?.localState !== undefined)[0];
          const cells = row?.values[0];
          if (row && (!row.columns.every(column => typeof column === 'string')
            || row.values.some(cells => cells.some(cell => cell !== null && typeof cell !== 'string' && typeof cell !== 'number')))) {
            throw new SQLiteObservationRetiredError();
          }
          const entries = row && cells ? row.columns.map((column, index) => [column, cells[index]] as const)
            .sort(([left], [right]) => selector.kind === 'source' ? left < right ? -1 : left > right ? 1 : 0 : left.localeCompare(right)) : null;
          const generation = entries ? createHash('sha256').update(JSON.stringify(entries)).digest('hex') : null;
          if (frame?.localState) frame.generations.set(key, generation);
          values.push(generation);
        }
        frame?.assertCurrent();
        generations = Object.freeze(values);
      };
      if (this.persistedReadFrame?.localState) read(); else this.assertPersistedReadFrame(read);
      return generations;
    } catch (error) { if (this.persistedReadFrame) this.persistedReadFrame.poisoned = true; throw error; }
  }

  /** Closed edge-table read; endpoint bounds remain local knowledge identities. */
  readPersistedEdgeRows(): ReturnType<SqlDatabase['exec']> {
    return this.readPrivatePersistedRows('SELECT * FROM knowledge_edges', []);
  }

  readPersistedEdgeChanges(): ReturnType<SqlDatabase['exec']> {
    return this.readPrivatePersistedRows('SELECT CAST(sequence AS TEXT),from_kind,from_id,to_kind,to_id FROM knowledge_edge_changes', []);
  }

  readPersistedEdgeIncarnations(): ReturnType<SqlDatabase['exec']> {
    return this.readPrivatePersistedRows('SELECT edge_id,CAST(MAX(sequence) AS TEXT) FROM knowledge_edge_changes GROUP BY edge_id', []);
  }

  readPersistedEdgeIncarnation(id: string): ReturnType<SqlDatabase['exec']> {
    return this.readPrivatePersistedRows('SELECT CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM knowledge_edge_changes WHERE edge_id = ?', [id]);
  }

  readPersistedEdgeWindowGeneration(keys: readonly string[], incidentKeys?: readonly string[], includeUnselectedEndpoints = false): ReturnType<SqlDatabase['exec']> {
    try {
      if ([...keys, ...(incidentKeys ?? [])].some(key => typeof key !== 'string' || (!key.startsWith('source:') && !key.startsWith('node:')))) {
        throw new TypeError('SQLiteStore: invalid edge change window');
      }
      if (typeof includeUnselectedEndpoints !== 'boolean' || (includeUnselectedEndpoints && !incidentKeys?.length)) throw new TypeError('SQLiteStore: missing incident edge window');
      const slots = (values: readonly string[]) => values.map(() => '?').join(',');
      const from = "(from_kind || ':' || from_id)", to = "(to_kind || ':' || to_id)";
      const endpoints = includeUnselectedEndpoints ? '1' : keys.length ? `${from} IN (${slots(keys)}) AND ${to} IN (${slots(keys)})` : '0';
      const incident = incidentKeys ? incidentKeys.length
        ? ` AND (${from} IN (${slots(incidentKeys)}) OR ${to} IN (${slots(incidentKeys)}))` : ' AND 0' : '';
      return this.readPrivatePersistedRows(`SELECT CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM knowledge_edge_changes WHERE ${endpoints}${incident}`,
        [...(includeUnselectedEndpoints ? [] : [...keys, ...keys]), ...(incidentKeys ?? []), ...(incidentKeys ?? [])]);
    } catch (error) { if (this.persistedReadFrame) this.persistedReadFrame.poisoned = true; throw error; }
  }

  private readPrivatePersistedRows(sql: string, params: string[], closedReadSet = false): ReturnType<SqlDatabase['exec']> {
    if (!this.coordinated) throw new Error('SQLiteStore: persisted reads require coordinated storage');
    const frame = this.persistedReadFrame;
    try {
      if (!frame) {
        // Closed internal selectors must not self-retire live ephemeral receipts.
        // Arbitrary legacy callbacks still use the revision-tracked facade.
        if (!this.persistence) return readDatabaseRow(this.getDb(), sql, params);
        const current = this.openCurrentImage();
        try { return readDatabaseRow(current, sql, params); } finally { this.closeReadImage(current); }
      }
      frame.assertCurrent(!closedReadSet);
      if (!frame.db) {
        frame.identity = this.persistence?.observationIdentity();
        frame.local = observeDatabase(this.getDb());
        const localState = ownedDatabases.get(this.getDb()), revision = localState?.revision;
        const probe = localState ? databaseProbe(localState.raw) : undefined;
        if (localState && probe?.guarded && probe.signature !== null) {
          if (localState.inFlight || localState.revision !== revision) throw new SQLiteObservationRetiredError();
          frame.localState = localState; frame.localRevision = revision;
          frame.localProbe = probe.signature; frame.localIsolated = probe.isolated;
          installDatabaseProbe(localState, probe.identities);
        }
        const persisted = this.persistence?.read();
        frame.persisted = persisted ? imageDigest(persisted) : undefined;
        const plan = this.nativeSchemaReadPlan;
        const stamp = persisted && this.persistence && plan && frame.localState
          && nativeKnowledgeSchemaReadPlanMatches(plan, this.validateCurrentSchema, this.schemaVersion)
          ? Object.freeze<NativeFrameImageStamp>({ [frameImageStampBrand]: true }) : undefined;
        if (stamp && persisted && this.persistence && plan && frame.persisted) {
          frameImageStamps.set(stamp, { store: this, frame, data: persisted, persistence: this.persistence,
            plan, validator: this.validateCurrentSchema, schemaVersion: this.schemaVersion,
            imageEpoch: this.imageEpoch, observationEpoch: this.observationEpoch, digest: frame.persisted });
        }
        try { frame.db = this.openPrivateReadImage(stamp); }
        finally { if (stamp) frameImageStamps.delete(stamp); }
        frame.owned = true;
        frame.assertCurrent();
      }
      const key = JSON.stringify([sql, params]);
      const copyRows = (rows: ReturnType<SqlDatabase['exec']>) => rows.map(row => ({ columns: [...row.columns], values: row.values.map(values => [...values]) }));
      const previous = frame.rows.get(key);
      if (previous) return copyRows(previous);
      const result = readDatabaseRow(frame.db, sql, params);
      if (result.every(row => row.values.every(values => values.every(value => value === null || typeof value === 'string' || typeof value === 'number')))) frame.rows.set(key, copyRows(result));
      frame.assertCurrent(!closedReadSet);
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
        if (active.db) {
          const localState = active.localState;
          if (localState) {
            const state = ownedDatabases.get(this.getDb());
            if (state !== localState || state.inFlight || state.revision !== active.localRevision) throw new SQLiteObservationRetiredError();
          } else if (observeDatabase(this.getDb()) !== active.local) throw new SQLiteObservationRetiredError();
        }
      };
      try { assertNestedCurrent(); invoke(); assertNestedCurrent(); }
      catch (error) { active.poisoned = true; throw error; }
      return;
    }
    const observationEpoch = this.observationEpoch, imageEpoch = this.imageEpoch;
    const frame = {
      db: null as SqlDatabase | null, owned: false, identity: undefined as string | undefined,
      local: undefined as string | undefined, persisted: undefined as string | undefined, poisoned: false,
      localState: undefined as OwnedSqlDatabase | undefined, localRevision: undefined as bigint | undefined,
      localProbe: undefined as string | undefined, localIsolated: false,
      rows: new Map<string, ReturnType<SqlDatabase['exec']>>(),
      generations: new Map<string, string | null>(),
      assertCurrent: (verifyNative = true) => {
        if (frame.poisoned || this.observationEpoch !== observationEpoch || this.imageEpoch !== imageEpoch
          || (frame.db !== null && this.persistence?.observationIdentity() !== frame.identity)) {
          throw new SQLiteObservationRetiredError();
        }
        if (frame.localState) {
          const state = ownedDatabases.get(this.getDb());
          if (state !== frame.localState || state.inFlight || state.revision !== frame.localRevision) throw new SQLiteObservationRetiredError();
          if (verifyNative && !frame.localIsolated && databaseProbe(state.raw, state.probePlans).signature !== frame.localProbe) throw new SQLiteObservationRetiredError();
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
      try { if (frame.localState) retireDatabaseProbe(frame.localState); }
      finally { if (frame.owned && frame.db) this.closeReadImage(frame.db); }
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

  /** Prepared imports have their own durable boundary, including inside a
   * deferred-save batch. Stage the captured prefix privately; ordinary failed
   * saves still retain their live pending rows under their existing contract. */
  publishPrepared(operation: (db: SqlDatabase) => void, assertCurrent: () => void, onCommit: () => void): Promise<void> {
    if (!this.coordinated) return Promise.reject(new Error('SQLiteStore: prepared publication requires coordinated storage'));
    assertCurrent();
    const original = this.getDb(), persistence = this.persistence, epoch = this.imageEpoch;
    const prefix = original.export();
    const local = observeDatabase(original);
    const staged = ownDatabase(new this.sqlEngine!.Database(prefix));
    let data: Uint8Array, cleanContent: string | null, stagedLocal: string;
    try {
      const result: unknown = operation(staged);
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => {});
        throw new TypeError('SQLiteStore: prepared operation must be synchronous and return no value');
      }
      assertCurrent();
      data = staged.export();
      cleanContent = this.readCleanContent(staged);
      stagedLocal = observeDatabase(staged);
    } catch (error) { staged.close(); return Promise.reject(error); }
    const assertOwnedImage = () => {
      if (this.getDb() !== original || this.persistence !== persistence || this.imageEpoch !== epoch
        || observeDatabase(original) !== local || observeDatabase(staged) !== stagedLocal) {
        throw new Error('SQLiteStore: prepared image was superseded by local changes');
      }
    };
    const adopt = () => {
      this.db = staged;
      this.imageEpoch += 1;
      this.observationEpoch += 1;
      this.cleanContent = cleanContent;
      this.cleanBytes = persistence ? null : data;
      try { original.close(); } catch { /* The replaced image has no current authority. */ }
      onCommit();
    };
    return this.enqueue(async () => {
      let release: (() => void) | undefined, adopted = false;
      try {
        release = persistence ? await persistence.lock() : () => {};
        assertOwnedImage();
        assertCurrent();
        assertOwnedImage();
        try { persistence?.writeIfCurrent(data); }
        catch (error) {
          if (error instanceof SQLitePublicationError && error.phase === 'indeterminate') {
            // A failed directory sync cannot undo a visible rename. Mirror only
            // our exact current image; never restore bytes or adopt another winner.
            try {
              assertOwnedImage();
              const published = persistence?.read();
              if (published && imageDigest(published) === imageDigest(data)) {
                adopted = true;
                adopt();
              }
            } catch { /* An unresolved publication stays fenced until reopen. */ }
            this.fenced = true;
          }
          throw error;
        }
        adopted = true;
        try { adopt(); } catch (error) { this.fenced = true; throw error; }
      } finally {
        if (!adopted) try { staged.close(); } catch { /* Detached image cleanup. */ }
        try { release?.(); } catch { this.fenced = true; }
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
      this.nativeSchemaReadPlan = options.nativeSchemaReadPlan;
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

  /** Callback-exposed images require a private clone. The closed native schema
   * plan can keep its unloaned image when every linked authority table is empty. */
  private openPrivateReadImage(stamp?: NativeFrameImageStamp): SqlDatabase {
    const exposed = this.openCurrentImage(this.nativeSchemaReadPlan, stamp);
    if (this.privateSchemaImages.delete(exposed)) return exposed;
    try { return ownDatabase(new this.sqlEngine!.Database(exposed.export())); }
    finally { this.closeReadImage(exposed); }
  }

  private openCurrentImage(privateReadPlan?: NativeKnowledgeSchemaReadPlan, stamp?: NativeFrameImageStamp): SqlDatabase {
    this.getDb(true);
    if (!this.persistence && (this.cleanContent === null || this.cleanBytes === null
      || observeDatabase(this.getDb(), 'clean-content') !== this.cleanContent)) {
      throw new Error('SQLiteStore: no proven clean ephemeral image is available');
    }
    let entryBytes: Uint8Array | undefined;
    if (stamp) {
      const captured = frameImageStamps.get(stamp), frame = this.persistedReadFrame;
      if (captured?.store === this) frameImageStamps.delete(stamp);
      if (captured?.store === this && captured.frame === frame && frame && frame.db === null
        && captured.persistence === this.persistence && captured.plan === privateReadPlan && privateReadPlan === this.nativeSchemaReadPlan
        && captured.validator === this.validateCurrentSchema && captured.schemaVersion === this.schemaVersion
        && captured.imageEpoch === this.imageEpoch && captured.observationEpoch === this.observationEpoch
        && captured.digest === frame.persisted
        && nativeKnowledgeSchemaReadPlanMatches(privateReadPlan, this.validateCurrentSchema, this.schemaVersion)) {
        frame.assertCurrent();
        if (captured.persistence.observationIdentity() !== frame.identity) throw new SQLiteObservationRetiredError();
        entryBytes = captured.data;
      }
    }
    const data = entryBytes ?? (this.persistence ? this.persistence.read() : this.cleanBytes);
    if (data !== null) assertSqliteImage(data);
    const current = ownDatabase(new this.sqlEngine!.Database(data ?? undefined));
    try {
      if (data === null) {
        this.schema!(current);
        sqlJsVersionHandle(current).setUserVersion(this.schemaVersion);
      } else if (sqlJsVersionHandle(current).getUserVersion() !== this.schemaVersion) {
        throw new Error('SQLiteStore: persisted schema changed; reopen the store before writing');
      }
      if (data !== null && nativeKnowledgeSchemaReadPlanMatches(privateReadPlan, this.validateCurrentSchema, this.schemaVersion)
        && validateNativeKnowledgeReadSchema({ exec: sql => readDatabaseRow(current, sql, []) })) {
        this.privateSchemaImages.add(current);
      } else this.validateCurrentSchema?.(current);
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
