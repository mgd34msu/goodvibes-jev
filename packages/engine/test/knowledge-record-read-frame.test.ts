import { afterEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlJsEngine, SQLiteObservationRetiredError, SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import { SQLiteStorePersistence } from '../sdk/src/platform/state/sqlite-store-persistence.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { assertKnowledgeRecordAdmissions, KnowledgeRecordAdmissionHeldError, prepareKnowledgeRecordAdmission } from '../sdk/src/platform/knowledge/store-record-snapshot.js';
import { createSemanticWriteGuard } from '../sdk/src/platform/knowledge/semantic/primary-source-plan.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { prepareKnowledgeScopeSelection, KnowledgeScopeSelectionHeldError } from '../sdk/src/platform/knowledge/scope-selection.js';

const roots: string[] = [], stores: KnowledgeStore[] = [], databases: SQLiteStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path() { const root = mkdtempSync(join(tmpdir(), 'knowledge-read-frame-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
function instrument(sqlite: SQLiteStore) {
  const internal = sqlite as unknown as { openCurrentImage(): SqlDatabase; openPrivateReadImage(): SqlDatabase; closeReadImage(db: SqlDatabase): void };
  const currentImages = new Set<SqlDatabase>(), privateImages = new Set<SqlDatabase>();
  const open = internal.openCurrentImage.bind(sqlite); let opened = 0, closed = 0;
  spyOn(internal, 'openCurrentImage').mockImplementation(() => {
    opened++; const db = open(); currentImages.add(db); return db;
  });
  const privateOpen = internal.openPrivateReadImage.bind(sqlite); let privateOpened = 0, privateClosed = 0;
  spyOn(internal, 'openPrivateReadImage').mockImplementation(() => {
    privateOpened++; const db = privateOpen(); privateImages.add(db); return db;
  });
  // Count the same cleanup calls without overwriting frozen facade methods.
  const close = internal.closeReadImage.bind(sqlite);
  spyOn(internal, 'closeReadImage').mockImplementation(db => {
    if (currentImages.has(db)) closed++;
    if (privateImages.has(db)) privateClosed++;
    close(db);
  });
  return Object.assign(() => ({ opened, closed }), { privateImages: () => ({ opened: privateOpened, closed: privateClosed }) });
}
async function fixture(filename = path(), observeValidation?: (db: SqlDatabase) => void) {
  // KnowledgeStore starts init in its constructor. Install the observation
  // before construction, preserving the real schema validator and its options.
  const init = SQLiteStore.prototype.init;
  const observing = observeValidation ? spyOn(SQLiteStore.prototype, 'init').mockImplementation(function (this: SQLiteStore, schema, options) {
    return init.call(this, schema, {
      ...options, validateCurrentSchema(db) { options?.validateCurrentSchema?.(db); observeValidation(db); },
    });
  }) : undefined;
  let store: KnowledgeStore;
  try { store = new KnowledgeStore({ dbPath: filename }); }
  finally { observing?.mockRestore(); }
  stores.push(store);
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  const source = await store.upsertSource({ id: 'source', connectorId: 'frame-test', sourceType: 'document',
    title: 'Router operations', status: 'indexed', metadata: { knowledgeSpaceId: 'default', nested: { original: 'complete' } } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'frame-test', format: 'text',
    sections: ['Router reference'], metadata: { knowledgeSpaceId: 'default' } });
  return { store, source, extraction, sqlite };
}
async function database() {
  const filename = path(), sqlite = new SQLiteStore(filename, { coordinated: true }); databases.push(sqlite);
  await sqlite.init(db => db.run('CREATE TABLE IF NOT EXISTS knowledge_sources (id TEXT)'));
  await sqlite.save();
  return { sqlite, filename };
}
const read = (sqlite: SQLiteStore) => sqlite.readPersistedRow('knowledge_sources', 'id', 'pending direct change');

function interceptPrivateImage(sqlite: SQLiteStore, intercept: (open: (...args: unknown[]) => unknown, args: unknown[]) => unknown) {
  const original: unknown = Reflect.get(sqlite, 'openPrivateReadImage');
  if (typeof original !== 'function') throw new Error('No private image method');
  Object.defineProperty(sqlite, 'openPrivateReadImage', { configurable: true, writable: true,
    value: (...args: unknown[]) => intercept((...values) => Reflect.apply(original, sqlite, values), args) });
  return () => { Reflect.deleteProperty(sqlite, 'openPrivateReadImage'); };
}

function observePhysicalReads() {
  const read = SQLiteStorePersistence.prototype.read;
  let count = 0;
  const observing = spyOn(SQLiteStorePersistence.prototype, 'read').mockImplementation(function (this: SQLiteStorePersistence) {
    count++; return read.call(this);
  });
  return { count: () => count, restore: () => observing.mockRestore() };
}

test('native frame construction consumes its exact hashed entry bytes once and keeps a fresh exit read', async () => {
  const { sqlite, source } = await fixture(), physical = observePhysicalReads();
  try {
    const current = () => sqlite.assertPersistedReadFrame(() => {
      expect(sqlite.readPersistedRow('knowledge_sources', 'id', source.id)[0]?.values).toHaveLength(1);
      sqlite.assertPersistedReadFrame(() => { sqlite.readPersistedRow('knowledge_sources', 'id', source.id); });
    });
    current(); expect(physical.count()).toBe(2);
    await Promise.resolve();
    current(); expect(physical.count()).toBe(4);
  } finally { physical.restore(); }
});

test.each(['missing', 'copied', 'proxy', 'replayed'] as const)(
  'native entry bytes require the authentic one-use frame token, rejecting %s tokens', async kind => {
    const { sqlite, source } = await fixture();
    let previous: unknown;
    const restore = interceptPrivateImage(sqlite, (open, args) => {
      const token: unknown = args[0];
      expect(token).toBeDefined();
      if (!token || typeof token !== 'object') throw new Error('No native frame token');
      const supplied = kind === 'missing' ? undefined : kind === 'copied' ? Object.assign({}, token)
        : kind === 'proxy' ? new Proxy(token, {}) : previous ?? token;
      previous = token;
      return open(supplied);
    });
    const physical = observePhysicalReads();
    try {
      const current = () => sqlite.assertPersistedReadFrame(() => { sqlite.readPersistedRow('knowledge_sources', 'id', source.id); });
      current();
      expect(physical.count()).toBe(kind === 'replayed' ? 2 : 3);
      current();
      expect(physical.count()).toBe(kind === 'replayed' ? 5 : 6);
    } finally { physical.restore(); restore(); }
  },
);

test('native entry-byte tokens cannot cross store owners', async () => {
  const first = await fixture(), second = await fixture();
  let firstToken: unknown;
  const restoreSecond = interceptPrivateImage(second.sqlite, (open, args) => { expect(args[0]).toBeDefined(); return open(firstToken); });
  const restoreFirst = interceptPrivateImage(first.sqlite, (open, args) => {
    firstToken = args[0];
    second.sqlite.assertPersistedReadFrame(() => { second.sqlite.readPersistedRow('knowledge_sources', 'id', second.source.id); });
    return open(...args);
  });
  const physical = observePhysicalReads();
  try {
    first.sqlite.assertPersistedReadFrame(() => { first.sqlite.readPersistedRow('knowledge_sources', 'id', first.source.id); });
    expect(physical.count()).toBe(5);
  } finally { physical.restore(); restoreFirst(); restoreSecond(); }
});

test('native entry bytes stay private when a reflected image interceptor attempts substitution', async () => {
  const { store, sqlite, source } = await fixture();
  const SQL = await loadSqlJsEngine(), forged = new SQL.Database(readFileSync(store.storagePath));
  let replacement: Uint8Array;
  try {
    forged.run("UPDATE knowledge_sources SET title='substituted frame bytes' WHERE id=?", [source.id]);
    replacement = forged.export();
  } finally { forged.close(); }
  const restore = interceptPrivateImage(sqlite, (open, args) => {
    const registry: unknown = Reflect.get(sqlite, 'frameImageStamps'), token: unknown = args[0];
    if (registry instanceof WeakMap && token && typeof token === 'object') {
      const captured: unknown = registry.get(token);
      if (captured && typeof captured === 'object') Object.defineProperty(captured, 'data', { value: replacement });
    }
    return open(...args);
  });
  try {
    sqlite.assertPersistedReadFrame(() => {
      const row = sqlite.readPersistedRow('knowledge_sources', 'id', source.id)[0];
      expect(row?.values[0]?.[row.columns.indexOf('title')]).toBe(source.title);
    });
    expect(Reflect.get(sqlite, 'frameImageStamps')).toBeUndefined();
  } finally { restore(); }
});

test('unknown schema plans retain the constructor reread', async () => {
  const { sqlite } = await database(), physical = observePhysicalReads();
  try {
    sqlite.assertPersistedReadFrame(() => { read(sqlite); });
    expect(physical.count()).toBe(3);
  } finally { physical.restore(); }
});

test('an unowned local facade cannot supply a native entry-byte stamp', async () => {
  const { sqlite, source } = await fixture();
  const original: unknown = Reflect.get(sqlite, 'db');
  if (!original || typeof original !== 'object') throw new Error('No native owner facade');
  Reflect.set(sqlite, 'db', new Proxy(original, {}));
  const physical = observePhysicalReads();
  try {
    sqlite.assertPersistedReadFrame(() => { sqlite.readPersistedRow('knowledge_sources', 'id', source.id); });
    expect(physical.count()).toBe(3);
  } finally { physical.restore(); Reflect.set(sqlite, 'db', original); }
});

test('a custom native validator keeps the reread and callback image isolation', async () => {
  const exposed: SqlDatabase[] = [];
  const { sqlite, source } = await fixture(path(), db => { exposed.push(db); });
  const physical = observePhysicalReads(), previous = exposed.length;
  try {
    sqlite.assertPersistedReadFrame(() => {
      sqlite.readPersistedRow('knowledge_sources', 'id', source.id);
      expect(exposed).toHaveLength(previous + 1);
      const image = exposed.at(-1);
      if (!image) throw new Error('No custom validator image');
      expect(() => image.run('SELECT 1')).toThrow();
    });
    expect(physical.count()).toBe(3);
  } finally { physical.restore(); }
});

test.each(['plan', 'validator', 'version'] as const)('entry-byte adoption rechecks the current native %s', async changed => {
  const { sqlite, source } = await fixture();
  const key = changed === 'plan' ? 'nativeSchemaReadPlan' : changed === 'validator' ? 'validateCurrentSchema' : 'schemaVersion';
  const original: unknown = Reflect.get(sqlite, key);
  let callbacks = 0;
  const restore = interceptPrivateImage(sqlite, (open, args) => {
    const replacement = changed === 'plan' && original && typeof original === 'object' ? Object.assign({}, original)
      : changed === 'validator' ? (db: SqlDatabase) => {
        callbacks++;
        if (typeof original !== 'function') throw new Error('No original native validator');
        Reflect.apply(original, undefined, [db]);
      } : 11;
    Reflect.set(sqlite, key, replacement);
    try { return open(...args); } finally { Reflect.set(sqlite, key, original); }
  });
  const physical = observePhysicalReads();
  try {
    const current = () => sqlite.assertPersistedReadFrame(() => { sqlite.readPersistedRow('knowledge_sources', 'id', source.id); });
    if (changed === 'version') { expect(current).toThrow('persisted schema changed'); expect(physical.count()).toBe(2); }
    else { current(); expect(physical.count()).toBe(3); }
    expect(callbacks).toBe(changed === 'validator' ? 1 : 0);
  } finally { physical.restore(); restore(); }
});

test.each(['file replacement', 'row rollback', 'native alias restore', 'native schema change', 'native pragma shadow'] as const)(
  'native entry-byte adoption preserves the %s fence before row consumption', async mutation => {
    const { store, sqlite, source } = await fixture();
    let retained: SqlDatabase | undefined;
    await sqlite.transactPersisted(db => { retained = db; db.run('UPDATE knowledge_sources SET title=title WHERE id=?', [source.id]);
      return { changed: true, value: undefined }; }, () => {});
    if (!retained) throw new Error('No native owner handle');
    const handle = retained, title = source.title;
    if (typeof title !== 'string') throw new Error('No original source title');
    const main = handle.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
    if (typeof main !== 'string') throw new Error('No native owner VFS path');
    const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
    alias.run('ATTACH DATABASE ? AS original', [main]);
    const restore = interceptPrivateImage(sqlite, (open, args) => {
      if (mutation === 'file replacement') {
        copyFileSync(store.storagePath, `${store.storagePath}.replacement`); renameSync(`${store.storagePath}.replacement`, store.storagePath);
      } else if (mutation === 'row rollback') {
        handle.run('BEGIN');
        try { handle.run("UPDATE knowledge_sources SET title='temporary' WHERE id=?", [source.id]); }
        finally { handle.run('ROLLBACK'); }
      } else if (mutation === 'native alias restore') {
        alias.run("UPDATE original.knowledge_sources SET title='temporary' WHERE id=?", [source.id]);
        alias.run('UPDATE original.knowledge_sources SET title=? WHERE id=?', [title, source.id]);
      } else if (mutation === 'native pragma shadow') {
        alias.run('CREATE TABLE original.pragma_read_uncommitted (read_uncommitted INTEGER)');
      } else alias.run('CREATE TABLE original.foreign_ddl (id INTEGER)');
      return open(...args);
    });
    let consumed = false;
    try {
      expect(() => sqlite.assertPersistedReadFrame(() => {
        sqlite.readPersistedRow('knowledge_sources', 'id', source.id); consumed = true;
      })).toThrow(SQLiteObservationRetiredError);
      expect(consumed).toBe(false);
    } finally { restore(); alias.close(); }
  },
);

async function observeProbePlans() {
  const SQL = await loadSqlJsEngine(), prepare = SQL.Database.prototype.prepare;
  const active = new Set<ReturnType<typeof prepare>>();
  let allocated = 0, freed = 0, stepped = 0;
  const queries: string[] = [];
  const observing = spyOn(SQL.Database.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof SQL.Database>, sql) {
    const statement = prepare.call(this, sql), free = statement.free, step = statement.step;
    allocated++; active.add(statement); queries.push(sql);
    statement.free = () => {
      expect(active.delete(statement)).toBe(true);
      freed++; return free.call(statement);
    };
    statement.step = () => { stepped++; return step.call(statement); };
    return statement;
  });
  return { restore: () => observing.mockRestore(), current: () => ({ allocated, freed, stepped, active: active.size }), queries };
}

test.each(['success', 'assertion', 'run', 'exec', 'export', 'close'] as const)('private PRAGMA plans are refreshed and freed on frame %s', async operation => {
  const { sqlite } = await database(); let retained: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    retained = db; db.run("INSERT INTO knowledge_sources VALUES ('original')");
    return { changed: true, value: undefined };
  }, () => {});
  if (!retained) throw new Error('Writer handle was not captured');
  const handle = retained, plans = await observeProbePlans();
  try {
    const assertion = () => sqlite.assertPersistedReadFrame(() => {
      read(sqlite);
      const first = plans.current();
      expect(first.active).toBe(1);
      expect(plans.queries[0]).toContain('FROM main.pragma_read_uncommitted()');
      expect(plans.queries[0]).toContain('name COLLATE NOCASE');
      expect(Object.keys(handle).sort()).toEqual(['close', 'exec', 'export', 'run']);
      read(sqlite);
      expect(plans.current().stepped).toBeGreaterThan(first.stepped);
      expect(plans.current().allocated).toBe(first.allocated);
      if (operation === 'assertion') throw new Error('original assertion failure');
      if (operation === 'run') handle.run('SELECT 1');
      if (operation === 'exec') handle.exec('SELECT 1');
      if (operation === 'export') handle.export();
      if (operation === 'close') sqlite.close();
      if (operation !== 'success') expect(plans.current().active).toBe(0);
    });
    if (operation === 'success') expect(assertion).not.toThrow(); else expect(assertion).toThrow();
    expect(plans.current().active).toBe(0);
    expect(plans.current().freed).toBe(plans.current().allocated);
    if (operation !== 'close') {
      sqlite.assertPersistedReadFrame(() => { read(sqlite); });
      expect(plans.current().allocated).toBe(2);
      expect(plans.current().freed).toBe(2);
    }
  } finally { plans.restore(); }
});

test.each(['prepare', 'reset'] as const)('private PRAGMA %s failure frees statements and uses fresh full probes', async failure => {
  const { store, source, sqlite } = await fixture();
  const SQL = await loadSqlJsEngine(), prepare = SQL.Database.prototype.prepare;
  let allocated = 0, freed = 0, attempts = 0, resetFailed = false;
  const observing = spyOn(SQL.Database.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof SQL.Database>, sql) {
    attempts++;
    if (failure === 'prepare' && sql.includes('FROM main.pragma_read_uncommitted()')) throw new Error('native plan unavailable');
    const statement = prepare.call(this, sql), free = statement.free, reset = statement.reset;
    allocated++;
    statement.free = () => { freed++; return free.call(statement); };
    if (failure === 'reset' && sql.includes('FROM main.pragma_read_uncommitted()')) statement.reset = () => {
      if (!resetFailed) { resetFailed = true; return false; }
      return reset.call(statement);
    };
    return statement;
  });
  try {
    store.assertRecordSnapshotFrame(() => {
      const original = store.getSourceGeneration(source.id);
      expect(store.getSourceGeneration(source.id)).toBe(original);
      expect(freed).toBe(allocated);
    });
    expect(allocated).toBe(failure === 'prepare' ? 0 : 1);
    expect(attempts).toBe(1);
    expect(freed).toBe(allocated);
    let consumed = false;
    expect(() => store.assertRecordSnapshotFrame(() => {
      store.getSourceGeneration(source.id);
      sqlite.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
      store.getSourceGeneration(source.id); consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(consumed).toBe(false);
    expect(freed).toBe(allocated);
  } finally { observing.mockRestore(); }
});

test.each(['mode', 'temp', 'attachment'] as const)('an existing %s database state retains the full native PRAGMA path', async operation => {
  const { sqlite } = await database();
  if (operation === 'mode') sqlite.run('PRAGMA read_uncommitted=1');
  else if (operation === 'temp') sqlite.run('CREATE TEMP TABLE separate_version (id);CREATE TEMP TABLE another_version (id)');
  else sqlite.run('ATTACH DATABASE \':memory:\' AS "other\"\"schema"');
  const plans = await observeProbePlans();
  try {
    sqlite.assertPersistedReadFrame(() => { read(sqlite); read(sqlite); });
    expect(plans.current().allocated).toBe(0);
    expect(plans.current().active).toBe(0);
  } finally { plans.restore(); }
});

const pragmaNames = ['pragma_read_uncommitted', 'pragma_database_list', 'pragma_data_version', 'pragma_schema_version'];
const shadowCases = pragmaNames.flatMap(name => ['table', 'view', 'uppercase'].map(kind => ({ name, kind })));
test.each(shadowCases)('a main $kind shadow of $name uses full probes and retires native row restore', async ({ name, kind }) => {
  const { sqlite } = await database();
  sqlite.run("INSERT INTO knowledge_sources VALUES ('original')");
  const columns = name === 'pragma_read_uncommitted' ? ['read_uncommitted']
    : name === 'pragma_database_list' ? ['seq', 'name', 'file'] : [name.slice('pragma_'.length)];
  const target = kind === 'uppercase' ? name.toUpperCase() : name;
  if (kind === 'view') sqlite.run(`CREATE VIEW ${target} AS SELECT ${columns.map(column => `0 AS ${column}`).join(',')}`);
  else sqlite.run(`CREATE TABLE ${target}(${columns.join(',')})`);
  await sqlite.save();
  const main = sqlite.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database(), plans = await observeProbePlans();
  const execute = SQL.Database.prototype.exec;
  let fullProbes = 0, consumed = false;
  const observing = spyOn(SQL.Database.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof SQL.Database>, sql, params, config) {
    if (sql === 'PRAGMA read_uncommitted;PRAGMA database_list') fullProbes++;
    return execute.call(this, sql, params, config);
  });
  try {
    alias.run('ATTACH DATABASE ? AS original', [main]);
    expect(() => sqlite.assertPersistedReadFrame(() => {
      expect(sqlite.readPersistedRow('knowledge_sources', 'id', 'original')[0]?.values).toEqual([['original']]);
      const before = fullProbes;
      read(sqlite);
      expect(fullProbes).toBeGreaterThan(before);
      expect(plans.current().active).toBe(0);
      expect(plans.current().freed).toBe(plans.current().allocated);
      alias.run("UPDATE original.knowledge_sources SET id = 'changed';UPDATE original.knowledge_sources SET id = 'original'");
      read(sqlite); consumed = true;
    })).toThrow(SQLiteObservationRetiredError);
    expect(consumed).toBe(false);
  } finally { observing.mockRestore(); plans.restore(); alias.close(); }
});

test.each(pragmaNames.flatMap(name => [name, name.toUpperCase()]))
('a newly created virtual %s shadow retires the combined cursor before a cached row returns', async name => {
  const { sqlite } = await database();
  sqlite.run("INSERT INTO knowledge_sources VALUES ('original')"); await sqlite.save();
  const main = sqlite.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const lower = name.toLowerCase(), columns = lower === 'pragma_read_uncommitted' ? ['read_uncommitted']
    : lower === 'pragma_database_list' ? ['seq', 'name', 'file'] : [lower.slice('pragma_'.length)];
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database(), plans = await observeProbePlans();
  let consumed = false;
  try {
    alias.run('ATTACH DATABASE ? AS original', [main]);
    expect(() => sqlite.assertPersistedReadFrame(() => {
      read(sqlite);
      expect(plans.current().active).toBe(1);
      alias.run(`CREATE VIRTUAL TABLE original.${name} USING fts4(${columns.join(',')})`);
      read(sqlite); consumed = true;
    })).toThrow(SQLiteObservationRetiredError);
    expect(consumed).toBe(false);
    expect(plans.current().active).toBe(0);
    expect(plans.current().freed).toBe(plans.current().allocated);
  } finally { plans.restore(); alias.close(); }
});

test.each(['columns', 'width', 'mode', 'sequence', 'name', 'file', 'data-version', 'schema-version', 'shadow', 'step'] as const)
('an unsupported combined probe %s frees its cursor before using full native metadata', async failure => {
  const { sqlite } = await database(), SQL = await loadSqlJsEngine();
  const prepare = SQL.Database.prototype.prepare, execute = SQL.Database.prototype.exec;
  let allocated = 0, freed = 0, fullProbes = 0;
  const executing = spyOn(SQL.Database.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof SQL.Database>, sql, params, config) {
    if (sql === 'PRAGMA read_uncommitted;PRAGMA database_list' && allocated > 0) {
      expect(freed).toBe(allocated); fullProbes++;
    }
    return execute.call(this, sql, params, config);
  });
  const observing = spyOn(SQL.Database.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof SQL.Database>, sql) {
    const statement = prepare.call(this, sql), get = statement.get, names = statement.getColumnNames, free = statement.free;
    allocated++;
    statement.free = () => { freed++; return free.call(statement); };
    if (failure === 'step') statement.step = () => { throw new Error('native cursor unavailable'); };
    else if (failure === 'columns') statement.getColumnNames = () => [...names.call(statement), 'extra'];
    else statement.get = (params, config) => {
      const row = get.call(statement, params, config);
      if (failure === 'width') row.push('extra');
      if (failure === 'mode') row[0] = 1n;
      if (failure === 'sequence') row[1] = 1n;
      if (failure === 'name') row[2] = 'temp';
      if (failure === 'file') row[3] = 'different identity';
      if (failure === 'data-version') row[4] = 1;
      if (failure === 'schema-version') row[5] = '1';
      if (failure === 'shadow') row[6] = 1n;
      return row;
    };
    return statement;
  });
  try {
    sqlite.assertPersistedReadFrame(() => { read(sqlite); read(sqlite); });
    expect(allocated).toBe(1);
    expect(freed).toBe(1);
    expect(fullProbes).toBeGreaterThan(0);
  } finally { observing.mockRestore(); executing.mockRestore(); }
});

