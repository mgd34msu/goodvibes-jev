import { expect, spyOn, test } from 'bun:test';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { prepareKnowledgeScopeSelection } from '../sdk/src/platform/knowledge/scope-selection.js';
import { renderHomeGraphMap } from '../sdk/src/platform/knowledge/home-graph/rendering.js';
import { renderHomeGraphState } from '../sdk/src/platform/knowledge/home-graph/state.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';

const readings = useKnowledgeAnswerReadings();
useHomeGraphFixtures();

test('Home Graph map keeps its caller request through awaited scope preparation', async () => {
  const { service, store } = createHomeGraphService();
  await service.syncSnapshot({ installationId: 'map-owner', devices: [{ id: 'vela', name: 'Vela' }], pageAutomation: { enabled: false } });
  const request = { installationId: 'map-owner', query: 'Vela' };
  const init = store.init.bind(store);
  let starts = 0;
  const changed = spyOn(store, 'init').mockImplementation(async () => {
    await init();
    if (++starts === 2) request.query = 'Different request';
  });
  try { await expect(service.map(request)).rejects.toMatchObject({ reason: 'stale' }); }
  finally { changed.mockRestore(); }
  expect(starts).toBe(2);
});

test('Home Graph map cannot publish a selected source after an operator replaces it', async () => {
  const { service, store } = createHomeGraphService();
  await service.syncSnapshot({ installationId: 'map-record', devices: [{ id: 'vela', name: 'Vela' }], pageAutomation: { enabled: false } });
  const source = store.listSources().find(row => row.metadata.homeGraphSourceKind === 'snapshot')!;
  const init = store.init.bind(store);
  let starts = 0;
  const changed = spyOn(store, 'init').mockImplementation(async () => {
    await init();
    if (++starts === 2) await store.upsertSource({ ...source, summary: 'Operator correction', metadata: { ...source.metadata, correction: 'operator' } });
  });
  try { await expect(service.map({ installationId: 'map-record' })).rejects.toMatchObject({ reason: 'stale' }); }
  finally { changed.mockRestore(); }
  expect(store.getSource(source.id)?.summary).toBe('Operator correction');
});

test('Home Graph map keeps the original persisted relation generation through scope preparation', async () => {
  const { service, store } = createHomeGraphService();
  await service.syncSnapshot({ installationId: 'map-relation', devices: [{ id: 'vela', name: 'Vela' }], pageAutomation: { enabled: false } });
  const source = store.listSources().find(row => row.metadata.homeGraphSourceKind === 'snapshot');
  const device = store.listNodes().find(row => row.kind === 'ha_device');
  if (!source || !device) throw new Error('Expected the observed snapshot and device');
  const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: device.id, relation: 'source_for',
    metadata: { knowledgeSpaceId: source.metadata.knowledgeSpaceId, first: 'original', second: 'retained' } });
  const originalGeneration = store.getEdgeSnapshot(edge.id).generation;
  const writer = new KnowledgeStore({ dbPath: store.storagePath });
  await writer.init();
  const init = store.init.bind(store);
  let starts = 0;
  const changed = spyOn(store, 'init').mockImplementation(async () => {
    await init();
    if (++starts === 2) await writer.replaceEdgeRecord({ ...edge, metadata: Object.fromEntries(Object.entries(edge.metadata).reverse()) });
  });
  try {
    await expect(service.map({ installationId: 'map-relation' })).rejects.toMatchObject({ reason: 'stale' });
    expect(store.getEdgeSnapshot(edge.id).generation).not.toBe(originalGeneration);
    expect(store.getEdgeSnapshot(edge.id).record).toEqual(edge);
    expect(store.listEdges().find(row => row.id === edge.id)).toEqual(edge);
  } finally { changed.mockRestore(); await writer.close(); }
});

