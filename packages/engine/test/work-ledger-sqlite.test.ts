import * as nativeFs from 'node:fs';
import type { SQLitePublicationIO } from '../sdk/src/platform/state/sqlite-store-persistence.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import type { WorkLedgerDecision } from '../sdk/src/platform/workflow/work-ledger/types.js';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'work-ledger-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function open(file: string, projectId = 'project') {
  const store = new KnowledgeStore({ dbPath: file }); stores.push(store);
  const storage = await store.openWorkLedgerStorage(projectId);
  let id = 0;
  const ledger = createWorkLedger({ projectId, storage, clock: { now: () => 100, newId: kind => `${kind}-${++id}` } });
  const actor = ledger.authority.issueActor({ projectId, actorId: 'owner', role: 'coordinator' });
  return { store, storage, ...ledger, actor };
}
const command = { type: 'create', requestId: 'request', expectedRevision: 0, title: 'Durable', goal: 'Persist', criteria: ['Atomic'] };

test('disk restart keeps original receipt, history and identities; ordinary save preserves ledger', async () => {
  const file = path(); const first = await open(file);
  const accepted = await first.service.execute(command, first.actor);
  expect(accepted.kind).toBe('accepted');
  if (accepted.kind !== 'accepted') throw new Error('Expected accepted receipt');
  await first.store.upsertSource({ id: 'source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', metadata: { executionApproved: true } });
  await first.service.close(); await first.store.close();
  const second = await open(file);
  expect(await second.service.execute(command, second.actor)).toEqual({ ...accepted, replayed: true });
  expect((await second.service.history(0, second.actor))).toHaveLength(1);
  expect(second.store.getSource('source')?.metadata).toMatchObject({ executionApproved: true });
  expect((await second.service.readSnapshot(second.actor)).works[0]?.verification.state).toBe('unverified');
  expect(await second.service.execute({ ...command, title: 'Changed' }, second.actor)).toMatchObject({ kind: 'rejected', code: 'request_conflict' });
  expect(await second.service.execute(command, first.actor)).toMatchObject({ kind: 'rejected', code: 'forbidden' });
});

test('independent owners serialize competing revision and preserve unrelated projects', async () => {
  const file = path(); const first = await open(file); const second = await open(file);
  const results = await Promise.all([first.service.execute(command, first.actor), second.service.execute({ ...command, requestId: 'second' }, second.actor)]);
  expect(results.map(result => result.kind).sort()).toEqual(['accepted', 'rejected']);
  const other = await open(file, 'other');
  expect(await other.service.execute(command, other.actor)).toMatchObject({ kind: 'accepted' });
  expect((await first.service.history(0, first.actor))).toHaveLength(1);
  expect((await other.service.history(0, other.actor))).toHaveLength(1);
});

