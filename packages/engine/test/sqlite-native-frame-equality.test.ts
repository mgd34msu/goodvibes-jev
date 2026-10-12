import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlJsEngine, SQLiteObservationRetiredError, SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createSemanticWriteGuard } from '../sdk/src/platform/knowledge/semantic/primary-source-plan.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';

type NativeDatabase = InstanceType<Awaited<ReturnType<typeof loadSqlJsEngine>>['Database']>;
const roots: string[] = [], databases: SQLiteStore[] = [], knowledgeStores: KnowledgeStore[] = [];
const observers: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const observing of observers.splice(0).reverse()) observing.mockRestore();
  for (const store of knowledgeStores.splice(0)) await store.close();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path() {
  const root = mkdtempSync(join(tmpdir(), 'native-frame-equality-'));
  roots.push(root); return join(root, 'knowledge.sqlite');
}
async function fixture(projection: boolean, primedReaderAtBirth = false,
  native: Pick<typeof import('../sdk/src/platform/state/sqlite-store.js'), 'SQLiteStore' | 'loadSqlJsEngine'> = { SQLiteStore, loadSqlJsEngine }) {
  const filename = path(), sqlite = new native.SQLiteStore(filename, { coordinated: true });
  databases.push(sqlite);
  let facade: SqlDatabase | undefined;
  await sqlite.init(db => { facade = db; db.run('CREATE TABLE IF NOT EXISTS knowledge_sources(id TEXT PRIMARY KEY,title TEXT)'); });
  if (!facade) throw new Error('No original public schema facade');
  sqlite.run("INSERT INTO knowledge_sources VALUES('original','Complete original source')");
  await sqlite.save();
  const SQL = await native.loadSqlJsEngine(), prepare = SQL.Database.prototype.prepare, execute = SQL.Database.prototype.exec;
  const scratch = new SQL.Database(), sample = scratch.prepare('SELECT 1');
  let statementPrototype: object, statementParent: object, bufferPrototype: object;
  try {
    const candidate: unknown = Object.getPrototypeOf(sample);
    if (!candidate || typeof candidate !== 'object') throw new Error('No actual native statement prototype');
    statementPrototype = candidate;
    const parent: unknown = Object.getPrototypeOf(candidate);
    const buffers: unknown = Object.getOwnPropertyDescriptor(sample, 'mb')?.value;
    const bufferParent: unknown = Array.isArray(buffers) ? Object.getPrototypeOf(buffers) : undefined;
    if (!parent || typeof parent !== 'object' || !bufferParent || typeof bufferParent !== 'object') {
      throw new Error('No actual native statement and buffer parents');
    }
    statementParent = parent; bufferPrototype = bufferParent;
  } finally { sample.free(); scratch.close(); }
  const preparedSql: string[] = [];
  let owner: NativeDatabase | undefined;
  const observing = spyOn(SQL.Database.prototype, 'exec').mockImplementation(function (this: NativeDatabase, sql, params, config) {
    if (sql === 'PRAGMA read_uncommitted;PRAGMA database_list') owner = this;
    return execute.call(this, sql, params, config);
  });
  observers.push(observing);
  if (!projection) observers.push(spyOn(SQL.Database.prototype, 'prepare').mockImplementation(function (this: NativeDatabase, sql) {
    preparedSql.push(sql);
    const statement = prepare.call(this, primedReaderAtBirth ? 'SELECT 1 AS frame_matches' : sql);
    if (primedReaderAtBirth) {
      if (!statement.step()) throw new Error('Actual native scalar could not be primed');
      let row = true;
      statement.reset = () => { row = true; return true; };
      statement.step = () => { const next = row; row = false; return next; };
    }
    return statement;
  }));
  const currentRaw = (): NativeDatabase => { if (!owner) throw new Error('No actual native probe owner'); return owner; };
  const liveStatements = () => {
    const registry: unknown = Object.getOwnPropertyDescriptor(currentRaw(), 'gb')?.value;
    if (!registry || typeof registry !== 'object') throw new Error('No actual native statement registry');
    return Object.values(registry);
  };
  const read = () => sqlite.readPersistedRow('knowledge_sources', 'id', 'original')[0]?.values;
  return { sqlite, facade, filename, currentRaw, read, preparedSql, statementPrototype, statementParent, bufferPrototype, liveStatements, SQL };
}

test.each([true, false])('fresh native and original complete fallback agree on unchanged/high-version rows (projection %s)', async projection => {
  const { sqlite, filename, liveStatements, read } = await fixture(projection);
  sqlite.run('PRAGMA schema_version=2147483647');
  await sqlite.save();
  const before = readFileSync(filename);
  const assertion = () => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); });
    if (projection) {
      expect(liveStatements()).toEqual([]);
    }
  });
  expect(assertion).not.toThrow();
  await Promise.resolve();
  expect(assertion).not.toThrow();
  expect(readFileSync(filename)).toEqual(before);
});

for (const projection of [true, false]) test.each(['mode', 'schema', 'attachment', 'shadow'] as const)(`native equality/fallback ${projection} detects %s changes before a later row`, async mutation => {
  const { sqlite, filename, currentRaw, read } = await fixture(projection);
  const before = readFileSync(filename); let consumed = false;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    const raw = currentRaw();
    if (mutation === 'mode') raw.run('PRAGMA read_uncommitted=1');
    else if (mutation === 'schema') raw.run('PRAGMA schema_version=2147483647');
    else if (mutation === 'attachment') raw.run("ATTACH DATABASE ':memory:' AS attached_probe");
    else raw.run('CREATE TABLE pragma_schema_version(schema_version INTEGER)');
    sqlite.assertPersistedReadFrame(() => { read(); consumed = true; });
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false);
  expect(readFileSync(filename)).toEqual(before);
});

test.each([true, false])('preexisting shadow metadata retains original complete fallback semantics (projection %s)', async projection => {
  const { sqlite, filename, read } = await fixture(projection);
  sqlite.run('CREATE TABLE pragma_schema_version(schema_version INTEGER)');
  await sqlite.save();
  const before = readFileSync(filename);
  expect(() => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); });
  })).not.toThrow();
  expect(readFileSync(filename)).toEqual(before);
});

