import { homeGraphDocumentKind, homeGraphDocumentSubject } from '../sdk/src/platform/knowledge/home-graph/auto-link/battery.js';
import { assertJudgmentInput, JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { runHomeGraphSnapshotSync } from '../sdk/src/platform/knowledge/home-graph/sync.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { autoLinkExistingHomeGraphSources } from '../sdk/src/platform/knowledge/home-graph/extraction.js';
import { autoLinkHomeGraphSource, autoLinkHomeGraphSources } from '../sdk/src/platform/knowledge/home-graph/auto-link.js';
import { readHomeGraphState } from '../sdk/src/platform/knowledge/home-graph/state.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const spaceId = 'homeassistant:link-readings', installationId = 'link-readings';
const roots: string[] = [], services: HomeGraphService[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const service of services.splice(0)) service.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'homegraph-auto-link-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const service = new HomeGraphService(store, artifactStore); services.push(service);
  const device = await seedHomeAssistantObservation(store, { id: 'exact-device-id', kind: 'ha_device', slug: 'router', title: 'Hall network box',
    status: 'active', confidence: 100, metadata: { knowledgeSpaceId: spaceId, installationId, model: 'WX-9900',
      homeAssistant: { deviceId: 'ha-device-untouched' } } });
  const source = await store.upsertSource({ id: 'exact-source-id', connectorId: 'fixture', sourceType: 'document', status: 'indexed',
    title: 'Receipt warranty manual WX-9900', metadata: { knowledgeSpaceId: spaceId, installationId } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text',
    sections: ['This is not a receipt or warranty. This describes operating the hallway network equipment.'], metadata: { knowledgeSpaceId: spaceId } });
  return { store, source, extraction, device, service };
}
function readings(selected = 0.99) {
  const fake = fakePort((name, question) => {
    if (name === 'relation') return choiceAnswer(question, 'source_for', 0.99);
    if (name === 'manual' || name === 'integrationDocumentation') return noulAnswer(0.01);
    if (name === 'selected') return noulAnswer(selected);
    return noulAnswer(0.99); // extraction fixture reads only
  });
  installJudgmentPort(fake.port); return fake;
}
const run = (f: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) => autoLinkExistingHomeGraphSources(f.store, spaceId, installationId, undefined, signal);

