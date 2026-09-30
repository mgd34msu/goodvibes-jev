import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HandlerSqliteStore } from '../sdk/src/platform/state/daemon-handler-sqlite-store.ts';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const SCHEMA = ['CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, value TEXT)'];
let directory: string;
const stores: HandlerSqliteStore[] = [];
beforeEach(() => { directory = makeProjectTempDir('gv-handler-sqlite-lifecycle'); });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function makeStore(schema = SCHEMA): HandlerSqliteStore {
  const store = new HandlerSqliteStore({ workingDirectory: directory, fileName: 'probe.sqlite', schema });
  stores.push(store);
  return store;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('daemon handler store preservation', () => {
  test('new quarantine preserves an old damaged file and cannot overwrite a same-clock copy', async () => {
    const store = makeStore();
    fs.mkdirSync(dirname(store.dbPath), { recursive: true });
    const now = Date.now();
    const oldCopy = `${store.dbPath}.corrupt-${now}`;
    fs.writeFileSync(oldCopy, 'previous salvage');
    fs.writeFileSync(store.dbPath, 'new salvage');
    const oldDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(store.dbPath, oldDate, oldDate);
    const nowSpy = spyOn(Date, 'now').mockReturnValue(now);
    try { await store.init(); } finally { nowSpy.mockRestore(); }
    expect(fs.readFileSync(oldCopy, 'utf8')).toBe('previous salvage');
    const files = fs.readdirSync(dirname(store.dbPath));
    expect(files).toHaveLength(2);
    expect(files.map((file) => fs.readFileSync(join(dirname(store.dbPath), file), 'utf8')).sort())
      .toEqual(['new salvage', 'previous salvage']);
    const reopened = makeStore();
    await reopened.init();
    expect(fs.readdirSync(dirname(store.dbPath))).toHaveLength(2);
  });

  test('a failed quarantine refuses save and leaves the original bytes untouched', async () => {
    const store = makeStore();
    fs.mkdirSync(dirname(store.dbPath), { recursive: true });
    const original = Buffer.from('operator may salvage these bytes');
    fs.writeFileSync(store.dbPath, original);
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture move denied'); });
    try { await store.init(); } finally { renameSpy.mockRestore(); }
    store.run('INSERT INTO probe VALUES (?, ?)', ['new', 'in memory']);
    await expect(store.save()).rejects.toThrow('quarantine');
    expect(fs.readFileSync(store.dbPath)).toEqual(original);
    expect(fs.readdirSync(dirname(store.dbPath))).toEqual(['probe.sqlite']);
  });

  test('an invalid schema never quarantines a healthy database', async () => {
    const original = makeStore();
    await original.init();
    original.run('INSERT INTO probe VALUES (?, ?)', ['old', 'preserved']);
    await original.save();
    original.close();
    const bytes = fs.readFileSync(original.dbPath);
    const broken = makeStore(['THIS IS NOT VALID SQL']);
    await expect(broken.init()).rejects.toThrow();
    expect(fs.readFileSync(original.dbPath)).toEqual(bytes);
    expect(fs.readdirSync(dirname(original.dbPath))).toEqual(['probe.sqlite']);
    expect(() => broken.get('SELECT 1')).toThrow('not initialized');
    const reopened = makeStore();
    await reopened.init();
    expect(reopened.get<{ value: string }>('SELECT value FROM probe')).toEqual({ value: 'preserved' });
  });

  test('a fresh schema failure leaves init retryable and no half-ready database', async () => {
    const schema = ['THIS IS NOT VALID SQL'];
    const store = makeStore(schema);
    await expect(store.init()).rejects.toThrow();
    expect(() => store.run('CREATE TABLE accidental (id TEXT)')).toThrow('not initialized');
    schema.splice(0, 1, ...SCHEMA);
    await store.init();
    store.run('INSERT INTO probe VALUES (?, ?)', ['retry', 'ready']);
    expect(store.get<{ value: string }>('SELECT value FROM probe')).toEqual({ value: 'ready' });
  });
});

describe('daemon handler store persistence order', () => {
  test.each([false, true])('saves stay in invocation order with separate instances = %s', async (separateInstances) => {
    const first = makeStore();
    await first.init();
    const second = separateInstances ? makeStore() : first;
    if (separateInstances) await second.init();
    first.run('INSERT INTO probe VALUES (?, ?)', ['version', 'old']);
    const entered = deferred();
    const release = deferred();
    const nativeRename = fsPromises.rename;
    let renames = 0;
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
      renames += 1;
      if (renames === 1) { entered.resolve(); await release.promise; }
      return nativeRename(...args);
    });
    let oldSave: Promise<void> | undefined;
    let newSave: Promise<void> | undefined;
    try {
      oldSave = first.save();
      await entered.promise;
      second.run('INSERT OR REPLACE INTO probe VALUES (?, ?)', ['version', 'new']);
      newSave = second.save();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(renames).toBe(1);
    } finally {
      release.resolve();
      await Promise.all([oldSave, newSave]);
      renameSpy.mockRestore();
    }
    const reopened = makeStore();
    await reopened.init();
    expect(reopened.get<{ value: string }>('SELECT value FROM probe')).toEqual({ value: 'new' });
  });

  test('failed atomic rename preserves disk, removes scratch, and does not poison next save', async () => {
    const store = makeStore();
    await store.init();
    store.run('INSERT INTO probe VALUES (?, ?)', ['version', 'old']);
    await store.save();
    const original = fs.readFileSync(store.dbPath);
    store.run('UPDATE probe SET value = ?', ['new']);
    const renameSpy = spyOn(fsPromises, 'rename').mockRejectedValueOnce(new Error('fixture rename failure'));
    try { await expect(store.save()).rejects.toThrow('fixture rename failure'); } finally { renameSpy.mockRestore(); }
    expect(fs.readFileSync(store.dbPath)).toEqual(original);
    expect(fs.readdirSync(dirname(store.dbPath))).toEqual(['probe.sqlite']);
    await store.save();
    const reopened = makeStore();
    await reopened.init();
    expect(reopened.get<{ value: string }>('SELECT value FROM probe')).toEqual({ value: 'new' });
  });

  test('save owns its snapshot before close or a subsequent in-memory change', async () => {
    const store = makeStore();
    await store.init();
    store.run('INSERT INTO probe VALUES (?, ?)', ['snapshot', 'saved']);
    const saving = store.save();
    store.run('UPDATE probe SET value = ?', ['not saved']);
    store.close();
    await saving;
    const reopened = makeStore();
    await reopened.init();
    expect(reopened.get<{ value: string }>('SELECT value FROM probe')).toEqual({ value: 'saved' });
  });
});