test('a native alias commit-and-restore remains held although final row bytes are equal', async () => {
  const { sqlite, filename, currentRaw, read } = await fixture(true), SQL = await loadSqlJsEngine();
  const alias = new SQL.Database(); const before = readFileSync(filename); let consumed = false;
  try {
    expect(() => sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      const raw = currentRaw();
      const main = raw.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
      if (typeof main !== 'string') throw new Error('No original native VFS path');
      alias.run('ATTACH DATABASE ? AS original', [main]);
      alias.run("UPDATE original.knowledge_sources SET title='temporary' WHERE id='original'");
      alias.run("UPDATE original.knowledge_sources SET title='Complete original source' WHERE id='original'");
      sqlite.assertPersistedReadFrame(() => { read(); consumed = true; });
    })).toThrow(SQLiteObservationRetiredError);
    expect(consumed).toBe(false); expect(readFileSync(filename)).toEqual(before);
  } finally { alias.close(); }
});

test('a replaced SQL typeof uses original complete observations without invoking the replacement', async () => {
  const { sqlite, currentRaw, read } = await fixture(true); let invoked = 0;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    currentRaw().create_function('typeof', () => { invoked++; return 'integer'; });
    sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); });
  })).not.toThrow();
  expect(invoked).toBe(0);
});

test.each([false, true])('primed reset/step replacements cannot grant scalar equality before installation (changed mode %s)', async changed => {
  const { sqlite, currentRaw, read, preparedSql } = await fixture(false, true); let consumed = false;
  const assertion = () => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    if (changed) currentRaw().run('PRAGMA read_uncommitted=1');
    sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); consumed = true; });
  });
  if (changed) expect(assertion).toThrow(SQLiteObservationRetiredError); else expect(assertion).not.toThrow();
  expect(consumed).toBe(!changed);
  expect(preparedSql).toHaveLength(1);
  expect(preparedSql[0]).not.toContain('AS frame_matches');
  expect(preparedSql[0]).toContain('AS shadowed');
});

test('fresh scalar execution exposes no registered live statement across caller callbacks', async () => {
  const { sqlite, filename, currentRaw, liveStatements, read } = await fixture(true);
  const before = readFileSync(filename); let consumed = false, invoked = 0;
  let other: ReturnType<NativeDatabase['prepare']> | undefined;
  try {
    expect(() => sqlite.assertPersistedReadFrame(() => {
      read(); expect(liveStatements()).toEqual([]);
      const raw = currentRaw(); other = raw.prepare('SELECT 1 AS frame_matches');
      Object.defineProperty(other, 'Ob', { value: () => { invoked++; return 1n; }, configurable: true });
      raw.run('PRAGMA read_uncommitted=1');
      sqlite.assertPersistedReadFrame(() => { read(); consumed = true; });
    })).toThrow(SQLiteObservationRetiredError);
    expect(consumed).toBe(false); expect(invoked).toBe(0);
  } finally { other?.free(); }
  expect(readFileSync(filename)).toEqual(before);
});

test('a replaced native statement constructor prototype holds before a later row callback', async () => {
  const { sqlite, filename, statementPrototype, read } = await fixture(true);
  const before = readFileSync(filename); let consumed = false;
  const constructor: unknown = Object.getOwnPropertyDescriptor(statementPrototype, 'constructor')?.value;
  if (typeof constructor !== 'function') throw new Error('No actual native statement constructor');
  const descriptor = Object.getOwnPropertyDescriptor(constructor, 'prototype');
  if (!descriptor || descriptor.value !== statementPrototype) throw new Error('No original native constructor prototype');
  expect(() => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    Object.defineProperty(constructor, 'prototype', { ...descriptor, value: Object.create(statementPrototype) });
    try { sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); consumed = true; }); }
    finally { Object.defineProperty(constructor, 'prototype', descriptor); }
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(readFileSync(filename)).toEqual(before);
});

test.each(['Ob', 'Ab', 'Tb', 'getBlob', 'get', 'qb', 'getColumnNames', 'step', 'reset', 'freemem', 'Ya', 'free'] as const)('a native prototype dependency replacement %s holds before later callbacks', async key => {
  const { sqlite, filename, currentRaw, statementPrototype, read } = await fixture(true);
  const before = readFileSync(filename); let consumed = false, invoked = 0;
  const descriptor = Object.getOwnPropertyDescriptor(statementPrototype, key);
  if (!descriptor) throw new Error('No actual native dependency descriptor');
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(); currentRaw().run('PRAGMA read_uncommitted=1');
    Object.defineProperty(statementPrototype, key, { ...descriptor, value: () => { invoked++; return 1n; } });
    try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
    finally { Object.defineProperty(statementPrototype, key, descriptor); }
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(invoked).toBe(0); expect(readFileSync(filename)).toEqual(before);
});

test.each(['value', 'accessor'] as const)('an own native handleError %s replacement holds before preparing a scalar', async kind => {
  const { sqlite, filename, currentRaw, read } = await fixture(true);
  const before = readFileSync(filename); let consumed = false, invoked = 0;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(); const raw = currentRaw(); raw.run('PRAGMA read_uncommitted=1');
    const replacement = () => { invoked++; return null; };
    Object.defineProperty(raw, 'handleError', kind === 'value' ? { value: replacement, configurable: true }
      : { get() { invoked++; return replacement; }, configurable: true });
    try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
    finally { Reflect.deleteProperty(raw, 'handleError'); }
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(invoked).toBe(0); expect(readFileSync(filename)).toEqual(before);
});