test('existing extraction consumer uses settled meaning and retains exact endpoint IDs, not filename relation', async () => {
  const f = await fixture(); const fake = readings();
  const linked = await run(f);
  expect(linked).toHaveLength(1);
  expect(linked[0]!.edge).toMatchObject({ fromId: f.source.id, toId: f.device.id, relation: 'source_for', weight: 1 });
  expect(linked[0]!.score).toBe(0);
  expect(fake.requests.some(request => JSON.stringify(request.state).includes('ha-device-untouched'))).toBe(true);
  expect(f.store.getNode(f.device.id)?.confidence).toBe(100);
});
test.each([0.01, 0.5])('negative or uncertain never falls back to exact model substring (%s)', async probability => {
  const f = await fixture(); readings(probability);
  if (probability === 0.01) expect(await run(f)).toHaveLength(0);
  else await expect(run(f)).rejects.toMatchObject({ reason: 'uncertain' });
  expect(f.store.listEdges()).toHaveLength(0);
});
test('unavailable port never writes heuristic matches', async () => {
  const f = await fixture(); await expect(run(f)).rejects.toMatchObject({ reason: 'unavailable' }); expect(f.store.listEdges()).toHaveLength(0);
});
test('two selected siblings hold instead of score margin or exact-model bypass', async () => {
  const f = await fixture();
  await seedHomeAssistantObservation(f.store, { ...f.device, id: 'second-device', slug: 'second-device', title: 'Other network box' });
  readings(); await expect(run(f)).rejects.toMatchObject({ reason: 'ambiguous' }); expect(f.store.listEdges()).toHaveLength(0);
});
test('protected late source tail precedes every candidate and model request', async () => {
  const f = await fixture(); const source = await f.store.upsertSource({ ...f.source, id: 'late-source', title: 'Late source' });
  await f.store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', sections: [
    'x'.repeat(128 * 1024) + '\nAuthorization: Bearer synthetic-protected-fixture'], metadata: { knowledgeSpaceId: spaceId } });
  const fake = readings(); await expect(run(f)).rejects.toMatchObject({ problem: 'credential-material' });
  expect(fake.requests).toHaveLength(0); expect(f.store.listEdges()).toHaveLength(0);
});
test.each(['source', 'device', 'extraction', 'port'] as const)('ABA %s replacement during reading refuses late edges', async kind => {
  const f = await fixture(); const fake = readings(); let changed = false;
  const port: JudgmentPort = { ...fake.port, async ask(request) {
    if (!changed && request.context?.site === 'engine.knowledge.homegraph-document-subject') {
      changed = true;
      if (kind === 'source') { await f.store.upsertSource({ ...f.source, title: 'intermediate' }); await f.store.upsertSource(f.source); }
      if (kind === 'device') { await seedHomeAssistantObservation(f.store, { ...f.device, title: 'intermediate' }); await seedHomeAssistantObservation(f.store, f.device); }
      if (kind === 'extraction') { await f.store.upsertExtraction({ ...f.extraction, sections: ['changed'] }); await f.store.upsertExtraction(f.extraction); }
      if (kind === 'port') { installJudgmentPort(fake.port); installJudgmentPort(port); }
    }
    return fake.port.ask(request);
  } }; installJudgmentPort(port);
  await expect(run(f)).rejects.toMatchObject({ reason: 'stale' }); expect(f.store.listEdges()).toHaveLength(0);
});
test('caller cancellation remains effective against a port which ignores cancellation', async () => {
  const f = await fixture(), controller = new AbortController(); const fake = readings();
  installJudgmentPort({ ...fake.port, async ask(request) { controller.abort(); return fake.port.ask(request); } });
  await expect(run(f, controller.signal)).rejects.toMatchObject({ reason: 'aborted' }); expect(f.store.listEdges()).toHaveLength(0);
});
test('edge commit after init await validates original source and keeps unrelated concurrent writes', async () => {
  const f = await fixture(); readings(); const original = f.store.upsertEdge.bind(f.store);
  const spy = spyOn(f.store, 'upsertEdge').mockImplementation(async input => {
    await f.store.upsertSource({ ...f.source, summary: 'Changed at commit boundary' });
    return original(input);
  });
  try { await expect(run(f)).rejects.toMatchObject({ reason: 'stale' }); }
  finally { spy.mockRestore(); }
  expect(f.store.listEdges()).toHaveLength(0); expect(f.store.getSource(f.source.id)?.summary).toBe('Changed at commit boundary');
});
test('explicit links and generated source markers bypass semantic auto-link without broadening policy', async () => {
  const f = await fixture(); await f.store.upsertEdge({ fromKind: 'source', fromId: f.source.id, toKind: 'node', toId: f.device.id,
    relation: 'has_manual', metadata: { knowledgeSpaceId: spaceId } });
  const fake = readings(); expect(await run(f)).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});