test('SQL operations preserve the legacy layout, transactions and missing-row behavior', async () => {
  const store = makeStore();
  expect(store.dbPath).toBe(join(directory, '.goodvibes', 'tui', 'operator', 'probe.sqlite'));
  expect(() => store.get('SELECT 1')).toThrow('not initialized');
  await store.init();
  expect(store.get('SELECT * FROM probe')).toBeNull();
  store.transaction(() => { store.run('INSERT INTO probe VALUES (?, ?)', ['a', 'kept']); });
  expect(() => store.transaction(() => {
    store.run('INSERT INTO probe VALUES (?, ?)', ['b', 'rolled back']);
    throw new Error('rollback');
  })).toThrow('rollback');
  expect(store.all('SELECT * FROM probe')).toEqual([{ id: 'a', value: 'kept' }]);
});

test('concurrent handler and SDK store initialization shares the WASM loader', async () => {
  const handler = makeStore();
  const sdk = new SQLiteStore();
  try {
    await Promise.all([handler.init(), handler.init(), sdk.init((db) => { db.run(SCHEMA[0]!); })]);
    handler.run('INSERT INTO probe VALUES (?, ?)', ['handler', 'ready']);
    sdk.run('INSERT INTO probe VALUES (?, ?)', ['sdk', 'ready']);
    expect(handler.get<{ value: string }>('SELECT value FROM probe')).toEqual({ value: 'ready' });
    expect(sdk.exec('SELECT value FROM probe')[0]?.values).toEqual([['ready']]);
  } finally { sdk.close(); }
});
