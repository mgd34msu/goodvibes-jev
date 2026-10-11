import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { assertJudgmentInput } from '../sdk/src/platform/gate/judgment-input.js';
import { knowledgeRawRepresentation } from '../sdk/src/platform/knowledge/store-record-representation.js';
import { prepareKnowledgeRecordAdmission } from '../sdk/src/platform/knowledge/store-record-snapshot.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';

useKnowledgeAnswerReadings();
useHomeGraphFixtures();

test('owned Home Graph stamps remain readable at a clock whose digits satisfy Luhn', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1791684509006);
  try {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({ installationId: 'owned-clock', devices: [{ id: 'vela', name: 'Vela' }], pageAutomation: { enabled: false } });
    const snapshot = store.listSources().find(source => source.metadata.homeGraphSourceKind === 'snapshot')!;
    expect(typeof snapshot.metadata.capturedAt).toBe('number');
    expect(knowledgeRawRepresentation(snapshot).metadata.capturedAt).toBe('2026-10-11T02:08:29.006Z');
    expect(() => assertJudgmentInput(knowledgeRawRepresentation(snapshot))).not.toThrow();
    const page = await service.refreshDevicePassport({ installationId: 'owned-clock', deviceId: 'vela' });
    if (!page.source) throw new Error('Expected the published device passport source.');
    expect(typeof page.source.metadata.generatedAt).toBe('number');
    expect(typeof page.passport.metadata.refreshedAt).toBe('number');
    expect(() => assertJudgmentInput(knowledgeRawRepresentation(page.source))).not.toThrow();
    expect(() => assertJudgmentInput(knowledgeRawRepresentation(page.passport))).not.toThrow();
  } finally { clock.mockRestore(); }
});

test('a caller supplied snapshot clock retains complete privacy admission', async () => {
  const { service, store } = createHomeGraphService();
  await service.syncSnapshot({ installationId: 'caller-clock', capturedAt: 4111111111111111, pageAutomation: { enabled: false } });
  const snapshot = store.listSources().find(source => source.metadata.homeGraphSourceKind === 'snapshot')!;
  expect(knowledgeRawRepresentation(snapshot).metadata.capturedAt).toBe(4111111111111111);
  expect(() => assertJudgmentInput(knowledgeRawRepresentation(snapshot))).toThrow();
});

test('retirement and reappearance preserve canonical native clocks and complete metadata at a colliding epoch', async () => {
  const initialClock = 1791684509006;
  const retiredClock = 1791723639004;
  const clock = spyOn(Date, 'now').mockReturnValue(initialClock);
  try {
    const { service, store, root } = createHomeGraphService();
    const device = { id: 'returning-display', name: 'Returning Display', manufacturer: 'Vendor', model: 'RET-1',
      metadata: { retainedContext: { text: 'Original installation details.' } } };
    await service.syncSnapshot({ installationId: 'owned-retirement', devices: [device] });
    const node = store.listNodes().find(record => record.title === device.name);
    const source = store.listSources().find(record => record.title === `${device.name} passport`);
    if (!node || !source) throw new Error('Expected the original native device and generated passport.');
    const originalNode = knowledgeRawRepresentation(node);
    const originalSource = knowledgeRawRepresentation(source);
    const originalSourceSql = store.getSourceSnapshot({ id: source.id }).raw;
    clock.mockReturnValue(retiredClock);
    await service.syncSnapshot({ installationId: 'owned-retirement', devices: [] });
    const retiredNode = store.getNode(node.id);
    const retiredSource = store.getSource(source.id);
    if (!retiredNode || !retiredSource) throw new Error('Expected the retained retired records.');
    const retiredIso = new Date(retiredClock).toISOString();
    expect(retiredNode.status).toBe('stale');
    expect(retiredSource.status).toBe('stale');
    expect(retiredNode.metadata.staleAt).toBe(retiredIso);
    expect(retiredSource.metadata.staleAt).toBe(retiredIso);
    const { reviewProvenance: originalReview, ...originalNodeMetadata } = originalNode.metadata;
    expect(originalReview).toBeDefined();
    expect(knowledgeRawRepresentation(retiredNode).metadata).toMatchObject(originalNodeMetadata);
    expect(knowledgeRawRepresentation(retiredNode).metadata.reviewProvenance).toEqual({
      state: 'explicit', reason: "Explicit non-serving status 'stale'", decidedAt: retiredIso,
    });
    expect(knowledgeRawRepresentation(retiredSource).metadata).toMatchObject(originalSource.metadata);
    expect(store.getSourceSnapshot({ id: source.id }).raw?.last_crawled_at).toBe(originalSourceSql?.last_crawled_at);
    expect(retiredSource.lastCrawledAt).toBe(source.lastCrawledAt);
    expect(() => prepareKnowledgeRecordAdmission(store, 'node', retiredNode).assertCurrent()).not.toThrow();
    expect(() => prepareKnowledgeRecordAdmission(store, 'source', retiredSource).assertCurrent()).not.toThrow();
    await service.syncSnapshot({ installationId: 'owned-retirement', devices: [device] });
    const browse = await service.browse({ installationId: 'owned-retirement' });
    const pages = await service.listPages({ installationId: 'owned-retirement', limit: 20 });
    expect(browse.nodes.some(record => record.id === node.id)).toBe(true);
    expect(pages.pages.some(page => page.source.id === source.id)).toBe(true);
    expect(store.getNode(node.id)?.metadata.staleAt).toBe(retiredIso);
    expect(store.getSource(source.id)?.metadata.staleAt).toBe(retiredIso);
    service.dispose();
    await store.close();
    const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    try {
      await reopened.init();
      const currentNode = reopened.getNode(node.id);
      const currentSource = reopened.getSource(source.id);
      if (!currentNode || !currentSource) throw new Error('Expected the reopened native records.');
      expect(currentNode.metadata.staleAt).toBe(retiredIso);
      expect(currentSource.metadata.staleAt).toBe(retiredIso);
      expect(() => prepareKnowledgeRecordAdmission(reopened, 'node', currentNode).assertCurrent()).not.toThrow();
      expect(() => prepareKnowledgeRecordAdmission(reopened, 'source', currentSource).assertCurrent()).not.toThrow();
      expect(() => prepareKnowledgeRecordAdmission(reopened, 'node', { ...currentNode })).toThrow();
      expect(() => prepareKnowledgeRecordAdmission(reopened, 'source', { ...currentSource })).toThrow();
    } finally { await reopened.close(); }
  } finally { clock.mockRestore(); }
});

test('caller numeric retirement labels remain protected data rather than owned timestamps', async () => {
  const collision = 1791723639004;
  const { store } = createHomeGraphService();
  const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'document', status: 'indexed',
    title: 'Caller supplied retirement metadata', metadata: { staleAt: collision, retainedContext: { staleAt: collision } } });
  expect(knowledgeRawRepresentation(source).metadata.staleAt).toBe(collision);
  expect(knowledgeRawRepresentation(source).metadata.retainedContext).toEqual({ staleAt: collision });
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).toThrow();
  expect(() => assertJudgmentInput(knowledgeRawRepresentation({ ...source }))).toThrow();
});