test('single-source original caller context remains guarded through reading', async () => {
  const f = await fixture(); const input = { store: f.store, source: f.source, extraction: f.extraction, spaceId, installationId, state: readHomeGraphState(f.store, spaceId) };
  const fake = readings(); installJudgmentPort({ ...fake.port, async ask(request) { input.installationId = 'replacement'; return fake.port.ask(request); } });
  await expect(autoLinkHomeGraphSource(input)).rejects.toMatchObject({ reason: 'stale' }); expect(f.store.listEdges()).toHaveLength(0);
});
test('actual service ingestion respects settled none despite model words in title', async () => {
  const f = await fixture(); readings(0.01);
  const result = await f.service.ingestNote({ knowledgeSpaceId: spaceId, installationId, title: 'WX-9900 receipt warranty manual',
    body: 'This document discusses a different device and provides no basis for linking the hallway equipment.' });
  expect(result).toMatchObject({ ok: true }); expect(f.store.listEdges()).toHaveLength(0);
});
test('actual service disposal cancels pending automatic edge publication', async () => {
  const f = await fixture(); const fake = readings();
  installJudgmentPort({ ...fake.port, async ask(request) {
    if (request.context?.site === 'engine.knowledge.homegraph-document-subject') f.service.dispose();
    return fake.port.ask(request);
  } });
  await expect(f.service.ingestNote({ knowledgeSpaceId: spaceId, installationId, title: 'WX-9900 operating note',
    body: 'The hallway equipment is restarted by holding the button.' })).rejects.toMatchObject({ reason: 'aborted' });
  expect(f.store.listEdges()).toHaveLength(0);
});
test('all sources settle before the first edge, including a later uncertain source', async () => {
  const f = await fixture(); await f.store.upsertSource({ ...f.source, id: 'later-source', title: 'Later document' });
  const fake = fakePort((name, question, state) => {
    if (name === 'relation') return choiceAnswer(question, 'source_for', 0.99);
    if (name === 'manual' || name === 'integrationDocumentation') return noulAnswer(0.01);
    const source = (state as { source?: { title?: string } }).source;
    return noulAnswer(source?.title === 'Later document' ? 0.5 : 0.99);
  }); installJudgmentPort(fake.port);
  await expect(run(f)).rejects.toMatchObject({ reason: 'uncertain' }); expect(f.store.listEdges()).toHaveLength(0);
});
test('settled short evidence is not rejected by a sixteen-character heuristic', async () => {
  const f = await fixture(); const source = await f.store.upsertSource({ ...f.source, title: 'X' });
  await f.store.upsertExtraction({ ...f.extraction, sections: [] });
  readings(); const linked = await run(f); expect(linked[0]?.edge.fromId).toBe(source.id);
});
test('complete candidate identity tail is protected before first request', async () => {
  const f = await fixture();
  await seedHomeAssistantObservation(f.store, { ...f.device, aliases: ['x'.repeat(64 * 1024) + '\nAuthorization: Bearer synthetic-protected-fixture'] });
  const fake = readings(); await expect(run(f)).rejects.toMatchObject({ problem: 'credential-material' }); expect(fake.requests).toHaveLength(0);
});
test('two ordinary selected source decisions publish exact independent edges', async () => {
  const f = await fixture(); await f.store.upsertSource({ ...f.source, id: 'second-source', title: 'Second document' });
  readings(); const linked = await run(f); expect(linked).toHaveLength(2); expect(f.store.listEdges()).toHaveLength(2);
});
test('restoring the exact old source object cannot revive an in-flight decision', async () => {
  const f = await fixture(), fake = readings(); let changed = false;
  installJudgmentPort({ ...fake.port, async ask(request) {
    if (!changed && request.context?.site === 'engine.knowledge.homegraph-document-subject') {
      changed = true; await f.store.replaceSourceRecord({ ...f.source, title: 'Temporary revision' }); await f.store.replaceSourceRecord(f.source);
    }
    return fake.port.ask(request);
  } });
  await expect(run(f)).rejects.toMatchObject({ reason: 'stale' }); expect(f.store.listEdges()).toHaveLength(0);
});
test('full original source metadata remains protected even when excluded from the model view', async () => {
  const f = await fixture(); Object.assign(f.source.metadata, { privatePayload: 'Authorization: Bearer synthetic-protected-fixture' });
  const fake = readings(); await expect(run(f)).rejects.toMatchObject({ problem: 'credential-material' }); expect(fake.requests).toHaveLength(0);
});
test('fresh same-value replacement owns a new row and raw numeric privacy admission still applies', async () => {
  const f = await fixture(); await f.store.replaceSourceRecord(f.source);
  const replacement = f.store.getSource(f.source.id)!;
  expect(replacement).not.toBe(f.source); expect(replacement).toEqual(f.source);
  const fake = readings();
  // Replacement is arbitrary raw input. If its numeric clock collides with the
  // card policy, restoration must remain held rather than regain old provenance.
  try { assertJudgmentInput(f.store.getSourceSnapshot({ id: replacement.id }).raw); } catch (error) {
    expect(error).toBeInstanceOf(JudgmentInputError);
    await expect(run(f)).rejects.toMatchObject({ problem: 'card-material' });
    expect(fake.requests).toHaveLength(0); return;
  }
  const linked = await run(f);
  expect(linked[0]?.edge).toMatchObject({ fromId: replacement.id, toId: f.device.id });
  expect(f.store.getSource(replacement.id)).toBe(replacement);
});