test('an altered native owner handle cannot redirect the scalar to a different connection', async () => {
  const { sqlite, filename, currentRaw, read } = await fixture(true), SQL = await loadSqlJsEngine();
  const other = new SQL.Database(); const before = readFileSync(filename); let consumed = false;
  try {
    expect(() => sqlite.assertPersistedReadFrame(() => {
      read(); const raw = currentRaw(), descriptor = Object.getOwnPropertyDescriptor(raw, 'db');
      const pointer: unknown = Object.getOwnPropertyDescriptor(other, 'db')?.value;
      if (!descriptor || typeof pointer !== 'number') throw new Error('No original native connection handles');
      Object.defineProperty(raw, 'db', { ...descriptor, value: pointer });
      try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
      finally { Object.defineProperty(raw, 'db', descriptor); }
    })).toThrow(SQLiteObservationRetiredError);
    expect(other.exec('SELECT 1')).toEqual([{ columns: ['1'], values: [[1]] }]);
  } finally { other.close(); }
  expect(consumed).toBe(false); expect(readFileSync(filename)).toEqual(before);
});

test.each(['pop', 'push', 'every'] as const)('a replaced Array prototype dependency %s holds before scalar execution', async key => {
  const { sqlite, filename, currentRaw, read } = await fixture(true);
  const before = readFileSync(filename); let consumed = false, invoked = 0;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key);
  if (!descriptor) throw new Error('No original native array dependency');
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(); currentRaw().run('PRAGMA read_uncommitted=1');
    Object.defineProperty(Array.prototype, key, { ...descriptor, value: () => { invoked++; return key === 'every'; } });
    try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
    finally { Object.defineProperty(Array.prototype, key, descriptor); }
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(invoked).toBe(0); expect(readFileSync(filename)).toEqual(before);
});

test('a replaced global BigInt row decoder holds without invoking it', async () => {
  const { sqlite, filename, currentRaw, read } = await fixture(true); let consumed = false, invoked = 0;
  const before = readFileSync(filename), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'BigInt');
  if (!descriptor) throw new Error('No original native integer decoder');
  try {
    expect(() => sqlite.assertPersistedReadFrame(() => {
      read(); currentRaw().run('PRAGMA read_uncommitted=1');
      const original = BigInt;
      Object.defineProperty(globalThis, 'BigInt', { ...descriptor, value: (value: string | number | bigint | boolean) => {
        // sql.js decodes SQLite integers from strings. Its filesystem cleanup
        // converts numeric stat fields and retains the original conversion.
        if (typeof value === 'string') { invoked++; return 1n; }
        return original(value);
      } });
      sqlite.assertPersistedReadFrame(() => { read(); consumed = true; });
    })).toThrow(SQLiteObservationRetiredError);
  } finally { Object.defineProperty(globalThis, 'BigInt', descriptor); }
  expect(consumed).toBe(false); expect(invoked).toBe(0); expect(readFileSync(filename)).toEqual(before);
});

test('owner cancellation still holds at the actual source guard inside a native frame', async () => {
  const store = new KnowledgeStore({ dbPath: path() }); knowledgeStores.push(store);
  await store.init();
  const source = await store.upsertSource({ connectorId: 'native-frame', sourceType: 'document', sourceUri: 'https://example.test/native-frame', title: 'Complete source', status: 'indexed' });
  const controller = new AbortController(), guard = createSemanticWriteGuard(store, controller.signal);
  guard.source(source.id, source);
  let consumed = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    guard.assertCurrent(); controller.abort(); guard.assertCurrent(); consumed = true;
  })).toThrow(KnowledgeSourceQualityHeldError);
  expect(consumed).toBe(false);
});


function nativeRegistry(raw: NativeDatabase): object {
  const registry: unknown = Object.getOwnPropertyDescriptor(raw, 'gb')?.value;
  if (!registry || typeof registry !== 'object') throw new Error('No actual native registry');
  return registry;
}

test('a genuine scalar preparation error retains complete native fallback and releases its unsuccessful preparation', async () => {
  const { sqlite, filename, liveStatements, read } = await fixture(true);
  sqlite.run('CREATE TABLE pragma_function_list(unrelated TEXT)');
  await sqlite.save();
  const before = readFileSync(filename);
  expect(() => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); });
    expect(liveStatements()).toEqual([]);
  })).not.toThrow();
  expect(readFileSync(filename)).toEqual(before);
});

test('an empty registry that no longer permits genuine registration uses complete native fallback', async () => {
  const { sqlite, filename, currentRaw, liveStatements, read } = await fixture(true);
  sqlite.assertPersistedReadFrame(() => { read(); });
  Object.preventExtensions(nativeRegistry(currentRaw()));
  const before = readFileSync(filename);
  expect(() => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); });
  })).not.toThrow();
  expect(liveStatements()).toEqual([]); expect(readFileSync(filename)).toEqual(before);
});

test.each(['value', 'accessor', 'prototype'] as const)('native release remains independent of a replaced registry %s', async kind => {
  const { sqlite, filename, currentRaw, read } = await fixture(true);
  const before = readFileSync(filename); let consumed = false, invoked = 0;
  let raw: NativeDatabase | undefined, descriptor: PropertyDescriptor | undefined;
  let registry: object | undefined, prototype: object | null | undefined;
  try {
    expect(() => sqlite.assertPersistedReadFrame(() => {
      read(); raw = currentRaw(); descriptor = Object.getOwnPropertyDescriptor(raw, 'gb');
      registry = nativeRegistry(raw); prototype = Object.getPrototypeOf(registry);
      if (!descriptor) throw new Error('No original registry descriptor');
      if (kind === 'value') Object.defineProperty(raw, 'gb', { ...descriptor, value: {} });
      else if (kind === 'accessor') Object.defineProperty(raw, 'gb', { configurable: true, get() { invoked++; throw new Error('Borrowed registry getter'); } });
      else Object.setPrototypeOf(registry, {});
      sqlite.assertPersistedReadFrame(() => { read(); consumed = true; });
    })).toThrow(SQLiteObservationRetiredError);
  } finally {
    if (raw && descriptor) Object.defineProperty(raw, 'gb', descriptor);
    if (registry && prototype !== undefined) Object.setPrototypeOf(registry, prototype);
  }
  expect(consumed).toBe(false); expect(invoked).toBe(0);
  expect(currentRaw().exec('SELECT 1')).toEqual([{ columns: ['1'], values: [[1]] }]);
  expect(() => sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); })).not.toThrow();
  expect(readFileSync(filename)).toEqual(before);
});