test('reused PRAGMA plans retire an actual foreign native schema change before a cached row can return', async () => {
  const { store, source, sqlite } = await fixture(); let retained: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    retained = db; db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = retained?.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database(), plans = await observeProbePlans();
  let consumed = false;
  try {
    alias.run('ATTACH DATABASE ? AS original', [main]);
    expect(() => store.assertRecordSnapshotFrame(() => {
      const original = store.getSourceGeneration(source.id);
      expect(store.getSourceGeneration(source.id)).toBe(original);
      expect(plans.current().active).toBe(1);
      alias.run('CREATE TABLE original.foreign_schema_change (id INTEGER)');
      store.getSourceGeneration(source.id); consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(consumed).toBe(false);
    expect(plans.current().active).toBe(0);
    expect(plans.current().freed).toBe(plans.current().allocated);
  } finally { plans.restore(); alias.close(); }
});

test('cached closed rows are detached on every read and cannot cross a synchronous frame', async () => {
  const { sqlite } = await database();
  sqlite.run("INSERT INTO knowledge_sources VALUES ('original')"); await sqlite.save();
  sqlite.assertPersistedReadFrame(() => {
    const first = sqlite.readPersistedRow('knowledge_sources', 'id', 'original');
    first[0]!.columns[0] = 'borrowed mutation'; first[0]!.values[0]![0] = 'borrowed mutation';
    first[0]!.values.push(['injected']);
    expect(sqlite.readPersistedRow('knowledge_sources', 'id', 'original')).toEqual([{ columns: ['id'], values: [['original']] }]);
  });
  sqlite.run("UPDATE knowledge_sources SET id = 'replacement'"); await sqlite.save();
  sqlite.assertPersistedReadFrame(() => {
    expect(sqlite.readPersistedRow('knowledge_sources', 'id', 'original')).toEqual([]);
    expect(sqlite.readPersistedRow('knowledge_sources', 'id', 'replacement')).toEqual([{ columns: ['id'], values: [['replacement']] }]);
  });
});

test('generation-only guards match complete snapshots and retain raw stored bytes', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  let originalSource: string | null = null, originalExtraction: string | null = null;
  store.assertRecordSnapshotFrame(() => {
    originalSource = store.getSourceGeneration(source.id);
    originalExtraction = store.getRecordGeneration('extraction', extraction.id);
    expect(originalSource).toBe(store.getSourceSnapshot({ id: source.id }).generation);
    expect(originalExtraction).toBe(store.getRecordSnapshot('extraction', extraction.id).generation);
    expect(store.getRecordGeneration('node', 'missing')).toBeNull();
  });
  const rawMetadata = String(store.getSourceSnapshot({ id: source.id }).raw!.metadata);
  sqlite.run('UPDATE knowledge_sources SET metadata = ? WHERE id = ?', [` ${rawMetadata}`, source.id]);
  await sqlite.save();
  store.assertRecordSnapshotFrame(() => {
    expect(store.getSourceGeneration(source.id)).not.toBe(originalSource);
    expect(store.getSourceSnapshot({ id: source.id }).source?.metadata).toEqual(source.metadata);
    expect(store.getRecordGeneration('extraction', extraction.id)).toBe(originalExtraction);
  });
  expect(store.getSource(source.id)).toBe(source);
});

test('a memoized raw generation retires before reuse after a retained writer restores the row', async () => {
  let writer: SqlDatabase | undefined;
  const { store, source, sqlite } = await fixture();
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const original = store.getSourceSnapshot({ id: source.id }).raw!;
  let reused = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    const generation = store.getSourceGeneration(source.id);
    expect(store.getSourceGeneration(source.id)).toBe(generation);
    writer!.run('UPDATE knowledge_sources SET summary = ? WHERE id = ?', ['temporary meaning', source.id]);
    writer!.run('UPDATE knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
    store.getSourceGeneration(source.id);
    reused = true;
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(reused).toBe(false);
  expect(store.getSourceSnapshot({ id: source.id }).raw).toEqual(original);
});

test('an admitted mutable record keeps its full descriptor fence after generation-only checks', async () => {
  const { store, extraction } = await fixture();
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); receipt.assertCurrent(); });
  Object.defineProperty(extraction.sections, 'extraMeaning', { value: 'new protected input', enumerable: true });
  expect(() => store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); })).toThrow(KnowledgeRecordAdmissionHeldError);
});