test('auto-link reads complete canonical rows under an adversarial colliding owned clock', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(4_222_222_222_222);
  try { const f = await fixture(); const fake = readings();
    expect((await run(f))[0]?.edge).toMatchObject({ fromId: f.source.id, toId: f.device.id });
    expect(fake.requests.length).toBeGreaterThan(0);
  } finally { clock.mockRestore(); }
});

test('benign source-array extras retain exact lifetime without a lossy snapshot hold', async () => {
  const f = await fixture(); const fake = readings();
  const sources = Object.assign([f.source], { note: 'caller sequence annotation' });
  const linked = await autoLinkHomeGraphSources({ store: f.store, spaceId, installationId, sources,
    state: readHomeGraphState(f.store, spaceId), extractionBySourceId: new Map([[f.source.id, f.extraction]]) });
  expect(linked).toHaveLength(1); expect(fake.requests.length).toBeGreaterThan(0);
});


test.each(['uncertain', 'source-change'] as const)('actual snapshot sync commits raw capture but no unauthorized enrichment on %s', async failure => {
  const clock = spyOn(Date, 'now').mockReturnValue(4_222_222_222_222);
  try {
  const root = mkdtempSync(join(tmpdir(), 'homegraph-sync-raw-admission-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath }); await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const source = await store.upsertSource({ id: 'sync-manual', connectorId: 'fixture', sourceType: 'manual',
    status: 'indexed', title: 'Network equipment manual', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text',
    sections: ['Instructions for the hallway network equipment.'], metadata: { knowledgeSpaceId: spaceId } });
  const fake = readings(failure === 'uncertain' ? 0.5 : 0.99); let observedCommittedDevice = false;
  installJudgmentPort({ ...fake.port, async ask(request) {
    if (!observedCommittedDevice && request.context?.site === 'engine.knowledge.homegraph-document-subject') {
      const device = store.listNodesInSpace(spaceId).find(node => node.kind === 'ha_device')!;
      expect(device).toBeDefined();
      expect(store.getRecordSnapshot('node', device.id).record).toEqual(device);
      observedCommittedDevice = true;
      if (failure === 'source-change') await store.upsertSource({ ...source, title: 'Concurrent revised manual' });
    }
    return fake.port.ask(request);
  } });
  await expect(runHomeGraphSnapshotSync({ store, artifactStore, snapshot: { installationId,
    devices: [{ id: 'hallway-router', name: 'Hall network box', model: 'WX-9900' }] },
  })).rejects.toMatchObject({ reason: failure === 'uncertain' ? 'uncertain' : 'stale' });
  expect(observedCommittedDevice).toBe(true);
  expect(store.listEdges().filter(edge => edge.fromKind === 'source' && edge.fromId === source.id)).toHaveLength(0);
  expect(store.listSources().filter(item => item.metadata.homeGraphSourceKind === 'generated-page')).toHaveLength(0);
  const reopened = new KnowledgeStore({ dbPath }); await reopened.init();
  try {
    expect(reopened.listNodesInSpace(spaceId).some(node => node.kind === 'ha_device')).toBe(true);
    expect(reopened.listEdges().filter(edge => edge.fromKind === 'source' && edge.fromId === source.id)).toHaveLength(0);
    expect(reopened.listSources().filter(item => item.metadata.homeGraphSourceKind === 'generated-page')).toHaveLength(0);
    expect(reopened.getSource(source.id)?.title).toBe(failure === 'source-change' ? 'Concurrent revised manual' : source.title);
  } finally { await reopened.close(); await store.close(); }
  } finally { clock.mockRestore(); }
});


