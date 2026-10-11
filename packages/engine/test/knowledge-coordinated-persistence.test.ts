import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { SQLiteStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'knowledge-coordinated-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
const source = (id: string) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const });
const job = (id: string) => ({ id, jobId: 'fixture-job', status: 'completed' as const, mode: 'inline' as const });
async function open(file: string) { const store = new KnowledgeStore({ dbPath: file }); await store.init(); return store; }

test('ordinary stale source and other-table saves refuse to replace a newer whole image', async () => {
  const file = path();
  const first = await open(file); await first.upsertSource(source('original'));
  const second = await open(file);
  await second.upsertJobRun(job('other-owner'));
  const bytes = readFileSync(file);
  await expect(first.upsertSource(source('stale-write'))).rejects.toThrow('persisted state changed');
  expect(readFileSync(file)).toEqual(bytes);
  // The failed save is retained locally, not silently dropped by a guarded refresh.
  expect(first.getSource('stale-write')).not.toBeNull();
  expect(await first.upsertSourceIfCurrent(source('conditional'), null)).toMatchObject({ kind: 'held', reason: 'pending-local-changes' });
  expect(readFileSync(file)).toEqual(bytes);
  const third = await open(file);
  expect(third.getJobRun('other-owner')).not.toBeNull();
  expect(third.getSource('stale-write')).toBeNull();
});

test('overlapping saves on one handle publish in admission order without dropping later rows', async () => {
  const file = path(); const store = await open(file);
  const results = await Promise.all([store.upsertSource(source('first')), store.upsertJobRun(job('middle')), store.upsertSource(source('last'))]);
  expect(results.map(record => record.id)).toEqual(['first', 'middle', 'last']);
  const reopened = await open(file);
  expect(reopened.listSources().map(record => record.id).sort()).toEqual(['first', 'last']);
  expect(reopened.getJobRun('middle')).not.toBeNull();
  expect(await store.upsertSourceIfCurrent(source('after-queue'), null)).toMatchObject({ kind: 'written' });
});

test('an unchanged save queued behind fresh-image adoption cannot restore the earlier image', async () => {
  const file = path();
  const store = new SQLiteStore(file, { coordinated: true });
  const schema = (db: { run(sql: string): void }) => db.run('CREATE TABLE IF NOT EXISTS fixture (value TEXT)');
  await store.init(schema); store.run("INSERT INTO fixture VALUES ('original')"); await store.save();
  const release = await acquireCrossProcessLock(`${file}.knowledge-lock`);
  const guarded = store.transactPersisted(db => { db.run("UPDATE fixture SET value = 'guarded'"); return { changed: true, value: 'written' }; }, () => {});
  const queuedSave = store.save();
  // Attach rejection handling before releasing either queued operation.
  const settledSave = queuedSave.then(() => ({ kind: 'written' }), (error: unknown) => ({ kind: 'error', error }));
  release();
  expect(await guarded).toEqual({ kind: 'completed', value: 'written' });
  const saveOutcome = await settledSave;
  const reopened = new SQLiteStore(file); await reopened.init(schema);
  expect(reopened.exec('SELECT value FROM fixture')[0]?.values).toEqual([['guarded']]);
  expect(saveOutcome).toMatchObject({ kind: 'error', error: { message: 'SQLiteStore: persisted state changed; captured image was superseded' } });
  store.close(); reopened.close();
});

test('a stale batch preserves current disk and keeps its pending local records on failure', async () => {
  const file = path(); const first = await open(file); await first.upsertSource(source('original'));
  const second = await open(file);
  let bytes: Buffer<ArrayBuffer> | undefined;
  await expect(first.batch(async () => {
    await first.upsertJobRun(job('pending-local'));
    await second.upsertSource(source('other-owner'));
    bytes = readFileSync(file);
  })).rejects.toThrow('persisted state changed');
  expect(readFileSync(file)).toEqual(bytes!);
  expect(first.getJobRun('pending-local')).not.toBeNull();
  const reopened = await open(file);
  expect(reopened.getSource('other-owner')).not.toBeNull();
  expect(reopened.getJobRun('pending-local')).toBeNull();
});

test('persisted snapshot reads observe a new owner without replacing a pending local image', async () => {
  const file = path(); const first = await open(file); await first.upsertSource(source('original'));
  const second = await open(file);
  const oldGeneration = first.getSourceGeneration('original');
  await second.upsertSource({ ...source('original'), title: 'new owner' });
  expect(first.getSourceSnapshot({ id: 'original' }).source?.title).toBe('new owner');
  expect(first.getSourceGeneration('original')).not.toBe(oldGeneration);
  expect(first.getSource('original')?.title).toBeUndefined();
});