test('authentic grouped admission checks use one private image and retain complete mutable descriptors', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  const receipts = [prepareKnowledgeRecordAdmission(store, 'source', source), prepareKnowledgeRecordAdmission(store, 'extraction', extraction)];
  const snapshots = instrument(sqlite);
  assertKnowledgeRecordAdmissions(store, receipts);
  expect(snapshots.privateImages()).toEqual({ opened: 1, closed: 1 });
  let getters = 0;
  Object.defineProperty(extraction, 'id', { get() { getters++; return 'newly borrowed extraction'; }, enumerable: true });
  expect(() => assertKnowledgeRecordAdmissions(store, receipts)).toThrow(JudgmentInputError);
  expect(getters).toBe(0);
});

test.each(['forged', 'foreign-store', 'index-accessor', 'named-array'] as const)('grouped admissions reject %s before raw access or borrowed callbacks', async mode => {
  const { store, source, sqlite } = await fixture();
  const receipt = prepareKnowledgeRecordAdmission(store, 'source', source);
  let borrowedCalls = 0;
  const receipts = [receipt, { assertCurrent() { borrowedCalls++; } }];
  if (mode !== 'forged') receipts[1] = receipt;
  if (mode === 'foreign-store') {
    const other = await fixture();
    receipts[1] = prepareKnowledgeRecordAdmission(other.store, 'source', other.source);
  }
  if (mode === 'index-accessor') Object.defineProperty(receipts, '1', { get() { borrowedCalls++; return receipt; }, enumerable: true });
  if (mode === 'named-array') Object.defineProperty(receipts, 'meaning', { value: 'unselected extra', enumerable: true });
  const snapshots = instrument(sqlite);
  expect(() => assertKnowledgeRecordAdmissions(store, receipts)).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(borrowedCalls).toBe(0);
  expect(snapshots()).toEqual({ opened: 0, closed: 0 });
  expect(snapshots.privateImages()).toEqual({ opened: 0, closed: 0 });
});

test('grouped admission retains the native exit fence through actual cached-record access', async () => {
  const { store, source, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  const receipt = prepareKnowledgeRecordAdmission(store, 'source', source), read = store.getSource.bind(store);
  let replaced = false, consumed = false;
  alias.run('ATTACH DATABASE ? AS original', [main]);
  const observing = spyOn(store, 'getSource').mockImplementation(id => {
    const record = read(id);
    if (!replaced && id === source.id) {
      replaced = true;
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['during receipt identity replacement', source.id]);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
    }
    return record;
  });
  try {
    expect(() => { assertKnowledgeRecordAdmissions(store, [receipt]); consumed = true; }).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(replaced).toBe(true);
    expect(consumed).toBe(false);
  } finally { observing.mockRestore(); alias.close(); }
});

test('an actual native VFS alias replacement and restore retires the original raw generation', async () => {
  const { store, source, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  let consumed = false;
  try {
    alias.run('ATTACH DATABASE ? AS original', [main]);
    expect(alias.exec('SELECT title FROM original.knowledge_sources WHERE id = ?', [source.id])[0]?.values[0]?.[0]).toBe(source.title);
    expect(() => store.assertRecordSnapshotFrame(() => {
      const original = store.getSourceGeneration(source.id);
      expect(store.getSourceGeneration(source.id)).toBe(original);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['native alias replacement', source.id]);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
      store.getSourceGeneration(source.id);
      consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(consumed).toBe(false);
    expect(store.getSourceSnapshot({ id: source.id }).source?.summary).toBe(source.summary);
  } finally { alias.close(); }
});

test('closed generation batches match every original row and retire native alias restore before returning', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  const selectors = [{ kind: 'source' as const, id: source.id }, { kind: 'extraction' as const, id: extraction.id }, { kind: 'node' as const, id: 'missing' }];
  let consumed = false;
  try {
    alias.run('ATTACH DATABASE ? AS original', [main]);
    expect(alias.exec('SELECT title FROM original.knowledge_sources WHERE id = ?', [source.id])[0]?.values[0]?.[0]).toBe(source.title);
    expect(() => store.assertRecordSnapshotFrame(() => {
      const expected = [store.getSourceSnapshot({ id: source.id }).generation, store.getRecordSnapshot('extraction', extraction.id).generation, null];
      expect(store.getRecordGenerations(selectors)).toEqual(expected);
      expect(Object.isFrozen(store.getRecordGenerations(selectors))).toBe(true);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['batch alias replacement', source.id]);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
      store.getRecordGenerations(selectors);
      consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(consumed).toBe(false);
  } finally { alias.close(); }
});

test.each(['selector-accessor', 'index-accessor', 'named-array'] as const)('generation batch rejects %s before reading any raw image', async mode => {
  const { store, source, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }];
  let getterCalls = 0;
  if (mode === 'selector-accessor') Object.defineProperty(selectors[0], 'id', { get() { getterCalls++; return source.id; }, enumerable: true });
  if (mode === 'index-accessor') Object.defineProperty(selectors, '0', { get() { getterCalls++; return { kind: 'source', id: source.id }; }, enumerable: true });
  if (mode === 'named-array') Object.defineProperty(selectors, 'meaning', { value: 'unselected extra', enumerable: true });
  const snapshots = instrument(sqlite);
  expect(() => store.getRecordGenerations(selectors)).toThrow(TypeError);
  expect(getterCalls).toBe(0);
  expect(snapshots()).toEqual({ opened: 0, closed: 0 });
  expect(snapshots.privateImages()).toEqual({ opened: 0, closed: 0 });
});

test('the all-cached generation batch exit fence retires an actual native alias restore before returning', async () => {
  const { store, source, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  const observers: { mockRestore(): void }[] = [];
  let replaced = false, consumed = false;
  alias.run('ATTACH DATABASE ? AS original', [main]);
  try {
    expect(() => store.assertRecordSnapshotFrame(() => {
      const selectors = [{ kind: 'source' as const, id: source.id }];
      store.getRecordGenerations(selectors);
      const frame: unknown = Reflect.get(sqlite, 'persistedReadFrame');
      if (!frame || typeof frame !== 'object') throw new Error('No original synchronous read frame');
      const memo: unknown = Reflect.get(frame, 'generations');
      if (!(memo instanceof Map)) throw new Error('No original generation memo');
      const read = memo.get.bind(memo), key = JSON.stringify(['knowledge_sources', 'id', source.id]);
      observers.push(spyOn(memo, 'get').mockImplementation(entry => {
        const generation: unknown = read(entry);
        if (!replaced && entry === key) {
          replaced = true;
          alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['during cached batch replacement', source.id]);
          alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
        }
        return generation;
      }));
      store.getRecordGenerations(selectors);
      consumed = true;
    })).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(replaced).toBe(true);
    expect(consumed).toBe(false);
  } finally { for (const observer of observers) observer.mockRestore(); alias.close(); }
});

test('the closed generation batch exit fence catches an actual native alias restore during its SQL read', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  let writer: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    writer = db;
    db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
    return { changed: true, value: undefined };
  }, () => {});
  const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
  if (typeof main !== 'string') throw new Error('No original VFS file');
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  const internal = sqlite as unknown as { readPrivatePersistedRows(sql: string, params: string[], closed?: boolean): ReturnType<SqlDatabase['exec']> };
  const read = internal.readPrivatePersistedRows.bind(sqlite);
  let replaced = false, consumed = false;
  alias.run('ATTACH DATABASE ? AS original', [main]);
  const observing = spyOn(internal, 'readPrivatePersistedRows').mockImplementation((sql, params, closed) => {
    const result = read(sql, params, closed);
    if (!replaced && sql === 'SELECT * FROM knowledge_sources WHERE id = ? LIMIT 1') {
      replaced = true;
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['during batch replacement', source.id]);
      alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
    }
    return result;
  });
  try {
    expect(() => store.getRecordGenerations([{ kind: 'source', id: source.id }, { kind: 'extraction', id: extraction.id }])
      && (consumed = true)).toThrow(SQLiteObservationRetiredError);
    expect(replaced).toBe(true);
    expect(consumed).toBe(false);
  } finally { observing.mockRestore(); alias.close(); }
});