test.each(['replace-restore', 'add-delete'])('Home Graph map detects a persisted %s relation before scope adoption', async mode => {
  const { service, store } = createHomeGraphService();
  await service.syncSnapshot({ installationId: 'map-history', devices: [{ id: 'vela', name: 'Vela' }], pageAutomation: { enabled: false } });
  const source = store.listSources().find(row => row.metadata.homeGraphSourceKind === 'snapshot');
  const device = store.listNodes().find(row => row.kind === 'ha_device');
  if (!source || !device) throw new Error('Expected the observed snapshot and device');
  const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: device.id, relation: 'source_for',
    metadata: { knowledgeSpaceId: source.metadata.knowledgeSpaceId } });
  const original = store.getEdgeSnapshot(edge.id);
  const keys = [`source:${source.id}`, `node:${device.id}`];
  const originalWindow = store.getEdgeWindowGeneration(keys);
  const originalEdges = store.listEdges();
  const writer = new KnowledgeStore({ dbPath: store.storagePath });
  await writer.init();
  const init = store.init.bind(store);
  let starts = 0;
  const changed = spyOn(store, 'init').mockImplementation(async () => {
    await init();
    if (++starts !== 2) return;
    if (mode === 'replace-restore') {
      await writer.replaceEdgeRecord({ ...edge, weight: 0.2 });
      await writer.replaceEdgeRecord(edge);
    } else {
      const added = await writer.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: device.id, relation: 'has_manual', metadata: edge.metadata });
      await writer.deleteEdge(added.id);
    }
  });
  try {
    await expect(service.map({ installationId: 'map-history' })).rejects.toMatchObject({ reason: 'stale' });
    expect(store.listEdges()).toEqual(originalEdges);
    expect(store.getEdgeSnapshot(edge.id).record).toEqual(original.record);
    expect(store.getEdgeWindowGeneration(keys)).not.toBe(originalWindow);
    if (mode === 'replace-restore') expect(store.getEdgeSnapshot(edge.id).generation).not.toBe(original.generation);
    else expect(store.getEdgeSnapshot(edge.id).generation).toBe(original.generation);
  } finally { changed.mockRestore(); await writer.close(); }
});

test('Home Graph filters cannot follow an excluded context bridge to an admitted source', async () => {
  const { store } = createHomeGraphService();
  const entity = await store.upsertNode({ kind: 'wiki_page', slug: 'fixture-entity', title: 'Fixture entity', status: 'active',
    metadata: { knowledgeSpaceId: 'default', homeAssistant: { objectKind: 'entity', entityId: 'light.fixture' }, labels: ['fixture'] } });
  const bridge = await store.upsertNode({ kind: 'wiki_page', slug: 'excluded-bridge', title: 'Excluded bridge', status: 'active',
    metadata: { knowledgeSpaceId: 'default' } });
  const source = await store.upsertSource({ sourceType: 'document', connectorId: 'synthetic', title: 'Reference behind excluded bridge', status: 'indexed',
    metadata: { knowledgeSpaceId: 'default' } });
  await store.upsertEdge({ fromKind: 'node', fromId: entity.id, toKind: 'node', toId: bridge.id, relation: 'connected_via', metadata: { knowledgeSpaceId: 'default' } });
  await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: bridge.id, relation: 'source_for', metadata: { knowledgeSpaceId: 'default' } });
  readings.set({ scope: [['node', bridge.title, 0.01]] });
  const selection = await prepareKnowledgeScopeSelection(store, { knowledgeSpaceId: 'default' });
  expect(selection.node(entity)).toBe(true);
  expect(selection.node(bridge)).toBe(false);
  expect(selection.source(source)).toBe(true);
  const map = renderHomeGraphMap(renderHomeGraphState(store, 'default', 'Fixture map'), selection, {
    ha: { domains: ['light'], labels: ['fixture'] }, includeSources: true,
  });
  expect(map.nodes.map(node => node.id)).toEqual([entity.id]);
  expect(map.edges).toEqual([]);
  expect(map.nodes.filter(node => node.recordKind === 'source')).toEqual([]);
  readings.set({ scope: [['node', bridge.title, 0.99]] });
  const admitted = await prepareKnowledgeScopeSelection(store, { knowledgeSpaceId: 'default' });
  const admittedMap = renderHomeGraphMap(renderHomeGraphState(store, 'default', 'Fixture map'), admitted, {
    ha: { domains: ['light'], labels: ['fixture'] }, includeSources: true,
  });
  expect(admittedMap.nodes.some(node => node.id === source.id && node.recordKind === 'source')).toBe(true);
  expect(admittedMap.edges).toHaveLength(2);
});
