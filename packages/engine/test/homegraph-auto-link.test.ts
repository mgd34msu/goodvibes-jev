import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { autoLinkHomeGraphSource, autoLinkHomeGraphSources } from '../sdk/src/platform/knowledge/home-graph/auto-link.js';
import { readHomeGraphState } from '../sdk/src/platform/knowledge/home-graph/state.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const spaceId = 'homeassistant:auto-link-fixture', installationId = 'auto-link-fixture';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-auto-link-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const metadata = { knowledgeSpaceId: spaceId };
  const node = await seedHomeAssistantObservation(store, { id: 'LOCAL_DEVICE', kind: 'ha_device', slug: 'appliance',
    title: 'Kitchen appliance', aliases: [], status: 'active', metadata: { ...metadata, model: 'OV-7', private: 'DO_NOT_TRANSMIT' } });
  const source = await store.upsertSource({ id: 'LOCAL_SOURCE', connectorId: 'homeassistant', sourceType: 'manual',
    title: 'OV-7 operating instructions', canonicalUri: 'https://example.test/ov7', tags: ['manual'], status: 'indexed', metadata });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'text', format: 'text',
    title: source.title, summary: 'Operating instructions for the OV-7 appliance.', excerpt: 'Turn the knob to start.',
    sections: ['Retain the purchase receipt for warranty service.'], links: [], estimatedTokens: 30, structure: {}, metadata });
  const run = (signal?: AbortSignal) => autoLinkHomeGraphSource({ store, spaceId, installationId, source: store.getSource(source.id)!,
    extraction: store.getExtractionBySourceId(source.id) ?? undefined, state: readHomeGraphState(store, spaceId), signal });
  return { store, node, source, extraction, run, metadata };
}
function readings(options: { pick?: string; pickConfidence?: number; fit?: number; relationConfidence?: number } = {}) {
  const fake = fakePort((name, question, state) => {
    if (name === 'manual') return noulAnswer(0.99);
    if (name === 'integrationDocumentation') return noulAnswer(0.01);
    if (name === 'selected') {
      const candidate = (state as { candidate: { reference: string } }).candidate;
      return noulAnswer(candidate.reference === (options.pick ?? 'candidate-1') ? options.fit ?? options.pickConfidence ?? 0.99 : 0.01);
    }
    if (name === 'relation') return choiceAnswer(question, 'has_manual', options.relationConfidence ?? 0.99);
    throw new Error('Unexpected auto-link question');
  });
  let calls = 0;
  const port: JudgmentPort = { ...fake.port, async ask(request) { return { ...await fake.port.ask(request), decisionId: `auto-link-call-${++calls}` }; } };
  installJudgmentPort(port);
  return { ...fake, port };
}

test('reads document kind and every candidate through the foundation with actual provenance', async () => {
  const { store, run } = await fixture(); const fake = readings();
  const linked = await run();
  expect(linked?.relation).toBe('has_manual'); expect(linked?.score).toBe(0);
  expect(linked?.edge.metadata.judgmentDecisionIds).toEqual(['auto-link-call-1', 'auto-link-call-2']);
  expect(linked?.edge.metadata.requestedModel).toBe('jev-latest');
  expect(linked?.edge.metadata.model).toBe('jev-1.13.0');
  expect(fake.requests.map((request) => request.context?.pattern)).toEqual(['battery', 'battery']);
  const sent = JSON.stringify(fake.requests);
  for (const local of ['LOCAL_DEVICE', 'LOCAL_SOURCE', 'DO_NOT_TRANSMIT']) expect(sent).not.toContain(local);
  expect(sent).toContain('Retain the purchase receipt');
  expect(await run()).toBeUndefined(); expect(store.listEdges()).toHaveLength(1); expect(fake.requests).toHaveLength(2);
});