test('physical edge generation reads retain exact original raw metadata without decoded views', async () => {
  const { store, source, sqlite } = await fixture();
  const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: 'bounded-node',
    relation: 'documents', weight: 0.75, metadata: { complete: 'raw' } });
  const original = store.getEdgeSnapshot(edge.id);
  store.assertRecordSnapshotFrame(() => {
    expect(store.getEdgeGenerationSnapshots().find(snapshot => snapshot.id === edge.id)).toEqual({ id: edge.id,
      fromKind: edge.fromKind, fromId: edge.fromId, toKind: edge.toKind, toId: edge.toId, generation: original.generation! });
  });
  sqlite.run('UPDATE knowledge_edges SET metadata = ? WHERE id = ?', [' {"complete":"raw"}', edge.id]);
  await sqlite.save();
  store.assertRecordSnapshotFrame(() => {
    const changed = store.getEdgeSnapshot(edge.id);
    expect(changed.record?.metadata).toEqual(edge.metadata);
    const generation = store.getEdgeGenerationSnapshots().find(snapshot => snapshot.id === edge.id)?.generation ?? null;
    expect(generation).toBe(changed.generation);
    expect(changed.generation).not.toBe(original.generation);
  });
});

test('real admission and nested semantic guard read every full row from one image per invocation', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  const sourceAdmission = prepareKnowledgeRecordAdmission(store, 'source', source);
  const extractionAdmission = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const guard = createSemanticWriteGuard(store);
  guard.watch('admitted-records', () => { sourceAdmission.assertCurrent(); extractionAdmission.assertCurrent(); return true; });
  const snapshots = instrument(sqlite);
  store.assertRecordSnapshotFrame(() => {
    for (let i = 0; i < 8; i++) { guard.assertCurrent(); sourceAdmission.assertCurrent(); }
    expect(JSON.parse(String(store.getSourceSnapshot({ id: source.id }).raw?.metadata))).toEqual(source.metadata);
    expect(store.getSource(source.id)).toBe(source);
    expect(typeof source.createdAt).toBe('number');
  });
  expect(snapshots()).toEqual({ opened: 1, closed: 1 });
  expect(snapshots.privateImages()).toEqual({ opened: 1, closed: 1 });
  await Promise.resolve(); guard.assertCurrent();
  expect(snapshots()).toEqual({ opened: 2, closed: 2 });
  await store.replaceSourceRecord({ ...source, summary: 'changed' });
  await store.replaceSourceRecord(source);
  expect(store.getSource(source.id)).toEqual(source); expect(store.getSource(source.id)).not.toBe(source);
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
  expect(snapshots()).toEqual({ opened: 3, closed: 3 });
});

test('each actual scope job captures all three owner checks in one fresh private image', async () => {
  const { store, sqlite, source } = await fixture();
  const second = await store.upsertSource({ id: 'second-source', connectorId: 'frame-test', sourceType: 'document',
    title: 'Router backup operations', status: 'indexed', metadata: { knowledgeSpaceId: 'default' } });
  const snapshots = instrument(sqlite), fake = fakePort(() => noulAnswer(0.99));
  const observations: { readonly capture: number; readonly baseline: { opened: number; closed: number };
    readonly callbacks: { opened: number; closed: number }[] }[] = [];
  bindJudgmentPortAuthority(fake.port, () => {
    const observation: (typeof observations)[number] = { capture: observations.length + 1,
      baseline: snapshots.privateImages(), callbacks: [] };
    observations.push(observation);
    return { identity: fake.port, assertCurrent() { observation.callbacks.push(snapshots.privateImages()); } };
  });
  const previous = installJudgmentPort(fake.port);
  try {
    const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
    expect(selection.sources.map(record => record.id).sort()).toEqual([source.id, second.id].sort());
    expect(fake.requests).toHaveLength(2);
    expect(observations).toHaveLength(3);
    for (const observation of observations.slice(1)) {
      expect(observation.callbacks.length).toBeGreaterThanOrEqual(3);
      expect(observation.callbacks.slice(0, 3).map(count => ({
        opened: count.opened - observation.baseline.opened, closed: count.closed - observation.baseline.closed,
      }))).toEqual([{ opened: 0, closed: 0 }, { opened: 1, closed: 0 }, { opened: 1, closed: 0 }]);
    }
    expect(snapshots.privateImages().opened).toBe(snapshots.privateImages().closed);
    const before = snapshots.privateImages();
    selection.assertCurrent();
    expect(snapshots.privateImages()).toEqual({ opened: before.opened + 1, closed: before.closed + 1 });
    await Promise.resolve();
    selection.assertCurrent();
    expect(snapshots.privateImages()).toEqual({ opened: before.opened + 2, closed: before.closed + 2 });
  } finally { installJudgmentPort(previous); }
});

test.each(['native alias ABA', 'file ABA', 'row ABA', 'caller cancellation', 'port replacement', 'async owner'] as const)(
  'an actual scope capture rejects %s during its second owner callback before dispatch', async mutation => {
    const { store, sqlite, source } = await fixture();
    let writer: SqlDatabase | undefined;
    await sqlite.transactPersisted(db => {
      writer = db;
      db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
      return { changed: true, value: undefined };
    }, () => {});
    if (!writer) throw new Error('The actual native writer was not retained');
    const main = writer.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
    if (typeof main !== 'string') throw new Error('No original VFS file');
    const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
    alias.run('ATTACH DATABASE ? AS original', [main]);
    const controller = new AbortController(), fake = fakePort(() => noulAnswer(0.99));
    let captures = 0, changed = false;
    bindJudgmentPortAuthority(fake.port, () => {
      const capture = ++captures; let checks = 0;
      return { identity: fake.port, assertCurrent() {
        if (capture !== 2 || ++checks !== 2) return;
        changed = true;
        if (mutation === 'native alias ABA') {
          alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', ['native capture replacement', source.id]);
          alias.run('UPDATE original.knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
        } else if (mutation === 'file ABA') {
          copyFileSync(store.storagePath, `${store.storagePath}.replacement`);
          renameSync(`${store.storagePath}.replacement`, store.storagePath);
        } else if (mutation === 'row ABA') {
          sqlite.run('UPDATE knowledge_sources SET summary = ? WHERE id = ?', ['capture replacement', source.id]);
          sqlite.run('UPDATE knowledge_sources SET summary = ? WHERE id = ?', [source.summary ?? null, source.id]);
        } else if (mutation === 'caller cancellation') controller.abort();
        else if (mutation === 'port replacement') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
        else return Promise.resolve();
      } };
    });
    const previous = installJudgmentPort(fake.port), snapshots = instrument(sqlite);
    try {
      await expect(prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'], signal: controller.signal }))
        .rejects.toBeInstanceOf(KnowledgeScopeSelectionHeldError);
      expect(changed).toBe(true);
      expect(fake.requests).toHaveLength(0);
      expect(snapshots.privateImages().opened).toBe(snapshots.privateImages().closed);
      expect(store.getSourceSnapshot({ id: source.id }).source?.summary).toBe(source.summary);
    } finally { installJudgmentPort(previous); alias.close(); }
  },
);

test('independent admission guard sees persisted extraction changes without adopting cached source identity', async () => {
  const { store, extraction, sqlite } = await fixture();
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); });
  sqlite.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["new raw evidence"]', extraction.id]);
  await sqlite.save();
  expect(store.getExtraction(extraction.id)).toBe(extraction);
  expect(() => store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); })).toThrow(KnowledgeRecordAdmissionHeldError);
});

test('retained edge descriptor fast paths still open a fresh native image for every observation', async () => {
  const { store, source, sqlite } = await fixture();
  const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'source', toId: source.id,
    relation: 'references', weight: 0.8, metadata: { detail: 'original' } });
  const fake = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(fake.port);
  try {
    const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
    const current = selection.retainEdges([edge]);
    const images = instrument(sqlite), before = images.privateImages();
    current();
    expect(images.privateImages()).toEqual({ opened: before.opened + 1, closed: before.closed + 1 });
    await Promise.resolve(); current();
    expect(images.privateImages()).toEqual({ opened: before.opened + 2, closed: before.closed + 2 });
  } finally { installJudgmentPort(previous); }
});

test('retained scope signatures preserve both extraction reads and a fresh image for each observation', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  const fake = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(fake.port);
  try {
    const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
    const images = instrument(sqlite), before = images.privateImages(), requests = fake.requests.length;
    const read = store.getExtractionBySourceId.bind(store); let reads = 0;
    spyOn(store, 'getExtractionBySourceId').mockImplementation(id => {
      if (id === source.id) reads++;
      return read(id);
    });
    selection.assertCurrent();
    expect(reads).toBe(2); expect(store.getExtraction(extraction.id)).toBe(extraction);
    expect(images.privateImages()).toEqual({ opened: before.opened + 1, closed: before.closed + 1 });
    await Promise.resolve(); selection.assertCurrent();
    expect(reads).toBe(4);
    expect(images.privateImages()).toEqual({ opened: before.opened + 2, closed: before.closed + 2 });
    expect(fake.requests).toHaveLength(requests);
  } finally { installJudgmentPort(previous); }
});

test.each(['equal replacement', 'changed text', 'hidden child', 'accessor', 'native alias ABA', 'row ABA', 'file ABA'] as const)(
  'a retained scope signature observes %s on the original second extraction read', async mutation => {
    const { store, source, extraction, sqlite } = await fixture();
    let writer: SqlDatabase | undefined;
    await sqlite.transactPersisted(db => {
      writer = db;
      db.run('UPDATE knowledge_sources SET summary = summary WHERE id = ?', [source.id]);
      return { changed: true, value: undefined };
    }, () => {});
    if (!writer) throw new Error('No original native writer');
    const main = writer.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
    if (typeof main !== 'string') throw new Error('No original native VFS filename');
    const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
    alias.run('ATTACH DATABASE ? AS original', [main]);
    const fake = fakePort(() => noulAnswer(0.99)), previous = installJudgmentPort(fake.port);
    try {
      const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
      const originalSections = JSON.stringify(extraction.sections), requests = fake.requests.length;
      const images = instrument(sqlite), read = store.getExtractionBySourceId.bind(store);
      let reads = 0, changed = false, accessors = 0;
      spyOn(store, 'getExtractionBySourceId').mockImplementation(id => {
        const current = read(id);
        if (id !== source.id || ++reads !== 2) return current;
        changed = true;
        if (mutation === 'equal replacement') expect(Reflect.set(extraction, 'sections', [...extraction.sections])).toBe(true);
        else if (mutation === 'changed text') expect(Reflect.set(extraction, 'sections', [...extraction.sections, 'Changed reference meaning'])).toBe(true);
        else if (mutation === 'hidden child') Object.defineProperty(extraction.structure, 'hidden', { value: 'never-wire child' });
        else if (mutation === 'accessor') Object.defineProperty(extraction, 'sections', { enumerable: true,
          get() { accessors++; return ['Original reference']; } });
        else if (mutation === 'native alias ABA') {
          alias.run('UPDATE original.knowledge_extractions SET sections = ? WHERE id = ?', ['["Native replacement"]', extraction.id]);
          alias.run('UPDATE original.knowledge_extractions SET sections = ? WHERE id = ?', [originalSections, extraction.id]);
        } else if (mutation === 'row ABA') {
          sqlite.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["Local replacement"]', extraction.id]);
          sqlite.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', [originalSections, extraction.id]);
        } else {
          copyFileSync(store.storagePath, `${store.storagePath}.replacement`);
          renameSync(`${store.storagePath}.replacement`, store.storagePath);
        }
        return current;
      });
      if (mutation === 'equal replacement') {
        selection.assertCurrent(); await Promise.resolve(); selection.assertCurrent();
        expect(reads).toBe(4);
        expect(Reflect.set(extraction, 'sections', [...extraction.sections, 'A later semantic correction'])).toBe(true);
        expect(selection.assertCurrent).toThrow(KnowledgeScopeSelectionHeldError);
      } else expect(selection.assertCurrent).toThrow(KnowledgeScopeSelectionHeldError);
      expect(changed).toBe(true); expect(accessors).toBe(0); expect(fake.requests).toHaveLength(requests);
      expect(images.privateImages().opened).toBe(images.privateImages().closed);
    } finally { installJudgmentPort(previous); alias.close(); }
  },
);

