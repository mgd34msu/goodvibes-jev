import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore, loadSqlJsEngine, type SqlDatabase, type SqliteStoreInitOptions } from '../sdk/src/platform/state/sqlite-store.js';
import { prepareNativeKnowledgeSchemaReadPlan } from '../sdk/src/platform/state/knowledge-schema-read-plan.js';
import { createSchema, KNOWLEDGE_SCHEMA_VERSION } from '../sdk/src/platform/knowledge/store-schema.js';
import { validateCurrentKnowledgeSchema } from '../sdk/src/platform/knowledge/store-current-schema-validation.js';
import { createEmptyWorkLedgerState } from '../sdk/src/platform/workflow/work-ledger/service.js';

const roots: string[] = [], stores: SQLiteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(options: SqliteStoreInitOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-schema-plan-')); roots.push(root);
  const sqlite = new SQLiteStore(join(root, 'knowledge.sqlite'), { coordinated: true }); stores.push(sqlite);
  await sqlite.init(createSchema, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    validateCurrentSchema: validateCurrentKnowledgeSchema, nativeSchemaReadPlan: prepareNativeKnowledgeSchemaReadPlan(), ...options });
  await sqlite.save();
  return sqlite;
}
async function captureImages(sqlite: SQLiteStore) {
  const SQL = await loadSqlJsEngine(), nativeExport = SQL.Database.prototype.export;
  let exports = 0;
  const exportObserver = spyOn(SQL.Database.prototype, 'export').mockImplementation(function (this: InstanceType<typeof SQL.Database>) {
    exports++; return nativeExport.call(this);
  });
  const current: unknown[] = [], privateImages: unknown[] = [], restore: (() => void)[] = [];
  for (const [name, images] of [['openCurrentImage', current], ['openPrivateReadImage', privateImages]] as const) {
    const original: unknown = Reflect.get(sqlite, name), descriptor = Object.getOwnPropertyDescriptor(sqlite, name);
    if (typeof original !== 'function') throw new Error('Native image method missing');
    Object.defineProperty(sqlite, name, { configurable: true, value(...args: unknown[]) {
      const image: unknown = Reflect.apply(original, sqlite, args); images.push(image); return image;
    } });
    restore.push(() => { if (descriptor) Object.defineProperty(sqlite, name, descriptor); else Reflect.deleteProperty(sqlite, name); });
  }
  return { current, privateImages, exports: () => exports, restore() { for (const undo of restore) undo(); exportObserver.mockRestore(); } };
}
function read(sqlite: SQLiteStore) { return sqlite.readPersistedRow('knowledge_sources', 'id', 'missing'); }

test('the authentic empty-authority profile uses one unloaned image without an export copy', async () => {
  const sqlite = await fixture(), images = await captureImages(sqlite);
  try {
    sqlite.assertPersistedReadFrame(() => { expect(read(sqlite)).toEqual([]); expect(read(sqlite)).toEqual([]); });
    expect(images.current).toHaveLength(1);
    expect(images.privateImages).toHaveLength(1);
    expect(images.privateImages[0]).toBe(images.current[0]);
    expect(images.exports()).toBe(0);
    sqlite.assertPersistedReadFrame(() => { read(sqlite); });
    expect(images.privateImages).toHaveLength(2);
    expect(images.privateImages[1]).not.toBe(images.privateImages[0]);
  } finally { images.restore(); }
});

test.each(['copied-token', 'different-version', 'arbitrary-validator'] as const)('native schema %s cannot skip original validation or the private clone', async mode => {
  let callbacks = 0;
  const token = prepareNativeKnowledgeSchemaReadPlan();
  const sqlite = await fixture(mode === 'copied-token' ? { nativeSchemaReadPlan: { ...token } }
    : mode === 'different-version' ? { schemaVersion: KNOWLEDGE_SCHEMA_VERSION + 1 }
      : { validateCurrentSchema(db) { callbacks++; validateCurrentKnowledgeSchema(db); } });
  callbacks = 0;
  const images = await captureImages(sqlite);
  try {
    sqlite.assertPersistedReadFrame(() => { read(sqlite); });
    expect(images.current).toHaveLength(1);
    expect(images.privateImages).toHaveLength(1);
    expect(images.privateImages[0]).not.toBe(images.current[0]);
    expect(images.exports()).toBe(1);
    if (mode === 'arbitrary-validator') expect(callbacks).toBe(1);
  } finally { images.restore(); }
});