test.each(['export', 'close', 'facade-export'] as const)('actual native %s retires a private executable without leaving a registered handle', async action => {
  const { sqlite, facade, filename, currentRaw, liveStatements, read } = await fixture(true);
  const before = readFileSync(filename); let consumed = false;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(); expect(liveStatements()).toEqual([]);
    if (action === 'facade-export') facade.export();
    else if (action === 'export') currentRaw().export();
    else currentRaw().close();
    sqlite.assertPersistedReadFrame(() => { read(); consumed = true; });
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(liveStatements()).toEqual([]);
  expect(readFileSync(filename)).toEqual(before);
  if (action !== 'close') expect(() => sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); })).not.toThrow();
});

test.each(['_sqlite3_finalize', '_sqlite3_step', '_sqlite3_prepare_v2', 'UTF8ToString'] as const)('a replaced module dependency %s cannot run or prevent original native release', async key => {
  const { sqlite, filename, read } = await fixture(true), SQL = await loadSqlJsEngine();
  const descriptor = Object.getOwnPropertyDescriptor(SQL, key);
  if (!descriptor || typeof descriptor.value !== 'function') throw new Error('No genuine module dependency');
  const before = readFileSync(filename); let consumed = false, invoked = 0;
  try {
    expect(() => sqlite.assertPersistedReadFrame(() => {
      read();
      Object.defineProperty(SQL, key, { configurable: true, get() { invoked++; throw new Error('Borrowed native module getter'); } });
      sqlite.assertPersistedReadFrame(() => { read(); consumed = true; });
    })).toThrow(SQLiteObservationRetiredError);
  } finally { Object.defineProperty(SQL, key, descriptor); }
  expect(consumed).toBe(false); expect(invoked).toBe(0);
  expect(() => sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); })).not.toThrow();
  expect(readFileSync(filename)).toEqual(before);
});

function actualMethodOwner(prototype: object, key: string): { owner: object; descriptor: PropertyDescriptor } {
  let owner: object | null = prototype;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return { owner, descriptor };
    owner = Object.getPrototypeOf(owner);
  }
  throw new Error('No actual dispatch owner');
}

test.each(['charCodeAt', 'codePointAt', 'decode', 'subarray'] as const)('original Unicode rows retain producer/decoder dependency %s guards', async key => {
  const { sqlite, filename, read } = await fixture(true);
  const title = 'A complete café source — 日本語';
  sqlite.run('UPDATE knowledge_sources SET title=? WHERE id=?', [title, 'original']); await sqlite.save();
  const prototype = key === 'decode' ? TextDecoder.prototype : key === 'subarray' ? Uint8Array.prototype : String.prototype;
  const { owner, descriptor } = actualMethodOwner(prototype, key);
  const before = readFileSync(filename); let consumed = false, invoked = 0;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', title]]);
    Object.defineProperty(owner, key, { ...descriptor, value: () => { invoked++; throw new Error('Borrowed decoder'); } });
    try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
    finally { Object.defineProperty(owner, key, descriptor); }
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(invoked).toBe(0); expect(readFileSync(filename)).toEqual(before);
});

test('a callback error stays exact while the registry getter is replaced through native release', async () => {
  const { sqlite, filename, currentRaw, read } = await fixture(true);
  const before = readFileSync(filename), original = new Error('Original callback refusal');
  let raw: NativeDatabase | undefined, descriptor: PropertyDescriptor | undefined, invoked = 0, caught: unknown;
  try {
    sqlite.assertPersistedReadFrame(() => {
      read(); raw = currentRaw(); descriptor = Object.getOwnPropertyDescriptor(raw, 'gb');
      Object.defineProperty(raw, 'gb', { configurable: true, get() { invoked++; throw new Error('Borrowed registry getter'); } });
      throw original;
    });
  } catch (error) { caught = error; }
  finally { if (raw && descriptor) Object.defineProperty(raw, 'gb', descriptor); }
  expect(caught).toBe(original); expect(invoked).toBe(0);
  expect(() => sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); })).not.toThrow();
  expect(readFileSync(filename)).toEqual(before);
});

test('mutable bookkeeping and freeze hooks never receive the private executable or prevent cleanup', async () => {
  const { sqlite, facade, filename, read } = await fixture(true);
  const freezeDescriptor = Object.getOwnPropertyDescriptor(Object, 'freeze');
  const getDescriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get');
  const setDescriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'set');
  const deleteDescriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'delete');
  if (!freezeDescriptor || !getDescriptor || !setDescriptor || !deleteDescriptor) throw new Error('No original native bookkeeping');
  const define = Object.defineProperty, freeze = Object.freeze, get = WeakMap.prototype.get,
    set = WeakMap.prototype.set, remove = WeakMap.prototype.delete;
  let exposed = false, removalInvoked = 0;
  const observe = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const execution: unknown = Object.getOwnPropertyDescriptor(value, 'execution')?.value;
    if (execution && typeof execution === 'object' && Object.getOwnPropertyDescriptor(execution, 'executable')) exposed = true;
  };
  const before = readFileSync(filename);
  try {
    define(Object, 'freeze', { ...freezeDescriptor, value: <T>(value: T): Readonly<T> => { observe(value); return freeze(value); } });
    define(WeakMap.prototype, 'get', { ...getDescriptor, value: function(this: WeakMap<object, unknown>, key: object): unknown { const value = get.call(this, key); observe(value); return value; } });
    define(WeakMap.prototype, 'set', { ...setDescriptor, value: function(this: WeakMap<object, unknown>, key: object, value: unknown) { observe(value); return set.call(this, key, value); } });
    define(WeakMap.prototype, 'delete', { ...deleteDescriptor, value: function(this: WeakMap<object, unknown>, key: object) { removalInvoked++; return remove.call(this, key); } });
    sqlite.assertPersistedReadFrame(() => {
      read(); sqlite.assertPersistedReadFrame(() => { read(); });
      // Native retirement and the outer finally both encounter this lifetime;
      // a borrowed bookkeeping hook never controls the release operation.
      facade.export();
    });
  } catch (error) { if (!(error instanceof SQLiteObservationRetiredError)) throw error; }
  finally {
    define(Object, 'freeze', freezeDescriptor); define(WeakMap.prototype, 'get', getDescriptor);
    define(WeakMap.prototype, 'set', setDescriptor); define(WeakMap.prototype, 'delete', deleteDescriptor);
  }
  expect(exposed).toBe(false); expect(removalInvoked).toBe(0);
  expect(() => sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); })).not.toThrow();
  expect(readFileSync(filename)).toEqual(before);
});