test.each([
  { pickConfidence: 0.7 }, { pickConfidence: 0.3 }, { fit: 0.75 }, { fit: 0.1 }, { relationConfidence: 0.7 },
])('uncertain or nonfitting reading writes no edge: %j', async (options) => {
  const { store, run } = await fixture(); readings(options);
  if (options.fit === 0.1) expect(await run()).toBeUndefined();
  else await expect(run()).rejects.toThrow();
  expect(store.listEdges()).toHaveLength(0);
});
test('settled none is an ordinary no-link result', async () => {
  const { store, run } = await fixture(); const fake = readings({ pick: 'none' });
  expect(await run()).toBeUndefined(); expect(store.listEdges()).toHaveLength(0); expect(fake.requests).toHaveLength(2);
});
test('missing port produces no graph writes', async () => {
  const { store, run } = await fixture(); await expect(run()).rejects.toThrow(); expect(store.listEdges()).toHaveLength(0);
});
test('all evidence is retained beyond the old clipping boundary', async () => {
  const { store, source, extraction, run } = await fixture();
  const full = 'Operating notes. '.repeat(2_200) + 'The final correction says this document covers OV-9, not OV-7.';
  await store.upsertExtraction({ ...extraction, sourceId: source.id, excerpt: full });
  const fake = readings({ pick: 'none' }); await run();
  expect(JSON.stringify(fake.requests[0]!.state)).toContain(full);
});
test('a protected later source prevents every request and write in a batch', async () => {
  const { store, metadata, source } = await fixture();
  const later = await store.upsertSource({ ...source, id: 'LATER_SOURCE', canonicalUri: 'https://example.test/later',
    description: 'Authorization: Bearer synthetic-protected-value', metadata });
  const state = readHomeGraphState(store, spaceId), fake = readings();
  await expect(autoLinkHomeGraphSources({ store, spaceId, installationId, state, sources: [source, later],
    extractionBySourceId: new Map(state.extractions.map((item) => [item.sourceId, item])) })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0); expect(store.listEdges()).toHaveLength(0);
});
test.each(['source', 'node', 'candidate-added', 'link-added', 'cancelled'] as const)('changes during a reading prevent stale writes: %s', async (change) => {
  const { store, node, source, metadata, run } = await fixture(); const fake = readings(); const controller = new AbortController();
  let called = false;
  installJudgmentPort({ ...fake.port, async ask(request) {
    const result = await fake.port.ask(request);
    if (!called) {
      called = true;
      if (change === 'source') await store.upsertSource({ ...source, summary: 'Changed while waiting' });
      if (change === 'node') node.metadata.model = 'OV-9';
      if (change === 'candidate-added') await seedHomeAssistantObservation(store, { ...node, id: 'NEW_DEVICE', slug: 'new', title: 'Another appliance' });
      if (change === 'link-added') await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id, relation: 'source_for', metadata });
      if (change === 'cancelled') controller.abort();
    }
    return result;
  } });
  await expect(run(controller.signal)).rejects.toThrow();
  expect(store.listEdges()).toHaveLength(change === 'link-added' ? 1 : 0);
  expect(store.listEdges().some((edge) => edge.metadata.linkMethod === 'homegraph-auto-link')).toBe(false);
});
test('rechecks after asynchronous store initialization immediately before commit', async () => {
  const { store, source, run } = await fixture(); const fake = readings(); const original = store.init.bind(store);
  let atCommit = false;
  installJudgmentPort({ ...fake.port, async ask(request) {
    const result = await fake.port.ask(request); if ('relation' in request.questions) atCommit = true; return result;
  } });
  const init = spyOn(store, 'init').mockImplementation(async () => {
    await original();
    if (atCommit) { atCommit = false; source.metadata.changedDuringInit = true; }
  });
  try { await expect(run()).rejects.toThrow(); expect(store.listEdges()).toHaveLength(0); }
  finally { init.mockRestore(); }
});
test('all candidates reach independent subject readings even when titles have no shared words', async () => {
  const { store, node, run } = await fixture();
  await seedHomeAssistantObservation(store, { ...node, id: 'SECOND_DEVICE', slug: 'second', title: 'Entirely different label' });
  const fake = readings({ pick: 'none' }); await run();
  expect(fake.requests.filter(request => 'selected' in request.questions)).toHaveLength(2);
  expect(JSON.stringify(fake.requests)).toContain('Entirely different label');
});
test('a later uncertain source holds the complete batch before any link is written', async () => {
  const { store, source } = await fixture();
  const later = await store.upsertSource({ ...source, id: 'LATER_SOURCE', title: 'Other reference', canonicalUri: 'https://example.test/later' });
  const fake = readings();
  installJudgmentPort({ ...fake.port, async ask(request) {
    const result = await fake.port.ask(request);
    if ('selected' in request.questions && (request.state as { source: { title: string } }).source.title === later.title) {
      return { ...result, answers: { ...result.answers, selected: noulAnswer(0.7) } };
    }
    return result;
  } });
  const state = readHomeGraphState(store, spaceId);
  await expect(autoLinkHomeGraphSources({ store, spaceId, installationId, state, sources: [source, later],
    extractionBySourceId: new Map(state.extractions.map((item) => [item.sourceId, item])) })).rejects.toThrow();
  expect(store.listEdges()).toHaveLength(0);
});
test('concurrent decisions cannot create two associations for the same source', async () => {
  const { store, run } = await fixture(); readings();
  const results = await Promise.allSettled([run(), run()]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(store.listEdges()).toHaveLength(1);
});
