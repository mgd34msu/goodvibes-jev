import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { KnowledgeProjectionService } from '../sdk/src/platform/knowledge/projections.js';
import { KnowledgeService } from '../sdk/src/platform/knowledge/service.js';
import { prepareKnowledgeScopeSelection } from '../sdk/src/platform/knowledge/scope-selection.js';
import { applyKnowledgeMapFilters } from '../sdk/src/platform/knowledge/map-filters.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import type { KnowledgeNodeUpsertInput } from '../sdk/src/platform/knowledge/types.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../sdk/src/platform/state/index.js';

const roots: string[] = [];
const services: KnowledgeService[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-scope-consumers-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const memoryStore = new MemoryStore(undefined, {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }),
    enableVectorIndex: false,
  });
  const service = new KnowledgeService(store, artifactStore, undefined, { memoryRegistry: new MemoryRegistry(memoryStore) });
  services.push(service); await service.whenReady();
  return { root, store, artifactStore, service, projection: new KnowledgeProjectionService(store, artifactStore) };
}

async function corpus(store: KnowledgeStore) {
  const allowed = await store.upsertSource({ id: 'allowed', connectorId: 'synthetic', sourceType: 'document',
    title: 'Home Assistant navigation design', description: 'An authored project design document.', tags: ['project'], status: 'indexed' });
  const rejected = await store.upsertSource({ id: 'rejected', connectorId: 'synthetic', sourceType: 'document',
    title: 'Queue recovery', description: 'Synthetic repository search chrome.', status: 'indexed' });
  for (const source of [allowed, rejected]) await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text',
    summary: `${source.title} body`, excerpt: 'Restore the committed queue before starting the worker.' });
  const input: KnowledgeNodeUpsertInput = { id: 'topic', kind: 'topic', slug: 'topic', title: 'Agent navigation design',
    summary: 'Implementation of ordinary application navigation.', sourceId: allowed.id, status: 'active' };
  const evidence = structuredClone(input);
  const node = await upsertObservedKnowledgeNode(store, input, 'catalog-structure', evidence, () => evidence);
  const issue = await store.upsertIssue({ id: 'issue', severity: 'info', code: 'fixture-note', message: 'Investigate queue replay.', sourceId: allowed.id });
  const visibleEdge = await store.upsertEdge({ fromKind: 'source', fromId: allowed.id, toKind: 'node', toId: node.id, relation: 'describes', metadata: { alpha: true, beta: false, labels: [] } });
  await store.upsertEdge({ fromKind: 'source', fromId: allowed.id, toKind: 'source', toId: rejected.id, relation: 'references' });
  return { allowed, rejected, node, issue, visibleEdge };
}

