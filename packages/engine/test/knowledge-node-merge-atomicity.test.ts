import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeNodeActivationHeldError } from '../sdk/src/platform/knowledge/activation/types.js';
import { createKnowledgeNodeOperatorMutation, KnowledgeNodeMutationHeldError } from '../sdk/src/platform/knowledge/store-node-authority.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { useFailureReadings } from './_helpers/failure-readings.js';

const readings = useFailureReadings([]);
const roots: string[] = [];
const stores: SQLiteStore[] = [];
afterEach(() => {
  for (const sqlite of stores.splice(0)) sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sqliteFor(store: KnowledgeStore): SQLiteStore {
  return (store as unknown as { sqlite: SQLiteStore }).sqlite;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-merge-atomicity-'));
  roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  const open = async () => {
    const store = new KnowledgeStore({ dbPath });
    stores.push(sqliteFor(store));
    await store.init();
    return store;
  };
  const store = await open();
  for (const id of ['loser', 'winner', 'other']) {
    await store.upsertNode({ id, kind: 'topic', slug: id, title: id, status: 'draft', metadata: { origin: 'untrusted producer' } });
  }
  await store.upsertEdge({ fromKind: 'node', fromId: 'loser', toKind: 'node', toId: 'other', relation: 'references', metadata: { original: true } });
  return { store, sqlite: sqliteFor(store), dbPath, open };
}

function snapshot(store: KnowledgeStore) {
  const nodes = store.listNodes().sort((a, b) => a.id.localeCompare(b.id));
  return {
    nodes,
    edges: store.listEdges().sort((a, b) => a.id.localeCompare(b.id)),
    revisions: nodes.map((node) => [node.id, store.listNodeRevisions(node.id)]),
  };
}

describe('knowledge merge authority and atomicity', () => {
  for (const action of ['accept', 'reject'] as const) {
    test(`operator ${action} holds before any graph, node or revision write`, async () => {
      const { store, sqlite, dbPath, open } = await fixture();
      const loser = store.getNode('loser')!;
      await store.upsertNode(loser, createKnowledgeNodeOperatorMutation(loser, { action, reviewer: 'operator' }));
      const before = snapshot(store);
      const bytes = readFileSync(dbPath);
      const writes = spyOn(sqlite, 'run');
      const saves = spyOn(sqlite, 'save');
      try {
        await expect(store.mergeNodes('loser', 'winner')).rejects.toBeInstanceOf(KnowledgeNodeMutationHeldError);
        expect(writes).not.toHaveBeenCalled();
        expect(saves).not.toHaveBeenCalled();
      } finally { writes.mockRestore(); saves.mockRestore(); }
      expect(snapshot(store)).toEqual(before);
      expect(readFileSync(dbPath)).toEqual(bytes);
      expect(snapshot(await open())).toEqual(before);
      expect(readings.requests).toHaveLength(0);
    });
  }

  for (const failure of ['marker', 'node', 'revision'] as const) {
    test(`SQLite ${failure} rejection rolls back earlier edge changes and preserves all caches`, async () => {
      const { store, sqlite, dbPath, open } = await fixture();
      const target = failure === 'marker' ? 'knowledge_edges' : failure === 'node' ? 'knowledge_nodes' : 'knowledge_node_revisions';
      const condition = failure === 'marker' ? "NEW.relation = 'merged_into'" : "NEW.status = 'stale'";
      sqlite.run(`CREATE TRIGGER reject_merge BEFORE INSERT ON ${target} WHEN ${condition}
        BEGIN SELECT RAISE(ABORT, 'merge write rejected'); END`);
      await sqlite.save();
      const before = snapshot(store);
      const bytes = readFileSync(dbPath);
      await expect(store.mergeNodes('loser', 'winner')).rejects.toThrow('merge write rejected');
      expect(snapshot(store)).toEqual(before);
      expect(readFileSync(dbPath)).toEqual(bytes);
      expect(snapshot(await open())).toEqual(before);
      // A later unrelated save must not reveal mutations hidden in SQL memory.
      await sqlite.save();
      expect(snapshot(await open())).toEqual(before);
      sqlite.run('DROP TRIGGER reject_merge');
      expect(await store.mergeNodes('loser', 'winner')).toEqual({ merged: true, repointedEdges: 1 });
      expect((await open()).getNode('loser')!.status).toBe('stale');
    });
  }

  test('valid merge deduplicates edges, drops self-loops and preserves winner authority', async () => {
    const { store, sqlite, dbPath, open } = await fixture();
    const winner = store.getNode('winner')!;
    const reviewedWinner = await store.upsertNode(winner, createKnowledgeNodeOperatorMutation(winner, { action: 'accept', reviewer: 'operator' }));
    const duplicate = await store.upsertEdge({ fromKind: 'node', fromId: 'winner', toKind: 'node', toId: 'other', relation: 'references', weight: 4, metadata: { winnerEdge: true } });
    await store.upsertEdge({ fromKind: 'node', fromId: 'other', toKind: 'node', toId: 'loser', relation: 'mentions' });
    await store.upsertEdge({ fromKind: 'node', fromId: 'loser', toKind: 'node', toId: 'winner', relation: 'references' });
    await store.upsertEdge({ fromKind: 'node', fromId: 'loser', toKind: 'node', toId: 'loser', relation: 'references' });
    await store.upsertEdge({ fromKind: 'source', fromId: 'winner', toKind: 'node', toId: 'loser', relation: 'supports' });
    const before = snapshot(store);
    const bytes = readFileSync(dbPath);
    const run = sqlite.run.bind(sqlite);
    let sqlWrites = 0;
    const observe = spyOn(sqlite, 'run').mockImplementation((sql, params) => {
      run(sql, params);
      // SQL writes cannot expose a partially repointed in-memory graph.
      expect(snapshot(store)).toEqual(before);
      expect(readFileSync(dbPath)).toEqual(bytes);
      sqlWrites += 1;
    });
    try {
      expect(await store.mergeNodes('loser', 'winner')).toEqual({ merged: true, repointedEdges: 3 });
    } finally { observe.mockRestore(); }
    expect(sqlWrites).toBeGreaterThan(4);
    const edges = store.listEdges();
    expect(edges).toHaveLength(4);
    expect(edges.find((edge) => edge.id === duplicate.id)).toMatchObject({
      fromId: 'winner', toId: 'other', weight: 1, createdAt: duplicate.createdAt,
      metadata: { winnerEdge: true, original: true, repointedFromNodeId: 'loser' },
    });
    expect(edges.some((edge) => edge.fromKind === 'source' && edge.fromId === 'winner' && edge.toId === 'winner')).toBe(true);
    expect(edges.filter((edge) => edge.relation === 'merged_into')).toHaveLength(1);
    expect(edges.some((edge) => edge.fromKind === edge.toKind && edge.fromId === edge.toId)).toBe(false);
    expect(store.getNode('winner')).toBe(reviewedWinner);
    expect(store.getNode('loser')).toMatchObject({ status: 'stale', metadata: { mergedInto: 'winner', origin: 'untrusted producer' } });
    expect(store.getNode('loser')!.metadata.review).toBeUndefined();
    expect(store.getNode('loser')!.metadata.reviewProvenance).toMatchObject({ state: 'explicit' });
    expect(store.listNodeRevisions('loser').map((revision) => revision.status)).toEqual(['draft', 'stale']);
    expect(snapshot(await open())).toEqual(snapshot(store));
    const merged = snapshot(store);
    const mergedBytes = readFileSync(dbPath);
    expect(await store.mergeNodes('loser', 'winner')).toEqual({ merged: true, repointedEdges: 0 });
    expect(snapshot(store)).toEqual(merged);
    expect(readFileSync(dbPath)).toEqual(mergedBytes);
    expect(readings.requests).toHaveLength(0);
  });

  test('partial field review survives a permitted structural merge without becoming full approval', async () => {
    const { store, open } = await fixture();
    const loser = store.getNode('loser')!;
    const corrected = await store.upsertNode({ ...loser, title: 'Corrected title' }, createKnowledgeNodeOperatorMutation(loser, {
      action: 'revise', reviewer: 'operator', fieldCorrections: [{ path: ['title'], value: 'Corrected title' }],
    }));
    await store.mergeNodes('loser', 'winner');
    const merged = store.getNode('loser')!;
    expect(merged.title).toBe('Corrected title');
    expect(merged.metadata.review).toEqual(corrected.metadata.review);
    expect(merged.metadata.review).toMatchObject({ scope: 'fields' });
    expect(merged.metadata.reviewProvenance).toMatchObject({ state: 'explicit' });
    await expect(store.upsertNode({ ...merged, title: 'Producer overwrites correction' })).rejects.toBeInstanceOf(KnowledgeNodeMutationHeldError);
    expect((await open()).getNode('loser')).toEqual(merged);
  });

  for (const concurrent of ['loser-review', 'winner-review', 'edge'] as const) {
    test(`a concurrent ${concurrent} survives a stale merge rejection`, async () => {
      const { store, open } = await fixture();
      const prepare = store.prepareNodeWrites.bind(store);
      let afterConcurrent: ReturnType<typeof snapshot> | undefined;
      const race = spyOn(store, 'prepareNodeWrites').mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        if (concurrent === 'edge') {
          await store.upsertEdge({ fromKind: 'node', fromId: 'other', toKind: 'node', toId: 'loser', relation: 'new-edge' });
        } else {
          const node = store.getNode(concurrent === 'loser-review' ? 'loser' : 'winner')!;
          await store.upsertNode(node, createKnowledgeNodeOperatorMutation(node, { action: 'accept', reviewer: 'concurrent operator' }));
        }
        afterConcurrent = snapshot(store);
        return prepared;
      });
      try {
        await expect(store.mergeNodes('loser', 'winner')).rejects.toBeInstanceOf(KnowledgeNodeActivationHeldError);
      } finally { race.mockRestore(); }
      expect(afterConcurrent).toBeDefined();
      expect(snapshot(store)).toEqual(afterConcurrent!);
      expect(snapshot(await open())).toEqual(afterConcurrent!);
    });
  }

  test('outer save batches retain successful work when a merge is rejected', async () => {
    const { store, sqlite, open } = await fixture();
    sqlite.run("CREATE TRIGGER reject_merge BEFORE INSERT ON knowledge_edges WHEN NEW.relation = 'merged_into' BEGIN SELECT RAISE(ABORT, 'merge write rejected'); END");
    const before = snapshot(store);
    await store.batch(async () => {
      await store.upsertSource({ id: 'unrelated', connectorId: 'manual', sourceType: 'manual', status: 'indexed', title: 'Unrelated successful work' });
      await expect(store.mergeNodes('loser', 'winner')).rejects.toThrow('merge write rejected');
    });
    const reopened = await open();
    expect(snapshot(store)).toEqual(before);
    expect(snapshot(reopened)).toEqual(before);
    expect(reopened.getSource('unrelated')?.title).toBe('Unrelated successful work');
  });

  test('missing nodes and self-merges are no-ops', async () => {
    const { store, dbPath, open } = await fixture();
    const before = snapshot(store);
    const bytes = readFileSync(dbPath);
    for (const [loser, winner] of [['loser', 'loser'], ['absent', 'winner'], ['loser', 'absent']] as const) {
      expect(await store.mergeNodes(loser, winner)).toEqual({ merged: false, repointedEdges: 0 });
    }
    expect(snapshot(store)).toEqual(before);
    expect(readFileSync(dbPath)).toEqual(bytes);
    expect(snapshot(await open())).toEqual(before);
  });
});