test.each(['plan-value', 'plan-accessor', 'frame-value', 'frame-accessor'] as const)('substituting the mutable %s slot cannot select or suppress native cleanup', async kind => {
  const { sqlite, filename, currentRaw, read } = await fixture(true);
  const before = readFileSync(filename); let consumed = false, invoked = 0;
  let owner: object | undefined, key: string | undefined, descriptor: PropertyDescriptor | undefined;
  try {
    expect(() => sqlite.assertPersistedReadFrame(() => {
      read();
      const frame: unknown = Object.getOwnPropertyDescriptor(sqlite, 'persistedReadFrame')?.value;
      if (!frame || typeof frame !== 'object') throw new Error('No actual active native frame');
      const state: unknown = Object.getOwnPropertyDescriptor(frame, 'localState')?.value;
      if (!state || typeof state !== 'object') throw new Error('No original native owner');
      owner = kind.startsWith('plan') ? state : frame;
      key = kind.startsWith('plan') ? 'probePlans' : 'localState';
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('No original data owner slot');
      if (kind.endsWith('accessor')) Object.defineProperty(owner, key, { configurable: true, get() { invoked++; throw new Error('Borrowed owner getter'); } });
      else Object.defineProperty(owner, key, { ...descriptor, value: { dispose() { invoked++; } } });
      sqlite.assertPersistedReadFrame(() => { read(); consumed = true; });
    })).toThrow(SQLiteObservationRetiredError);
  } finally { if (owner && key && descriptor) Object.defineProperty(owner, key, descriptor); }
  expect(consumed).toBe(false); expect(invoked).toBe(0);
  expect(currentRaw().exec('SELECT 1')).toEqual([{ columns: ['1'], values: [[1]] }]);
  expect(readFileSync(filename)).toEqual(before);
});


test('caller-authored constructor-proof fields are never consumed as native birth provenance', async () => {
  const { sqlite, filename, read } = await fixture(true);
  let state: object | undefined, invoked = 0;
  sqlite.assertPersistedReadFrame(() => {
    read();
    const frame: unknown = Object.getOwnPropertyDescriptor(sqlite, 'persistedReadFrame')?.value;
    const value: unknown = frame && typeof frame === 'object' ? Object.getOwnPropertyDescriptor(frame, 'localState')?.value : undefined;
    if (!value || typeof value !== 'object') throw new Error('No actual original owner');
    state = value;
  });
  if (!state) throw new Error('No actual native owner');
  Object.defineProperty(state, 'birthRegistry', { configurable: true, get() { invoked++; throw new Error('Caller-authored constructor proof'); } });
  const before = readFileSync(filename);
  expect(() => sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); });
  })).not.toThrow();
  expect(invoked).toBe(0); expect(readFileSync(filename)).toEqual(before);
});


test('an actual constructor hook cannot grant native birth provenance to a proxied registry', async () => {
  await loadSqlJsEngine();
  const random = Math.random, define = Object.defineProperty, remove = Reflect.deleteProperty;
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'gb');
  let exposed = 0;
  const observing = spyOn(Math, 'random').mockImplementation(() => {
    const result = random();
    define(Object.prototype, 'gb', { configurable: true, set(this: object, value: unknown) {
      if (!value || typeof value !== 'object') throw new Error('No genuine constructor registry');
      const registry = new Proxy(value, { set(target, key, assigned: unknown, receiver: object) {
        if (assigned && typeof assigned === 'object' && typeof Object.getOwnPropertyDescriptor(assigned, 'Qa')?.value === 'number') exposed++;
        return Reflect.set(target, key, assigned, receiver);
      } });
      define(this, 'gb', { value: registry, configurable: true, writable: true, enumerable: true });
      if (original) define(Object.prototype, 'gb', original); else remove(Object.prototype, 'gb');
    } });
    return result;
  });
  try {
    const filename = path(), sqlite = new SQLiteStore(filename, { coordinated: true }); databases.push(sqlite);
    await sqlite.init(db => db.run('CREATE TABLE IF NOT EXISTS knowledge_sources(id TEXT PRIMARY KEY,title TEXT)'));
    sqlite.run("INSERT INTO knowledge_sources VALUES('original','Complete original source')"); await sqlite.save();
    const before = readFileSync(filename);
    const read = () => sqlite.readPersistedRow('knowledge_sources', 'id', 'original')[0]?.values;
    expect(() => sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      sqlite.assertPersistedReadFrame(() => { expect(read()).toEqual([['original', 'Complete original source']]); });
    })).not.toThrow();
    expect(exposed).toBe(0); expect(readFileSync(filename)).toEqual(before);
  } finally {
    observing.mockRestore();
    if (original) define(Object.prototype, 'gb', original); else remove(Object.prototype, 'gb');
  }
});

