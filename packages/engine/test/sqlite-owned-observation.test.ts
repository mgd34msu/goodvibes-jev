import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlJsEngine, SQLiteObservationRetiredError, SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import * as observations from '../sdk/src/platform/state/sqlite-local-observation.js';

const stores: SQLiteStore[] = [], knowledge: KnowledgeStore[] = [], peers: SqlDatabase[] = [], roots: string[] = [];
afterEach(async () => {
  for (const store of knowledge.splice(0)) await store.close();
  for (const peer of peers.splice(0)) peer.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function filename() { const root = mkdtempSync(join(tmpdir(), 'sqlite-owned-')); roots.push(root); return join(root, 'state.sqlite'); }
async function fixture(persisted = false) {
  const sqlite = new SQLiteStore(persisted ? filename() : ':memory:', { coordinated: true }); stores.push(sqlite);
  let handle!: SqlDatabase;
  await sqlite.init(db => { handle = db; db.run('CREATE TABLE IF NOT EXISTS knowledge_sources (id TEXT)'); });
  handle.run("INSERT INTO knowledge_sources VALUES ('original')");
  if (persisted) await sqlite.save();
  return { sqlite, handle };
}
const read = (sqlite: SQLiteStore) => sqlite.readPersistedRow('knowledge_sources', 'id', 'original');
function exactFacade(db: SqlDatabase) {
  expect(Object.keys(db).sort()).toEqual(['close', 'exec', 'export', 'run']);
  expect(Object.isFrozen(db)).toBe(true);
  expect(db.run('SELECT 1')).toBeUndefined();
}
async function peerOf(handle: SqlDatabase, schema = 'main') {
  const file = handle.exec('PRAGMA database_list')[0]!.values.find(row => row[1] === schema)?.[2];
  if (typeof file !== 'string' || !file) throw new Error('Connection filename unavailable');
  const SQL = await loadSqlJsEngine(), peer = new SQL.Database(); peers.push(peer);
  peer.run(`ATTACH DATABASE '${file.replaceAll("'", "''")}' AS shared`);
  return peer;
}

test('schema migration validation legacy and durable callbacks expose only immutable four-method facades', async () => {
  const sqlite = new SQLiteStore(filename(), { coordinated: true }); stores.push(sqlite);
  const received: SqlDatabase[] = [];
  await sqlite.init(db => { received.push(db); db.run('CREATE TABLE IF NOT EXISTS knowledge_sources (id TEXT)'); }, {
    migrations: [{ toVersion: 1, migrate(db) { received.push(db); db.run('CREATE TABLE IF NOT EXISTS knowledge_sources (id TEXT)'); } }],
    validateCurrentSchema(db) { received.push(db); },
  });
  for (const db of received) exactFacade(db);
  await sqlite.save();
  sqlite.readPersisted(exactFacade);
  let writer!: SqlDatabase, durable!: SqlDatabase;
  await sqlite.transactPersisted(db => { writer = db; exactFacade(db); db.run("INSERT INTO knowledge_sources VALUES ('original')"); return { changed: true, value: 1 }; }, () => {},
    (_value, db) => { durable = db; exactFacade(db); });
  expect(durable).toBe(writer);
  const current = sqlite.captureObservation(); writer.run("UPDATE knowledge_sources SET id = 'changed'");
  expect(current).toThrow(SQLiteObservationRetiredError);
});

test('unchanged checks reuse a complete digest and fixed ephemeral row reads do not self-retire', async () => {
  const { sqlite } = await fixture();
  const scan = spyOn(observations, 'sqliteLocalObservation');
  try {
    const current = sqlite.captureObservation();
    for (let i = 0; i < 5; i++) { read(sqlite); current(); }
    expect(scan.mock.calls.length).toBe(1);
  } finally { scan.mockRestore(); }
});

test('retained handles keep transactions rollbackable while rollback ABA retires observations', async () => {
  const { sqlite, handle } = await fixture(); handle.run('BEGIN'); handle.run('SAVEPOINT retained');
  const before = sqlite.captureObservation(); before();
  handle.run("UPDATE knowledge_sources SET id = 'transient'"); handle.run('ROLLBACK TO retained');
  expect(before).toThrow(SQLiteObservationRetiredError);
  handle.run('RELEASE retained'); handle.run('ROLLBACK');
  expect(read(sqlite)[0]?.values).toEqual([['original']]);
});

test('retained export reset and failed partial statements cannot revive an observation', async () => {
  const { sqlite, handle } = await fixture();
  const before = sqlite.captureObservation(); handle.export(); expect(before).toThrow(SQLiteObservationRetiredError);
  const next = sqlite.captureObservation();
  expect(() => handle.exec("UPDATE knowledge_sources SET id = 'changed'; SELECT * FROM absent_table")).toThrow();
  expect(next).toThrow(SQLiteObservationRetiredError);
});

test('reentrant parameter access cannot authorize an in-flight operation', async () => {
  const { sqlite, handle } = await fixture(); let attempted = false;
  const params: string[] = ['changed'];
  Object.defineProperty(params, '0', { get() {
    attempted = true;
    expect(() => sqlite.captureObservation()).toThrow(SQLiteObservationRetiredError);
    return 'changed';
  } });
  const current = sqlite.captureObservation(); handle.run('UPDATE knowledge_sources SET id = ?', params);
  expect(attempted).toBe(true); expect(current).toThrow(SQLiteObservationRetiredError);
});

test('independent SQL commit and restore retire a cached observation without owner facade operations', async () => {
  const { sqlite, handle } = await fixture(), peer = await peerOf(handle);
  const before = sqlite.captureObservation(); before();
  peer.run("UPDATE shared.knowledge_sources SET id = 'peer'");
  peer.run("UPDATE shared.knowledge_sources SET id = 'original'");
  expect(before).toThrow(SQLiteObservationRetiredError);
  expect(() => sqlite.captureObservation()()).not.toThrow();
});

test('independent attached-schema writes remain fenced after owner export resets data_version', async () => {
  const { sqlite, handle } = await fixture();
  handle.run("ATTACH DATABASE 'owned-observation-attached' AS auxiliary; CREATE TABLE auxiliary.extra(value); INSERT INTO auxiliary.extra VALUES ('original')");
  const peer = await peerOf(handle, 'auxiliary'), before = sqlite.captureObservation();
  peer.run("UPDATE shared.extra SET value = 'changed'"); expect(before).toThrow(SQLiteObservationRetiredError);
  // sql.js export ends the connection lifetime (and drops attachments). The
  // facade revision must fence this independently of any reset version values.
  const next = sqlite.captureObservation(); handle.export(); expect(next).toThrow(SQLiteObservationRetiredError);
});

test('read_uncommitted uses complete scans rather than an owned memo', async () => {
  const { sqlite, handle } = await fixture(); handle.run('PRAGMA read_uncommitted = ON');
  const scan = spyOn(observations, 'sqliteLocalObservation');
  try { const current = sqlite.captureObservation(); current(); current(); expect(scan.mock.calls.length).toBe(3); }
  finally { scan.mockRestore(); }
});

test('closed internal persisted row reads keep facade ownership and existing frame lifetimes', async () => {
  const { sqlite } = await fixture(true), current = sqlite.captureObservation();
  sqlite.assertPersistedReadFrame(() => { read(sqlite); sqlite.assertPersistedReadFrame(() => { read(sqlite); }); });
  current();
});


const canonicalInput = { id: 'planning-source', connectorId: 'goodvibes-project-planning', sourceType: 'document' as const,
  title: 'Planning artifact', status: 'indexed' as const, metadata: { knowledgeSpaceId: 'default' } };

test('real canonical-source publication succeeds on both file-backed and ephemeral stores', async () => {
  for (const persisted of [false, true]) {
    const store = new KnowledgeStore({ dbPath: persisted ? filename() : ':memory:' }); knowledge.push(store);
    const first = await store.upsertCanonicalSource(canonicalInput);
    expect(first.id).toBe(canonicalInput.id);
    const second = await store.upsertCanonicalSource({ ...canonicalInput, summary: 'Updated planning artifact' });
    expect(second.summary).toBe('Updated planning artifact');
    expect(typeof store.getSourceSnapshot({ id: first.id }).raw?.created_at).toBe('string');
  }
});

test('actual canonical publication rejects mutation after its publication receipt is captured', async () => {
  for (const persisted of [false, true]) {
    const store = new KnowledgeStore({ dbPath: persisted ? filename() : ':memory:' }); knowledge.push(store);
    await store.upsertCanonicalSource(canonicalInput);
    const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
    const capture = store.captureSourcePublication.bind(store);
    const intercept = spyOn(store, 'captureSourcePublication').mockImplementationOnce(() => {
      const receipt = capture();
      sqlite.run("UPDATE knowledge_sources SET summary = 'pending concurrent change' WHERE id = ?", [canonicalInput.id]);
      return receipt;
    });
    try { await expect(store.upsertCanonicalSource({ ...canonicalInput, summary: 'must not publish' })).rejects.toThrow(); }
    finally { intercept.mockRestore(); }
    expect(sqlite.exec('SELECT summary FROM knowledge_sources WHERE id = ?', [canonicalInput.id])[0]?.values)
      .toEqual([['pending concurrent change']]);
  }
});

test('captured publication restrictions survive non-destructive transaction clean checks in both storage modes', async () => {
  for (const persisted of [false, true]) {
    const { sqlite } = await fixture(persisted); await sqlite.save();
    const current = sqlite.captureObservation();
    const result = await sqlite.transactPersisted(db => { current(); expect(db.exec('SELECT id FROM knowledge_sources')[0]?.values).toEqual([['original']]);
      return { changed: false, value: 'checked' }; }, () => {});
    expect(result).toEqual({ kind: 'completed', value: 'checked' }); current();
  }
});

test('pending local changes are retained and prevent guarded publication in both storage modes', async () => {
  for (const persisted of [false, true]) {
    const { sqlite, handle } = await fixture(persisted); await sqlite.save();
    handle.run("UPDATE knowledge_sources SET id = 'pending'"); let called = false;
    expect(await sqlite.transactPersisted(() => { called = true; return { changed: true, value: 1 }; }, () => {}))
      .toEqual({ kind: 'local-changes' });
    expect(called).toBe(false);
    expect(handle.exec('SELECT id FROM knowledge_sources')[0]?.values).toEqual([['pending']]);
  }
});

test('rolled-back DML remains clean while the earlier publication receipt is retired', async () => {
  for (const persisted of [false, true]) {
    const { sqlite, handle } = await fixture(persisted); await sqlite.save();
    const old = sqlite.captureObservation(); handle.run('BEGIN');
    handle.run("UPDATE knowledge_sources SET id = 'transient'"); handle.run('ROLLBACK');
    expect(old).toThrow(SQLiteObservationRetiredError);
    const restored = sqlite.captureObservation();
    expect(await sqlite.transactPersisted(() => { restored(); return { changed: false, value: 'restored' }; }, () => {}))
      .toEqual({ kind: 'completed', value: 'restored' });
  }
});

test('unsupported generic schema still initializes and saves but guarded mutation conservatively holds', async () => {
  for (const persisted of [false, true]) {
    const sqlite = new SQLiteStore(persisted ? filename() : ':memory:', { coordinated: true }); stores.push(sqlite);
    await sqlite.init(db => db.run('CREATE TABLE IF NOT EXISTS generic (value, derived GENERATED ALWAYS AS (value || value) VIRTUAL)'));
    expect(await sqlite.save()).toBe(persisted);
    let called = false;
    expect(await sqlite.transactPersisted(() => { called = true; return { changed: true, value: 1 }; }, () => {}))
      .toEqual({ kind: 'local-changes' });
    expect(called).toBe(false);
  }
});

test('clean-content mode excludes only irreversible operation count while default observation retains it', async () => {
  const SQL = await loadSqlJsEngine(), db = new SQL.Database(); peers.push(db);
  db.run("CREATE TABLE evidence(value); INSERT INTO evidence VALUES ('original')");
  const full = observations.sqliteLocalObservation(db), clean = observations.sqliteLocalObservation(db, 'clean-content');
  db.run("BEGIN; UPDATE evidence SET value = 'transient'; ROLLBACK");
  expect(observations.sqliteLocalObservation(db)).not.toBe(full);
  expect(observations.sqliteLocalObservation(db, 'clean-content')).toBe(clean);
});