test('directory and database symlink aliases coordinate the same persisted file', async () => {
  const file = path(); const first = await open(file); await first.upsertSource(source('original'));
  const alias = `${file}.alias`; symlinkSync(file, alias);
  const second = await open(alias);
  const directoryAlias = join(dirname(file), 'directory-alias'); symlinkSync(dirname(file), directoryAlias, 'dir');
  const third = await open(join(directoryAlias, 'knowledge.sqlite'));
  const outcomes = await Promise.all([first.upsertSourceIfCurrent(source('contended'), null), second.upsertSourceIfCurrent(source('contended'), null), third.upsertSourceIfCurrent(source('contended'), null)]);
  expect(outcomes.map(result => result.kind).sort()).toEqual(['held', 'held', 'written']);
  expect((await open(file)).getSource('contended')).not.toBeNull();
  expect(readFileSync(alias)).toEqual(readFileSync(file));
});

test('a dangling database symlink and its missing target share one first-write identity', async () => {
  const file = path(); const alias = `${file}.alias`; symlinkSync(file, alias);
  const linked = await open(alias); const direct = await open(file);
  const results = await Promise.all([
    linked.upsertSourceIfCurrent({ ...source('first-write'), metadata: { owner: 'alias' } }, null),
    direct.upsertSourceIfCurrent({ ...source('first-write'), metadata: { owner: 'direct' } }, null),
  ]);
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(results.map(result => result.kind).sort()).toEqual(['held', 'written']);
  expect(readFileSync(alias)).toEqual(readFileSync(file));
  expect((await open(file)).getSource('first-write')?.metadata.owner).toBe('alias');
});

test('relative chained aliases preserve both links and share the missing target on first write', async () => {
  const file = path(); const firstAlias = join(dirname(file), 'first-alias'); const secondAlias = join(dirname(file), 'second-alias');
  symlinkSync('second-alias', firstAlias); symlinkSync('knowledge.sqlite', secondAlias);
  const first = await open(firstAlias); const second = await open(secondAlias); const direct = await open(file);
  const results = await Promise.all([
    first.upsertSourceIfCurrent({ ...source('chain-first-write'), metadata: { owner: 'chain' } }, null),
    second.upsertSourceIfCurrent(source('chain-first-write'), null),
    direct.upsertSourceIfCurrent(source('chain-first-write'), null),
  ]);
  expect(results.map(result => result.kind).sort()).toEqual(['held', 'held', 'written']);
  expect(readlinkSync(firstAlias)).toBe('second-alias');
  expect(readlinkSync(secondAlias)).toBe('knowledge.sqlite');
  expect(readFileSync(firstAlias)).toEqual(readFileSync(file));
  expect(readFileSync(secondAlias)).toEqual(readFileSync(file));
  expect(first.getSourceSnapshot({ id: 'chain-first-write' }).source?.metadata.owner).toBe('chain');
  expect(direct.getSourceSnapshot({ id: 'chain-first-write' }).source?.metadata.owner).toBe('chain');
});

test('a symlink cycle is refused without replacing links or creating lock/database files', async () => {
  const file = path(); const firstAlias = join(dirname(file), 'first-alias'); const secondAlias = join(dirname(file), 'second-alias');
  symlinkSync('second-alias', firstAlias); symlinkSync('first-alias', secondAlias);
  const before = readdirSync(dirname(file)).sort();
  const store = new KnowledgeStore({ dbPath: firstAlias });
  const result = await store.init().then(() => null, (error: unknown) => error);
  expect(result).toMatchObject({ code: 'ELOOP' });
  expect(store.isReady).toBe(false);
  expect(readdirSync(dirname(file)).sort()).toEqual(before);
  expect(readlinkSync(firstAlias)).toBe('second-alias');
  expect(readlinkSync(secondAlias)).toBe('first-alias');
});

test('an unresolved target directory fails without falling back to replacing its alias', async () => {
  const file = path(); const alias = join(dirname(file), 'unresolved-alias');
  symlinkSync('missing-directory/knowledge.sqlite', alias);
  const before = readdirSync(dirname(file)).sort();
  const store = new KnowledgeStore({ dbPath: alias });
  const result = await store.init().then(() => null, (error: unknown) => error);
  expect(result).toMatchObject({ code: 'ENOENT' });
  expect(store.isReady).toBe(false);
  expect(readdirSync(dirname(file)).sort()).toEqual(before);
  expect(readlinkSync(alias)).toBe('missing-directory/knowledge.sqlite');
  expect(existsSync(join(dirname(file), 'missing-directory'))).toBe(false);
});

