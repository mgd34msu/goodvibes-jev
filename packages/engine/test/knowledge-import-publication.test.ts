import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { KnowledgeImportInput } from '../sdk/src/platform/knowledge/store-import.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import type { SQLitePublicationIO, SQLiteStorePersistence } from '../sdk/src/platform/state/sqlite-store-persistence.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sqliteOf = (store: KnowledgeStore) => (store as unknown as { sqlite: SQLiteStore }).sqlite;
const persistenceOf = (store: KnowledgeStore) => (sqliteOf(store) as unknown as { persistence: SQLiteStorePersistence }).persistence;
const source = (id: string) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const });
async function open(dbPath: string) {
  const store = new KnowledgeStore({ dbPath }); stores.push(store); await store.init(); return store;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-import-publication-')); roots.push(root);
  const store = await open(join(root, 'knowledge.sqlite'));
  await store.upsertSource({ ...source('unrelated'), title: 'Original unrelated source' });
  return store;
}
const input: KnowledgeImportInput = {
  sources: [{ ...source('generated'), title: 'Generated source', artifactId: 'generated-artifact' }],
  extractions: [{ id: 'generated-extraction', sourceId: 'generated', artifactId: 'generated-artifact', extractorId: 'fixture', format: 'text', excerpt: 'Generated excerpt.' }],
  nodes: [{ id: 'generated-node', kind: 'topic', slug: 'generated-node', title: 'Generated node', status: 'draft', sourceId: 'generated' }],
  edges: [{ fromKind: 'source', fromId: 'generated', toKind: 'node', toId: 'generated-node', relation: 'source_for' }],
  issues: [{ id: 'generated-issue', severity: 'info', code: 'fixture', message: 'Generated issue', nodeId: 'generated-node' }],
};
const graph = async () => ({ nodes: input.nodes, edges: input.edges, issues: input.issues });
function cacheState(store: KnowledgeStore) {
  return { sources: store.listSources(), extractions: store.listExtractions(), nodes: store.listNodes(),
    edges: store.listEdges(), issues: store.listIssues(), revisions: store.listNodeRevisions('generated-node') };
}
function localGeneratedRows(store: KnowledgeStore) {
  const sqlite = sqliteOf(store);
  return ['knowledge_sources', 'knowledge_extractions', 'knowledge_nodes', 'knowledge_edges', 'knowledge_issues', 'knowledge_node_revisions']
    .map(table => sqlite.exec(`SELECT COUNT(*) FROM ${table} WHERE ${table === 'knowledge_edges' ? 'from_id' : table === 'knowledge_node_revisions' ? 'node_id' : 'id'} LIKE 'generated%'`)[0]?.values[0]?.[0]);
}

test('unrelated external winner survives failed import with no published cache, SQL, artifact reference or callback', async () => {
  const store = await fixture(), writer = await open(store.storagePath), before = cacheState(store);
  let committed = 0, winningBytes = readFileSync(store.storagePath);
  await expect(store.applyPreparedIngest(input, async () => {
    await writer.replaceSourceRecord({ ...writer.getSource('unrelated')!, title: 'External correction' });
    winningBytes = readFileSync(store.storagePath);
    return graph();
  }, {}, () => { committed++; })).rejects.toThrow('persisted state changed');
  expect(committed).toBe(0); expect(cacheState(store)).toEqual(before);
  expect(localGeneratedRows(store)).toEqual([0, 0, 0, 0, 0, 0]);
  expect(readFileSync(store.storagePath)).toEqual(winningBytes);
  expect(store.getSourceSnapshot({ id: 'unrelated' }).source?.title).toBe('External correction');
  expect(store.getSourceSnapshot({ id: 'generated' }).source).toBeNull();
  expect(cacheState(await open(store.storagePath)).sources).toEqual(writer.listSources());
});

test('native prepublication rename failure publishes no imported image, caches or callback and cleans its temporary file', async () => {
  const store = await fixture(), before = cacheState(store), bytes = readFileSync(store.storagePath);
  const io = (persistenceOf(store) as unknown as { io: SQLitePublicationIO }).io;
  const rename = io.renameSync;
  const failure = spyOn(io, 'renameSync').mockImplementation((from, to) => {
    if (to === store.storagePath) throw new Error('Synthetic native import rename failure');
    return rename(from, to);
  });
  let committed = 0;
  try { await expect(store.applyPreparedIngest(input, graph, {}, () => { committed++; })).rejects.toThrow('before-publication'); }
  finally { failure.mockRestore(); }
  expect(committed).toBe(0); expect(cacheState(store)).toEqual(before);
  expect(localGeneratedRows(store)).toEqual([0, 0, 0, 0, 0, 0]);
  expect(readFileSync(store.storagePath)).toEqual(bytes);
  expect(readdirSync(dirname(store.storagePath)).filter(name => name.includes('.pending-'))).toEqual([]);
  expect(cacheState(await open(store.storagePath))).toEqual(before);
});

