import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { readYesNo } from '@goodvibes-jev/judgment';
import { inboxTriage } from '../sdk/src/platform/intake/triage/battery.js';
import { captureTriageInputs, settleTriage, triageBinding } from '../sdk/src/platform/intake/triage/evidence.js';
import { SqliteTriageStore } from '../sdk/src/platform/intake/triage/store.js';
import type { TriageEvidence, TriageReceipt } from '../sdk/src/platform/intake/triage/types.js';
import { loadSqlJsEngine, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function binding(id: string, subject = 'Synthetic routine update') {
  return triageBinding(captureTriageInputs([{ id, surface: 'synthetic', subject }])[0]!);
}

function settled(id: string, subject?: string): TriageEvidence {
  const value = settleTriage(binding(id, subject),
    readYesNo({ type: 'noul', noul: 0.01 }, inboxTriage.items.spam.band),
    readYesNo({ type: 'noul', noul: 0.01 }, inboxTriage.items.urgency.band));
  if (value.status !== 'settled') throw new Error('Synthetic fixture must settle.');
  return value;
}

function attempt(id: string, status: 'held' | 'unavailable', subject = 'Synthetic changed input'): TriageReceipt {
  return { ...binding(id, subject), status };
}

let dir: string;
let stores: SqliteTriageStore[];

function owner(directory = dir): SqliteTriageStore {
  const store = new SqliteTriageStore(directory);
  stores.push(store);
  return store;
}

beforeEach(() => {
  dir = makeProjectTempDir('intake-triage-store');
  stores = [];
});

afterEach(async () => {
  await Promise.all(stores.map(store => store.close()));
  fs.rmSync(dir, { force: true, recursive: true });
});

async function alterDatabase(path: string, alter: (db: SqlDatabase) => void): Promise<void> {
  const SQL = await loadSqlJsEngine();
  const db = new SQL.Database(fs.readFileSync(path));
  try {
    alter(db);
    fs.writeFileSync(path, db.export());
  } finally {
    db.close();
  }
}

describe('SqliteTriageStore', () => {
  test('constructor, absent reads, empty commits and close never create a store or directory', async () => {
    const missing = join(dir, 'missing', 'workspace');
    const store = owner(missing);
    expect(store.dbPath).toBe(join(missing, '.goodvibes', 'tui', 'operator', 'inbox-triage.sqlite'));
    expect(fs.existsSync(missing)).toBe(false);
    expect((await store.readBatch(['absent'])).size).toBe(0);
    await store.commit([]);
    await store.close();
    expect(fs.existsSync(missing)).toBe(false);
  });

  test('settled evidence round-trips and reads are immutable detached projections', async () => {
    const store = owner();
    const a = settled('a');
    await store.commit([a, settled('b')]);
    const bytes = fs.readFileSync(store.dbPath);
    const records = await store.readBatch(['a', 'absent', 'a']);
    expect([...records.keys()]).toEqual(['a']);
    expect(records.get('a')).toEqual({ latest: a, settled: a });
    expect(Object.isFrozen(records.get('a'))).toBe(true);
    expect(Object.isFrozen(records.get('a')?.latest)).toBe(true);
    expect(Object.isFrozen(records.get('a')?.settled?.tags)).toBe(true);
    expect(Object.isFrozen(records.get('a')?.settled?.spam)).toBe(true);
    expect(Object.isFrozen(records.get('a')?.settled?.signals)).toBe(true);
    await store.close();
    expect(fs.readFileSync(store.dbPath)).toEqual(bytes);
    expect((await owner().readBatch(['a'])).get('a')).toEqual({ latest: a, settled: a });
  });

  test('held and unavailable replace latest while preserving historical settled evidence', async () => {
    const store = owner();
    const previous = settled('a');
    const held = attempt('a', 'held');
    const unavailable = attempt('a', 'unavailable', 'Synthetic third input');
    await store.commit([previous]);
    await store.commit([held, attempt('new', 'held')]);
    expect((await store.readBatch(['a'])).get('a')).toEqual({ latest: held, settled: previous });
    await store.commit([unavailable]);
    const records = await owner().readBatch(['a', 'new']);
    expect(records.get('a')).toEqual({ latest: unavailable, settled: previous });
    expect(records.get('new')?.settled).toBeNull();
    const replacement = settled('a', 'Synthetic newer settled input');
    await store.commit([replacement]);
    expect((await store.readBatch(['a'])).get('a')).toEqual({ latest: replacement, settled: replacement });
  });

  test('multiple same-id receipts commit atomically in supplied order', async () => {
    const store = owner();
    const evidence = settled('a');
    const held = attempt('a', 'held');
    await store.commit([evidence, held]);
    expect((await store.readBatch(['a'])).get('a')).toEqual({ latest: held, settled: evidence });
  });

  test('captures caller-owned receipts and ids before asynchronous admission', async () => {
    const store = owner();
    const mutable = structuredClone(settled('original'));
    const write = store.commit([mutable]);
    Object.assign(mutable, { id: 'changed' });
    Object.assign(mutable.tags, { 0: 'unexpected' });
    const ids = ['original'];
    const read = store.readBatch(ids);
    ids[0] = 'changed';
    await write;
    expect((await read).get('original')?.latest).toEqual(settled('original'));
    expect((await store.readBatch(['changed'])).size).toBe(0);
  });

  test('concurrent independent owners reload their image and never lose updates', async () => {
    const left = owner();
    const right = owner();
    const ids = Array.from({ length: 20 }, (_, index) => `item-${index}`);
    await Promise.all(ids.map((id, index) => (index % 2 ? right : left).commit([settled(id)])));
    expect((await left.readBatch(ids)).size).toBe(ids.length);
    const held = attempt('item-0', 'held');
    await Promise.all([left.commit([settled('item-0')]), right.commit([held])]);
    expect((await right.readBatch(['item-0'])).get('item-0')).toEqual({ latest: held, settled: settled('item-0') });
  });

  test('symlink working-directory aliases share canonical identity before parent creation', async () => {
    const real = join(dir, 'real');
    const alias = join(dir, 'alias');
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias, 'dir');
    const left = owner(join(real, 'not-yet-created'));
    const right = owner(join(alias, 'not-yet-created'));
    expect(left.dbPath).toBe(right.dbPath);
    await Promise.all([left.commit([settled('a')]), right.commit([settled('b')])]);
    expect((await left.readBatch(['a', 'b'])).size).toBe(2);
    expect(owner(join(alias, 'not-yet-created')).dbPath).toBe(left.dbPath);
  });

  test('retargeting the caller directory alias cannot redirect an admitted store', async () => {
    const first = join(dir, 'first'), second = join(dir, 'second'), alias = join(dir, 'alias');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.symlinkSync(first, alias, 'dir');
    const original = owner(alias);
    fs.unlinkSync(alias);
    fs.symlinkSync(second, alias, 'dir');
    await original.commit([settled('a')]);
    expect((await owner(first).readBatch(['a'])).size).toBe(1);
    expect((await owner(second).readBatch(['a'])).size).toBe(0);
    expect(fs.existsSync(join(second, '.goodvibes'))).toBe(false);
  });

  test('close drains accepted writes and immediately rejects later operations', async () => {
    const store = owner();
    const first = store.commit([settled('a')]);
    const second = store.commit([settled('b')]);
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await expect(store.commit([settled('c')])).rejects.toThrow('closed');
    await expect(store.readBatch(['a'])).rejects.toThrow('closed');
    await Promise.all([first, second, closing]);
    const reopened = await owner().readBatch(['a', 'b', 'c']);
    expect([...reopened.keys()]).toEqual(['a', 'b']);
  });

  test('invalid receipt anywhere in a batch rejects the entire batch before directory creation', async () => {
    const store = owner();
    const invalid = { ...settled('bad'), score: 0.123 };
    await expect(store.commit([settled('valid'), invalid])).rejects.toThrow();
    expect(fs.existsSync(join(dir, '.goodvibes'))).toBe(false);
    await store.commit([settled('existing')]);
    const bytes = fs.readFileSync(store.dbPath);
    await expect(store.commit([settled('valid'), invalid])).rejects.toThrow();
    expect(fs.readFileSync(store.dbPath)).toEqual(bytes);
  });

  test('accessor and proxy receipt arrays are rejected without invoking user code', async () => {
    const store = owner();
    let invoked = 0;
    const accessor: TriageReceipt[] = [];
    Object.defineProperty(accessor, '0', { get() { invoked += 1; return settled('a'); } });
    await expect(store.commit(accessor)).rejects.toThrow();
    const proxy = new Proxy([settled('a')], { get() { invoked += 1; throw new Error('must not read'); } });
    await expect(store.commit(proxy)).rejects.toThrow();
    expect(invoked).toBe(0);
    expect(fs.existsSync(join(dir, '.goodvibes'))).toBe(false);
  });

  test('already aborted and queued canceled writes publish nothing', async () => {
    const store = owner();
    const stopped = new AbortController();
    stopped.abort();
    await expect(store.commit([settled('never')], stopped.signal)).rejects.toThrow();
    expect(fs.existsSync(join(dir, '.goodvibes'))).toBe(false);
    const accepted = store.commit([settled('accepted')]);
    const queued = new AbortController();
    const rejected = store.commit([settled('canceled')], queued.signal);
    queued.abort();
    await expect(rejected).rejects.toThrow();
    await accepted;
    expect([...(await store.readBatch(['accepted', 'canceled'])).keys()]).toEqual(['accepted']);
  });

  test('abort after temp-file preparation preserves the previous image and removes the temp file', async () => {
    const store = owner();
    await store.commit([settled('existing')]);
    const before = fs.readFileSync(store.dbPath);
    const controller = new AbortController();
    const actualSync = fs.fsyncSync;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => { actualSync(fd); controller.abort(); });
    try {
      await expect(store.commit([settled('canceled')], controller.signal)).rejects.toThrow();
    } finally {
      sync.mockRestore();
    }
    expect(fs.readFileSync(store.dbPath)).toEqual(before);
    expect(fs.readdirSync(dirname(store.dbPath))).toEqual(['inbox-triage.sqlite']);
    expect((await store.readBatch(['canceled'])).size).toBe(0);
  });

  test('failed atomic replacement preserves prior receipts and does not poison the queue', async () => {
    const store = owner();
    await store.commit([settled('existing')]);
    const before = fs.readFileSync(store.dbPath);
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic rename failure'); });
    try {
      await expect(store.commit([settled('failed')])).rejects.toThrow('synthetic rename failure');
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(store.dbPath)).toEqual(before);
    expect(fs.readdirSync(dirname(store.dbPath))).toEqual(['inbox-triage.sqlite']);
    await store.commit([settled('recovered')]);
    expect([...(await store.readBatch(['existing', 'failed', 'recovered'])).keys()]).toEqual(['existing', 'recovered']);
  });

  test('rejects managed-directory symlinks without touching the linked target', async () => {
    const outside = join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, join(dir, '.goodvibes'), 'dir');
    const store = owner();
    await expect(store.readBatch(['a'])).rejects.toThrow('symlink');
    await expect(store.commit([settled('a')])).rejects.toThrow('symlink');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(join(dir, '.goodvibes')).isSymbolicLink()).toBe(true);
  });

  test('rejects database symlinks, including dangling links, and preserves their target', async () => {
    const store = owner();
    fs.mkdirSync(dirname(store.dbPath), { recursive: true });
    const target = join(dir, 'outside.sqlite');
    const bytes = Buffer.from('synthetic outside bytes');
    fs.writeFileSync(target, bytes);
    fs.symlinkSync(target, store.dbPath);
    await expect(store.readBatch(['a'])).rejects.toThrow('symlink');
    await expect(store.commit([settled('a')])).rejects.toThrow('symlink');
    expect(fs.readFileSync(target)).toEqual(bytes);
    fs.unlinkSync(store.dbPath);
    fs.symlinkSync(join(dir, 'missing.sqlite'), store.dbPath);
    await expect(store.commit([settled('a')])).rejects.toThrow('symlink');
    expect(fs.existsSync(join(dir, 'missing.sqlite'))).toBe(false);
  });

  test.each([Buffer.alloc(0), Buffer.from('not SQLite'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200)])])(
    'corrupt preexisting bytes fail closed on read, commit and close', async bytes => {
      const store = owner();
      fs.mkdirSync(dirname(store.dbPath), { recursive: true });
      fs.writeFileSync(store.dbPath, bytes);
      await expect(store.readBatch(['a'])).rejects.toThrow();
      await expect(store.commit([settled('a')])).rejects.toThrow();
      await store.close();
      expect(fs.readFileSync(store.dbPath)).toEqual(bytes);
      expect(fs.readdirSync(dirname(store.dbPath))).toEqual(['inbox-triage.sqlite']);
    },
  );

  test.each([
    ['latest id', (db: SqlDatabase) => db.run('UPDATE triage_receipts SET latest = ?', [JSON.stringify(settled('wrong'))])],
    ['settled id', (db: SqlDatabase) => db.run('UPDATE triage_receipts SET settled = ?', [JSON.stringify(settled('wrong'))])],
    ['settled status', (db: SqlDatabase) => db.run('UPDATE triage_receipts SET settled = ?', [JSON.stringify(attempt('a', 'held'))])],
    ['settled conclusion', (db: SqlDatabase) => db.run('UPDATE triage_receipts SET latest = ?', [JSON.stringify({ ...settled('a'), label: 'spam' })])],
    ['missing settled', (db: SqlDatabase) => db.run('UPDATE triage_receipts SET settled = NULL')],
    ['inconsistent settled', (db: SqlDatabase) => db.run('UPDATE triage_receipts SET settled = ?', [JSON.stringify(settled('a', 'other input'))])],
    ['malformed JSON', (db: SqlDatabase) => db.run('UPDATE triage_receipts SET latest = ?', ['{'])],
    ['future schema', (db: SqlDatabase) => db.run('PRAGMA user_version = 999')],
    ['unexpected schema', (db: SqlDatabase) => db.run('CREATE TABLE unrelated (id TEXT)')],
    ['unexpected trigger', (db: SqlDatabase) => db.run('CREATE TRIGGER sqlitexhidden AFTER INSERT ON triage_receipts BEGIN DELETE FROM triage_receipts; END')],
  ] as const)('persisted %s corruption is rejected even outside the requested ids', async (_name, alter) => {
    const store = owner();
    await store.commit([settled('a')]);
    await alterDatabase(store.dbPath, alter);
    const bytes = fs.readFileSync(store.dbPath);
    await expect(store.readBatch(['unrelated'])).rejects.toThrow();
    await expect(store.commit([settled('b')])).rejects.toThrow();
    await store.close();
    expect(fs.readFileSync(store.dbPath)).toEqual(bytes);
  });
});