test('hardlinked aliases are refused before a coordinated store can replace one name', async () => {
  const file = path(); const first = await open(file); await first.upsertSource(source('original'));
  linkSync(file, `${file}.hardlink`);
  const bytes = readFileSync(file);
  await expect(first.upsertSource(source('replacement'))).rejects.toThrow('unsupported coordinated file identity');
  expect(readFileSync(file)).toEqual(bytes);
});

test('initialization and a held creation do not create a database or publish schema bytes', async () => {
  const file = path(); const store = await open(file);
  expect(existsSync(file)).toBe(false);
  expect(await store.upsertSourceIfCurrent(source('missing'), 'a'.repeat(64))).toMatchObject({ kind: 'held', reason: 'source-changed' });
  expect(existsSync(file)).toBe(false);
});

test('concurrent KnowledgeStore initialization coordinates an existing schema migration', async () => {
  const file = path(); const legacy = new SQLiteStore(file);
  await legacy.init(createSchema, { schemaVersion: 0 }); await legacy.save(); legacy.close();
  const [first, second] = await Promise.all([open(file), open(file)]);
  expect(first.isReady && second.isReady).toBe(true);
  const results = await Promise.all([first.upsertSourceIfCurrent(source('after-migration'), null), second.upsertSourceIfCurrent(source('after-migration'), null)]);
  expect(results.map(result => result.kind).sort()).toEqual(['held', 'written']);
  expect((await open(file)).getSource('after-migration')).not.toBeNull();
});

test('initialization persists settled-run retention before the first guarded source action', async () => {
  const file = path(); const seed = await open(file);
  await seed.batch(async () => {
    for (let index = 0; index < 501; index++) await seed.upsertJobRun({ ...job(`retained-${index}`), status: 'running' });
  });
  // Model an older file containing an over-cap settled history; current normal
  // upserts already prune their own completed records.
  const legacy = new SQLiteStore(file); await legacy.init(createSchema, { schemaVersion: 9 });
  legacy.run("UPDATE knowledge_job_runs SET status = 'completed'"); await legacy.save(); legacy.close();
  const reopened = await open(file);
  expect(reopened.listJobRuns(1000)).toHaveLength(500);
  expect(await reopened.upsertSourceIfCurrent(source('first-guarded'), null)).toMatchObject({ kind: 'written' });
  const disk = new SQLiteStore(file); await disk.init(createSchema, { schemaVersion: 9 });
  expect(disk.exec('SELECT COUNT(*) FROM knowledge_job_runs')[0]?.values).toEqual([[500]]);
  disk.close();
  expect((await open(file)).getSource('first-guarded')).not.toBeNull();
});

test('an initialization retention conflict refuses stale persistence and a retry reloads the winning owner', async () => {
  const file = path(); const seed = await open(file);
  await seed.batch(async () => {
    for (let index = 0; index < 501; index++) await seed.upsertJobRun({ ...job(`retained-${index}`), status: 'running' });
  });
  const writer = new SQLiteStore(file, { coordinated: true }); await writer.init(createSchema, { schemaVersion: 9 });
  writer.run("UPDATE knowledge_job_runs SET status = 'completed'"); await writer.save();
  const release = await acquireCrossProcessLock(`${file}.knowledge-lock`);
  const target = new KnowledgeStore({ dbPath: file });
  const initialization = target.init().then(() => ({ kind: 'ready' }), (error: unknown) => ({ kind: 'error', error }));
  // Drain initialization's already-loaded WASM promise. The held file lock
  // keeps it queued before the ordinary writer and its later retention save.
  await new Promise<void>(resolve => setImmediate(resolve));
  writer.run('UPDATE knowledge_job_runs SET result = ? WHERE id = ?', [JSON.stringify({ owner: 'winner' }), 'retained-500']);
  const saved = writer.save();
  release();
  await saved;
  const winningBytes = readFileSync(file);
  expect(await initialization).toMatchObject({ kind: 'error', error: { message: 'SQLiteStore: persisted state changed; pending local changes were not saved' } });
  expect(target.isReady).toBe(false);
  expect(readFileSync(file)).toEqual(winningBytes);
  await target.init();
  expect(target.getJobRun('retained-500')?.result).toEqual({ owner: 'winner' });
  expect(await target.upsertSourceIfCurrent(source('after-retry'), null)).toMatchObject({ kind: 'written' });
  const reopened = await open(file);
  expect(reopened.getJobRun('retained-500')?.result).toEqual({ owner: 'winner' });
  expect(reopened.getSource('after-retry')).not.toBeNull();
  writer.close();
});