test.each(['native alias ABA', 'file ABA', 'row ABA', 'caller owner ABA', 'caller cancellation'] as const)(
  'retained edge fast paths preserve the original %s fence inside an actual composed guard', async mutation => {
    const { store, source, sqlite } = await fixture();
    const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'source', toId: source.id,
      relation: 'references', weight: 0.8, metadata: { detail: 'original' } });
    let writer: SqlDatabase | undefined;
    await sqlite.transactPersisted(db => {
      writer = db;
      db.run('UPDATE knowledge_edges SET relation = relation WHERE id = ?', [edge.id]);
      return { changed: true, value: undefined };
    }, () => {});
    if (!writer) throw new Error('No original writer');
    const main = writer.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
    if (typeof main !== 'string') throw new Error('No original VFS filename');
    const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
    alias.run('ATTACH DATABASE ? AS original', [main]);
    const controller = new AbortController(), fake = fakePort(() => noulAnswer(0.99));
    let armed = false, changed = false;
    bindJudgmentPortAuthority(fake.port, () => ({ identity: fake.port, assertCurrent() {
      if (!armed || changed) return;
      changed = true;
      if (mutation === 'native alias ABA') {
        alias.run('UPDATE original.knowledge_edges SET relation = ? WHERE id = ?', ['contradicts', edge.id]);
        alias.run('UPDATE original.knowledge_edges SET relation = ? WHERE id = ?', [edge.relation, edge.id]);
      } else if (mutation === 'file ABA') {
        copyFileSync(store.storagePath, `${store.storagePath}.replacement`);
        renameSync(`${store.storagePath}.replacement`, store.storagePath);
      } else if (mutation === 'row ABA') {
        sqlite.run('UPDATE knowledge_edges SET relation = ? WHERE id = ?', ['contradicts', edge.id]);
        sqlite.run('UPDATE knowledge_edges SET relation = ? WHERE id = ?', [edge.relation, edge.id]);
      } else if (mutation === 'caller owner ABA') {
        installJudgmentPort(undefined); installJudgmentPort(fake.port);
      } else controller.abort();
    } }));
    const previous = installJudgmentPort(fake.port);
    try {
      const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'], signal: controller.signal });
      const current = selection.retainEdges([edge]), requests = fake.requests.length, images = instrument(sqlite);
      expect(() => store.assertRecordSnapshotFrame(() => {
        selection.assertCurrent(); armed = true; current();
      })).toThrow(KnowledgeScopeSelectionHeldError);
      expect(changed).toBe(true);
      expect(fake.requests).toHaveLength(requests);
      expect(images.privateImages().opened).toBe(images.privateImages().closed);
      expect(store.getEdgeSnapshot(edge.id).record?.relation).toBe(edge.relation);
    } finally { installJudgmentPort(previous); alias.close(); }
  },
);

test('throws and swallowed nested misuse retire and close the frame before an independent read', async () => {
  const { sqlite } = await database(); const snapshots = instrument(sqlite);
  expect(() => sqlite.assertPersistedReadFrame(() => { read(sqlite); throw new Error('caller failure'); })).toThrow('caller failure');
  expect(snapshots()).toEqual({ opened: 1, closed: 1 });
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    try { sqlite.assertPersistedReadFrame(() => { throw new Error('nested failure'); }); } catch { /* cannot revive frame */ }
  })).toThrow(SQLiteObservationRetiredError);
  read(sqlite); expect(snapshots()).toEqual({ opened: 3, closed: 3 });
});

test('async return is rejected and its continuation cannot inherit a frame', async () => {
  const { sqlite } = await database(); const snapshots = instrument(sqlite);
  let continuation: Promise<void> | undefined;
  const unsupported = () => {
    read(sqlite);
    continuation = Promise.resolve().then(() => { read(sqlite); });
    return continuation;
  };
  expect(() => sqlite.assertPersistedReadFrame(unsupported as unknown as () => undefined)).toThrow(TypeError);
  expect(snapshots()).toEqual({ opened: 1, closed: 1 });
  await continuation;
  expect(snapshots()).toEqual({ opened: 2, closed: 2 });
});

test('local revision ABA is rejected even when the complete local bytes are restored', async () => {
  const { sqlite } = await database(); const before = sqlite.readPersisted(db => Buffer.from(db.export()));
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite); sqlite.run("INSERT INTO knowledge_sources VALUES ('temporary')"); sqlite.run('DELETE FROM knowledge_sources');
  })).toThrow(SQLiteObservationRetiredError);
  expect(sqlite.readPersisted(db => Buffer.from(db.export()))).toEqual(before);
});

test('identical-byte external file replacement retires the current frame and the next guard opens fresh', async () => {
  const { sqlite, filename } = await database(); const snapshots = instrument(sqlite);
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite); copyFileSync(filename, `${filename}.replacement`); renameSync(`${filename}.replacement`, filename);
  })).toThrow(SQLiteObservationRetiredError);
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
  expect(snapshots()).toEqual({ opened: 2, closed: 2 });
});

test('semantic guard preserves cancellation and translates a synchronous raw-read mutation to a typed stale hold', async () => {
  const { store, source, sqlite } = await fixture();
  const controller = new AbortController(), guard = createSemanticWriteGuard(store, controller.signal);
  let mutate = false;
  guard.watch('source-raw', () => {
    const snapshot = store.getSourceSnapshot({ id: source.id });
    if (mutate) sqlite.run("UPDATE knowledge_sources SET summary = 'pending local change' WHERE id = ?", [source.id]);
    return snapshot;
  });
  mutate = true;
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
  mutate = false; controller.abort();
  let failure: unknown; try { guard.assertCurrent(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(KnowledgeSourceQualityHeldError);
  expect((failure as KnowledgeSourceQualityHeldError).reason).toBe('aborted');
});

test('full local-content fence catches untracked raw-image mutation without replacing pending local state', async () => {
  const { sqlite } = await database();
  const local = (sqlite as unknown as { db: SqlDatabase }).db;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite); local.run("INSERT INTO knowledge_sources VALUES ('pending direct change')");
  })).toThrow(SQLiteObservationRetiredError);
  expect(local.exec('SELECT id FROM knowledge_sources')[0]?.values).toEqual([['pending direct change']]);
  expect(read(sqlite)).toEqual([]);
});

test('a caught async nested misuse still prevents outer success', async () => {
  const { sqlite } = await database(); const snapshots = instrument(sqlite);
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    try { sqlite.assertPersistedReadFrame((() => Promise.resolve()) as unknown as () => undefined); } catch { /* invalid nested frame */ }
  })).toThrow(SQLiteObservationRetiredError);
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
  expect(snapshots()).toEqual({ opened: 2, closed: 2 });
});

test('mutable legacy callbacks cannot restore obsolete evidence inside the shared admission image', async () => {
  const { store, extraction, sqlite } = await fixture();
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const oldSections = store.getRecordSnapshot('extraction', extraction.id).raw!.sections as string;
  sqlite.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["changed persisted evidence"]', extraction.id]);
  await sqlite.save();
  let callbackReached = false, admitted = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    // Acquire the frame before a legacy mutable read tries to contaminate it.
    store.getRecordSnapshot('extraction', extraction.id);
    sqlite.readPersisted(db => {
      callbackReached = true;
      db.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', [oldSections, extraction.id]);
      try { receipt.assertCurrent(); admitted = true; }
      finally {
        // Mutation then restoration must not evade the admission boundary.
        db.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["changed persisted evidence"]', extraction.id]);
      }
    });
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(callbackReached).toBe(true); expect(admitted).toBe(false);
  expect(store.getRecordSnapshot('extraction', extraction.id).raw?.sections).toBe('["changed persisted evidence"]');
  expect(store.getExtraction(extraction.id)).toBe(extraction);
});

test('invalid descriptor attempts cannot inject SQL or revive a caught active frame', async () => {
  const { sqlite } = await database();
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    try { sqlite.readPersistedRow('knowledge_sources; DELETE FROM knowledge_sources' as 'knowledge_sources', 'id', 'x'); }
    catch { /* rejected attempts poison the entire assertion */ }
  })).toThrow(SQLiteObservationRetiredError);
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
});


test('ephemeral legacy transaction mutation and rollback cannot hide behind an earlier frame image', async () => {
  const { store, extraction, sqlite } = await fixture(':memory:');
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const before = store.getRecordSnapshot('extraction', extraction.id).raw;
  let mutated = false, admitted = false, rolledBack = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    receipt.assertCurrent();
    sqlite.readPersisted(db => {
      db.run('BEGIN');
      try {
        db.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["transient evidence"]', extraction.id]);
        mutated = true;
        receipt.assertCurrent(); admitted = true;
      } finally { db.run('ROLLBACK'); rolledBack = true; }
    });
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(mutated).toBe(true); expect(rolledBack).toBe(true); expect(admitted).toBe(false);
  expect(store.getRecordSnapshot('extraction', extraction.id).raw).toEqual(before);
  // A separate invocation is fresh and may admit the truly restored current row.
  expect(() => store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); })).not.toThrow();
});


test('ephemeral admission stays live for mutable handles retained before an assertion', async () => {
  const { store, extraction, sqlite } = await fixture(':memory:');
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const retained = sqlite.readPersisted(db => db);
  const before = store.getRecordSnapshot('extraction', extraction.id).raw;
  let admitted = false;
  expect(() => store.assertRecordSnapshotFrame(() => {
    receipt.assertCurrent();
    retained.run('BEGIN');
    try {
      retained.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', ['["retained handle evidence"]', extraction.id]);
      receipt.assertCurrent(); admitted = true;
    } finally { retained.run('ROLLBACK'); }
  })).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(admitted).toBe(false);
  expect(store.getRecordSnapshot('extraction', extraction.id).raw).toEqual(before);
  expect(() => store.assertRecordSnapshotFrame(() => { receipt.assertCurrent(); })).not.toThrow();
});

test('nested file-backed guards detect mutations through a legitimately retained writer handle', async () => {
  const { sqlite } = await database(); let retained: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    retained = db; db.run("INSERT INTO knowledge_sources VALUES ('original')");
    return { changed: true, value: undefined };
  }, () => {});
  if (!retained) throw new Error('Writer handle was not captured');
  const handle = retained;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    handle.run('BEGIN');
    try {
      handle.run("UPDATE knowledge_sources SET id = 'transient'");
      sqlite.assertPersistedReadFrame(() => { read(sqlite); });
    } finally { handle.run('ROLLBACK'); }
  })).toThrow(SQLiteObservationRetiredError);
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
});

test.each(['mode', 'attachment', 'export'] as const)('a retained facade %s operation invalidates the private image before a nested read', async operation => {
  const { sqlite } = await database(); let retained: SqlDatabase | undefined;
  await sqlite.transactPersisted(db => {
    retained = db; db.run("INSERT INTO knowledge_sources VALUES ('original')");
    return { changed: true, value: undefined };
  }, () => {});
  if (!retained) throw new Error('Writer handle was not captured');
  const handle = retained; let consumed = false;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    read(sqlite);
    if (operation === 'mode') handle.exec('PRAGMA read_uncommitted=1');
    else if (operation === 'attachment') handle.exec("ATTACH DATABASE ':memory:' AS external");
    else handle.export();
    sqlite.assertPersistedReadFrame(() => { read(sqlite); consumed = true; });
  })).toThrow(SQLiteObservationRetiredError);
  expect(consumed).toBe(false);
});


test('a supported validation callback cannot retain the private admission image', async () => {
  const observed: SqlDatabase[] = [];
  const { store, extraction, sqlite } = await fixture(path(), db => { observed.push(db); });
  const receipt = prepareKnowledgeRecordAdmission(store, 'extraction', extraction);
  const snapshots = instrument(sqlite);
  store.assertRecordSnapshotFrame(() => {
    receipt.assertCurrent();
    const exposed = observed.at(-1);
    if (!exposed) throw new Error('Validation callback was not invoked');
    // The callback-exposed image is closed before the receipt can reuse the
    // private clone. Mutation/restoration through that handle is impossible.
    expect(() => exposed.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?',
      ['["forged callback evidence"]', extraction.id])).toThrow();
    receipt.assertCurrent();
    expect(store.getRecordSnapshot('extraction', extraction.id).record).toEqual(extraction);
  });
  expect(snapshots()).toEqual({ opened: 1, closed: 1 });
  expect(snapshots.privateImages()).toEqual({ opened: 1, closed: 1 });
});

test('exact native source restoration preserves original persisted clocks and retires the old observation', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(4_222_222_222_222);
  try {
    const { store, source } = await fixture();
    const original = store.getSourceSnapshot({ id: source.id });
    const old = prepareKnowledgeRecordAdmission(store, 'source', source);
    await store.replaceSourceRecord(source);
    const restored = store.getSource(source.id)!;
    const persisted = store.getSourceSnapshot({ id: source.id });
    expect(restored).not.toBe(source);
    expect(restored).toEqual(source);
    expect(persisted.raw).toEqual(original.raw);
    expect(typeof persisted.raw?.created_at).toBe('string');
    expect(typeof persisted.raw?.updated_at).toBe('string');
    expect(() => old.assertCurrent()).toThrow(KnowledgeRecordAdmissionHeldError);
    expect(() => prepareKnowledgeRecordAdmission(store, 'source', restored)).not.toThrow();
  } finally { clock.mockRestore(); }
});

