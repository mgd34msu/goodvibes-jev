import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlJsEngine, SQLiteObservationRetiredError, SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
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
async function fixture(projection: boolean, primedReaderAtBirth = false) {
  const filename = path(), sqlite = new SQLiteStore(filename, { coordinated: true });
  databases.push(sqlite);
  await sqlite.init(db => db.run('CREATE TABLE IF NOT EXISTS knowledge_sources(id TEXT PRIMARY KEY,title TEXT)'));
  sqlite.run("INSERT INTO knowledge_sources VALUES('original','Complete original source')");
  await sqlite.save();
  const SQL = await loadSqlJsEngine(), prepare = SQL.Database.prototype.prepare, execute = SQL.Database.prototype.exec;
  const scratch = new SQL.Database(), sample = scratch.prepare('SELECT 1');
  let statementPrototype: object;
  try {
    const candidate: unknown = Object.getPrototypeOf(sample);
    if (!candidate || typeof candidate !== 'object') throw new Error('No actual native statement prototype');
    statementPrototype = candidate;
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
  return { sqlite, filename, currentRaw, read, preparedSql, statementPrototype, liveStatements };
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

test('fresh scalar execution leaves no native statement across caller callbacks', async () => {
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