test('a failed coordinated migration restores the original bytes while it owns the file', async () => {
  const file = path(); const legacy = new SQLiteStore(file);
  await legacy.init(createSchema, { schemaVersion: 0 }); await legacy.save(); legacy.close();
  const original = readFileSync(file);
  const failing = new SQLiteStore(file, { coordinated: true });
  await expect(failing.init(createSchema, { schemaVersion: 1, migrations: [{ toVersion: 1, migrate(db) { db.run('DROP TABLE knowledge_sources'); throw new Error('fixture migration refused'); } }] })).rejects.toThrow('fixture migration refused');
  expect(readFileSync(file)).toEqual(original);
  const reopened = await open(file);
  expect(await reopened.upsertSourceIfCurrent(source('after-failure'), null)).toMatchObject({ kind: 'written' });
});

test('unrelated SQLiteStore callers keep the existing default save behavior', async () => {
  const file = path(); const schema = (db: { run(sql: string): void }) => db.run('CREATE TABLE IF NOT EXISTS fixture (value TEXT)');
  const first = new SQLiteStore(file); await first.init(schema); await first.save();
  const second = new SQLiteStore(file); await second.init(schema);
  first.run("INSERT INTO fixture VALUES ('first')"); await first.save();
  second.run("INSERT INTO fixture VALUES ('second')"); await second.save();
  const third = new SQLiteStore(file); await third.init(schema);
  expect(third.exec('SELECT value FROM fixture')[0]?.values).toEqual([['second']]);
  first.close(); second.close(); third.close();
});

test('default in-memory subclasses retain their existing batch save lifecycle', async () => {
  class RecordingStore extends SQLiteStore {
    calls = 0;
    override save() { this.calls += 1; return super.save(); }
  }
  const store = new RecordingStore(':memory:');
  await store.init(db => db.run('CREATE TABLE IF NOT EXISTS fixture (value TEXT)'));
  await store.batch(async () => { await store.save(); });
  expect(store.calls).toBe(1);
  store.close();
});

test('a concurrent ordinary process writer cannot undo a successful guarded process write', async () => {
  const file = path(); const seed = await open(file); await seed.upsertSource(source('original'));
  const script = `
    import { KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
    const store = new KnowledgeStore({ dbPath: process.argv[1] }); await store.init();
    console.log('ready'); await Bun.stdin.text();
    let result;
    if (process.argv[2] === 'ordinary') {
      try { await store.upsertJobRun({ id: 'ordinary-job', jobId: 'fixture', status: 'completed', mode: 'inline' }); result = 'written'; }
      catch (error) { if (!String(error.message).startsWith('SQLiteStore: persisted state changed;')) throw error; result = 'conflict'; }
    } else {
      result = (await store.upsertSourceIfCurrent({ id: 'guarded-source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' }, null)).kind;
    }
    console.log(result);
  `;
  const children = ['ordinary', 'guarded'].map(mode => Bun.spawn([
    process.execPath, '--no-env-file', '--preload', new URL('../scripts/test-network-preload.ts', import.meta.url).pathname, '-e', script, file, mode,
  ], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  const readers = children.map(child => child.stdout.getReader());
  const deadline = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill(); }, 12000);
  try {
    await Promise.all(readers.map(async reader => {
      let line = '';
      while (!line.includes('\n')) { const chunk = await reader.read(); if (chunk.done) break; line += new TextDecoder().decode(chunk.value); }
      expect(line.trim()).toBe('ready');
    }));
    for (const child of children) { child.stdin.write('go'); child.stdin.end(); }
    const outcomes = await Promise.all(children.map(async (child, index) => {
      const output = async () => { let text = ''; for (;;) { const chunk = await readers[index]!.read(); if (chunk.done) return text.trim(); text += new TextDecoder().decode(chunk.value); } };
      const [exit, result, error] = await Promise.all([child.exited, output(), new Response(child.stderr).text()]);
      expect({ exit, error }).toEqual({ exit: 0, error: '' });
      return result;
    }));
    expect(['written', 'conflict']).toContain(outcomes[0]!);
    expect(outcomes[1]).toBe('written');
    const reopened = await open(file);
    expect(reopened.getSource('guarded-source')).not.toBeNull();
    expect(reopened.getSource('original')).not.toBeNull();
    expect(reopened.getJobRun('ordinary-job') !== null).toBe(outcomes[0] === 'written');
  } finally {
    clearTimeout(deadline);
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(children.map(child => child.exited));
    for (const reader of readers) reader.releaseLock();
  }
}, 20000);