test.each(['clone', 'changed-origin'] as const)('source restoration never supplies native clock proof to a %s', async kind => {
  const epoch = 4_222_222_222_222;
  const clock = spyOn(Date, 'now').mockReturnValue(epoch);
  try {
    const { store, source } = await fixture();
    const candidate = kind === 'clone' ? structuredClone(source) : source;
    if (kind === 'changed-origin') Object.defineProperty(candidate, 'summary', { value: 'Caller changed the retained record', enumerable: true, writable: true, configurable: true });
    await store.replaceSourceRecord(candidate);
    const restored = store.getSource(source.id)!;
    const persisted = store.getSourceSnapshot({ id: source.id });
    expect(persisted.raw?.created_at).toBe(epoch);
    expect(persisted.raw?.updated_at).toBe(epoch);
    expect(() => prepareKnowledgeRecordAdmission(store, 'source', restored)).toThrow(JudgmentInputError);
  } finally { clock.mockRestore(); }
});


function observeExpectedRawRows(sqlite: SQLiteStore) {
  const original: unknown = Reflect.get(sqlite, 'readPrivatePersistedRows');
  if (typeof original !== 'function') throw new Error('No private row reader');
  let count = 0;
  Object.defineProperty(sqlite, 'readPrivatePersistedRows', { configurable: true, writable: true,
    value: (...args: unknown[]) => {
      if (typeof args[0] === 'string' && /^SELECT \* FROM knowledge_(sources|nodes|extractions) WHERE id/.test(args[0])) count++;
      return Reflect.apply(original, sqlite, args);
    } });
  return { count: () => count, reset: () => { count = 0; }, restore: () => { Reflect.deleteProperty(sqlite, 'readPrivatePersistedRows'); } };
}

test('compiled expected readsets return equality only and still open a fresh physical frame', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }, { kind: 'extraction' as const, id: extraction.id }];
  const captured = store.captureExpectedRecordReadset(selectors), rows = observeExpectedRawRows(sqlite), physical = observePhysicalReads();
  try {
    expect(captured.originalGenerations).toEqual(store.getRecordGenerations(selectors));
    rows.reset();
    const input = [{ expected: captured.expected, selectors }];
    expect(store.matchesExpectedRecordReadsets(input)).toEqual([true]);
    expect(rows.count()).toBe(0);
    const first = physical.count();
    await Promise.resolve();
    expect(store.matchesExpectedRecordReadsets(input)).toEqual([true]);
    expect(rows.count()).toBe(0);
    expect(physical.count() - first).toBe(2);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.expected)).toBe(true);
    expect(Object.isFrozen(captured.originalGenerations)).toBe(true);
    // The existing actual-current API still selects and hashes original rows.
    expect(store.getRecordGenerations(selectors)).toEqual(captured.originalGenerations);
    expect(rows.count()).toBe(2);
    expect(Reflect.get(sqlite, 'expectedRecordReadsets')).toBeUndefined();
  } finally { rows.restore(); physical.restore(); }
});

test('compiled expected readsets allow unrelated persistence and reject changed complete raw content', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }, { kind: 'extraction' as const, id: extraction.id }];
  const captured = store.captureExpectedRecordReadset(selectors), rows = observeExpectedRawRows(sqlite);
  const input = [{ expected: captured.expected, selectors }];
  try {
    await store.upsertSource({ id: 'unrelated', connectorId: 'frame-test', sourceType: 'document', title: 'Separate project notes', status: 'indexed' });
    expect(store.matchesExpectedRecordReadsets(input)).toEqual([true]);
    expect(rows.count()).toBe(0);
    sqlite.run('UPDATE knowledge_extractions SET sections = ? WHERE id = ?', [' ["Router reference"]', extraction.id]);
    await sqlite.save();
    expect(store.getExtraction(extraction.id)).toBe(extraction);
    expect(store.matchesExpectedRecordReadsets(input)).toEqual([false]);
    expect(rows.count()).toBe(0);
  } finally { rows.restore(); }
});

test.each(['copy', 'proxy', 'cross-store', 'wrong-id', 'wrong-kind', 'selector-accessor', 'expected-accessor', 'index-accessor', 'named-array'] as const)(
  'compiled expected readsets reject %s before raw consumption', async mode => {
    const first = await fixture(), second = mode === 'cross-store' ? await fixture() : first;
    const selectors = [{ kind: 'source' as const, id: first.source.id }];
    const captured = first.store.captureExpectedRecordReadset(selectors);
    let expected = captured.expected, getters = 0;
    if (mode === 'copy') expected = { ...expected };
    if (mode === 'proxy') expected = new Proxy(expected, {});
    if (mode === 'wrong-id') selectors[0]!.id = 'unowned';
    const input = [{ expected, selectors }];
    if (mode === 'wrong-kind') Object.defineProperty(selectors[0], 'kind', { value: 'node', enumerable: true, writable: true, configurable: true });
    if (mode === 'selector-accessor') Object.defineProperty(selectors[0], 'id', { get() { getters++; return first.source.id; }, enumerable: true });
    if (mode === 'expected-accessor') Object.defineProperty(input[0], 'expected', { get() { getters++; return expected; }, enumerable: true });
    if (mode === 'index-accessor') Object.defineProperty(input, '0', { get() { getters++; return { expected, selectors }; }, enumerable: true });
    if (mode === 'named-array') Object.defineProperty(input, 'meaning', { value: 'extra input', enumerable: true });
    const rows = observeExpectedRawRows(second.sqlite), physical = observePhysicalReads();
    try {
      expect(() => second.store.matchesExpectedRecordReadsets(input)).toThrow(TypeError);
      expect(rows.count()).toBe(0); expect(physical.count()).toBe(0); expect(getters).toBe(0);
    } finally { rows.restore(); physical.restore(); }
  });

test.each(['view', 'generated-column', 'custom-validator', 'native-method'] as const)(
  'compiled expected readsets preserve exact fresh fallback for %s', async mode => {
    const { store, source, sqlite } = await fixture(path(), mode === 'custom-validator' ? () => {} : undefined);
    if (mode === 'view') {
      sqlite.run('ALTER TABLE knowledge_sources RENAME TO source_rows');
      sqlite.run('CREATE VIEW knowledge_sources AS SELECT * FROM source_rows');
      await sqlite.save();
    }
    if (mode === 'generated-column') {
      sqlite.run('ALTER TABLE knowledge_sources ADD COLUMN generated TEXT GENERATED ALWAYS AS (lower(title)) VIRTUAL');
      await sqlite.save();
    }
    const selectors = [{ kind: 'source' as const, id: source.id }];
    if (mode === 'generated-column') {
      expect(() => store.captureExpectedRecordReadset(selectors)).toThrow('unsupported local observation shape');
      return;
    }
    const captured = store.captureExpectedRecordReadset(selectors), rows = observeExpectedRawRows(sqlite);
    const SQL = await loadSqlJsEngine(), execute = SQL.Database.prototype.exec;
    const changed = mode === 'native-method' ? spyOn(SQL.Database.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof SQL.Database>, sql, params, config) {
      return execute.call(this, sql, params, config);
    }) : undefined;
    try {
      expect(store.matchesExpectedRecordReadsets([{ expected: captured.expected, selectors }])).toEqual([true]);
      expect(rows.count()).toBe(0);
    } finally { changed?.mockRestore(); rows.restore(); }
  });

test.each(['row rollback', 'native alias restore', 'identical file replacement', 'DDL', 'pragma shadow'] as const)(
  'compiled expected readsets keep the complete native and physical %s exit fences', async mutation => {
    const { store, source, sqlite } = await fixture();
    let writer: SqlDatabase | undefined;
    await sqlite.transactPersisted(db => { writer = db; db.run('UPDATE knowledge_sources SET summary=summary WHERE id=?', [source.id]); return { changed: true, value: undefined }; }, () => {});
    const selectors = [{ kind: 'source' as const, id: source.id }], captured = store.captureExpectedRecordReadset(selectors);
    const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
    const main = writer!.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
    if (typeof main !== 'string') throw new Error('No original native main');
    alias.run('ATTACH DATABASE ? AS original', [main]);
    const original: unknown = Reflect.get(sqlite, 'readPrivatePersistedRows');
    if (typeof original !== 'function') throw new Error('No private reader');
    let changed = false, consumed = false;
    Object.defineProperty(sqlite, 'readPrivatePersistedRows', { configurable: true, writable: true,
      value: (...args: unknown[]) => {
        const value: unknown = Reflect.apply(original, sqlite, args);
        if (!changed && args[0] === 'SELECT 1') {
          changed = true;
          if (mutation === 'row rollback') { writer!.run('BEGIN'); writer!.run('UPDATE knowledge_sources SET title=? WHERE id=?', ['Temporary title', source.id]); writer!.run('ROLLBACK'); }
          else if (mutation === 'native alias restore') { alias.run('UPDATE original.knowledge_sources SET title=? WHERE id=?', ['Temporary title', source.id]); alias.run('UPDATE original.knowledge_sources SET title=? WHERE id=?', [source.title ?? null, source.id]); }
          else if (mutation === 'identical file replacement') { copyFileSync(store.storagePath, `${store.storagePath}.replacement`); renameSync(`${store.storagePath}.replacement`, store.storagePath); }
          else if (mutation === 'DDL') { writer!.run('CREATE TABLE temporary_schema (value TEXT)'); writer!.run('DROP TABLE temporary_schema'); }
          else { writer!.run('CREATE TABLE pragma_data_version(data_version INTEGER)'); writer!.run('DROP TABLE pragma_data_version'); }
        }
        return value;
      } });
    try {
      expect(() => store.matchesExpectedRecordReadsets([{ expected: captured.expected, selectors }]) && (consumed = true)).toThrow(SQLiteObservationRetiredError);
      expect(changed).toBe(true); expect(consumed).toBe(false);
    } finally { Reflect.deleteProperty(sqlite, 'readPrivatePersistedRows'); alias.close(); }
  });


test('compiled expected readsets do not trust an intercepted modified private constructor image', async () => {
  const { store, source, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }], captured = store.captureExpectedRecordReadset(selectors);
  const restore = interceptPrivateImage(sqlite, (open, args) => {
    const image: unknown = open(...args);
    if (!image || typeof image !== 'object') throw new Error('No private image');
    const run: unknown = Reflect.get(image, 'run');
    if (typeof run !== 'function') throw new Error('No native facade write');
    Reflect.apply(run, image, ['UPDATE knowledge_sources SET title=? WHERE id=?', ['Intercepted constructor meaning', source.id]]);
    return image;
  });
  try {
    expect(() => store.matchesExpectedRecordReadsets([{ expected: captured.expected, selectors }])).toThrow(SQLiteObservationRetiredError);
    expect(store.getSource(source.id)?.title).toBe(source.title);
  } finally { restore(); }
});


test('compiled expected readsets retain missing rows and every actual node selector', async () => {
  const { store, source } = await fixture();
  const node = await store.upsertNode({ kind: 'topic', slug: 'bounded-record', title: 'Bounded record', status: 'active', confidence: 0.9, sourceId: source.id });
  const selectors = [{ kind: 'node' as const, id: node.id }, { kind: 'extraction' as const, id: 'missing-extraction' }];
  const captured = store.captureExpectedRecordReadset(selectors);
  expect(captured.originalGenerations).toEqual([store.getRecordSnapshot('node', node.id).generation, null]);
  expect(store.matchesExpectedRecordReadsets([{ expected: captured.expected, selectors }])).toEqual([true]);
  await store.upsertNode({ ...node, title: 'Changed bounded record' });
  expect(store.matchesExpectedRecordReadsets([{ expected: captured.expected, selectors }])).toEqual([false]);
});