function readings(probability = 0.99) {
  const fake = fakePort((name, question, state) => {
    if (name === 'included') {
      const candidate = (state as { candidate: { kind: string; content: { title?: string; code?: string } } }).candidate;
      const key = `${candidate.kind}:${candidate.content.title ?? candidate.content.code}`;
      const accepted = new Set(['source:Home Assistant navigation design', 'node:Agent navigation design', 'issue:fixture-note']);
      return noulAnswer(accepted.has(key) ? probability : 0.01);
    }
    if (question.type !== 'noul') throw new Error(`Unexpected scope consumer fixture question: ${name}`);
    // Separate synthetic source-quality admission for generated projection text.
    if (name === 'useful') return noulAnswer(0.99);
    throw new Error(`Unexpected scope consumer fixture question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}

describe('retained canonical scope consumers', () => {
  test('status prepares once and public filters follow contrary semantic readings', async () => {
    const { store, service } = await fixture(); const rows = await corpus(store); const fake = readings();
    const status = await service.getStatus();
    expect([status.sourceCount, status.nodeCount, status.issueCount, status.extractionCount, status.edgeCount]).toEqual([1, 1, 1, 1, 1]);
    expect(fake.requests).toHaveLength(4);
    expect((await service.querySources({ tag: 'project', query: 'committed queue' })).items.map(row => row.id)).toEqual([rows.allowed.id]);
    expect((await service.queryNodes({ kind: 'topic' })).items.map(row => row.id)).toEqual([rows.node.id]);
    expect((await service.queryIssues({ code: 'fixture-note' })).items.map(row => row.id)).toEqual([rows.issue.id]);
    expect((await service.listExtractions()).map(row => row.sourceId)).toEqual([rows.allowed.id]);
    expect(await service.getItemScoped(rows.rejected.id)).toBeNull();
  });

  test('item and map remove rejected linked records and their edges', async () => {
    const { store, service } = await fixture(); const rows = await corpus(store); readings();
    const item = await service.getItemScoped(rows.allowed.id);
    expect(item?.linkedSources.map(row => row.id)).not.toContain(rows.rejected.id);
    expect(item?.linkedNodes.map(row => row.id)).toContain(rows.node.id);
    expect(item?.relatedEdges.map(edge => edge.id)).toEqual([rows.visibleEdge.id]);
    const selection = await prepareKnowledgeScopeSelection(store);
    const filtered = applyKnowledgeMapFilters({ sources: store.listSources(), nodes: store.listNodes(), issues: store.listIssues(), edges: store.listEdges() }, selection);
    expect(filtered.sources.map(row => row.id)).toEqual([rows.allowed.id]);
    expect(filtered.edges.map(edge => edge.id)).toEqual([rows.visibleEdge.id]);
    const withoutEdges = applyKnowledgeMapFilters({ ...filtered, edges: [] }, selection);
    expect(withoutEdges.edges).toEqual([]);
    const changedEdges = applyKnowledgeMapFilters({ ...filtered, edges: [{ ...rows.visibleEdge, relation: 'invented' }] }, selection);
    expect(changedEdges.edges).toEqual([]);
    const reorderedEdges = applyKnowledgeMapFilters({ ...filtered, edges: [{ ...rows.visibleEdge, metadata: { labels: [], beta: false, alpha: true } }] }, selection);
    expect(reorderedEdges.edges.map(edge => edge.id)).toEqual([rows.visibleEdge.id]);
    const labels: string[] & { extra?: string } = []; labels.extra = 'Added array data';
    expect(() => applyKnowledgeMapFilters({ ...filtered, edges: [{ ...rows.visibleEdge, metadata: { ...rows.visibleEdge.metadata, labels } }] }, selection)).toThrow('Knowledge web gap repair held (malformed)');
    expect((await service.map({ filters: { ids: [rows.allowed.id, rows.rejected.id] } })).nodes.map(row => row.id)).toEqual([rows.allowed.id]);
  });

  test('batched items prepare once and neighbor reads require an admitted primary and endpoints', async () => {
    const { store, service } = await fixture(); const rows = await corpus(store); const fake = readings();
    expect((await service.getItems([rows.allowed.id, rows.rejected.id, rows.node.id])).map(item => item.source?.id ?? item.node?.id)).toEqual([rows.allowed.id, rows.node.id]);
    expect(fake.requests).toHaveLength(4);
    const neighbors = await service.getNeighbors('source', rows.allowed.id);
    expect(neighbors.nodes.map(node => node.id)).toEqual([rows.node.id]);
    expect(neighbors.sources).toEqual([]); expect(neighbors.edges.map(edge => edge.id)).toEqual([rows.visibleEdge.id]);
    expect(await service.getNeighbors('source', rows.rejected.id)).toEqual({ edges: [], sources: [], nodes: [] });
  });

  test.each(['items', 'map'] as const)('%s ownership cannot be supplied by an asynchronous callback', async consumer => {
    const { store, service } = await fixture(); const rows = await corpus(store); const fake = readings();
    const options = { assertCurrent: async () => {} };
    await expect(consumer === 'items' ? service.getItems([rows.allowed.id], {}, options) : service.map({}, options)).rejects.toThrow('Knowledge scope selection held');
    expect(fake.requests).toEqual([]); expect(store.listUsageRecords()).toEqual([]);
  });

  test.each(['items', 'map'] as const)('%s forwards the retained pre-adoption restriction', async consumer => {
    const { store, service } = await fixture(); const rows = await corpus(store); const fake = readings();
    const options = { assertPreparedInputCurrent: () => { throw new Error('Synthetic owner retired before adoption.'); } };
    await expect(consumer === 'items' ? service.getItems([rows.allowed.id], {}, options) : service.map({}, options)).rejects.toThrow('Knowledge scope selection held');
    expect(fake.requests).toEqual([]); expect(store.listUsageRecords()).toEqual([]);
  });

  test.each(['items', 'map'] as const)('%s rejects a restriction changed by the ownership callback', async consumer => {
    const { store, service } = await fixture(); const rows = await corpus(store); const fake = readings();
    const options: { sourceIds: string[]; assertPreparedInputCurrent: () => void; assertCurrent?: () => void } = {
      sourceIds: [rows.allowed.id, rows.rejected.id], assertPreparedInputCurrent: () => {},
    };
    options.assertCurrent = () => {
      if (consumer === 'items') options.sourceIds = [rows.allowed.id];
      else options.assertPreparedInputCurrent = () => {};
    };
    await expect(consumer === 'items' ? service.getItems([rows.allowed.id], {}, options) : service.map({}, options)).rejects.toThrow('Knowledge scope selection held');
    expect(fake.requests).toEqual([]); expect(store.listUsageRecords()).toEqual([]);
  });

  test('projection targets and bundle share canonical admission without repeated dispatch', async () => {
    const { store, projection } = await fixture(); const rows = await corpus(store); const fake = readings();
    const bundle = await projection.render({ kind: 'bundle' });
    expect(fake.requests).toHaveLength(4);
    expect(bundle.pages.some(page => page.content.includes(rows.allowed.title!))).toBe(true);
    expect(bundle.pages.some(page => page.content.includes(rows.rejected.title!))).toBe(false);
    const targets = await projection.listTargets(100);
    expect(targets.some(target => target.kind === 'source' && target.itemId === rows.allowed.id)).toBe(true);
    expect(targets.some(target => target.kind === 'source' && target.itemId === rows.rejected.id)).toBe(false);
    await expect(projection.render({ kind: 'source', id: rows.rejected.id })).rejects.toThrow('Unknown knowledge projection target');
  });

  test.each(['missing', 'uncertain'] as const)('%s readings hold reads and generated output without usage or writes', async (mode) => {
    const { store, service, projection, artifactStore } = await fixture(); const rows = await corpus(store);
    if (mode === 'uncertain') readings(0.5);
    await expect(service.querySources()).rejects.toThrow('Knowledge scope selection held');
    await expect(service.getItemScoped(rows.allowed.id)).rejects.toThrow('Knowledge scope selection held');
    await expect(projection.materialize({ kind: 'source', id: rows.allowed.id })).rejects.toThrow('Knowledge scope selection held');
    expect(store.listUsageRecords()).toEqual([]); expect(artifactStore.list()).toEqual([]); expect(store.listSources()).toHaveLength(2);
  });

  test('caller mutation and cancellation during dispatch hold before publication', async () => {
    const { store, service } = await fixture(); await corpus(store); const fake = readings();
    const input = { query: 'queue' }; const controller = new AbortController();
    installJudgmentPort({ ...fake.port, async ask(request) {
      input.query = 'changed'; controller.abort(); return fake.port.ask(request);
    } });
    await expect(service.querySources(input, { signal: controller.signal })).rejects.toThrow('Knowledge scope selection held');
    expect(store.listUsageRecords()).toEqual([]);
  });

  test('authority retired during synchronous rendering prevents publication and artifact creation', async () => {
    const { store, artifactStore } = await fixture(); await corpus(store); readings();
    const projection = new KnowledgeProjectionService(store, artifactStore, { connectors: () => { installJudgmentPort(undefined); return []; } });
    await expect(projection.materialize({ kind: 'overview' })).rejects.toThrow('Knowledge scope selection held');
    expect(artifactStore.list()).toEqual([]); expect(store.listSources()).toHaveLength(2);
  });

  test('original source replacement during artifact handoff prevents generated-source commit', async () => {
    const { store, projection, artifactStore } = await fixture(); const rows = await corpus(store); readings();
    const create = artifactStore.create.bind(artifactStore);
    artifactStore.create = async (...args) => {
      const artifact = await create(...args);
      await store.upsertSource({ ...rows.allowed, title: 'Replaced source content' });
      return artifact;
    };
    await expect(projection.materialize({ kind: 'source', id: rows.allowed.id })).rejects.toThrow('Knowledge scope selection held');
    expect(store.listSources()).toHaveLength(2); expect(artifactStore.list()).toEqual([]);
  });

  test('rendered extraction replacement during artifact handoff prevents stale text publication', async () => {
    const { store, projection, artifactStore } = await fixture(); const rows = await corpus(store); readings();
    const create = artifactStore.create.bind(artifactStore);
    artifactStore.create = async (...args) => {
      const artifact = await create(...args);
      await store.upsertExtraction({ sourceId: rows.allowed.id, extractorId: 'synthetic', format: 'text', excerpt: 'Replacement body.' });
      return artifact;
    };
    await expect(projection.materialize({ kind: 'source', id: rows.allowed.id })).rejects.toThrow('Knowledge scope selection held');
    expect(store.listSources()).toHaveLength(2); expect(artifactStore.list()).toEqual([]);
  });

  test.each(['status', 'map', 'item', 'items', 'neighbors', 'projection'] as const)('%s retains original edge content during semantic dispatch', async consumer => {
    const { store, service, projection } = await fixture(); const rows = await corpus(store); const fake = readings();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let held = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (!held) { held = true; entered.resolve(); await release.promise; }
      return fake.port.ask(request);
    } });
    const work = consumer === 'status' ? service.getStatus()
      : consumer === 'map' ? service.map()
      : consumer === 'item' ? service.getItemScoped(rows.allowed.id)
      : consumer === 'items' ? service.getItems([rows.allowed.id, rows.node.id])
      : consumer === 'neighbors' ? service.getNeighbors('source', rows.allowed.id)
      : projection.render({ kind: 'source', id: rows.allowed.id });
    const result = work.then(() => undefined, (error: unknown) => error);
    try {
      await entered.promise;
      await store.replaceEdgeRecord({ ...rows.visibleEdge, relation: 'contradicts', weight: 0.1 });
      release.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(String(await result)).toContain('Knowledge scope selection held');
      expect(store.listUsageRecords()).toEqual([]);
    } finally { release.resolve(); }
  });

  test('a separate writer edge ABA cannot publish a cached map relation', async () => {
    const { root, store } = await fixture(); const rows = await corpus(store); readings();
    const selection = await prepareKnowledgeScopeSelection(store);
    const state = { sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() };
    const writer = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await writer.init();
    try {
      await writer.replaceEdgeRecord({ ...rows.visibleEdge, relation: 'contradicts' });
      await writer.replaceEdgeRecord(rows.visibleEdge);
      expect(() => applyKnowledgeMapFilters(state, selection)).toThrow('Knowledge scope selection held');
    } finally { await writer.close(); }
  });

  test.each(['replacement', 'addition', 'ABA'] as const)('persisted edge %s during artifact handoff prevents stale projection commit', async mode => {
    const { root, store, projection, artifactStore } = await fixture(); const rows = await corpus(store); readings();
    const writer = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await writer.init();
    const create = artifactStore.create.bind(artifactStore);
    artifactStore.create = async (...args) => {
      const artifact = await create(...args);
      if (mode === 'addition') await writer.upsertEdge({ fromKind: 'source', fromId: rows.allowed.id, toKind: 'node', toId: rows.node.id, relation: 'contradicts' });
      else {
        await writer.replaceEdgeRecord({ ...rows.visibleEdge, relation: 'contradicts' });
        if (mode === 'ABA') await writer.replaceEdgeRecord(rows.visibleEdge);
      }
      return artifact;
    };
    try {
      await expect(projection.materialize({ kind: 'source', id: rows.allowed.id })).rejects.toThrow('Knowledge scope selection held');
      expect(store.listSources()).toHaveLength(2); expect(artifactStore.list()).toEqual([]);
    } finally { await writer.close(); }
  });

  test('authorized projection materialization can replace its own previously generated output', async () => {
    const { store, projection, artifactStore } = await fixture(); const rows = await corpus(store); readings();
    const first = await projection.materialize({ kind: 'source', id: rows.allowed.id });
    await store.upsertExtraction({ sourceId: rows.allowed.id, extractorId: 'synthetic', format: 'text', summary: 'Updated authored source body.', excerpt: 'Replay the durable queue.' });
    const second = await projection.materialize({ kind: 'source', id: rows.allowed.id });
    if (!first.source || !second.source) throw new Error('Projection fixture did not materialize its generated source.');
    expect(first.source.id).toBe(second.source.id); expect(first.artifact.id).not.toBe(second.artifact.id);
    expect(artifactStore.get(first.artifact.id)).toBeNull(); expect(artifactStore.get(second.artifact.id)).not.toBeNull();
    expect(second.bundle.pages[0]?.content).toContain('Updated authored source body.');
  });
});
