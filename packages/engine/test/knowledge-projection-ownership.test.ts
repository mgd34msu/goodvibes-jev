import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { materializeGeneratedKnowledgeProjection, type GeneratedKnowledgeProjectionInput } from '../sdk/src/platform/knowledge/generated-projections.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-projection-owner-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const raw = { id: 'device', kind: 'ha_device' as const, slug: 'device', title: 'Device', status: 'active' as const, metadata: { knowledgeSpaceId: 'test' } };
  const target = await upsertObservedKnowledgeNode(store, raw, 'home-assistant-snapshot', raw, () => raw);
  const input: GeneratedKnowledgeProjectionInput = { store, artifactStore, connectorId: 'generated', sourceId: 'generated-page',
    title: 'Device page', filename: 'device.md', markdown: '# Device\nOriginal fact.', canonicalUri: 'knowledge://generated/device',
    projectionKind: 'test', target: { kind: 'node', id: target.id }, assertCurrent: () => {} };
  const first = await materializeGeneratedKnowledgeProjection(input);
  return { store, artifactStore, target, input, first };
}
describe('generated page original output ownership', () => {
  test('ordinary guarded success and exact-content artifact reuse retain coherent receipts', async () => {
    const item = await fixture();
    expect(item.store.getSource(item.first.source.id)).toBe(item.first.source);
    expect(item.first.source.artifactId).toBe(item.first.artifact.id);
    const next = await materializeGeneratedKnowledgeProjection(item.input);
    expect(next.artifactCreated).toBe(false); expect(next.artifact.id).toBe(item.first.artifact.id);
    expect(item.store.getSource(next.source.id)).toBe(next.source);
  });
  test('a newer generated source or edge during artifact creation survives stale publication unchanged', async () => {
    for (const change of ['source', 'edge', 'target'] as const) {
      const item = await fixture(); const original = item.artifactStore.create.bind(item.artifactStore);
      let external: unknown;
      const create = spyOn(item.artifactStore, 'create').mockImplementation(async (...args) => {
        const artifact = await original(...args);
        if (change === 'source') { await item.store.replaceSourceRecord({ ...item.first.source, title: 'Newer writer' }); external = item.store.getSource(item.first.source.id); }
        if (change === 'edge') external = await item.store.upsertEdge({ ...item.first.linked!, metadata: { writer: 'newer' } });
        if (change === 'target') { const raw = { ...item.target, title: 'Newer device' }; external = await upsertObservedKnowledgeNode(item.store, raw, 'home-assistant-snapshot', raw, () => raw); }
        return artifact;
      });
      try { await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nNew fact.' })).rejects.toThrow(); }
      finally { create.mockRestore(); }
      if (change === 'source') expect(external).toBe(item.store.getSource(item.first.source.id));
      if (change === 'edge') expect(external).toBe(item.store.listEdges().find((edge) => edge.id === item.first.linked!.id));
      if (change === 'target') expect(external).toBe(item.store.getNode(item.target.id));
      expect(item.artifactStore.list().map((artifact) => artifact.id)).toEqual([item.first.artifact.id]);
    }
  });
  test('precommit owner retirement preserves published page and cleans only the unreferenced candidate artifact', async () => {
    const item = await fixture(); let live = true; const original = item.store.applyPreparedIngest.bind(item.store);
    const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => { live = false; return original(...args); });
    try { await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nReplacement.', assertCurrent: () => { if (!live) throw new Error('retired'); } })).rejects.toThrow(); }
    finally { ingest.mockRestore(); }
    expect(item.store.getSource(item.first.source.id)).toBe(item.first.source);
    expect(item.store.listEdges().find((edge) => edge.id === item.first.linked!.id)).toBe(item.first.linked);
    expect(item.artifactStore.list().map((artifact) => artifact.id)).toEqual([item.first.artifact.id]);
  });
  test('successful atomic commit followed by late retirement stays committed with referenced artifact and stale outcome', async () => {
    const item = await fixture(); const controller = new AbortController(); const original = item.store.applyPreparedIngest.bind(item.store);
    const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => { const receipt = await original(...args); controller.abort(); return receipt; });
    try { await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nCommitted replacement.', signal: controller.signal })).rejects.toThrow(); }
    finally { ingest.mockRestore(); }
    const committed = item.store.getSource(item.first.source.id)!;
    expect(committed).not.toBe(item.first.source);
    expect(item.artifactStore.get(committed.artifactId!)).not.toBeNull();
    expect(item.store.listEdges().some((edge) => edge.fromId === committed.id && edge.toId === item.target.id)).toBe(true);
  });
  test('postcommit replacement is never returned as this operation receipt or overwritten by compensation', async () => {
    const item = await fixture(); const original = item.store.applyPreparedIngest.bind(item.store); let newer: unknown;
    const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
      const receipt = await original(...args);
      const own = receipt.sources[0]!;
      await item.store.replaceSourceRecord({ ...own, title: 'Concurrent owner after commit' }); newer = item.store.getSource(own.id);
      return receipt;
    });
    try { await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nOwn candidate.' })).rejects.toThrow(); }
    finally { ingest.mockRestore(); }
    expect(newer).toBe(item.store.getSource(item.first.source.id));
    expect(item.artifactStore.get(item.store.getSource(item.first.source.id)!.artifactId!)).not.toBeNull();
  });
  test('replacing a page never deletes an old generated artifact still referenced by another source', async () => {
    const item = await fixture();
    await item.store.upsertSource({ id: 'another-page', connectorId: 'generated', sourceType: 'document', artifactId: item.first.artifact.id, status: 'indexed' });
    const next = await materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nA revised fact.' });
    expect(next.artifact.id).not.toBe(item.first.artifact.id);
    expect(item.artifactStore.get(item.first.artifact.id)).not.toBeNull();
  });
});

test('authority removal cannot downgrade a guarded hold into legacy compensation', async () => {
  const item = await fixture();
  const input = { ...item.input, markdown: '# New projection' };
  const original = item.artifactStore.create.bind(item.artifactStore); let newer: unknown;
  const create = spyOn(item.artifactStore, 'create').mockImplementation(async (...args) => {
    const artifact = await original(...args);
    await item.store.replaceSourceRecord({ ...item.first.source, title: 'New owner while awaiting artifact' });
    newer = item.store.getSource(item.first.source.id);
    input.assertCurrent = undefined;
    return artifact;
  });
  try { await expect(materializeGeneratedKnowledgeProjection(input)).rejects.toThrow(); }
  finally { create.mockRestore(); }
  expect(newer).toBe(item.store.getSource(item.first.source.id));
  expect(item.artifactStore.get(item.first.artifact.id)).not.toBeNull();
});

test('store replacement after commit cannot delete the original stores referenced artifact', async () => {
  const item = await fixture(); const other = await fixture();
  const input = { ...item.input, markdown: '# Newly committed projection' };
  const original = item.store.applyPreparedIngest.bind(item.store);
  const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
    const receipt = await original(...args); input.store = other.store; return receipt;
  });
  try { await expect(materializeGeneratedKnowledgeProjection(input)).rejects.toThrow(); }
  finally { ingest.mockRestore(); }
  const committed = item.store.getSource(item.first.source.id)!;
  expect(item.artifactStore.get(committed.artifactId!)).not.toBeNull();
});