test('actual scope adoption rejects a compiler capture that disagrees with the original snapshot before dispatch', async () => {
  const { store } = await fixture(), fake = fakePort(() => noulAnswer(0.99));
  const previous = installJudgmentPort(fake.port), capture = store.captureExpectedRecordReadsets.bind(store);
  const observing = spyOn(store, 'captureExpectedRecordReadsets').mockImplementation(groups => {
    const originals = capture(groups);
    return originals.map(original => ({ expected: original.expected, originalGenerations: original.originalGenerations.map(() => null) }));
  });
  try {
    await expect(prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] })).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(0);
  } finally { observing.mockRestore(); installJudgmentPort(previous); }
});

test('actual scope compiled equality preserves mutable borrowed-view checks before later dispatch', async () => {
  const { store, source } = await fixture(), fake = fakePort(() => noulAnswer(0.99));
  const previous = installJudgmentPort(fake.port);
  try {
    const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
    const requests = fake.requests.length;
    Object.defineProperty(source.metadata, 'hidden', { value: 'A new consumed private meaning', enumerable: false, configurable: true, writable: true });
    expect(() => selection.assertCurrent()).toThrow(KnowledgeScopeSelectionHeldError);
    expect(fake.requests).toHaveLength(requests);
  } finally { installJudgmentPort(previous); }
});


function expectedFrameCache(sqlite: SQLiteStore, key: 'rows' | 'generations'): Map<unknown, unknown> {
  const frame: unknown = Object.getOwnPropertyDescriptor(sqlite, 'persistedReadFrame')?.value;
  if (!frame || typeof frame !== 'object') throw new Error('No actual frame');
  const cache: unknown = Object.getOwnPropertyDescriptor(frame, key)?.value;
  if (!(cache instanceof Map)) throw new Error('No actual frame cache');
  return cache;
}

test('compiled expected readsets ignore substituted original generation memos', async () => {
  const { store, source, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }];
  let compiled: ReturnType<KnowledgeStore['captureExpectedRecordReadset']> | undefined;
  store.assertRecordSnapshotFrame(() => {
    store.getRecordGenerations(selectors);
    expectedFrameCache(sqlite, 'generations').set(JSON.stringify(['knowledge_sources', 'id', source.id]), 'f'.repeat(64));
    compiled = store.captureExpectedRecordReadset(selectors);
  });
  if (!compiled) throw new Error('No compiled original');
  expect(compiled.originalGenerations).toEqual(store.getRecordGenerations(selectors));
  expect(store.matchesExpectedRecordReadsets([{ expected: compiled.expected, selectors }])).toEqual([true]);
});

test.each(['generations', 'rows'] as const)('compiled expected readsets ignore substituted current %s memos', async cache => {
  const { store, source, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }];
  const originalRows = sqlite.readPersistedRow('knowledge_sources', 'id', source.id), compiled = store.captureExpectedRecordReadset(selectors);
  await store.upsertSource({ ...source, title: 'Changed physical source meaning' });
  let matched: boolean | undefined;
  store.assertRecordSnapshotFrame(() => {
    store.getRecordGenerations(selectors);
    const generations = expectedFrameCache(sqlite, 'generations');
    if (cache === 'generations') generations.set(JSON.stringify(['knowledge_sources', 'id', source.id]), compiled.originalGenerations[0]);
    else {
      generations.clear();
      expectedFrameCache(sqlite, 'rows').set(JSON.stringify(['SELECT * FROM knowledge_sources WHERE id = ? LIMIT 1', [source.id]]), originalRows);
    }
    matched = store.matchesExpectedRecordReadsets([{ expected: compiled.expected, selectors }])[0];
  });
  expect(matched).toBe(false);
});

test('compiled expected readsets retire a canonical private image restored to obsolete physical rows', async () => {
  const { store, source, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }], compiled = store.captureExpectedRecordReadset(selectors);
  sqlite.run('UPDATE knowledge_sources SET title=? WHERE id=?', ['Changed physical source meaning', source.id]);
  await sqlite.save();
  const restore = interceptPrivateImage(sqlite, (open, args) => {
    const image: unknown = open(...args);
    if (!image || typeof image !== 'object') throw new Error('No private image');
    const run: unknown = Reflect.get(image, 'run');
    if (typeof run !== 'function') throw new Error('No native facade write');
    Reflect.apply(run, image, ['UPDATE knowledge_sources SET title=? WHERE id=?', [source.title, source.id]]);
    return image;
  });
  try {
    expect(() => store.matchesExpectedRecordReadsets([{ expected: compiled.expected, selectors }])).toThrow(SQLiteObservationRetiredError);
  } finally { restore(); }
  expect(store.getSourceSnapshot({ id: source.id }).source?.title).toBe('Changed physical source meaning');
});


test('compiled expected readsets never borrow a substituted schema-layout row memo', async () => {
  const { store, source, sqlite } = await fixture();
  const sql = "SELECT type,name,sql FROM main.sqlite_schema WHERE name IN ('knowledge_sources','knowledge_nodes','knowledge_extractions')";
  const canonical = sqlite.readPersisted(db => db.exec(sql));
  sqlite.run('ALTER TABLE knowledge_sources RENAME TO source_rows');
  sqlite.run('CREATE VIEW knowledge_sources AS SELECT *,hex(randomblob(16)) AS dynamic FROM source_rows');
  await sqlite.save();
  const selectors = [{ kind: 'source' as const, id: source.id }];
  let compiled: ReturnType<KnowledgeStore['captureExpectedRecordReadset']> | undefined;
  store.assertRecordSnapshotFrame(() => {
    store.getRecordGenerations(selectors);
    expectedFrameCache(sqlite, 'rows').set(JSON.stringify([sql, []]), canonical);
    compiled = store.captureExpectedRecordReadset(selectors);
  });
  if (!compiled) throw new Error('No compiled dynamic view');
  // The same bytes cannot prove equality for a runtime-computed view column.
  expect(store.matchesExpectedRecordReadsets([{ expected: compiled.expected, selectors }])).toEqual([false]);
});


test('actual scope never reauthorizes a false raw equality result through a substituted legacy memo', async () => {
  const { store, source, sqlite } = await fixture(), fake = fakePort(() => noulAnswer(0.99));
  const previous = installJudgmentPort(fake.port);
  try {
    const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
    const requests = fake.requests.length, generation = store.getSourceGeneration(source.id);
    sqlite.run('UPDATE knowledge_sources SET title=? WHERE id=?', ['Changed persisted source meaning', source.id]);
    await sqlite.save();
    const match = store.matchesExpectedRecordReadsets.bind(store);
    const observing = spyOn(store, 'matchesExpectedRecordReadsets').mockImplementation(inputs => {
      const current = match(inputs);
      expect(current).toContain(false);
      expectedFrameCache(sqlite, 'generations').set(JSON.stringify(['knowledge_sources', 'id', source.id]), generation);
      return current;
    });
    try {
      expect(() => selection.assertCurrent()).toThrow(KnowledgeScopeSelectionHeldError);
      expect(fake.requests).toHaveLength(requests);
    } finally { observing.mockRestore(); }
  } finally { installJudgmentPort(previous); }
});


test.each(['compiler', 'matcher'] as const)('compiled expected readsets reject a copied retired frame in the %s', async operation => {
  const { store, source, sqlite } = await fixture();
  const selectors = [{ kind: 'source' as const, id: source.id }], compiled = store.captureExpectedRecordReadset(selectors);
  sqlite.run('UPDATE knowledge_sources SET title=? WHERE id=?', ['Changed physical source meaning', source.id]);
  await sqlite.save();
  expect(() => sqlite.assertPersistedReadFrame(() => {
    store.getRecordGenerations(selectors);
    const descriptor = Object.getOwnPropertyDescriptor(sqlite, 'persistedReadFrame'), frame: unknown = descriptor?.value;
    if (!descriptor || !frame || typeof frame !== 'object') throw new Error('No actual frame');
    const image: unknown = Object.getOwnPropertyDescriptor(frame, 'db')?.value;
    if (!image || typeof image !== 'object') throw new Error('No actual image');
    const run: unknown = Reflect.get(image, 'run');
    if (typeof run !== 'function') throw new Error('No native facade write');
    Reflect.apply(run, image, ['UPDATE knowledge_sources SET title=? WHERE id=?', [source.title, source.id]]);
    const copy: unknown = Object.create(Object.getPrototypeOf(frame), Object.getOwnPropertyDescriptors(frame));
    Object.defineProperty(sqlite, 'persistedReadFrame', { ...descriptor, value: copy });
    try {
      if (operation === 'compiler') store.captureExpectedRecordReadset(selectors);
      else store.matchesExpectedRecordReadsets([{ expected: compiled.expected, selectors }]);
    } finally { Object.defineProperty(sqlite, 'persistedReadFrame', descriptor); }
  })).toThrow(SQLiteObservationRetiredError);
});

test.each(['compiler', 'matcher'] as const)('compiled expected readsets reject another store genuine custom-validator frame in the %s', async operation => {
  const first = await fixture(), second = await fixture(path(), () => {});
  const selectors = [{ kind: 'source' as const, id: first.source.id }], compiled = first.store.captureExpectedRecordReadset(selectors);
  let rejected = false;
  expect(() => first.sqlite.assertPersistedReadFrame(() => {
    second.sqlite.assertPersistedReadFrame(() => {
      second.store.getRecordGenerations(selectors);
      const descriptor = Object.getOwnPropertyDescriptor(first.sqlite, 'persistedReadFrame');
      const foreign: unknown = Object.getOwnPropertyDescriptor(second.sqlite, 'persistedReadFrame')?.value;
      if (!descriptor || !foreign || typeof foreign !== 'object') throw new Error('No genuine owner frames');
      Object.defineProperty(first.sqlite, 'persistedReadFrame', { ...descriptor, value: foreign });
      try {
        expect(() => operation === 'compiler' ? first.store.captureExpectedRecordReadset(selectors)
          : first.store.matchesExpectedRecordReadsets([{ expected: compiled.expected, selectors }])).toThrow(SQLiteObservationRetiredError);
        rejected = true;
      } finally { Object.defineProperty(first.sqlite, 'persistedReadFrame', descriptor); }
    });
  })).toThrow(SQLiteObservationRetiredError);
  expect(rejected).toBe(true);
});

for (const operation of ['compiler', 'matcher'] as const) {
  test.each(['constructor', 'prototype', 'constructor-accessor'] as const)(
    `compiled expected readsets retire changed native %s identity before the ${operation}`, async mutation => {
      const { store, source, sqlite } = await fixture();
      const selectors = [{ kind: 'source' as const, id: source.id }], compiled = store.captureExpectedRecordReadset(selectors);
      const originalTitle = source.title;
      if (typeof originalTitle !== 'string') throw new Error('No authored original title');
      sqlite.run('UPDATE knowledge_sources SET title=? WHERE id=?', ['Changed physical source meaning', source.id]);
      await sqlite.save();
      const engine = await loadSqlJsEngine(), OriginalDatabase = engine.Database;
      const constructorDescriptor = Object.getOwnPropertyDescriptor(engine, 'Database');
      const prototypeDescriptor = Object.getOwnPropertyDescriptor(OriginalDatabase, 'prototype');
      if (!constructorDescriptor || !prototypeDescriptor) throw new Error('No original native identity');
      let constructorCalls = 0, getterCalls = 0;
      const replacement = function(data?: Uint8Array | Buffer) {
        constructorCalls++;
        const image = new OriginalDatabase(data);
        image.run('UPDATE knowledge_sources SET title=? WHERE id=?', [originalTitle, source.id]);
        return image;
      };
      Object.defineProperty(replacement, 'prototype', { value: OriginalDatabase.prototype });
      if (mutation === 'constructor') Object.defineProperty(engine, 'Database', { ...constructorDescriptor, value: replacement });
      else if (mutation === 'prototype') Object.defineProperty(OriginalDatabase, 'prototype', {
        ...prototypeDescriptor, value: Object.create(OriginalDatabase.prototype),
      });
      else Object.defineProperty(engine, 'Database', { configurable: true, enumerable: true,
        get() { getterCalls++; return OriginalDatabase; },
      });
      try {
        expect(() => operation === 'compiler' ? store.captureExpectedRecordReadset(selectors)
          : store.matchesExpectedRecordReadsets([{ expected: compiled.expected, selectors }])).toThrow(SQLiteObservationRetiredError);
        expect(constructorCalls).toBe(0); expect(getterCalls).toBe(0);
      } finally {
        Object.defineProperty(engine, 'Database', constructorDescriptor);
        Object.defineProperty(OriginalDatabase, 'prototype', prototypeDescriptor);
      }
      expect(store.getSourceSnapshot({ id: source.id }).source?.title).toBe('Changed physical source meaning');
    });
}

