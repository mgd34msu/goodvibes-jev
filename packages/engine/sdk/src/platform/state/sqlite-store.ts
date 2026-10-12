import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { types as nativeNodeTypes } from 'node:util';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { openVersionedSchema, sqlJsVersionHandle } from './store-versioning.js';
import { restoreStoreSnapshot, snapshotStoreFile } from './store-snapshots.js';
import { imageDigest, SQLitePublicationError, SQLiteStorePersistence } from './sqlite-store-persistence.js';
import { sqliteLocalObservation } from './sqlite-local-observation.js';
import { nativeKnowledgeSchemaReadPlanMatches, validateNativeKnowledgeReadSchema, type NativeKnowledgeSchemaReadPlan } from './knowledge-schema-read-plan.js';
import { knowledgeRecordTableSql } from '../knowledge/store-schema-validation-data.js';

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
      .then(engine => {
        const constructor = engine.Database, prototype = constructor.prototype;
        const scalar = captureNativeScalarRuntime(engine);
        privateMapSet(nativeEngineIdentities, engine, nativeFreeze({ constructor, prototype,
          methods: nativeFreeze({ run: prototype.run, exec: prototype.exec,
            export: prototype.export, close: prototype.close,
            prepare: prototype.prepare, create_function: prototype.create_function }),
          statement: captureNativeStatementIdentity(constructor),
          scalar,
        }));
        return engine;
      })
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

const expectedReadsetBrand: unique symbol = Symbol('expected-native-record-readset');
export interface ExpectedKnowledgeRecordReadset { readonly [expectedReadsetBrand]: true }
export interface ExpectedKnowledgeRecordReadsetInput {
  readonly expected: ExpectedKnowledgeRecordReadset;
  readonly selectors: readonly PersistedKnowledgeRecordSelector[];
}

function captureExpectedReadsets(value: readonly ExpectedKnowledgeRecordReadsetInput[]) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('SQLiteStore: invalid expected readsets');
  const array: object = value;
  const descriptors = Object.getOwnPropertyDescriptors(array);
  const length: unknown = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || Reflect.ownKeys(descriptors).length !== length + 1) throw new TypeError('SQLiteStore: invalid expected readsets');
  const captured: { expected: ExpectedKnowledgeRecordReadset; selectors: PersistedKnowledgeRecordSelector[] }[] = [];
  for (let index = 0; index < length; index++) {
    const entry = descriptors[String(index)];
    if (!entry || !('value' in entry)) throw new TypeError('SQLiteStore: invalid expected readset');
    const input: unknown = entry.value;
    if (!input || typeof input !== 'object' || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
      throw new TypeError('SQLiteStore: invalid expected readset');
    }
    const fields = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(fields).length !== 2 || !fields.expected || !fields.selectors
      || !('value' in fields.expected) || !('value' in fields.selectors)) throw new TypeError('SQLiteStore: invalid expected readset');
    const expected: unknown = fields.expected.value;
    if (!expected || typeof expected !== 'object' || !privateMapHas(expectedRecordReadsets, expected)) throw new TypeError('SQLiteStore: unknown expected readset');
    const retained = privateMapGet(expectedRecordReadsets, expected);
    if (!retained) throw new TypeError('SQLiteStore: unknown expected readset');
    captured.push({ expected: retained.token, selectors: captureRecordSelectors(fields.selectors.value) });
  }
  return captured;
}

function captureRecordSelectors(value: unknown): PersistedKnowledgeRecordSelector[] {
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

function captureRecordSelectorGroups(value: readonly (readonly PersistedKnowledgeRecordSelector[])[]): PersistedKnowledgeRecordSelector[][] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('SQLiteStore: invalid record generation groups');
  const descriptors = Object.getOwnPropertyDescriptors(value), length: unknown = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || Reflect.ownKeys(descriptors).length !== length + 1) throw new TypeError('SQLiteStore: invalid record generation groups');
  const captured: PersistedKnowledgeRecordSelector[][] = [];
  for (let index = 0; index < length; index++) {
    const entry = descriptors[String(index)];
    if (!entry || !('value' in entry)) throw new TypeError('SQLiteStore: invalid record generation group');
    captured.push(captureRecordSelectors(entry.value));
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
  readonly _sqlite3_prepare_v2?: ((...args: number[]) => number) | undefined;
  readonly _sqlite3_step?: ((statement: number) => number) | undefined;
  readonly _sqlite3_reset?: ((statement: number) => number) | undefined;
  readonly _sqlite3_clear_bindings?: ((statement: number) => number) | undefined;
  readonly _sqlite3_finalize?: ((statement: number) => number) | undefined;
  readonly _sqlite3_column_count?: ((statement: number) => number) | undefined;
  readonly _sqlite3_data_count?: ((statement: number) => number) | undefined;
  readonly _sqlite3_column_type?: ((statement: number, column: number) => number) | undefined;
  readonly _sqlite3_column_double?: ((statement: number, column: number) => number) | undefined;
  readonly _sqlite3_column_name?: ((statement: number, column: number) => number) | undefined;
  readonly UTF8ToString?: ((pointer: number) => string) | undefined;
}

type NativeEngineMethods = Pick<NativeSqlDatabase, 'run' | 'exec' | 'export' | 'close' | 'prepare' | 'create_function'>;
type NativeStatementMethods = Pick<NativeSqlStatement, 'reset' | 'step' | 'get' | 'getColumnNames' | 'free'>;
const nativeOwnKeys = Reflect.ownKeys, nativeApply = Reflect.apply;
const nativeGetPrototypeOf = Object.getPrototypeOf, nativeGetDescriptor = Object.getOwnPropertyDescriptor, nativeHasOwn = Object.hasOwn;
const nativeDefineProperty = Object.defineProperty, nativeDeleteProperty = Reflect.deleteProperty, nativeIsExtensible = Object.isExtensible;
const nativeEntries = Object.entries, nativeIsProxy = nativeNodeTypes.isProxy;
const nativeString = String, nativeSafeInteger = Number.isSafeInteger, nativeIsArray = Array.isArray, nativeFreeze = Object.freeze;
const nativeGlobalReceiver = globalThis;
const nativeGlobalReceiverSelf = !nativeIsProxy(nativeGlobalReceiver)
  ? nativeGetDescriptor(nativeGlobalReceiver, 'globalThis') : undefined;
function nativeGlobalReceiverMatches(): boolean {
  return !!nativeGlobalReceiverSelf && 'value' in nativeGlobalReceiverSelf
    && nativeGlobalReceiverSelf.value === nativeGlobalReceiver
    && nativeDescriptorMatches(nativeGetDescriptor(nativeGlobalReceiver, 'globalThis'), nativeGlobalReceiverSelf)
    && globalThis === nativeGlobalReceiver;
}
const nativeWeakMapGet = WeakMap.prototype.get, nativeWeakMapSet = WeakMap.prototype.set,
  nativeWeakMapHas = WeakMap.prototype.has, nativeWeakMapDelete = WeakMap.prototype.delete;
function privateMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return nativeApply(nativeWeakMapGet, map, [key]);
}
function privateMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  nativeApply(nativeWeakMapSet, map, [key, value]);
}
function privateMapHas<K extends object, V>(map: WeakMap<K, V>, key: K): boolean {
  return nativeApply(nativeWeakMapHas, map, [key]);
}
function privateMapDelete<K extends object, V>(map: WeakMap<K, V>, key: K): void {
  nativeApply(nativeWeakMapDelete, map, [key]);
}
function nativeEvery<T>(values: readonly T[], predicate: (value: T) => boolean): boolean {
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === undefined || !predicate(value)) return false;
  }
  return true;
}
interface NativeObjectFacts {
  readonly object: object;
  readonly prototype: object | null;
  readonly slots: readonly { readonly key: PropertyKey; readonly descriptor: Readonly<PropertyDescriptor> }[];
}
function captureNativeObjectFacts(object: object): NativeObjectFacts {
  return nativeFreeze({ object, prototype: nativeGetPrototypeOf(object),
    slots: nativeFreeze(nativeOwnKeys(object).map(key => {
      const descriptor = nativeGetDescriptor(object, key);
      if (!descriptor) throw new SQLiteObservationRetiredError();
      return nativeFreeze({ key, descriptor: nativeFreeze(descriptor) });
    })) });
}
function nativeDescriptorMatches(current: PropertyDescriptor | undefined, original: Readonly<PropertyDescriptor>): boolean {
  return !!current && current.configurable === original.configurable && current.enumerable === original.enumerable
    && ('value' in current) === ('value' in original) && current.value === original.value
    && current.writable === original.writable && current.get === original.get && current.set === original.set;
}
function nativeObjectFactsMatch(facts: NativeObjectFacts): boolean {
  return nativeGetPrototypeOf(facts.object) === facts.prototype && nativeOwnKeys(facts.object).length === facts.slots.length
    && nativeEvery(facts.slots, ({ key, descriptor }) => nativeDescriptorMatches(nativeGetDescriptor(facts.object, key), descriptor));
}
function captureNativePrototypeFacts(prototype: object | null): readonly NativeObjectFacts[] {
  const facts: NativeObjectFacts[] = [], seen = new Set<object>();
  for (let current = prototype; current; current = nativeGetPrototypeOf(current)) {
    if (seen.has(current)) throw new SQLiteObservationRetiredError();
    seen.add(current); facts.push(captureNativeObjectFacts(current));
  }
  return nativeFreeze(facts);
}
interface NativeStatementIdentity {
  readonly constructor: object;
  readonly constructorPrototype: Readonly<PropertyDescriptor>;
  readonly prototype: object;
  readonly methods: Readonly<NativeStatementMethods>;
  readonly prototypes: readonly NativeObjectFacts[];
  readonly ownerPrototypes: readonly NativeObjectFacts[];
  readonly arrayPrototypes: readonly (readonly NativeObjectFacts[])[];
  readonly uniqueExecutionFacts: readonly NativeObjectFacts[] | undefined;
  readonly bigint: Readonly<PropertyDescriptor>;
}
function captureNativeStatementIdentity(Database: SqlJsStatic['Database']): NativeStatementIdentity | undefined {
  const raw = new Database();
  let statement: NativeSqlStatement | undefined, original: NativeStatementIdentity | undefined;
  try {
    statement = raw.prepare('SELECT 1');
    const prototype: unknown = Object.getPrototypeOf(statement);
    if (prototype && typeof prototype === 'object') {
      const constructor: unknown = nativeGetDescriptor(prototype, 'constructor')?.value;
      const constructorPrototype = typeof constructor === 'function' ? nativeGetDescriptor(constructor, 'prototype') : undefined;
      if (typeof constructor !== 'function' || !constructorPrototype || constructorPrototype.value !== prototype) return undefined;
      const methods = nativeFreeze({ reset: statement.reset, step: statement.step, get: statement.get,
        getColumnNames: statement.getColumnNames, free: statement.free });
      const bigint = Object.getOwnPropertyDescriptor(globalThis, 'BigInt');
      if (!bigint || typeof bigint.value !== 'function') return undefined;
      const constructorPrototypeSnapshot = nativeFreeze(constructorPrototype);
      const prototypes = captureNativePrototypeFacts(prototype);
      const ownerPrototypes = captureNativePrototypeFacts(Object.getPrototypeOf(raw));
      const bigintSnapshot = nativeFreeze(bigint);
      const arrayPrototypes = nativeFreeze(Object.values(Object.getOwnPropertyDescriptors(statement)).flatMap(descriptor => Array.isArray(descriptor.value)
        ? [captureNativePrototypeFacts(Object.getPrototypeOf(descriptor.value))] : []));
      const groups: { readonly facts: readonly NativeObjectFacts[] }[] = [{ facts: prototypes }];
      for (let index = 0; index < arrayPrototypes.length; index++) {
        const facts = arrayPrototypes[index];
        if (!facts) return undefined;
        nativeDefineProperty(groups, groups.length, { value: { facts }, configurable: true, enumerable: true, writable: true });
      }
      const candidate = nativeFreeze({ constructor, constructorPrototype: constructorPrototypeSnapshot,
        prototype, methods, prototypes, ownerPrototypes, bigint: bigintSnapshot, arrayPrototypes,
        uniqueExecutionFacts: uniqueNativeFacts(groups) });
      if (nativeStatementMethodsMatch(candidate, statement)) original = candidate;
    }
  } catch { /* Unsupported native statement identities keep the original full path. */ }
  finally {
    try { if (statement && !statement.free()) original = undefined; }
    catch { original = undefined; }
    finally { raw.close(); }
  }
  return original;
}
function nativeStatementMethodsMatch(original: NativeStatementIdentity, statement: NativeSqlStatement): boolean {
  return nativeDescriptorMatches(nativeGetDescriptor(original.constructor, 'prototype'), original.constructorPrototype)
    && Object.getPrototypeOf(statement) === original.prototype
    && original.prototypes.every(nativeObjectFactsMatch)
    && original.arrayPrototypes.every(facts => facts.every(nativeObjectFactsMatch))
    && nativeDescriptorMatches(Object.getOwnPropertyDescriptor(globalThis, 'BigInt'), original.bigint)
    && original.prototypes.every(fact => fact.slots.every(({ key }) => !Object.hasOwn(statement, key)))
    && Object.values(original.methods).every(method => typeof method === 'function');
}
/** The public native execution path creates and frees its JavaScript statement
 * before returning; the private executable has a separate owned lifetime. */
function nativeOwnerPrototypeFactsMatch(original: NativeStatementIdentity): boolean {
  return nativeEvery(original.ownerPrototypes, facts => nativeGetPrototypeOf(facts.object) === facts.prototype
    && nativeOwnKeys(facts.object).length === facts.slots.length
    && nativeEvery(facts.slots, ({ key, descriptor }) => key === 'exec'
      || nativeDescriptorMatches(nativeGetDescriptor(facts.object, key), descriptor)));
}
function nativeOwnerDependenciesMatch(original: NativeStatementIdentity, raw: NativeSqlDatabase): boolean {
  // Only the loader-pinned implementation executes; public exec observers may
  // observe complete probes but cannot supply the scalar implementation.
  return nativeOwnerPrototypeFactsMatch(original)
    && nativeEvery(original.ownerPrototypes, facts => nativeEvery(facts.slots, ({ key }) => key === 'exec' || !nativeHasOwn(raw, key)));
}
function nativeExecutionDependenciesMatch(original: NativeStatementIdentity, raw: NativeSqlDatabase): boolean {
  return nativeDescriptorMatches(nativeGetDescriptor(original.constructor, 'prototype'), original.constructorPrototype)
    && (original.uniqueExecutionFacts ? nativeEvery(original.uniqueExecutionFacts, nativeObjectFactsMatch)
      : nativeEvery(original.prototypes, nativeObjectFactsMatch)
        && nativeEvery(original.arrayPrototypes, facts => nativeEvery(facts, nativeObjectFactsMatch)))
    && nativeDescriptorMatches(nativeGetDescriptor(globalThis, 'BigInt'), original.bigint)
    && nativeOwnerDependenciesMatch(original, raw);
}
interface NativeScalarRuntime {
  readonly module: SqlJsStatic;
  readonly exports: readonly { readonly key: keyof SqlJsStatic; readonly descriptor: Readonly<PropertyDescriptor> }[];
  readonly globals: readonly { readonly key: string; readonly descriptor: Readonly<PropertyDescriptor>; readonly facts: readonly NativeObjectFacts[] }[];
  readonly uniqueGlobalFacts: readonly NativeObjectFacts[] | undefined;
  readonly step: (statement: number) => number;
  readonly reset: (statement: number) => number;
  readonly clear: (statement: number) => number;
  readonly finalize: (statement: number) => number;
  readonly count: (statement: number) => number;
  readonly dataCount: (statement: number) => number;
  readonly type: (statement: number, column: number) => number;
  readonly value: (statement: number, column: number) => number;
  readonly name: (statement: number, column: number) => number;
  readonly decode: (pointer: number) => string;
}
/** Only repeated ordinary original objects can share one complete descriptor
 * traversal. Unsupported or conflicting captures keep the original checks. */