test('a same-handle winner during persistence admission is retained without publishing the superseded import', async () => {
  const store = await fixture(), persistence = persistenceOf(store), lock = persistence.lock.bind(persistence);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  const interception = spyOn(persistence, 'lock').mockImplementationOnce(async () => { entered(); await pause; return lock(); });
  let committed = 0;
  const imported = store.applyPreparedIngest(input, graph, {}, () => { committed++; }).then(() => undefined, (error: unknown) => error);
  try {
    await started;
    const winner = store.upsertSource({ ...source('local-winner'), title: 'Current local writer' });
    await new Promise<void>(resolve => setImmediate(resolve));
    release();
    expect(await imported).toBeInstanceOf(Error);
    await winner;
    expect(committed).toBe(0);
    expect(localGeneratedRows(store)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(store.getSource('local-winner')?.title).toBe('Current local writer');
    const reopened = await open(store.storagePath);
    expect(reopened.getSource('local-winner')?.title).toBe('Current local writer');
    expect(reopened.getSource('generated')).toBeNull();
  } finally { release(); interception.mockRestore(); }
});

test('visible indeterminate publication retains its exact SQL/cache references, withholds callback and fences later writes', async () => {
  const store = await fixture(), io = (persistenceOf(store) as unknown as { io: SQLitePublicationIO }).io;
  const rename = io.renameSync, fsync = io.fsyncSync;
  let renamed = false, committed = 0;
  const renameWatch = spyOn(io, 'renameSync').mockImplementation((from, to) => {
    rename(from, to); if (to === store.storagePath) renamed = true;
  });
  const syncFailure = spyOn(io, 'fsyncSync').mockImplementation(fd => {
    if (renamed) throw new Error('Synthetic import directory sync failure');
    fsync(fd);
  });
  try { await expect(store.applyPreparedIngest(input, graph, {}, () => { committed++; })).rejects.toThrow('indeterminate'); }
  finally { syncFailure.mockRestore(); renameWatch.mockRestore(); }
  expect(committed).toBe(0);
  expect(store.getSource('generated')?.artifactId).toBe('generated-artifact');
  const visible = readFileSync(store.storagePath), reopened = await open(store.storagePath);
  expect(cacheState(store)).toEqual(cacheState(reopened));
  expect(reopened.getSource('generated')?.artifactId).toBe('generated-artifact');
  await expect(store.upsertSource(source('must-not-write'))).rejects.toThrow('cache fenced');
  expect(readFileSync(store.storagePath)).toEqual(visible);
  expect(store.getSource('must-not-write')).toBeNull();
});

test('successful import publishes complete exact records and callback only after real persistence, including a batch prefix', async () => {
  const store = await fixture(); let committed = 0;
  await store.batch(async () => {
    await store.upsertSource(source('batch-prefix'));
    const receipt = await store.applyPreparedIngest(input, graph, {}, () => {
      committed++;
      const rows = sqliteOf(store).readPersistedRow('knowledge_sources', 'id', 'generated')[0];
      expect(rows?.values[0]?.[rows.columns.indexOf('artifact_id')]).toBe('generated-artifact');
      expect(sqliteOf(store).readPersistedRow('knowledge_sources', 'id', 'batch-prefix')[0]?.values).toHaveLength(1);
    });
    const [writtenSource] = receipt.sources, [writtenNode] = receipt.nodes, [writtenEdge] = receipt.edges;
    if (!writtenSource || !writtenNode || !writtenEdge) throw new Error('Complete import receipt must contain the generated source, node and edge.');
    expect(store.getSource('generated')).toBe(writtenSource);
    expect(store.getNode('generated-node')).toBe(writtenNode);
    expect(store.listEdges()[0]).toBe(writtenEdge);
    expect(localGeneratedRows(store)).toEqual([1, 1, 1, 1, 1, 1]);
    await store.upsertSource(source('batch-suffix'));
  });
  expect(committed).toBe(1);
  expect(cacheState(await open(store.storagePath))).toEqual(cacheState(store));
});