test.each(['own-key', 'descriptor', 'prototype'] as const)('complete shared native prototype %s mutations hold before later callbacks', async mutation => {
  const { sqlite, filename, read } = await fixture(true);
  const before = readFileSync(filename), shared = Function.prototype, originalParent = Object.getPrototypeOf(shared);
  const key = mutation === 'own-key' ? Symbol('native shared prototype field') : 'toString';
  const descriptor = Object.getOwnPropertyDescriptor(shared, key);
  if (mutation === 'descriptor' && (!descriptor || !descriptor.configurable)) throw new Error('No replaceable original native prototype descriptor');
  let consumed = false, invoked = 0, caught: unknown;
  try {
    sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      if (mutation === 'prototype') Object.setPrototypeOf(shared, Object.create(originalParent));
      else Object.defineProperty(shared, key, { configurable: true, get() { invoked++; throw new Error('Borrowed complete native prototype getter'); } });
      try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
      finally {
        if (mutation === 'prototype') Object.setPrototypeOf(shared, originalParent);
        else if (descriptor) Object.defineProperty(shared, key, descriptor);
        else Reflect.deleteProperty(shared, key);
      }
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(invoked).toBe(0);
  expect(readFileSync(filename)).toEqual(before);
});

test.each(['proxy', 'accessor'] as const)('an observable global receiver %s cannot restore native facts before their original check', async receiverKind => {
  const { sqlite, filename, read } = await fixture(true);
  const before = readFileSync(filename), globalReceiver = globalThis;
  const self = Object.getOwnPropertyDescriptor(globalReceiver, 'globalThis');
  if (!self || !('value' in self) || self.value !== globalReceiver || !self.configurable) throw new Error('No original replaceable global receiver');
  const define = Object.defineProperty, remove = Reflect.deleteProperty, ownDescriptor = Reflect.getOwnPropertyDescriptor;
  const shared = Function.prototype, key = Symbol('temporary native complete prototype field');
  let firstTrap = 0, restorationTrap = 0, borrowedGetter = 0, receiverGetter = 0, consumed = false, caught: unknown;
  const receiver = new Proxy(globalReceiver, {
    getOwnPropertyDescriptor(target, field) {
      const descriptor = ownDescriptor(target, field);
      if (field === 'String') {
        firstTrap++;
        define(shared, key, { configurable: true, get() { borrowedGetter++; throw new Error('Borrowed transient prototype field'); } });
      } else if (field === 'Uint8Array') { restorationTrap++; remove(shared, key); }
      return descriptor;
    },
  });
  try {
    sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      if (receiverKind === 'proxy') define(globalReceiver, 'globalThis', { ...self, value: receiver });
      else define(globalReceiver, 'globalThis', { configurable: true, get() { receiverGetter++; return receiver; } });
      try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
      finally { define(globalReceiver, 'globalThis', self); remove(shared, key); }
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SQLiteObservationRetiredError);
  expect(firstTrap).toBeGreaterThan(0); expect(restorationTrap).toBe(0);
  if (receiverKind === 'accessor') expect(receiverGetter).toBeGreaterThan(0);
  expect(consumed).toBe(false); expect(borrowedGetter).toBe(0);
  expect(readFileSync(filename)).toEqual(before);
});

test('a late global capture setter cannot omit complete private native facts', async () => {
  // A separate actual source module keeps this acquisition control from
  // changing the engine provenance used by every other whole-file control.
  const modulePath = '../sdk/src/platform/state/sqlite-store.js?native-global-facts-own-append';
  const isolated: typeof import('../sdk/src/platform/state/sqlite-store.js') = await import(modulePath);
  if (isolated.loadSqlJsEngine === loadSqlJsEngine) throw new Error('The acquisition control requires a distinct actual source loader');
  const own = Object.getOwnPropertyDescriptor;
  const parent = Object.getPrototypeOf, define = Object.defineProperty, remove = Reflect.deleteProperty, apply = Reflect.apply;
  const push = Array.prototype.push, isArray = Array.isArray;
  const pushSlot = own(Array.prototype, 'push'), parentSlot = own(Object, 'getPrototypeOf');
  const zeroSlot = own(Array.prototype, '0'), lengthSlot = own(Array.prototype, 'length');
  if (!pushSlot || !parentSlot || zeroSlot || !lengthSlot || !('value' in lengthSlot)) throw new Error('No original native acquisition reflection slots');
  let armed = false, captured = 0, restored = 0, exposed = 0;
  const isStatement = (target: object) => {
    const pointer: unknown = own(target, 'Qa')?.value, buffers: unknown = own(target, 'mb')?.value;
    return typeof pointer === 'number' && Number.isSafeInteger(pointer) && pointer > 0
      && own(target, 'Oa')?.value === 1 && typeof own(target, 'db')?.value === 'object' && isArray(buffers);
  };
  const restore = () => {
    remove(Array.prototype, '0');
    define(Array.prototype, 'length', lengthSlot);
    define(Array.prototype, 'push', pushSlot);
    define(Object, 'getPrototypeOf', parentSlot);
  };
  const installSetter = () => {
    if (armed) return;
    armed = true; captured++;
    define(Array.prototype, '0', { configurable: true, set(this: object, value: unknown) {
      if (value && typeof value === 'object') {
        const object: unknown = own(value, 'object')?.value, slots: unknown = own(value, 'slots')?.value;
        if (object && (typeof object === 'object' || typeof object === 'function') && isArray(slots)) {
          exposed++; return;
        }
      }
      // Ordinary native writes still perform their exact real array append.
      define(this, '0', { value, configurable: true, enumerable: true, writable: true });
    } });
  };
  function reflectingParent(target: object): object | null {
    const result: unknown = parent(target);
    if (result !== null && typeof result !== 'object' && typeof result !== 'function') throw new Error('No actual native prototype');
    if (isStatement(target) && result) {
      if (armed) { restored++; restore(); }
    }
    return result;
  }
  function observingPush(this: unknown[], ...values: unknown[]): number {
    const result: number = apply(push, this, values);
    const value = values[0];
    if (value && typeof value === 'object' && own(value, 'key')?.value === 'TextDecoder') installSetter();
    return result;
  }
  try {
    define(Object, 'getPrototypeOf', { ...parentSlot, value: reflectingParent });
    define(Array.prototype, 'push', { ...pushSlot, value: observingPush });
    await isolated.loadSqlJsEngine();
  } finally { restore(); }
  expect(own(Array.prototype, 'length')).toEqual(lengthSlot);
  expect(own(Array.prototype, '0')).toBeUndefined();
  expect(captured).toBe(1); expect(restored).toBe(1); expect(exposed).toBe(0);
  const filename = path();
  const sqlite = new isolated.SQLiteStore(filename, { coordinated: true });
  databases.push(sqlite);
  await sqlite.init(db => { db.run('CREATE TABLE IF NOT EXISTS knowledge_sources(id TEXT PRIMARY KEY,title TEXT)'); });
  sqlite.run("INSERT INTO knowledge_sources VALUES('original','Complete original source')");
  await sqlite.save();
  const before = readFileSync(filename), shared = Function.prototype;
  const key = Symbol('original complete acquisition prototype field');
  const read = () => sqlite.readPersistedRow('knowledge_sources', 'id', 'original')[0]?.values;
  let consumed = false, getter = 0, caught: unknown;
  try {
    sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      define(shared, key, { configurable: true, get() { getter++; throw new Error('Borrowed omitted complete acquisition field'); } });
      try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
      finally { remove(shared, key); }
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(isolated.SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(getter).toBe(0);
  expect(readFileSync(filename)).toEqual(before);
});

async function nativePrefixFixture() {
  const modulePath = '../sdk/src/platform/state/sqlite-store.js?native-adjacent-facts-prefix-guard';
  const native: typeof import('../sdk/src/platform/state/sqlite-store.js') = await import(modulePath);
  if (native.loadSqlJsEngine === loadSqlJsEngine) throw new Error('The prefix control requires a distinct actual source loader');
  return { ...await fixture(true, false, native), heldError: native.SQLiteObservationRetiredError };
}

function requireNativePrefixFrame(sqlite: SQLiteStore): void {
  const own = Object.getOwnPropertyDescriptor;
  const frame: unknown = own(sqlite, 'persistedReadFrame')?.value;
  if (!frame || typeof frame !== 'object') throw new Error('No actual prefix read frame');
  const state: unknown = own(frame, 'localState')?.value;
  const plans: unknown = state && typeof state === 'object' ? own(state, 'probePlans')?.value : undefined;
  if (own(frame, 'localIsolated')?.value !== false || !plans || typeof plans !== 'object'
    || own(plans, 'kind')?.value !== 'scalar') throw new Error('No actual non-isolated scalar prefix plan');
}

test.each(['own-key', 'descriptor', 'prototype'] as const)('the complete statement/array prefix holds %s changes before a later row', async mutation => {
  const { sqlite, filename, read, statementParent, bufferPrototype, heldError } = await nativePrefixFixture();
  const before = readFileSync(filename), shared = mutation === 'prototype' ? bufferPrototype : statementParent;
  const originalParent = Object.getPrototypeOf(shared), key = mutation === 'own-key' ? Symbol('shared statement parent field') : 'toString';
  const descriptor = Object.getOwnPropertyDescriptor(shared, key);
  if (mutation === 'descriptor' && (!descriptor || !descriptor.configurable)) throw new Error('No original shared parent descriptor');
  const define = Object.defineProperty, parent = Object.setPrototypeOf, remove = Reflect.deleteProperty;
  let consumed = false, invoked = 0, caught: unknown;
  try {
    sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      requireNativePrefixFrame(sqlite);
      if (mutation === 'prototype') parent(shared, Object.create(originalParent));
      else define(shared, key, { configurable: true, get() { invoked++; throw new Error('Borrowed shared statement parent getter'); } });
      try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
      finally {
        if (mutation === 'prototype') parent(shared, originalParent);
        else if (descriptor) define(shared, key, descriptor);
        else remove(shared, key);
      }
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(heldError);
  expect(consumed).toBe(false); expect(invoked).toBe(0);
  expect(readFileSync(filename)).toEqual(before);
});

test('a call-through descriptor callback cannot restore shared statement facts before their original prefix check', async () => {
  const { sqlite, filename, read, SQL, statementParent, heldError } = await nativePrefixFixture();
  const before = readFileSync(filename), own = Object.getOwnPropertyDescriptor;
  const method = own(Object, 'getOwnPropertyDescriptor');
  if (!method || !('value' in method) || method.value !== own || !method.configurable) throw new Error('No original descriptor dispatch');
  const define = Object.defineProperty, remove = Reflect.deleteProperty, shared = statementParent;
  const key = Symbol('transient shared statement parent field');
  let firstCallback = 0, restorationCallback = 0, getter = 0, consumed = false, caught: unknown;
  function reflecting(target: object, field: PropertyKey): PropertyDescriptor | undefined {
    const descriptor = own(target, field);
    if (target === SQL.Database.prototype && field === 'prepare') {
      firstCallback++;
      define(shared, key, { configurable: true, get() { getter++; throw new Error('Borrowed transient shared statement parent getter'); } });
    } else if (target === SQL && field === 'Database' && firstCallback) {
      restorationCallback++; remove(shared, key);
    }
    return descriptor;
  }
  try {
    sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      requireNativePrefixFrame(sqlite);
      define(Object, 'getOwnPropertyDescriptor', { ...method, value: reflecting });
      try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
      finally { define(Object, 'getOwnPropertyDescriptor', method); remove(shared, key); }
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(heldError);
  expect(firstCallback).toBeGreaterThan(0); expect(restorationCallback).toBe(0);
  expect(consumed).toBe(false); expect(getter).toBe(0);
  expect(readFileSync(filename)).toEqual(before);
});

test('a late statement capture setter cannot omit complete private native facts', async () => {
  // A separate actual source module keeps this acquisition control from
  // changing the engine provenance used by every other whole-file control.
  const modulePath = '../sdk/src/platform/state/sqlite-store.js?native-adjacent-facts-acquisition';
  const isolated: typeof import('../sdk/src/platform/state/sqlite-store.js') = await import(modulePath);
  if (isolated.loadSqlJsEngine === loadSqlJsEngine) throw new Error('The acquisition control requires a distinct actual source loader');
  const own = Object.getOwnPropertyDescriptor, descriptors = Object.getOwnPropertyDescriptors;
  const parent = Object.getPrototypeOf, define = Object.defineProperty, remove = Reflect.deleteProperty;
  const isArray = Array.isArray;
  const parentSlot = own(Object, 'getPrototypeOf');
  const descriptorsSlot = own(Object, 'getOwnPropertyDescriptors'), zeroSlot = own(Array.prototype, '0');
  const lengthSlot = own(Array.prototype, 'length');
  if (!parentSlot || !descriptorsSlot || zeroSlot || !lengthSlot || !('value' in lengthSlot)) throw new Error('No original native acquisition reflection slots');
  let armed = false, captured = 0, restored = 0, exposed = 0;
  let statementPrototype: object | undefined;
  const isStatement = (target: object) => {
    const pointer: unknown = own(target, 'Qa')?.value, buffers: unknown = own(target, 'mb')?.value;
    return typeof pointer === 'number' && Number.isSafeInteger(pointer) && pointer > 0
      && own(target, 'Oa')?.value === 1 && typeof own(target, 'db')?.value === 'object' && isArray(buffers);
  };
  const restore = () => {
    remove(Array.prototype, '0');
    define(Array.prototype, 'length', lengthSlot);
    define(Object, 'getPrototypeOf', parentSlot);
    define(Object, 'getOwnPropertyDescriptors', descriptorsSlot);
  };
  const installSetter = () => {
    if (armed) return;
    armed = true; captured++;
    define(Array.prototype, '0', { configurable: true, set(this: object, value: unknown) {
      if (value && typeof value === 'object') {
        const object: unknown = own(value, 'object')?.value, slots: unknown = own(value, 'slots')?.value;
        if (object && (typeof object === 'object' || typeof object === 'function') && isArray(slots) && object === statementPrototype) {
          exposed++; return;
        }
      }
      // Ordinary native writes still perform their exact real array append.
      define(this, '0', { value, configurable: true, enumerable: true, writable: true });
    } });
  };
  function reflectingParent(target: object): object | null {
    const result: unknown = parent(target);
    if (result !== null && typeof result !== 'object' && typeof result !== 'function') throw new Error('No actual native prototype');
    if (isStatement(target) && result) {
      statementPrototype = result;
      if (armed) { restored++; restore(); }
    }
    return result;
  }
  function reflectingDescriptors(target: object): PropertyDescriptorMap {
    const fields = descriptors(target);
    if (isStatement(target)) {
      // The original buffer-array descriptor precedes this final observation,
      // so its complete prototype facts have already been captured.
      const afterOriginalArray: PropertyDescriptor = {};
      define(afterOriginalArray, 'value', { configurable: true, get() { installSetter(); return undefined; } });
      define(fields, 'afterOriginalArray', { value: afterOriginalArray, configurable: true, enumerable: true, writable: true });
    }
    return fields;
  }
  try {
    define(Object, 'getPrototypeOf', { ...parentSlot, value: reflectingParent });
    define(Object, 'getOwnPropertyDescriptors', { ...descriptorsSlot, value: reflectingDescriptors });
    await isolated.loadSqlJsEngine();
  } finally { restore(); }
  expect(own(Array.prototype, 'length')).toEqual(lengthSlot);
  expect(own(Array.prototype, '0')).toBeUndefined();
  expect(captured).toBe(1); expect(restored).toBe(1); expect(exposed).toBe(0);
  if (!statementPrototype) throw new Error('No actual original statement prototype');
  const filename = path();
  const sqlite = new isolated.SQLiteStore(filename, { coordinated: true });
  databases.push(sqlite);
  await sqlite.init(db => { db.run('CREATE TABLE IF NOT EXISTS knowledge_sources(id TEXT PRIMARY KEY,title TEXT)'); });
  sqlite.run("INSERT INTO knowledge_sources VALUES('original','Complete original source')");
  await sqlite.save();
  const before = readFileSync(filename), shared = statementPrototype;
  const key = Symbol('original complete acquisition prototype field');
  const read = () => sqlite.readPersistedRow('knowledge_sources', 'id', 'original')[0]?.values;
  let consumed = false, getter = 0, caught: unknown;
  try {
    sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      define(shared, key, { configurable: true, get() { getter++; throw new Error('Borrowed omitted complete acquisition field'); } });
      try { sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
      finally { remove(shared, key); }
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(isolated.SQLiteObservationRetiredError);
  expect(consumed).toBe(false); expect(getter).toBe(0);
  expect(readFileSync(filename)).toEqual(before);
});


test.each(['writable', 'enumerable'] as const)('every fresh native slot comparison rejects changed %s metadata with the original method value', async flag => {
  const { sqlite, filename, read, statementPrototype, heldError } = await nativePrefixFixture();
  const before = readFileSync(filename), key = 'step';
  const descriptor = Object.getOwnPropertyDescriptor(statementPrototype, key);
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function'
    || !descriptor.configurable || typeof descriptor[flag] !== 'boolean') throw new Error('No genuine mutable native method metadata');
  let consumed = false, reachedMutation = false, nestedAttempt = false, caught: unknown;
  try {
    sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]);
      requireNativePrefixFrame(sqlite);
      Object.defineProperty(statementPrototype, key, { ...descriptor, [flag]: !descriptor[flag] });
      reachedMutation = true;
      try { nestedAttempt = true; sqlite.assertPersistedReadFrame(() => { read(); consumed = true; }); }
      finally { Object.defineProperty(statementPrototype, key, descriptor); }
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(heldError);
  expect(reachedMutation).toBe(true); expect(nestedAttempt).toBe(true);
  expect(consumed).toBe(false);
  expect(readFileSync(filename)).toEqual(before);
});

test('a genuine unchanged native descriptor restamp remains eligible for fresh complete comparisons', async () => {
  const { sqlite, filename, read, statementPrototype } = await nativePrefixFixture();
  const before = readFileSync(filename), descriptor = Object.getOwnPropertyDescriptor(statementPrototype, 'step');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function'
    || !descriptor.configurable) throw new Error('No genuine native method descriptor');
  let consumed = false;
  sqlite.assertPersistedReadFrame(() => {
    expect(read()).toEqual([['original', 'Complete original source']]);
    requireNativePrefixFrame(sqlite);
    Object.defineProperty(statementPrototype, 'step', { ...descriptor });
    sqlite.assertPersistedReadFrame(() => {
      expect(read()).toEqual([['original', 'Complete original source']]); consumed = true;
    });
  });
  expect(consumed).toBe(true);
  expect(readFileSync(filename)).toEqual(before);
});