test('a newly populated linked ledger immediately returns to complete validation and two images', async () => {
  const sqlite = await fixture(), images = await captureImages(sqlite);
  try {
    sqlite.assertPersistedReadFrame(() => { read(sqlite); });
    expect(images.exports()).toBe(0);
    const ledger = createEmptyWorkLedgerState('native-schema-plan');
    sqlite.run('INSERT INTO work_ledgers(project_id,format_version,revision,state_json) VALUES(?,?,?,?)',
      [ledger.projectId, ledger.version, ledger.revision, JSON.stringify(ledger)]);
    await sqlite.save();
    sqlite.assertPersistedReadFrame(() => { read(sqlite); });
    expect(images.privateImages).toHaveLength(2);
    expect(images.privateImages[1]).not.toBe(images.current[1]);
    expect(images.exports()).toBe(2); // ordinary save and the required validation clone
  } finally { images.restore(); }
});

test('a populated execution table retains the complete validator and private clone without linked authority', async () => {
  const sqlite = await fixture();
  sqlite.run("INSERT INTO native_work_executions VALUES('project','key',1,'{}','attempt')");
  await sqlite.save();
  // The current canonical validator checks this table's structure and uniqueness.
  // Row association validation belongs to its migration and later execution reads.
  sqlite.readPersisted(db => validateCurrentKnowledgeSchema(db));
  const images = await captureImages(sqlite);
  try {
    sqlite.assertPersistedReadFrame(() => { expect(read(sqlite)).toEqual([]); });
    expect(images.current).toHaveLength(1);
    expect(images.privateImages).toHaveLength(1);
    expect(images.privateImages[0]).not.toBe(images.current[0]);
    expect(images.exports()).toBe(1);
  } finally { images.restore(); }
});

test.each([
  "INSERT INTO native_work_execution_intents VALUES('project','attempt',1,'{}')",
  "INSERT INTO native_conversation_captures VALUES('project','principal','input','request',1,'{}')",
  "INSERT INTO native_work_execution_settlements VALUES('project','key',1,'{}')",
  "INSERT INTO native_ci_continuations VALUES('project','continuation',1,'{}')",
])('native row validation stays complete after empty-profile admission: %s', async statement => {
  const sqlite = await fixture();
  sqlite.assertPersistedReadFrame(() => { read(sqlite); });
  sqlite.run(statement); await sqlite.save();
  const images = await captureImages(sqlite);
  try {
    expect(() => sqlite.assertPersistedReadFrame(() => { read(sqlite); })).toThrow();
    expect(images.privateImages).toHaveLength(0);
  } finally { images.restore(); }
});

test.each([
  'ALTER TABLE work_ledgers ADD COLUMN unexpected TEXT',
  'DROP TRIGGER knowledge_edge_change_update',
  'DROP TABLE native_work_executions; CREATE TABLE native_work_executions(project_id TEXT NOT NULL,key_hash TEXT NOT NULL,format_version INTEGER NOT NULL,state_json TEXT NOT NULL,attempt_id TEXT NOT NULL,PRIMARY KEY(project_id,key_hash))',
])('current layout, trigger and uniqueness conditions remain mandatory: %s', async statement => {
  const sqlite = await fixture();
  sqlite.run(statement); await sqlite.save();
  expect(() => sqlite.assertPersistedReadFrame(() => { read(sqlite); })).toThrow();
});

test('a borrowed native plan cannot suppress an arbitrary validator or admit its retained native alias', async () => {
  const SQL = await loadSqlJsEngine(), alias = new SQL.Database();
  let observe = false, exposed: SqlDatabase | undefined;
  const sqlite = await fixture({ validateCurrentSchema(db) {
    validateCurrentKnowledgeSchema(db);
    if (!observe) return;
    exposed = db;
    const main = db.exec('PRAGMA database_list')[0]?.values.find(row => row[1] === 'main')?.[2];
    if (typeof main !== 'string') throw new Error('Native validator image missing');
    alias.run('ATTACH DATABASE ? AS borrowed', [main]);
  } });
  sqlite.run("INSERT INTO knowledge_sources(id,connector_id,source_type,status,created_at,updated_at,metadata) VALUES('missing','fixture','manual','indexed',0,0,'{}')");
  await sqlite.save(); observe = true;
  const images = await captureImages(sqlite);
  try {
    sqlite.assertPersistedReadFrame(() => {
      const original = read(sqlite);
      expect(images.current[0]).toBe(exposed);
      expect(() => exposed?.run("UPDATE knowledge_sources SET title='borrowed callback mutation'")).toThrow();
      expect(() => alias.run("UPDATE borrowed.knowledge_sources SET title='escaped native alias mutation'")).toThrow('readonly database');
      expect(read(sqlite)).toEqual(original);
    });
    expect(images.privateImages[0]).not.toBe(exposed);
    expect(images.exports()).toBe(1);
  } finally { images.restore(); observe = false; alias.close(); }
});