function uniqueNativeFacts(groups: readonly { readonly facts: readonly NativeObjectFacts[] }[]): readonly NativeObjectFacts[] | undefined {
  const unique: NativeObjectFacts[] = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (!group) return undefined;
    for (let factIndex = 0; factIndex < group.facts.length; factIndex++) {
      const facts = group.facts[factIndex];
      if (!facts || nativeIsProxy(facts.object)) return undefined;
      let duplicate = false;
      for (let uniqueIndex = 0; uniqueIndex < unique.length; uniqueIndex++) {
        const original = unique[uniqueIndex];
        if (!original || original.object !== facts.object) continue;
        if (original.prototype !== facts.prototype || original.slots.length !== facts.slots.length) return undefined;
        for (let slotIndex = 0; slotIndex < original.slots.length; slotIndex++) {
          const left = original.slots[slotIndex], right = facts.slots[slotIndex];
          if (!left || !right || left.key !== right.key || !nativeDescriptorMatches(right.descriptor, left.descriptor)) return undefined;
        }
        duplicate = true;
        break;
      }
      if (!duplicate) nativeDefineProperty(unique, unique.length, { value: facts, configurable: true, enumerable: true, writable: true });
    }
  }
  return nativeFreeze(unique);
}
function captureNativeScalarRuntime(module: SqlJsStatic): NativeScalarRuntime | undefined {
  const step = module._sqlite3_step, reset = module._sqlite3_reset, clear = module._sqlite3_clear_bindings,
    finalize = module._sqlite3_finalize, count = module._sqlite3_column_count, dataCount = module._sqlite3_data_count,
    type = module._sqlite3_column_type, value = module._sqlite3_column_double, name = module._sqlite3_column_name,
    decode = module.UTF8ToString;
  if (typeof module._sqlite3_prepare_v2 !== 'function' || typeof step !== 'function' || typeof reset !== 'function'
    || typeof clear !== 'function' || typeof finalize !== 'function' || typeof count !== 'function'
    || typeof dataCount !== 'function' || typeof type !== 'function' || typeof value !== 'function'
    || typeof name !== 'function' || typeof decode !== 'function') return undefined;
  const keys: readonly (keyof SqlJsStatic)[] = ['_sqlite3_prepare_v2', '_sqlite3_step', '_sqlite3_reset',
    '_sqlite3_clear_bindings', '_sqlite3_finalize', '_sqlite3_column_count', '_sqlite3_data_count',
    '_sqlite3_column_type', '_sqlite3_column_double', '_sqlite3_column_name', 'UTF8ToString'];
  const exports: NativeScalarRuntime['exports'][number][] = [];
  for (const key of keys) {
    const descriptor = nativeGetDescriptor(module, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return undefined;
    exports.push(nativeFreeze({ key, descriptor: nativeFreeze(descriptor) }));
  }
  const globals: NativeScalarRuntime['globals'][number][] = [];
  for (const key of ['String', 'Uint8Array', 'TextDecoder']) {
    const descriptor = nativeGetDescriptor(globalThis, key), constructor: unknown = descriptor?.value;
    if (!descriptor || !('value' in descriptor) || typeof constructor !== 'function') return undefined;
    const prototype: unknown = nativeGetDescriptor(constructor, 'prototype')?.value;
    if (!prototype || typeof prototype !== 'object') return undefined;
    globals.push(nativeFreeze({ key, descriptor: nativeFreeze(descriptor), facts: nativeFreeze([
      ...captureNativePrototypeFacts(constructor), ...captureNativePrototypeFacts(prototype),
    ]) }));
  }
  return nativeFreeze({ module, exports: nativeFreeze(exports), globals: nativeFreeze(globals),
    uniqueGlobalFacts: uniqueNativeFacts(globals),
    step, reset, clear, finalize, count, dataCount, type, value, name, decode });
}
function nativeScalarRuntimeMatches(runtime: NativeScalarRuntime): boolean {
  if (!nativeEvery(runtime.exports, ({ key, descriptor }) => nativeDescriptorMatches(nativeGetDescriptor(runtime.module, key), descriptor))) return false;
  if (!runtime.uniqueGlobalFacts || !nativeGlobalReceiverMatches()) {
    return nativeEvery(runtime.globals, ({ key, descriptor, facts }) => nativeDescriptorMatches(nativeGetDescriptor(globalThis, key), descriptor)
      && nativeEvery(facts, nativeObjectFactsMatch));
  }
  return nativeEvery(runtime.globals, ({ key, descriptor }) => nativeDescriptorMatches(nativeGetDescriptor(nativeGlobalReceiver, key), descriptor))
    && nativeEvery(runtime.uniqueGlobalFacts, nativeObjectFactsMatch);
}
const nativeEngineIdentities = new WeakMap<SqlJsStatic, {
  readonly constructor: SqlJsStatic['Database'];
  readonly prototype: NativeSqlDatabase;
  readonly methods: Readonly<NativeEngineMethods>;
  readonly statement: NativeStatementIdentity | undefined;
  readonly scalar: NativeScalarRuntime | undefined;
}>();
function assertNativeEngineIdentity(engine: SqlJsStatic | null): void {
  const original = engine ? privateMapGet(nativeEngineIdentities, engine) : undefined;
  if (original && (Object.getOwnPropertyDescriptor(engine, 'Database')?.value !== original.constructor
    || Object.getOwnPropertyDescriptor(original.constructor, 'prototype')?.value !== original.prototype)) {
    throw new SQLiteObservationRetiredError();
  }
}
function currentDatabaseConstructor(engine: SqlJsStatic): SqlJsStatic['Database'] {
  assertNativeEngineIdentity(engine);
  return privateMapGet(nativeEngineIdentities, engine)?.constructor ?? engine.Database;
}
function nativeMethodsMatch(engine: SqlJsStatic | null, raw: NativeSqlDatabase | undefined): boolean {
  const original = engine ? privateMapGet(nativeEngineIdentities, engine) : undefined;
  if (!original || !raw || !engine || Object.getPrototypeOf(raw) !== original.prototype) return false;
  assertNativeEngineIdentity(engine);
  return Object.entries(original.methods).every(([name, method]) => !Object.hasOwn(raw, name)
    && Object.getOwnPropertyDescriptor(original.prototype, name)?.value === method);
}
function nativePrepareMatch(engine: SqlJsStatic | null, raw: NativeSqlDatabase): boolean {
  const original = engine ? privateMapGet(nativeEngineIdentities, engine) : undefined;
  if (!original || !engine || Object.getPrototypeOf(raw) !== original.prototype) return false;
  assertNativeEngineIdentity(engine);
  return !Object.hasOwn(raw, 'prepare')
    && Object.getOwnPropertyDescriptor(original.prototype, 'prepare')?.value === original.methods.prepare;
}

interface NativeProbePlanLifetime {
  readonly raw: NativeSqlDatabase;
  readonly identities: string;
  readonly dispose: () => void;
  readonly retired: boolean;
}
type NativeProbePlans = NativeProbePlanLifetime & (
  | { readonly kind: 'scalar' }
  | { readonly kind: 'columns'; readonly statement: NativeSqlStatement }
);

const nativeProbeSql = `SELECT r.read_uncommitted,d.seq,d.name,d.file,v.data_version,s.schema_version,
 EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name COLLATE NOCASE IN
 ('pragma_read_uncommitted','pragma_database_list','pragma_data_version','pragma_schema_version')) AS shadowed
 FROM main.pragma_read_uncommitted() AS r CROSS JOIN main.pragma_database_list() AS d
 CROSS JOIN main.pragma_data_version() AS v CROSS JOIN main.pragma_schema_version() AS s ORDER BY d.seq`;
const nativeProbeColumns = ['read_uncommitted', 'seq', 'name', 'file', 'data_version', 'schema_version', 'shadowed'];
interface NativeMainProbeValues {
  readonly file: string;
  readonly dataVersion: bigint;
  readonly schemaVersion: bigint;
}
interface NativeFrameComparison {
  readonly engine: SqlJsStatic;
  readonly raw: NativeSqlDatabase;
  readonly signature: string;
  readonly sql: string;
  readonly execution: { readonly kind: 'exec'; readonly execute: NativeSqlDatabase['exec'] }
    | { readonly kind: 'native'; readonly executable: NativeScalarExecutable };
  readonly origin: NativeStatementIdentity;
  readonly owner: NativeObjectFacts;
}
interface NativeScalarExecutable {
  readonly read: (assertDependencies: () => void) => boolean | undefined;
  readonly dispose: () => void;
}
// Executable plans only. Every invocation still steps fresh native values.
const nativeFrameComparisons = new WeakMap<NativeProbePlans, NativeFrameComparison>();
function nativeFrameComparisonSql(probe: DatabaseProbe): string | undefined {
  if (!probe.main || !probe.signature) return undefined;
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // Unknown replacements for typeof or its introspection table use the
  // complete original probe; they cannot grant native type authority.
  return `SELECT CASE
 WHEN EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name COLLATE NOCASE IN
 ('pragma_read_uncommitted','pragma_database_list','pragma_data_version','pragma_schema_version','pragma_function_list'))
 OR EXISTS(SELECT 1 FROM main.pragma_function_list() WHERE name COLLATE NOCASE = 'typeof' AND builtin = 0) THEN 2
 WHEN typeof(r.read_uncommitted) = 'integer' AND r.read_uncommitted = 0
 AND typeof(d.seq) = 'integer' AND d.seq = 0
 AND typeof(d.name) = 'text' AND d.name COLLATE BINARY = 'main'
 AND typeof(d.file) = 'text' AND d.file COLLATE BINARY = ${literal(probe.main.file)}
 AND typeof(v.data_version) = 'integer' AND v.data_version = ${probe.main.dataVersion}
 AND typeof(s.schema_version) = 'integer' AND s.schema_version = ${probe.main.schemaVersion}
 THEN 1 ELSE 0 END AS frame_matches
 FROM main.pragma_read_uncommitted() AS r CROSS JOIN main.pragma_database_list() AS d
 CROSS JOIN main.pragma_data_version() AS v CROSS JOIN main.pragma_schema_version() AS s ORDER BY d.seq`;
}
function matchesNativeFrameProbe(raw: NativeSqlDatabase, plans: NativeProbePlans | undefined, signature: string | undefined): boolean | undefined {
  if (!plans || plans.retired || !signature) return undefined;
  const comparison = privateMapGet(nativeFrameComparisons, plans);
  if (!comparison || comparison.raw !== raw || comparison.signature !== signature) return undefined;
  const assertDependencies = () => {
    if (!nativePrepareMatch(comparison.engine, raw) || !nativeExecutionDependenciesMatch(comparison.origin, raw)
      || !nativeObjectFactsMatch(comparison.owner)) throw new SQLiteObservationRetiredError();
  };
  let recognized = false;
  try {
    assertDependencies();
    if (comparison.execution.kind === 'native') {
      const value = comparison.execution.executable.read(assertDependencies);
      assertDependencies();
      recognized = value !== undefined;
      return value;
    }
    // Unknown birth/registry/decoder shapes retain the genuine lexical native
    // implementation, which creates and frees its statement before returning.
    const result: ReturnType<NativeSqlDatabase['exec']> = nativeApply(comparison.execution.execute, raw, [comparison.sql, undefined, { useBigInt: true }]);
    assertDependencies();
    const packet = result[0], row = packet?.values[0];
    if (result.length !== 1 || !packet || packet.columns.length !== 1
      || packet.columns[0] !== 'frame_matches' || packet.values.length !== 1
      || !row || row.length !== 1) return undefined;
    const value = row[0];
    if (value !== 1n && value !== 0n) return undefined;
    recognized = true;
    return value === 1n;
  } catch (error) { if (error instanceof SQLiteObservationRetiredError) throw error; return undefined; }
  finally { if (!recognized) plans.dispose(); }
}

/** Only an original constructor birth can supply the private registry proof.
 * Unknown/custom births retain their ordinary facade and fresh-exec fallback. */
function constructOwnedDatabase(engine: SqlJsStatic, data?: Uint8Array | Buffer,
  Constructor: SqlJsStatic['Database'] = engine.Database): SqlDatabase {
  const original = privateMapGet(nativeEngineIdentities, engine), origin = original?.statement, runtime = original?.scalar,
    originalPrototype = original?.prototype;
  const genuine = !!original && Constructor === original.constructor
    && nativeGetDescriptor(engine, 'Database')?.value === Constructor
    && nativeGetDescriptor(Constructor, 'prototype')?.value === originalPrototype
    && !!origin && nativeOwnerPrototypeFactsMatch(origin) && !!runtime && nativeScalarRuntimeMatches(runtime);
  const raw = new Constructor(data), facade = ownDatabase(raw), state = privateMapGet(ownedDatabases, facade);
  if (genuine && original && origin && runtime && state && !nativeIsProxy(raw) && nativePrepareMatch(engine, raw)
    && nativeExecutionDependenciesMatch(origin, raw) && nativeScalarRuntimeMatches(runtime)) {
    const descriptor = nativeGetDescriptor(raw, 'gb'), registry: unknown = descriptor?.value;
    if (descriptor && 'value' in descriptor && registry && typeof registry === 'object' && !nativeIsProxy(registry)
      && nativeGetPrototypeOf(registry) === Object.prototype && nativeOwnKeys(registry).length === 0
      && nativeIsExtensible(registry)) privateMapSet(nativeBirthRegistries, state, captureNativeObjectFacts(registry));
  }
  return facade;
}

/** Genuine prepare mints the native pointer; no live JavaScript statement is
 * exposed through the registry across an assertion callback. Finalization uses
 * its independent original WASM function, even after owner/helper retirement. */
function preparePrivateNativeScalar(state: OwnedSqlDatabase, engine: SqlJsStatic, sql: string): NativeScalarExecutable | undefined {
  const original = privateMapGet(nativeEngineIdentities, engine), origin = original?.statement, runtime = original?.scalar;
  const birth = privateMapGet(nativeBirthRegistries, state), registryDescriptor = nativeGetDescriptor(state.raw, 'gb');
  if (!original || !origin || !runtime || !birth || registryDescriptor?.value !== birth.object
    || !nativeObjectFactsMatch(birth) || birth.slots.length !== 0 || !nativeIsExtensible(birth.object)
    || !nativePrepareMatch(engine, state.raw) || !nativeExecutionDependenciesMatch(origin, state.raw)
    || !nativeScalarRuntimeMatches(runtime)) return undefined;
  let statement: NativeSqlStatement;
  try { statement = nativeApply(original.methods.prepare, state.raw, [sql]); }
  catch (error) {
    // The genuine native API returns a null statement on preparation failure.
    // It cannot authorize a borrowed resource or a changed registry transition.
    if (!nativeObjectFactsMatch(birth) || !nativePrepareMatch(engine, state.raw)
      || !nativeExecutionDependenciesMatch(origin, state.raw) || !nativeScalarRuntimeMatches(runtime)) throw new SQLiteObservationRetiredError();
    return undefined;
  }
  // The actual original producer returns its own data pointer. Record release
  // ownership immediately, before any subsequent validation or detach can fail.
  const pointerDescriptor = nativeGetDescriptor(statement, 'Qa'), pointer: unknown = pointerDescriptor?.value;
  if (!pointerDescriptor || !('value' in pointerDescriptor) || typeof pointer !== 'number'
    || !nativeSafeInteger(pointer) || pointer <= 0) throw new SQLiteObservationRetiredError();
  let released = false;
  const dispose = () => {
    if (released) return;
    released = true;
    // Finalize destroys the allocation even if its status reports a prior SQL
    // error. It must never be retried or depend on the current JS registry.
    runtime.finalize(pointer);
  };
  try {
    const ownerDescriptor = nativeGetDescriptor(statement, 'db'), cursor = nativeGetDescriptor(statement, 'Oa'),
      buffersDescriptor = nativeGetDescriptor(statement, 'mb'), buffers: unknown = buffersDescriptor?.value;
    const entries = nativeOwnKeys(birth.object), entry = entries.length === 1 ? nativeGetDescriptor(birth.object, nativeString(pointer)) : undefined;
    if (nativeOwnKeys(statement).length !== 4 || !pointerDescriptor.writable || !pointerDescriptor.configurable
      || !ownerDescriptor || !('value' in ownerDescriptor) || ownerDescriptor.value !== state.raw
      || !cursor || !('value' in cursor) || cursor.value !== 1
      || !buffersDescriptor || !('value' in buffersDescriptor) || !nativeIsArray(buffers)
      || nativeGetPrototypeOf(buffers) !== Array.prototype || buffers.length !== 0 || nativeOwnKeys(buffers).length !== 1
      || entries[0] !== nativeString(pointer) || !entry || !('value' in entry) || entry.value !== statement || !entry.configurable) {
      throw new SQLiteObservationRetiredError();
    }
    // No borrowed operation runs between detachment and neutralization. The
    // detached pointer is now owned only by this private synchronous closure.
    nativeDefineProperty(statement, 'Qa', { ...pointerDescriptor, value: 0 });
    if (!nativeDeleteProperty(birth.object, nativeString(pointer))) throw new SQLiteObservationRetiredError();
    if (!nativeObjectFactsMatch(birth) || nativeGetDescriptor(statement, 'Qa')?.value !== 0
      || !nativePrepareMatch(engine, state.raw) || !nativeExecutionDependenciesMatch(origin, state.raw)
      || !nativeScalarRuntimeMatches(runtime) || !nativeStatementMethodsMatch(origin, statement)) throw new SQLiteObservationRetiredError();
  } catch (error) {
    // Partial mint cleanup closes the original JavaScript handle before native
    // release, so later raw export/close cannot finalize the same pointer twice.
    try {
      nativeDefineProperty(statement, 'Qa', { ...pointerDescriptor, value: 0 });
      const entry = nativeGetDescriptor(birth.object, nativeString(pointer));
      if (entry && 'value' in entry && entry.value === statement && entry.configurable) nativeDeleteProperty(birth.object, nativeString(pointer));
    } finally { dispose(); }
    throw error;
  }
  return nativeFreeze({ dispose, read(assertDependencies: () => void): boolean | undefined {
    const current = () => {
      assertDependencies();
      if (released || !nativeObjectFactsMatch(birth) || !nativeScalarRuntimeMatches(runtime)) throw new SQLiteObservationRetiredError();
    };
    current();
    if (runtime.clear(pointer) !== 0 || runtime.reset(pointer) !== 0) return undefined;
    let result: boolean | undefined;
    try {
      const first = runtime.step(pointer);
      current();
      if (first === 100 && runtime.count(pointer) === 1 && runtime.dataCount(pointer) === 1
        && runtime.type(pointer, 0) === 1 && runtime.decode(runtime.name(pointer, 0)) === 'frame_matches') {
        const value = runtime.value(pointer, 0);
        current();
        if ((value === 0 || value === 1) && runtime.step(pointer) === 101) result = value === 1;
      }
    } finally {
      if (runtime.reset(pointer) !== 0) result = undefined;
    }
    current();
    return result;
  } });
}

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
const nativeBirthRegistries = new WeakMap<OwnedSqlDatabase, NativeObjectFacts>();
const nativeOwnedProbePlans = new WeakMap<OwnedSqlDatabase, NativeProbePlans>();
const nativeFrameReleases = new WeakMap<object, () => void>();
const unownedIdentities = new WeakMap<SqlDatabase, bigint>();

/** Never return sql.js's chainable run result or a native property/statement.
 * Every supported callback receives the same immutable four-method facade. */
function ownedProbePlans(state: OwnedSqlDatabase): NativeProbePlans | undefined {
  const original = privateMapGet(nativeOwnedProbePlans, state), descriptor = nativeGetDescriptor(state, 'probePlans');
  if (descriptor && (!('value' in descriptor) || descriptor.value !== original)) throw new SQLiteObservationRetiredError();
  if (original && (!descriptor || nativeGetDescriptor(state, 'raw')?.value !== original.raw)) throw new SQLiteObservationRetiredError();
  return original;
}
function retireDatabaseProbe(state: OwnedSqlDatabase): void {
  const original = privateMapGet(nativeOwnedProbePlans, state);
  privateMapDelete(nativeOwnedProbePlans, state);
  try {
    const descriptor = nativeGetDescriptor(state, 'probePlans');
    // A replaced slot cannot select cleanup or receive a setter invocation.
    if (descriptor && 'value' in descriptor && descriptor.value === original
      && (descriptor.writable || descriptor.configurable)) nativeDefineProperty(state, 'probePlans', { ...descriptor, value: undefined });
  } finally { original?.dispose(); }
}

function ownDatabase(raw: NativeSqlDatabase): SqlDatabase {
  const state: OwnedSqlDatabase = { raw, identity: ++nextDatabaseIdentity, revision: 0n, inFlight: 0 };
  const operation = <T>(run: () => T): T => {
    state.revision++; state.inFlight++; state.memo = undefined; state.cleanMemo = undefined;
    try { retireDatabaseProbe(state); return run(); }
    finally { state.revision++; state.inFlight--; state.memo = undefined; state.cleanMemo = undefined; }
  };
  const facade: SqlDatabase = nativeFreeze({
    run(sql: string, params?: (string | number | Uint8Array | null)[]) {
      operation(() => { raw.run(sql, params); });
    },
    exec(sql: string, params?: (string | number)[], config?: { useBigInt: boolean }) {
      return operation(() => raw.exec(sql, params, config));
    },
    export() { return operation(() => raw.export()); },
    close() { operation(() => { raw.close(); }); },
  });
  privateMapSet(ownedDatabases, facade, state);
  return facade;
}

/** This path is only for fixed internal SQL, never caller SQL or callbacks. */
function readDatabaseRow(db: SqlDatabase, sql: string, params: string[]) {
  const state = privateMapGet(ownedDatabases, db);
  if (state?.inFlight) throw new SQLiteObservationRetiredError();
  return (state?.raw ?? db).exec(sql, params);
}

/** Initial and fallback equality reads never consume mutable guard memos. */
function readActualRecordGenerations(db: SqlDatabase, selectors: readonly PersistedKnowledgeRecordSelector[]): readonly (string | null)[] {
  const generations: (string | null)[] = [];
  for (const selector of selectors) {
    const table = selector.kind === 'source' ? 'knowledge_sources' : selector.kind === 'node' ? 'knowledge_nodes' : 'knowledge_extractions';
    const row = readDatabaseRow(db, `SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [selector.id])[0], cells = row?.values[0];
    if (row && (!row.columns.every(column => typeof column === 'string')
      || row.values.some(cells => cells.some(cell => cell !== null && typeof cell !== 'string' && typeof cell !== 'number')))) {
      throw new SQLiteObservationRetiredError();
    }
    const entries = row && cells ? row.columns.map((column, index) => [column, cells[index]] as const)
      .sort(([left], [right]) => selector.kind === 'source' ? left < right ? -1 : left > right ? 1 : 0 : left.localeCompare(right)) : null;
    generations.push(entries ? createHash('sha256').update(JSON.stringify(entries)).digest('hex') : null);
  }
  return Object.freeze(generations);
}

interface DatabaseProbe {
  readonly signature: string | null;
  readonly cacheable: boolean;
  readonly isolated: boolean;
  readonly guarded: boolean;
  readonly identities: readonly (readonly string[])[];
  readonly main?: NativeMainProbeValues | undefined;
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
function installDatabaseProbe(state: OwnedSqlDatabase, probe: DatabaseProbe, engine: SqlJsStatic | null, frame: object): void {
  retireDatabaseProbe(state);
  const identities = probe.identities;
  // This sql.js build's table-valued version PRAGMAs report main only.
  // Other database sets retain the complete schema-qualified PRAGMA path.
  if (identities.length !== 1 || identities[0]?.[0] !== '0' || identities[0]?.[1] !== 'main') return;
  const identity = engine ? privateMapGet(nativeEngineIdentities, engine) : undefined;
  const origin = identity?.statement;
  const owner = origin ? captureNativeObjectFacts(state.raw) : undefined;
  const comparisonSql = origin && owner && nativeEvery(owner.slots, ({ descriptor }) => 'value' in descriptor)
    && nativeExecutionDependenciesMatch(origin, state.raw)
    && nativePrepareMatch(engine, state.raw) ? nativeFrameComparisonSql(probe) : undefined;
  let executable: NativeScalarExecutable | undefined, statement: NativeSqlStatement | undefined;
  let installed = false;
  try {
    executable = comparisonSql && engine ? preparePrivateNativeScalar(state, engine, comparisonSql) : undefined;
    if (!comparisonSql) { try { statement = state.raw.prepare(nativeProbeSql); } catch { return; } }
    let retired = false;
    const dispose = () => {
      if (retired) return;
      retired = true;
      try { privateMapDelete(nativeFrameComparisons, plans); }
      finally {
        try { executable?.dispose(); }
        finally { if (statement && !statement.free()) throw new SQLiteObservationRetiredError(); }
      }
    };
    const candidate: NativeProbePlans = statement
      ? { raw: state.raw, identities: JSON.stringify(identities), kind: 'columns', statement, get retired() { return retired; }, dispose }
      : { raw: state.raw, identities: JSON.stringify(identities), kind: 'scalar', get retired() { return retired; }, dispose };
    const plans = nativeFreeze(candidate);
    if (comparisonSql && probe.signature && engine && identity && origin && owner) {
      const execution: NativeFrameComparison['execution'] = executable
        ? { kind: 'native', executable } : { kind: 'exec', execute: identity.methods.exec };
      privateMapSet(nativeFrameComparisons, plans, nativeFreeze({ engine, raw: state.raw, signature: probe.signature,
        sql: comparisonSql, execution, origin, owner }));
    }
    nativeDefineProperty(state, 'probePlans', { value: plans, writable: true, configurable: true, enumerable: true });
    privateMapSet(nativeOwnedProbePlans, state, plans);
    privateMapSet(nativeFrameReleases, frame, () => retireDatabaseProbe(state));
    installed = true;
  } finally {
    // Minted ownership transfers only after the actual plan is installed. No
    // formatting/registration exception may strand a detached native pointer.
    if (!installed) {
      try { executable?.dispose(); }
      finally { if (statement && !statement.free()) throw new SQLiteObservationRetiredError(); }
    }
  }
}

function databaseProbe(raw: SqlDatabase, plans?: NativeProbePlans): DatabaseProbe {
  const unsupported: DatabaseProbe = { signature: null, cacheable: false, isolated: false, guarded: false, identities: [] };
  if (plans?.retired) plans = undefined;
  // Full observations keep all original native fields. The scalar plan is
  // used only for equality fences and is never an observed signature.
  if (plans && privateMapHas(nativeFrameComparisons, plans)) { plans.dispose(); plans = undefined; }
  if (plans) {
    let result: ReturnType<SqlDatabase['exec']> | undefined;
    if (raw === plans.raw && plans.kind === 'columns') {
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
            cacheable: true, isolated: file === '', guarded: true, identities,
            main: { file, dataVersion: version, schemaVersion } };
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
  const main = identities[0], file = main?.[2];
  const dataVersion = versions[0]?.values[0]?.[0], schemaVersion = versions[1]?.values[0]?.[0];
  return { signature: JSON.stringify([String(mode), observed]), cacheable: mode === 0n,
    isolated: guarded && identities.every(row => row[2] === ''), guarded, identities,
    main: guarded && identities.length === 1 && main?.[0] === '0' && main[1] === 'main'
      && typeof file === 'string' && typeof dataVersion === 'bigint' && typeof schemaVersion === 'bigint'
      ? { file, dataVersion, schemaVersion } : undefined };
}

/** Reuse only a complete observation owned by an uninterrupted connection.
 * Native data_version fences other SQL connections; facade revisions fence all
 * owner operations, including failed writes, rollback and export/reopen ABA. */
function observeDatabase(db: SqlDatabase, mode: 'observation' | 'clean-content' = 'observation'): string {
  const state = privateMapGet(ownedDatabases, db);
  if (!state) {
    let identity = privateMapGet(unownedIdentities, db);
    if (identity === undefined) { identity = ++nextDatabaseIdentity; privateMapSet(unownedIdentities, db, identity); }
    return JSON.stringify([String(identity), mode === 'observation' ? '0' : 'clean-content', null, sqliteLocalObservation(db, mode)]);
  }
  try {
    if (state.inFlight) throw new SQLiteObservationRetiredError();
    const revision = state.revision, before = databaseProbe(state.raw, ownedProbePlans(state));
    const memo = mode === 'observation' ? state.memo : state.cleanMemo;
    const digest = before.cacheable && memo?.revision === revision && memo.probe === before.signature
      ? memo.digest : sqliteLocalObservation(state.raw, mode);
    const after = databaseProbe(state.raw, ownedProbePlans(state));
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
interface NativeReadFrameObservation {
  readonly identity: string | undefined;
  readonly local: string;
  readonly persisted: string | undefined;
  readonly localState: OwnedSqlDatabase | undefined;
  readonly localRevision: bigint | undefined;
  readonly localProbe: string | undefined;
  readonly localIsolated: boolean;
}
const nativeReadFrameIdentities = new WeakMap<object, {
  readonly store: SQLiteStore;
  readonly identity: object;
  readonly assertCurrent: (verifyNative?: boolean) => void;
  readonly observation?: NativeReadFrameObservation;
}>();
function assertReadFrameOrigin(store: SQLiteStore, frame: object) {
  const original = privateMapGet(nativeReadFrameIdentities, frame);
  if (original?.store !== store || nativeGetDescriptor(frame, 'assertCurrent')?.value !== original.assertCurrent) {
    throw new SQLiteObservationRetiredError();
  }
  if (original.observation) {
    for (const key of nativeOwnKeys(original.observation)) {
      const expected = nativeGetDescriptor(original.observation, key), actual = nativeGetDescriptor(frame, key);
      if (!expected || !('value' in expected) || !actual || !('value' in actual) || actual.value !== expected.value) {
        throw new SQLiteObservationRetiredError();
      }
    }
  }
  return original;
}
const nativeReadImages = new WeakMap<object, {
  readonly db: SqlDatabase;
  readonly store: SQLiteStore;
  readonly origin: object;
  readonly digest: string;
  readonly state: OwnedSqlDatabase;
  readonly revision: bigint;
}>();
function currentNativeReadImage(store: SQLiteStore, frame: object | null, db: SqlDatabase | null | undefined, engine: SqlJsStatic | null) {
  assertNativeEngineIdentity(engine);
  if (frame) {
    const original = assertReadFrameOrigin(store, frame);
    if (original.observation && nativeEntries(original.observation).some(([name, value]) => {
      const field = Object.getOwnPropertyDescriptor(frame, name);
      return !field || !('value' in field) || field.value !== value;
    })) throw new SQLiteObservationRetiredError();
  }
  const image = frame ? privateMapGet(nativeReadImages, frame) : undefined;
  if (image && (image.store !== store || image.db !== db || privateMapGet(ownedDatabases, image.db) !== image.state
    || image.state.inFlight || image.state.revision !== image.revision)) throw new SQLiteObservationRetiredError();
  return image;
}
const expectedRecordReadsets = new WeakMap<object, {
  readonly token: ExpectedKnowledgeRecordReadset;
  readonly store: SQLiteStore;
  readonly origin: object | undefined;
  readonly persistence: SQLiteStorePersistence | null;
  readonly plan: NativeKnowledgeSchemaReadPlan | undefined;
  readonly validator: SqliteStoreInitOptions['validateCurrentSchema'];
  readonly schemaVersion: number;
  readonly digest: string | undefined;
  readonly canonical: boolean;
  readonly selectors: readonly PersistedKnowledgeRecordSelector[];
  readonly generations: readonly (string | null)[];
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

  /** Compile only actual original rows, never a caller's claimed fingerprints. */
  captureExpectedRecordReadset(selectors: readonly PersistedKnowledgeRecordSelector[]): {
    readonly expected: ExpectedKnowledgeRecordReadset;
    readonly originalGenerations: readonly (string | null)[];
  } {
    const captured = captureRecordSelectors(selectors);
    let result: { readonly expected: ExpectedKnowledgeRecordReadset; readonly originalGenerations: readonly (string | null)[] } | undefined;
    this.assertPersistedReadFrame(() => {
      currentNativeReadImage(this, this.persistedReadFrame, this.persistedReadFrame?.db, this.sqlEngine);
      this.readPrivatePersistedRows('SELECT 1', [], true);
      const frame = this.persistedReadFrame;
      const image = currentNativeReadImage(this, frame, frame?.db, this.sqlEngine);
      const db = frame?.db ?? this.getDb();
      frame?.assertCurrent();
      const originalGenerations = readActualRecordGenerations(db, captured);
      const native = frame?.db ? privateMapGet(ownedDatabases, frame.db) : undefined;
      let canonical = Boolean(frame && image?.store === this && image.origin === privateMapGet(nativeReadFrameIdentities, frame)?.identity
        && image.digest === frame.persisted && image.state === native && image.revision === native?.revision && !native?.inFlight
        && frame.localState && frame.persisted
        && nativeMethodsMatch(this.sqlEngine, native?.raw) && nativeMethodsMatch(this.sqlEngine, frame.localState.raw)
        && nativeKnowledgeSchemaReadPlanMatches(this.nativeSchemaReadPlan, this.validateCurrentSchema, this.schemaVersion));
      if (canonical) {
        const rows = readDatabaseRow(db, "SELECT type,name,sql FROM main.sqlite_schema WHERE name IN ('knowledge_sources','knowledge_nodes','knowledge_extractions')", [])[0]?.values;
        canonical = Boolean(rows && rows.length === 3 && Object.entries(knowledgeRecordTableSql).every(([name, sql]) =>
          rows.some(row => row[0] === 'table' && row[1] === name && row[2] === sql.trim().replace('IF NOT EXISTS ', ''))));
      }
      currentNativeReadImage(this, frame, frame?.db, this.sqlEngine);
      frame?.assertCurrent();
      const expected = Object.freeze<ExpectedKnowledgeRecordReadset>({ [expectedReadsetBrand]: true });
      privateMapSet(expectedRecordReadsets, expected, nativeFreeze({ token: expected, store: this,
        origin: frame ? privateMapGet(nativeReadFrameIdentities, frame)?.identity : undefined, persistence: this.persistence,
        plan: this.nativeSchemaReadPlan, validator: this.validateCurrentSchema, schemaVersion: this.schemaVersion,
        digest: frame?.persisted, canonical, selectors: Object.freeze(captured.map(selector => Object.freeze(selector))),
        generations: originalGenerations }));
      result = Object.freeze({ expected, originalGenerations });
    });
    if (!result) throw new SQLiteObservationRetiredError();
    return result;
  }

  /** Mint one synchronous group's original readsets. Every requested row is
   * read in selector order, bypassing guard memos; the complete schema is
   * observed once for the group. No token is returned before the exit fence. */
  captureExpectedRecordReadsets(groups: readonly (readonly PersistedKnowledgeRecordSelector[])[]): readonly ReturnType<SQLiteStore['captureExpectedRecordReadset']>[] {
    const captured = captureRecordSelectorGroups(groups);
    let result: readonly ReturnType<SQLiteStore['captureExpectedRecordReadset']>[] | undefined;
    this.assertPersistedReadFrame(() => {
      currentNativeReadImage(this, this.persistedReadFrame, this.persistedReadFrame?.db, this.sqlEngine);
      this.readPrivatePersistedRows('SELECT 1', [], true);
      const frame = this.persistedReadFrame;
      const image = currentNativeReadImage(this, frame, frame?.db, this.sqlEngine);
      const db = frame?.db ?? this.getDb();
      const originals: (readonly (string | null)[])[] = [];
      for (const selectors of captured) {
        frame?.assertCurrent();
        originals.push(readActualRecordGenerations(db, selectors));
        currentNativeReadImage(this, frame, frame?.db, this.sqlEngine);
        frame?.assertCurrent();
      }
      const native = frame?.db ? privateMapGet(ownedDatabases, frame.db) : undefined;
      let canonical = Boolean(frame && image?.store === this && image.origin === privateMapGet(nativeReadFrameIdentities, frame)?.identity
        && image.digest === frame.persisted && image.state === native && image.revision === native?.revision && !native?.inFlight
        && frame.localState && frame.persisted
        && nativeMethodsMatch(this.sqlEngine, native?.raw) && nativeMethodsMatch(this.sqlEngine, frame.localState.raw)
        && nativeKnowledgeSchemaReadPlanMatches(this.nativeSchemaReadPlan, this.validateCurrentSchema, this.schemaVersion));
      if (canonical) {
        const rows = readDatabaseRow(db, "SELECT type,name,sql FROM main.sqlite_schema WHERE name IN ('knowledge_sources','knowledge_nodes','knowledge_extractions')", [])[0]?.values;
        canonical = Boolean(rows && rows.length === 3 && Object.entries(knowledgeRecordTableSql).every(([name, sql]) =>
          rows.some(row => row[0] === 'table' && row[1] === name && row[2] === sql.trim().replace('IF NOT EXISTS ', ''))));
      }
      currentNativeReadImage(this, frame, frame?.db, this.sqlEngine);
      frame?.assertCurrent();
      const values: ReturnType<SQLiteStore['captureExpectedRecordReadset']>[] = [];
      for (let index = 0; index < captured.length; index++) {
        const selectors = captured[index], originalGenerations = originals[index];
        if (!selectors || !originalGenerations) throw new SQLiteObservationRetiredError();
        const expected = Object.freeze<ExpectedKnowledgeRecordReadset>({ [expectedReadsetBrand]: true });
        privateMapSet(expectedRecordReadsets, expected, nativeFreeze({ token: expected, store: this,
          origin: frame ? privateMapGet(nativeReadFrameIdentities, frame)?.identity : undefined, persistence: this.persistence,
          plan: this.nativeSchemaReadPlan, validator: this.validateCurrentSchema, schemaVersion: this.schemaVersion,
          digest: frame?.persisted, canonical, selectors: Object.freeze(selectors.map(selector => Object.freeze(selector))),
          generations: originalGenerations }));
        values.push(Object.freeze({ expected, originalGenerations }));
      }
      result = Object.freeze(values);
    });
    if (!result) throw new SQLiteObservationRetiredError();
    return result;
  }

  /** Equality only. Each invocation observes a fresh guarded physical image;
   * no retained row or fingerprint is returned as a current observation. */
  matchesExpectedRecordReadsets(inputs: readonly ExpectedKnowledgeRecordReadsetInput[]): readonly boolean[] {
    try {
      const captured = captureExpectedReadsets(inputs);
      for (const input of captured) {
        const retained = privateMapGet(expectedRecordReadsets, input.expected);
        if (!retained || retained.store !== this || retained.selectors.length !== input.selectors.length
          || retained.selectors.some((selector, index) => selector.kind !== input.selectors[index]?.kind || selector.id !== input.selectors[index]?.id)) {
          throw new TypeError('SQLiteStore: expected readset does not belong to this selection');
        }
      }
      let matches: readonly boolean[] = [];
      const compare = (): undefined => {
        // Acquire this frame's private image and complete entry digest even
        // when every original raw row can be proved equal without selecting it.
        currentNativeReadImage(this, this.persistedReadFrame, this.persistedReadFrame?.db, this.sqlEngine);
        this.readPrivatePersistedRows('SELECT 1', [], true);
        const frame = this.persistedReadFrame;
        frame?.assertCurrent();
        const native = frame?.db ? privateMapGet(ownedDatabases, frame.db) : undefined;
        const image = currentNativeReadImage(this, frame, frame?.db, this.sqlEngine);
        const closed = Boolean(frame && image?.store === this && image.origin === privateMapGet(nativeReadFrameIdentities, frame)?.identity
          && image.digest === frame.persisted && image.state === native && image.revision === native?.revision && !native?.inFlight
          && frame.localState
          && nativeMethodsMatch(this.sqlEngine, native?.raw) && nativeMethodsMatch(this.sqlEngine, frame.localState.raw)
          && nativeKnowledgeSchemaReadPlanMatches(this.nativeSchemaReadPlan, this.validateCurrentSchema, this.schemaVersion));
        const values: boolean[] = [];
        for (const input of captured) {
          const retained = privateMapGet(expectedRecordReadsets, input.expected);
          if (!retained) throw new TypeError('SQLiteStore: unknown expected readset');
          if (closed && retained.canonical && retained.origin && retained.persistence === this.persistence
            && retained.plan === this.nativeSchemaReadPlan && retained.validator === this.validateCurrentSchema
            && retained.schemaVersion === this.schemaVersion && retained.digest === frame?.persisted) {
            values.push(true);
          } else {
            frame?.assertCurrent();
            const current = readActualRecordGenerations(frame?.db ?? this.getDb(), input.selectors);
            currentNativeReadImage(this, frame, frame?.db, this.sqlEngine);
            frame?.assertCurrent();
            values.push(current.length === retained.generations.length && current.every((value, index) => value === retained.generations[index]));
          }
        }
        currentNativeReadImage(this, frame, frame?.db, this.sqlEngine);
        frame?.assertCurrent();
        matches = Object.freeze(values);
      };
      if (this.persistedReadFrame?.localState) compare(); else this.assertPersistedReadFrame(compare);
      return matches;
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
        const localState = privateMapGet(ownedDatabases, this.getDb()), revision = localState?.revision;
        const probe = localState ? databaseProbe(localState.raw) : undefined;
        if (localState && probe?.guarded && probe.signature !== null) {
          if (localState.inFlight || localState.revision !== revision) throw new SQLiteObservationRetiredError();
          frame.localState = localState; frame.localRevision = revision;
          frame.localProbe = probe.signature; frame.localIsolated = probe.isolated;
          installDatabaseProbe(localState, probe, this.sqlEngine, frame);
        }
        const persisted = this.persistence?.read();
        frame.persisted = persisted ? imageDigest(persisted) : undefined;
        const origin = assertReadFrameOrigin(this, frame);
        if (origin.observation) throw new SQLiteObservationRetiredError();
        privateMapSet(nativeReadFrameIdentities, frame, nativeFreeze({ ...origin, observation: nativeFreeze({
          identity: frame.identity, local: frame.local, persisted: frame.persisted, localState: frame.localState,
          localRevision: frame.localRevision, localProbe: frame.localProbe, localIsolated: frame.localIsolated,
        }) }));
        const plan = this.nativeSchemaReadPlan;
        const stamp = persisted && this.persistence && plan && frame.localState
          && nativeKnowledgeSchemaReadPlanMatches(plan, this.validateCurrentSchema, this.schemaVersion)
          ? Object.freeze<NativeFrameImageStamp>({ [frameImageStampBrand]: true }) : undefined;
        if (stamp && persisted && this.persistence && plan && frame.persisted) {
          privateMapSet(frameImageStamps, stamp, { store: this, frame, data: persisted, persistence: this.persistence,
            plan, validator: this.validateCurrentSchema, schemaVersion: this.schemaVersion,
            imageEpoch: this.imageEpoch, observationEpoch: this.observationEpoch, digest: frame.persisted });
        }
        try { frame.db = this.openPrivateReadImage(stamp); }
        finally { if (stamp) privateMapDelete(frameImageStamps, stamp); }
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
            const state = privateMapGet(ownedDatabases, this.getDb());
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
        const original = assertReadFrameOrigin(this, frame).observation;
        if (frame.poisoned || this.observationEpoch !== observationEpoch || this.imageEpoch !== imageEpoch
          || (original && this.persistence?.observationIdentity() !== original.identity)) {
          throw new SQLiteObservationRetiredError();
        }
        if (original?.localState) {
          const state = privateMapGet(ownedDatabases, this.getDb());
          if (state !== original.localState || state.inFlight || state.revision !== original.localRevision) throw new SQLiteObservationRetiredError();
          if (verifyNative && !original.localIsolated) {
            const matches = matchesNativeFrameProbe(state.raw, ownedProbePlans(state), original.localProbe);
            if (matches === false || (matches === undefined
              && databaseProbe(state.raw, ownedProbePlans(state)).signature !== original.localProbe)) throw new SQLiteObservationRetiredError();
          }
        }
      },
    };
    const assertCurrent = frame.assertCurrent;
    privateMapSet(nativeReadFrameIdentities, frame, nativeFreeze({ store: this, identity: nativeFreeze({}), assertCurrent }));
    this.persistedReadFrame = frame;
    try {
      invoke();
      assertCurrent();
      if (frame.db) {
        // Full-state fences run once per outer assertion, not once per row. No
        // data from this frame can authorize the next await or publication.
        const persisted = this.persistence?.read(), original = assertReadFrameOrigin(this, frame).observation;
        if (!original || observeDatabase(this.getDb()) !== original.local
          || (persisted ? imageDigest(persisted) : undefined) !== original.persisted) {
          throw new SQLiteObservationRetiredError();
        }
        assertCurrent();
      }
    } finally {
      this.persistedReadFrame = null;
      const release = privateMapGet(nativeFrameReleases, frame);
      privateMapDelete(nativeFrameReleases, frame);
      try { release?.(); }
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
    const staged = constructOwnedDatabase(this.sqlEngine!, prefix);
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
        this.db = constructOwnedDatabase(SQL, original!);
        logger.info('SQLiteStore: loaded from disk', { path: dbPath });
      } else {
        this.db = constructOwnedDatabase(SQL);
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
              this.db = constructOwnedDatabase(SQL, readFileSync(dbPath!));
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
    try {
      const bytes = exposed.export(), Database = currentDatabaseConstructor(this.sqlEngine!);
      return constructOwnedDatabase(this.sqlEngine!, bytes, Database);
    }
    finally { this.closeReadImage(exposed); }
  }

  private openCurrentImage(privateReadPlan?: NativeKnowledgeSchemaReadPlan, stamp?: NativeFrameImageStamp): SqlDatabase {
    assertNativeEngineIdentity(this.sqlEngine);
    this.getDb(true);
    if (!this.persistence && (this.cleanContent === null || this.cleanBytes === null
      || observeDatabase(this.getDb(), 'clean-content') !== this.cleanContent)) {
      throw new Error('SQLiteStore: no proven clean ephemeral image is available');
    }
    let entryBytes: Uint8Array | undefined;
    let entryDigest: string | undefined;
    if (stamp) {
      const captured = privateMapGet(frameImageStamps, stamp), frame = this.persistedReadFrame;
      if (captured?.store === this) privateMapDelete(frameImageStamps, stamp);
      if (captured?.store === this && captured.frame === frame && frame && frame.db === null
        && captured.persistence === this.persistence && captured.plan === privateReadPlan && privateReadPlan === this.nativeSchemaReadPlan
        && captured.validator === this.validateCurrentSchema && captured.schemaVersion === this.schemaVersion
        && captured.imageEpoch === this.imageEpoch && captured.observationEpoch === this.observationEpoch
        && captured.digest === frame.persisted
        && nativeKnowledgeSchemaReadPlanMatches(privateReadPlan, this.validateCurrentSchema, this.schemaVersion)) {
        frame.assertCurrent();
        if (captured.persistence.observationIdentity() !== frame.identity) throw new SQLiteObservationRetiredError();
        entryBytes = captured.data;
        entryDigest = captured.digest;
      }
    }
    const data = entryBytes ?? (this.persistence ? this.persistence.read() : this.cleanBytes);
    if (data !== null) assertSqliteImage(data);
    const Database = currentDatabaseConstructor(this.sqlEngine!);
    const current = constructOwnedDatabase(this.sqlEngine!, data ?? undefined, Database);
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
        const frame = this.persistedReadFrame, state = privateMapGet(ownedDatabases, current), origin = frame ? privateMapGet(nativeReadFrameIdentities, frame)?.identity : undefined;
        if (entryDigest && origin && state && frame) privateMapSet(nativeReadImages, frame, nativeFreeze({ db: current, store: this, origin,
          digest: entryDigest, state, revision: state.revision }));
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