for (const operation of ['compiler', 'matcher'] as const) {
  test.each(['assertCurrent', 'identity'] as const)(
    `compiled expected readsets retain original physical ownership despite reflected %s in the ${operation}`, async slot => {
      const { store, source, sqlite } = await fixture();
      const selectors = [{ kind: 'source' as const, id: source.id }], compiled = store.captureExpectedRecordReadset(selectors);
      let consumed = false;
      expect(() => sqlite.assertPersistedReadFrame(() => {
        store.getRecordGenerations(selectors);
        const frame: unknown = Object.getOwnPropertyDescriptor(sqlite, 'persistedReadFrame')?.value;
        if (!frame || typeof frame !== 'object') throw new Error('No actual frame');
        const original = Object.getOwnPropertyDescriptor(frame, slot);
        if (!original || !('value' in original)) throw new Error('No actual frame slot');
        copyFileSync(store.storagePath, `${store.storagePath}.replacement`);
        renameSync(`${store.storagePath}.replacement`, store.storagePath);
        if (slot === 'assertCurrent') Object.defineProperty(frame, slot, { ...original, value: () => {} });
        else {
          const persistence: unknown = Object.getOwnPropertyDescriptor(sqlite, 'persistence')?.value;
          if (!persistence || typeof persistence !== 'object') throw new Error('No actual persistence');
          const observe: unknown = Reflect.get(persistence, 'observationIdentity');
          if (typeof observe !== 'function') throw new Error('No physical identity observer');
          const replacement: unknown = Reflect.apply(observe, persistence, []);
          if (typeof replacement !== 'string') throw new Error('No replacement physical identity');
          Object.defineProperty(frame, slot, { ...original, value: replacement });
        }
        try {
          if (operation === 'compiler') store.captureExpectedRecordReadset(selectors);
          else store.matchesExpectedRecordReadsets([{ expected: compiled.expected, selectors }]);
          consumed = true;
        } finally { Object.defineProperty(frame, slot, original); }
      })).toThrow(SQLiteObservationRetiredError);
      expect(consumed).toBe(false);
    });
}


test('grouped initial readsets preserve order, duplicate identities, missing rows and one fresh native image per invocation', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  const node = await store.upsertNode({ id: source.id, kind: 'topic', slug: 'same-local-id', title: 'Separate native topic',
    status: 'draft', confidence: 0.5, sourceId: source.id });
  const groups: Parameters<KnowledgeStore['captureExpectedRecordReadsets']>[0] = [
    [{ kind: 'node', id: node.id }, { kind: 'source', id: source.id }, { kind: 'extraction', id: 'absent' }],
    [{ kind: 'extraction', id: extraction.id }, { kind: 'source', id: source.id }, { kind: 'source', id: source.id }], [],
  ];
  const originals = groups.map(selectors => store.captureExpectedRecordReadset(selectors).originalGenerations);
  const images = instrument(sqlite);
  const first = store.captureExpectedRecordReadsets(groups);
  expect(first.map(value => value.originalGenerations)).toEqual(originals);
  expect(images.privateImages()).toEqual({ opened: 1, closed: 1 });
  expect(Object.isFrozen(first)).toBe(true);
  const inputs = first.map((value, index) => {
    const selectors = groups[index]; if (!selectors) throw new Error('No original selector group');
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.originalGenerations)).toBe(true);
    return { expected: value.expected, selectors };
  });
  expect(store.matchesExpectedRecordReadsets(inputs)).toEqual([true, true, true]);
  const before = images.privateImages();
  await Promise.resolve();
  const second = store.captureExpectedRecordReadsets(groups);
  expect(second.map(value => value.originalGenerations)).toEqual(originals);
  expect(images.privateImages()).toEqual({ opened: before.opened + 1, closed: before.closed + 1 });
  expect(second[0]?.expected).not.toBe(first[0]?.expected);
  await store.upsertSource({ ...source, title: 'Changed source meaning' });
  expect(store.matchesExpectedRecordReadsets(inputs)).toEqual([false, false, true]);
});

test('grouped initial readsets execute every requested raw-row callback in order with a custom validator', async () => {
  const { store, source, extraction, sqlite } = await fixture(path(), () => {});
  const groups: Parameters<KnowledgeStore['captureExpectedRecordReadsets']>[0] = [
    [{ kind: 'source', id: source.id }, { kind: 'extraction', id: extraction.id }],
    [{ kind: 'source', id: source.id }, { kind: 'node', id: 'absent' }],
  ];
  const expected = groups.map(selectors => store.captureExpectedRecordReadset(selectors).originalGenerations);
  const SQL = await loadSqlJsEngine(), exec = SQL.Database.prototype.exec, seen: string[] = [];
  const observer = spyOn(SQL.Database.prototype, 'exec').mockImplementation(function (this: InstanceType<typeof SQL.Database>, sql, params, options) {
    if (/^SELECT \* FROM knowledge_(sources|nodes|extractions) WHERE id/.test(sql)) seen.push(sql);
    return exec.call(this, sql, params, options);
  });
  try {
    const captured = store.captureExpectedRecordReadsets(groups);
    expect(captured.map(value => value.originalGenerations)).toEqual(expected);
    expect(seen).toEqual([
      'SELECT * FROM knowledge_sources WHERE id = ? LIMIT 1', 'SELECT * FROM knowledge_extractions WHERE id = ? LIMIT 1',
      'SELECT * FROM knowledge_sources WHERE id = ? LIMIT 1', 'SELECT * FROM knowledge_nodes WHERE id = ? LIMIT 1',
    ]);
    expect(sqlite.readPersistedRow('knowledge_sources', 'id', source.id)[0]?.values).toHaveLength(1);
  } finally { observer.mockRestore(); }
});

test.each(['group accessor', 'selector accessor', 'named tail', 'selected kind alias'] as const)(
  'grouped initial readset capture rejects %s before native image acquisition', async mode => {
    const { store, source, sqlite } = await fixture(), images = instrument(sqlite);
    let getters = 0;
    const selector: object = { kind: 'source', id: source.id }, group: object[] = [selector], groups = [group];
    if (mode === 'group accessor') Object.defineProperty(groups, '0', { configurable: true, get() { getters++; return group; } });
    else if (mode === 'selector accessor') Object.defineProperty(selector, 'id', { enumerable: true, configurable: true, get() { getters++; return source.id; } });
    else if (mode === 'named tail') Object.defineProperty(groups, 'tail', { value: 'Extra claimed work', configurable: true });
    else Object.defineProperty(selector, 'kind', { value: 'edge', enumerable: true, writable: true, configurable: true });
    expect(() => Reflect.apply(store.captureExpectedRecordReadsets, store, [groups])).toThrow(TypeError);
    expect(getters).toBe(0); expect(images.privateImages()).toEqual({ opened: 0, closed: 0 });
  });

test.each(['writer rollback', 'native alias restore', 'identical file replacement'] as const)(
  'grouped initial mint keeps the original complete %s fence between requested groups', async mutation => {
    const { store, source, extraction, sqlite } = await fixture();
    let writer: SqlDatabase | undefined;
    await sqlite.transactPersisted(db => { writer = db; db.run('UPDATE knowledge_sources SET summary=summary WHERE id=?', [source.id]);
      return { changed: true, value: undefined }; }, () => {});
    if (!writer) throw new Error('No actual retained native writer');
    const retained = writer;
    const engine = await loadSqlJsEngine(), alias = new engine.Database();
    const main = retained.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
    if (typeof main !== 'string') throw new Error('No actual original native main');
    alias.run('ATTACH DATABASE ? AS original', [main]);
    const bytes = readFileSync(store.storagePath), stringify = JSON.stringify;
    let changed = false, published = false;
    const observing = spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      const result = stringify(value, replacer, space);
      if (!changed && Array.isArray(value) && value.some(entry => Array.isArray(entry) && entry[0] === 'id' && entry[1] === source.id)) {
        changed = true;
        if (mutation === 'writer rollback') {
          retained.run('BEGIN'); retained.run('UPDATE knowledge_extractions SET sections=? WHERE id=?', ['["Temporary native evidence"]', extraction.id]); retained.run('ROLLBACK');
        } else if (mutation === 'native alias restore') {
          alias.run('UPDATE original.knowledge_sources SET title=? WHERE id=?', ['Temporary native title', source.id]);
          alias.run('UPDATE original.knowledge_sources SET title=? WHERE id=?', [source.title ?? null, source.id]);
        } else {
          copyFileSync(store.storagePath, `${store.storagePath}.replacement`); renameSync(`${store.storagePath}.replacement`, store.storagePath);
        }
      }
      return result;
    });
    try {
      expect(() => {
        store.captureExpectedRecordReadsets([[{ kind: 'source', id: source.id }], [{ kind: 'extraction', id: extraction.id }]]);
        published = true;
      }).toThrow(SQLiteObservationRetiredError);
      expect(changed).toBe(true); expect(published).toBe(false);
    } finally { observing.mockRestore(); alias.close(); }
    expect(readFileSync(store.storagePath).equals(bytes)).toBe(true);
  });

test('grouped original mint bypasses both mutable frame memo collections', async () => {
  const { store, source, extraction, sqlite } = await fixture();
  const groups: Parameters<KnowledgeStore['captureExpectedRecordReadsets']>[0] = [
    [{ kind: 'source', id: source.id }], [{ kind: 'extraction', id: extraction.id }],
  ];
  const original = groups.map(selectors => store.captureExpectedRecordReadset(selectors).originalGenerations);
  let captured: ReturnType<KnowledgeStore['captureExpectedRecordReadsets']> | undefined;
  store.assertRecordSnapshotFrame(() => {
    store.getRecordGenerations(groups.flat());
    expectedFrameCache(sqlite, 'generations').set(JSON.stringify(['knowledge_sources', 'id', source.id]), 'f'.repeat(64));
    expectedFrameCache(sqlite, 'rows').set(JSON.stringify(['SELECT * FROM knowledge_extractions WHERE id = ? LIMIT 1', [extraction.id]]), []);
    captured = store.captureExpectedRecordReadsets(groups);
  });
  if (!captured) throw new Error('No genuine grouped original');
  expect(captured.map(value => value.originalGenerations)).toEqual(original);
});

test('grouped original mint rejects a copied retired frame before returning any token', async () => {
  const { store, source, sqlite } = await fixture();
  let returned = false;
  expect(() => sqlite.assertPersistedReadFrame(() => {
    store.getSourceGeneration(source.id);
    const descriptor = Object.getOwnPropertyDescriptor(sqlite, 'persistedReadFrame'), frame: unknown = descriptor?.value;
    if (!descriptor || !frame || typeof frame !== 'object') throw new Error('No actual native frame');
    const copy: unknown = Object.create(Object.getPrototypeOf(frame), Object.getOwnPropertyDescriptors(frame));
    Object.defineProperty(sqlite, 'persistedReadFrame', { ...descriptor, value: copy });
    try { store.captureExpectedRecordReadsets([[{ kind: 'source', id: source.id }]]); returned = true; }
    finally { Object.defineProperty(sqlite, 'persistedReadFrame', descriptor); }
  })).toThrow(SQLiteObservationRetiredError);
  expect(returned).toBe(false);
});

test('scope grouped original capture preserves extraction lookup and cancellation before semantic dispatch', async () => {
  const { store } = await fixture(), fake = fakePort(() => noulAnswer(0.99)), controller = new AbortController();
  const previous = installJudgmentPort(fake.port), compile = store.captureExpectedRecordReadsets.bind(store);
  const lookup = store.getExtractionBySourceId.bind(store);
  let lookups = 0, entered = false;
  const reading = spyOn(store, 'getExtractionBySourceId').mockImplementation(id => { lookups++; return lookup(id); });
  const capturing = spyOn(store, 'captureExpectedRecordReadsets').mockImplementation(groups => {
    entered = true; expect(lookups).toBeGreaterThanOrEqual(2);
    const value = compile(groups); controller.abort(); return value;
  });
  try {
    await expect(prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'], signal: controller.signal })).rejects.toMatchObject({ reason: 'aborted' });
    expect(entered).toBe(true); expect(fake.requests).toHaveLength(0);
  } finally { capturing.mockRestore(); reading.mockRestore(); installJudgmentPort(previous); }
});