test('decision is synchronous, exactly once and detached; pending local edits are not discarded', async () => {
  const first = await open(path()); let called = 0;
  await expect(first.storage.transaction((async () => ({ next: null, value: 1 })) as unknown as () => WorkLedgerDecision<number>)).rejects.toThrow('synchronous');
  expect(await first.storage.transaction(current => { called++; (current as { revision: number }).revision = 99; return { next: null, value: 'read' }; })).toBe('read');
  expect(called).toBe(1);
  expect((await first.storage.read() as { revision: number }).revision).toBe(0);
  await first.store.batch(async () => {
    await first.store.upsertSource({ id: 'pending', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
    await expect(first.storage.transaction(() => { called++; return { next: null, value: 0 }; })).rejects.toThrow('admission blocked');
  });
  expect(called).toBe(1);
  expect(first.store.getSource('pending')).not.toBeNull();
});

test('revocation and abort during lock wait leave bytes unchanged', async () => {
  const file = path(); const first = await open(file); await first.store.upsertSource({ id: 'seed', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
  const bytes = readFileSync(file); const release = await acquireCrossProcessLock(`${file}.knowledge-lock`, { strictOwnership: true });
  const abort = new AbortController();
  const pending = first.service.execute(command, first.actor, { signal: abort.signal });
  await new Promise(resolve => setTimeout(resolve, 20)); abort.abort(); release();
  expect(await pending).toMatchObject({ kind: 'rejected', code: 'cancelled' });
  expect(readFileSync(file)).toEqual(bytes);
  const release2 = await acquireCrossProcessLock(`${file}.knowledge-lock`, { strictOwnership: true });
  const revoked = first.service.execute(command, first.actor);
  await new Promise(resolve => setTimeout(resolve, 20)); first.authority.revokeActor(first.actor); release2();
  expect(await revoked).toMatchObject({ kind: 'rejected', code: 'forbidden' });
  expect(readFileSync(file)).toEqual(bytes);
});

test('missing established database and corruption fail closed without resetting', async () => {
  const file = path(); const first = await open(file); await first.service.execute(command, first.actor);
  unlinkSync(file);
  await expect(first.storage.read()).rejects.toThrow();
  expect(await first.service.execute(command, first.actor)).toMatchObject({ kind: 'indeterminate' });
  writeFileSync(file, 'corrupt');
  await expect(first.storage.read()).rejects.toThrow();
  expect(readFileSync(file, 'utf8')).toBe('corrupt');
});

test('postcommit refresh failure cannot erase accepted result and fences ordinary cache writes', async () => {
  const file = path(); const sqlite = new SQLiteStore(file, { coordinated: true });
  const schema = (db: { run(sql: string): void }) => db.run('CREATE TABLE IF NOT EXISTS proof (value TEXT)');
  await sqlite.init(schema);
  expect(await sqlite.transactPersisted(db => { db.run("INSERT INTO proof VALUES ('durable')"); return { changed: true, value: 'accepted' }; }, () => { throw new Error('refresh'); })).toEqual({ kind: 'completed', value: 'accepted' });
  expect(() => sqlite.run("DELETE FROM proof")).toThrow('fenced');
  expect(sqlite.readPersisted(db => db.exec('SELECT value FROM proof')[0]?.values)).toEqual([['durable']]);
  expect(await sqlite.transactPersisted(db => ({ changed: false, value: db.exec('SELECT value FROM proof')[0]?.values }), () => {})).toEqual({ kind: 'completed', value: [['durable']] });
  sqlite.close();
});

test('cross-owner polling catches up and subscription cleanup stops callbacks', async () => {
  const file = path(); const first = await open(file); const other = await open(file); const seen: number[] = [];
  const stop = first.storage.subscribe(state => { seen.push(state.revision); throw new Error('observer'); });
  await other.service.execute(command, other.actor);
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(seen).toContain(1); stop(); const count = seen.length;
  await other.service.execute({ ...command, requestId: 'next', expectedRevision: 1 }, other.actor);
  await new Promise(resolve => setTimeout(resolve, 160)); expect(seen).toHaveLength(count);
});

test('v1 migration adds ledger and native execution tables; legacy metadata is preserved and older open refuses v5', async () => {
  const file = path(); const seed = await open(file);
  await seed.store.upsertSource({ id: 'legacy', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', metadata: { executionApproved: true, verifier: 'legacy-text', answers: ['yes'] } });
  await seed.store.close();
  const legacy = new SQLiteStore(file); await legacy.init(() => {}, { schemaVersion: 9 });
  legacy.run('DROP TABLE work_ledgers'); legacy.run('PRAGMA user_version = 1'); await legacy.save(); legacy.close();
  const migrated = await open(file);
  expect(migrated.store.getSource('legacy')?.metadata).toMatchObject({ executionApproved: true, verifier: 'legacy-text', answers: ['yes'] });
  expect(await migrated.service.readSnapshot(migrated.actor)).toMatchObject({ revision: 0, works: [] });
  const oldBinary = new SQLiteStore(file);
  await expect(oldBinary.init(() => {}, { schemaVersion: 1 })).rejects.toThrow('newer version');
});

test('malformed ledger receipt/history is rejected without reset or publication', async () => {
  const file = path(); const first = await open(file); await first.service.execute(command, first.actor);
  const raw = new SQLiteStore(file, { coordinated: true }); await raw.init(() => {}, { schemaVersion: 9 });
  const state = await first.storage.read() as { receipts: unknown[] };
  state.receipts = [];
  raw.run('UPDATE work_ledgers SET state_json = ?', [JSON.stringify(state)]); await raw.save(); raw.close();
  const bytes = readFileSync(file);
  expect(await first.service.execute(command, first.actor)).toMatchObject({ kind: 'rejected', code: 'invalid_state' });
  await expect(first.service.readSnapshot(first.actor)).rejects.toThrow();
  expect(readFileSync(file)).toEqual(bytes);
});

test('owner close waits for a ledger write held on file ownership and then rejects new storage admission', async () => {
  const file = path(); const first = await open(file);
  const release = await acquireCrossProcessLock(`${file}.knowledge-lock`, { strictOwnership: true });
  const writing = first.service.execute(command, first.actor);
  await new Promise(resolve => setTimeout(resolve, 15));
  let settled = false; const closing = first.store.close().then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 15)); expect(settled).toBe(false);
  await expect(first.storage.read()).rejects.toThrow('closed');
  release(); expect(await writing).toMatchObject({ kind: 'accepted' }); await closing; expect(settled).toBe(true);
  const reopened = await open(file); expect((await reopened.service.history(0, reopened.actor))).toHaveLength(1);
});

test('reentrant local writes during a decision are retained and prevent publication', async () => {
  const file = path(); const sqlite = new SQLiteStore(file, { coordinated: true });
  await sqlite.init(db => db.run('CREATE TABLE IF NOT EXISTS fixture(value TEXT)'));
  await expect(sqlite.transactPersisted(db => {
    db.run("INSERT INTO fixture VALUES ('ledger')");
    sqlite.run("INSERT INTO fixture VALUES ('local')");
    return { changed: true, value: 'unsafe' };
  }, () => {})).rejects.toThrow('reentrant local changes');
  expect(sqlite.exec('SELECT value FROM fixture')[0]?.values).toEqual([['local']]);
  await sqlite.save(); sqlite.close();
});

test('missing ledger table in an established v5 database cannot be repaired by ordinary writes', async () => {
  const file = path(); const first = await open(file); await first.service.execute(command, first.actor); await first.store.close();
  const raw = new SQLiteStore(file); await raw.init(() => {}, { schemaVersion: 9 }); raw.run('DROP TABLE work_ledgers'); await raw.save(); raw.close();
  const bytes = readFileSync(file);
  const owner = new KnowledgeStore({ dbPath: file }); stores.push(owner);
  await expect(owner.init()).rejects.toThrow('schema is missing or corrupt');
  await expect(owner.upsertSource({ id: 'must-not-repair', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' })).rejects.toThrow('schema is missing or corrupt');
  await expect(owner.openWorkLedgerStorage('project')).rejects.toThrow('schema is missing or corrupt');
  expect(readFileSync(file)).toEqual(bytes);
});

test('schema deletion after open fences an ordinary save without replacing the newer disk image', async () => {
  const file = path(); const first = await open(file); await first.service.execute(command, first.actor);
  const raw = new SQLiteStore(file); await raw.init(() => {}, { schemaVersion: 9 }); raw.run('DROP TABLE work_ledgers'); await raw.save(); raw.close();
  const bytes = readFileSync(file);
  await expect(first.store.upsertSource({ id: 'must-not-repair', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' })).rejects.toThrow('persisted state changed');
  expect(await first.service.execute(command, first.actor)).toMatchObject({ kind: 'indeterminate' });
  expect(readFileSync(file)).toEqual(bytes);
});

test('KnowledgeStore close drains an admitted ordinary batch and its deferred save', async () => {
  const file = path(); const first = await open(file);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const batch = first.store.batch(async () => {
    await first.store.upsertSource({ id: 'batched', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
    entered(); await gate;
  });
  await ready;
  let closed = false; const closing = first.store.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 15)); expect(closed).toBe(false);
  release(); await batch; await closing;
  expect((await open(file)).store.getSource('batched')).not.toBeNull();
});

for (const corrupt of [Buffer.alloc(0), Buffer.from('SQLite format 3\0'), Buffer.from('not a database')]) {
  test(`existing corrupt ${corrupt.length}-byte database cannot be treated as new`, async () => {
    const file = path(); writeFileSync(file, corrupt);
    const owner = new KnowledgeStore({ dbPath: file }); stores.push(owner);
    await expect(owner.openWorkLedgerStorage('project')).rejects.toThrow('existing database image is corrupt');
    await expect(owner.upsertSource({ id: 'must-not-repair', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' })).rejects.toThrow('existing database image is corrupt');
    expect(readFileSync(file)).toEqual(corrupt);
  });
}

test('postcommit replaced-image close failure does not change the durable result', async () => {
  const file = path(); const sqlite = new SQLiteStore(file, { coordinated: true });
  await sqlite.init(db => db.run('CREATE TABLE IF NOT EXISTS fixture(value TEXT)'));
  const previous = (sqlite as unknown as { db: { close(): void } }).db;
  const originalClose = previous.close.bind(previous);
  previous.close = () => { originalClose(); throw new Error('injected old image cleanup'); };
  expect(await sqlite.transactPersisted(db => { db.run("INSERT INTO fixture VALUES ('durable')"); return { changed: true, value: 'accepted' }; }, () => {})).toEqual({ kind: 'completed', value: 'accepted' });
  expect(sqlite.readPersisted(db => db.exec('SELECT value FROM fixture')[0]?.values)).toEqual([['durable']]);
  sqlite.close();
});

test('postcommit lock cleanup failure preserves success and durable replay while fencing ordinary writes', async () => {
  const file = path(); const sqlite = new SQLiteStore(file, { coordinated: true });
  await sqlite.init(db => db.run('CREATE TABLE IF NOT EXISTS fixture(value TEXT)'));
  const persistence = (sqlite as unknown as { persistence: { lock(): Promise<() => void> } }).persistence;
  const originalLock = persistence.lock.bind(persistence);
  persistence.lock = async () => { const release = await originalLock(); return () => { release(); throw new Error('injected release cleanup'); }; };
  expect(await sqlite.transactPersisted(db => { db.run("INSERT INTO fixture VALUES ('durable')"); return { changed: true, value: 'accepted' }; }, () => {})).toEqual({ kind: 'completed', value: 'accepted' });
  expect(() => sqlite.run('DELETE FROM fixture')).toThrow('fenced');
  persistence.lock = originalLock;
  expect(await sqlite.transactPersisted(db => ({ changed: false, value: db.exec('SELECT value FROM fixture')[0]?.values }), () => {})).toEqual({ kind: 'completed', value: [['durable']] });
  sqlite.close();
});


test('actual ledger directory-sync ambiguity returns indeterminate then exact retry proves durable receipt', async () => {
  const file = path(); const first = await open(file);
  const persistence = (first.store as unknown as { sqlite: { persistence: { io: SQLitePublicationIO } } }).sqlite.persistence;
  let fail = true; const synced: string[] = [];
  persistence.io = { ...nativeFs, fsyncSync(fd) {
    const kind = nativeFs.fstatSync(fd).isDirectory() ? 'directory' : 'file'; synced.push(kind);
    if (kind === 'directory' && fail) { fail = false; throw new Error('injected directory sync ambiguity'); }
    nativeFs.fsyncSync(fd);
  } };
  expect(await first.service.execute(command, first.actor)).toMatchObject({ kind: 'indeterminate', requestId: 'request' });
  const bytes = readFileSync(file); synced.length = 0;
  expect(await first.service.execute(command, first.actor)).toMatchObject({ kind: 'accepted', replayed: true });
  const expected = ['file'];
  for (let path = dirname(file);; path = dirname(path)) {
    expected.push('directory');
    if (dirname(path) === path) break;
  }
  expect(synced).toEqual(expected);
  expect(readFileSync(file)).toEqual(bytes);
  expect((await first.service.history(0, first.actor))).toHaveLength(1);
});

test('documented boundary: a fresh owner has no manifest to distinguish deleted whole DB from first creation', async () => {
  const file = path(); const first = await open(file); await first.service.execute(command, first.actor); await first.store.close();
  unlinkSync(file);
  const fresh = await open(file);
  expect(await fresh.service.readSnapshot(fresh.actor)).toMatchObject({ revision: 0, works: [] });
  // An established-open policy needs independent durable identity outside this
  // missing file. This test records the boundary, not a deletion-protection claim.
});