test('all authored document kind and subject fixtures settle their exact expected outcomes', async () => {
  for (const battery of [homeGraphDocumentKind, homeGraphDocumentSubject]) {
    const fake = fakePort((name, question, state) => {
      const fixture = battery.fixtures.find(item => JSON.stringify(item.state) === JSON.stringify(state));
      const expected = (fixture?.expect as Readonly<Record<string, string | undefined>> | undefined)?.[name];
      if (expected === undefined) throw new Error(`Unexpected document fixture question: ${name}`);
      return name === 'relation' ? choiceAnswer(question, expected, 0.99) : noulAnswer(expected === 'yes' ? 0.99 : 0.01);
    });
    const results = await battery.checkFixtures(fake.port);
    expect(results).toHaveLength(battery.fixtures.reduce((count, fixture) => count + Object.keys(fixture.expect).length, 0));
    expect(results.every(result => result.correct && result.outcome === 'act')).toBe(true);
  }
});

test.each([
  ['has_receipt', 'Purchase receipt', 'Payment received for one WX-9900 router. Item USD 80.00, tax USD 6.00, total paid USD 86.00. This records the completed sale.'],
  ['has_warranty', 'Limited warranty', 'The WX-9900 router is warranted against defects in materials and workmanship for two years from original purchase. The manufacturer will repair or replace a defective unit upon proof of purchase; accidental damage is excluded.'],
  ['source_for', 'Home Assistant WX Network integration', 'In Home Assistant, choose Settings, Devices and services, Add integration, then WX Network. Configure the router hostname to create connectivity and connected-clients sensors. This documents the integration, not the router owner manual.'],
] as const)('actual consumer publishes the exact %s relation for authored %s evidence', async (relation, title, body) => {
  const f = await fixture();
  const integration = relation === 'source_for';
  const target = integration ? await seedHomeAssistantObservation(f.store, { id: 'wx-integration', kind: 'ha_integration', slug: 'wx-network',
    title: 'WX Network', status: 'active', metadata: { knowledgeSpaceId: spaceId, installationId } }) : f.device;
  await f.store.upsertSource({ ...f.source, title });
  await f.store.upsertExtraction({ ...f.extraction, sections: [body] });
  const fake = fakePort((name, question, state) => {
    const input = state as { source?: { extraction?: { sections?: string[] } }; candidate?: { subject?: { title?: string } } };
    expect(input.source?.extraction?.sections).toEqual([body]);
    if (name === 'relation') return choiceAnswer(question, relation, 0.99);
    if (name === 'manual') return noulAnswer(0.01);
    if (name === 'integrationDocumentation') return noulAnswer(integration ? 0.99 : 0.01);
    if (name === 'selected') return noulAnswer(input.candidate?.subject?.title === target.title ? 0.99 : 0.01);
    throw new Error(`Unexpected authored consumer question: ${name}`);
  });
  installJudgmentPort(fake.port);
  const linked = await run(f);
  expect(linked).toHaveLength(1);
  expect(linked[0]!.edge).toMatchObject({ fromKind: 'source', fromId: f.source.id, toKind: 'node', toId: target.id, relation });
  expect(f.store.listEdges()).toHaveLength(1);
  expect(fake.requests.some(request => 'selected' in request.questions)).toBe(true);
  expect(fake.requests.some(request => 'integrationDocumentation' in request.questions)).toBe(true);
});
