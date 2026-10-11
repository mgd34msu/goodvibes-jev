import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { buildDevicePageProfileFacts, devicePageProfileFactInput } from '../sdk/src/platform/knowledge/home-graph/page-profile-facts.js';
import { createHomeGraphPageSourceReader } from '../sdk/src/platform/knowledge/home-graph/page-quality.js';
import { prepareSourceLinkedRepairProfileFacts, promoteRepairSources } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { deriveRepairProfileFactPass, repairProfileSourceText } from '../sdk/src/platform/knowledge/semantic/repair-profile.js';
import { captureKnowledgeSourceReferences, registerGeneratedKnowledgeSourceReferences, registerGeneratedKnowledgeExtractionReferences } from '../sdk/src/platform/knowledge/source-structural-references.js';
import { KnowledgeRepairProfileHeldError } from '../sdk/src/platform/knowledge/semantic/repair-profile/types.js';
import { KnowledgeSourceQualityHeldError, isKnowledgeSourceQualityFailure } from '../sdk/src/platform/knowledge/source-quality.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
const spaceId = 'homeassistant:profile-readings';
const display = 'Display and picture specifications', ports = 'Input and output ports';
const first = 'AC-7 resolution: 4K.', last = 'AC-7 has four HDMI inputs.';
const text = `${first}\n\n${last}`;
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type State = { category?: { title: string }; candidate?: { text?: string }; text?: string; fact?: { title: string; value?: unknown; evidence?: unknown } };
function readings(mode: 'yes' | 'uncertain' | 'unsupported' = 'yes', values: readonly (readonly [string, string])[] = [[display, first], [ports, last]]) {
  const fake = fakePort((name, question, state) => {
    const item = state as State;
    if (name === 'wanted') return noulAnswer(values.some(([category]) => category === item.category?.title) ? 0.99 : 0.01);
    if (name === 'selected') return noulAnswer(values.some(([category, value]) => category === item.category?.title && value === item.candidate?.text) ? 0.99 : 0.01);
    if (name === 'profileSupported') return noulAnswer(item.candidate?.text === last && mode !== 'yes' ? mode === 'uncertain' ? 0.5 : 0.01 : 0.99);
    if (name === 'repairUseful') return noulAnswer(values.some(([category, value]) => item.fact?.title === category && item.fact?.value === value)
      || (item.fact?.title === 'Network and wireless capabilities' && item.fact?.evidence === 'AC-7 supports Bluetooth wireless connectivity.') ? 0.99 : 0.01);
    if (name === 'authority') return choiceAnswer(question, 'secondary', 0.99);
    if (['useful', 'supported', 'attached', 'serve'].includes(name)) return noulAnswer(0.99); // Authored claims are exact AC-7 excerpts.
    throw new Error(`Unscripted profile boundary question ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-profile-readings-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const observed = { id: 'device-ac-seven', kind: 'ha_device' as const, slug: 'ac-seven', title: 'AC-7', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, model: 'AC-7', manufacturer: 'Synthetic', entityKind: 'device' } };
  const device = await upsertObservedKnowledgeNode(store, observed, 'home-assistant-snapshot', observed, () => observed);
  const source = await store.upsertSource({ id: 'source-ac-seven', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 specifications',
    canonicalUri: 'https://example.test/ac-seven/specifications', status: 'indexed', metadata: { knowledgeSpaceId: spaceId, privateMetadata: 'NEVER_TRANSMIT', sourceDiscovery: { linkedObjectIds: [device.id] } } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: text, sections: [], metadata: { knowledgeSpaceId: spaceId } });
  return { store, device, source, extraction };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function snapshot(store: KnowledgeStore) { return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues(), sources: store.listSources(), extractions: store.listExtractions(), tasks: store.listRefinementTasks() }); }
async function plan(item: Fixture, signal?: AbortSignal) {
  const facts = await buildDevicePageProfileFacts({ ...item, spaceId, installationId: 'profile-readings', sources: [item.source], sourceReader: createHomeGraphPageSourceReader(signal), signal });
  return prepareSourceLinkedRepairProfileFacts(facts.map((fact) => devicePageProfileFactInput(item.store, spaceId, 'profile-readings', item.device, fact)), { signal });
}
async function write(item: Fixture) {
  const prepared = await plan(item);
  return item.store.batch(async () => { prepared.assertCurrent(); return prepared.write(); });
}
describe('repair profile complete-pass write boundaries', () => {
  test('real-store profile writes preserve precise values, support provenance and idempotent record identities', async () => {
    const item = await fixture(); const fake = readings();
    const written = await write(item);
    expect(written).toHaveLength(2); expect(written.map((fact) => fact.metadata.value)).toEqual([first, last]);
    const ids = written.map((fact) => fact.id), edges = item.store.listEdges().map((edge) => edge.id).sort();
    expect((await write(item)).map((fact) => fact.id)).toEqual(ids);
    expect(item.store.listNodes().filter((node) => node.kind === 'fact')).toHaveLength(2);
    expect(item.store.listEdges().map((edge) => edge.id).sort()).toEqual(edges);
    for (const fact of item.store.listNodes().filter((node) => node.kind === 'fact')) {
      expect(fact.sourceId).toBe(item.source.id);
      const support = fact.metadata.generatedFactSupport as { receipts: { sourceId: string; extractionId: string }[] };
      expect(support.receipts.every((receipt) => receipt.sourceId === item.source.id && receipt.extractionId === item.extraction.id)).toBe(true);
    }
    expect(JSON.stringify(fake.requests)).not.toContain('NEVER_TRANSMIT');
  });
  test('accepted and rejected operator state survive profile reruns', async () => {
    for (const decision of ['accept', 'reject'] as const) {
      const item = await fixture(); readings(); const [fact] = await write(item);
      await reviewKnowledgeNodeRecord(item.store, { id: fact!.id, decision, reviewer: 'fixture-operator' });
      const reviewed = item.store.getNode(fact!.id)!;
      try { await write(item); } catch (error) { expect(String(error)).toContain('operator review'); }
      const current = item.store.getNode(fact!.id)!;
      expect(current.status).toBe(decision === 'accept' ? 'active' : 'stale');
      expect(current.metadata.review).toEqual(reviewed.metadata.review);
      expect(current.metadata.reviewProvenance).toEqual(reviewed.metadata.reviewProvenance);
      expect(item.store.listNodes().filter((node) => node.kind === 'fact')).toHaveLength(2);
    }
  });
  test('late unsupported, uncertain, unavailable, unconfigured and pre-aborted passes make zero affected writes', async () => {
    for (const mode of ['unsupported', 'uncertain', 'unavailable', 'unconfigured', 'aborted'] as const) {
      const item = await fixture(), before = snapshot(item.store); const fake = readings(mode === 'unsupported' || mode === 'uncertain' ? mode : 'yes');
      const controller = new AbortController();
      if (mode === 'unconfigured') installJudgmentPort(undefined);
      if (mode === 'unavailable') installJudgmentPort({ ...fake.port, async ask() { throw new Error('synthetic unavailable'); } });
      if (mode === 'aborted') controller.abort();
      await expect(plan(item, controller.signal)).rejects.toThrow();
      expect(snapshot(item.store)).toBe(before);
    }
  });
  test('source, extraction and operator changes during the reading cannot write a stale profile', async () => {
    for (const change of ['source', 'extraction', 'operator'] as const) {
      const item = await fixture(); const fake = readings(); const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let paused = false;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const answer = await fake.port.ask(request);
        if (!paused && 'profileSupported' in request.questions) { paused = true; entered.resolve(); await released.promise; }
        return answer;
      } });
      const pending = plan(item); await entered.promise;
      if (change === 'source') await item.store.replaceSourceRecord({ ...item.source, title: 'Changed model AC-8' });
      if (change === 'extraction') await item.store.upsertExtraction({ sourceId: item.source.id, extractorId: 'synthetic', format: 'text', excerpt: 'AC-8 supports 8K.', metadata: { knowledgeSpaceId: spaceId } });
      if (change === 'operator') await reviewKnowledgeNodeRecord(item.store, { id: item.device.id, decision: 'reject' });
      const afterExternalChange = snapshot(item.store); released.resolve();
      await expect(pending).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
      expect(snapshot(item.store)).toBe(afterExternalChange);
    }
  });
  test('enrichment awaits readings before any generated nodes or semantic-state writes', async () => {
    const item = await fixture(); readings('unsupported'); const before = snapshot(item.store);
    await expect(enrichKnowledgeSource({ store: item.store }, item.source, { force: true })).rejects.toBeInstanceOf(KnowledgeRepairProfileHeldError);
    expect(snapshot(item.store)).toBe(before); expect(item.store.getSemanticEnrichmentState(item.source.id)).toBeNull();
  });
  test('indirect repair enrichment holds propagate without fallback or task writes', async () => {
    const item = await fixture();
    const empty = await item.store.upsertSource({ id: 'empty-repair-source', connectorId: 'synthetic', sourceType: 'manual', title: 'No extracted source yet', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
    const observed = { id: 'profile-gap', kind: 'knowledge_gap' as const, slug: 'profile-gap', title: 'Full AC-7 specifications', status: 'active' as const, metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.device.id] } };
    const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
    const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
    readings(); let atHold = '';
    const error = new KnowledgeRepairProfileHeldError('unsettled'); expect(isKnowledgeSourceQualityFailure(error)).toBe(true);
    await expect(promoteRepairSources({ store: item.store, enrichSource: async () => { atHold = snapshot(item.store); throw error; } }, spaceId, gap, [empty.id], task, Date.now() + 5_000)).rejects.toBe(error);
    expect(atHold).not.toBe(''); expect(snapshot(item.store)).toBe(atHold);
  });
  test('canonical profile pass retains distinct display and network spans without legacy value fabrication', async () => {
    const item = await fixture();
    const selected = 'AC-7 refresh rate: 120 Hz.';
    const distinct = 'AC-7 supports Bluetooth wireless connectivity.';
    await item.store.upsertExtraction({ sourceId: item.source.id, extractorId: 'synthetic', format: 'text', excerpt: `${selected} ${distinct}`, metadata: { knowledgeSpaceId: spaceId } });
    const observed = { id: 'exact-span-gap', kind: 'knowledge_gap' as const, slug: 'exact-span-gap', title: 'Full AC-7 specifications', status: 'active' as const, metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.device.id] } };
    const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
    const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
    readings('yes', [[display, selected], ['Network and wireless capabilities', distinct]]);
    for (let repeat = 0; repeat < 2; repeat++) {
      await promoteRepairSources({ store: item.store }, spaceId, gap, [item.source.id], task, Date.now() + 5_000);
      const facts = item.store.listNodes().filter((node) => node.kind === 'fact');
      expect(facts.filter((fact) => fact.title === display)).toHaveLength(1);
      expect(facts.find((fact) => fact.title === display)?.metadata.value).toBe(selected);
      expect(facts.some((fact) => fact.summary?.includes('100/120'))).toBe(false);
      expect(facts.some((fact) => fact.title === 'Network and wireless capabilities' && fact.metadata.evidence === distinct)).toBe(true);
    }
  });
  test('first unavailable and late unsettled or not-useful proposed readings leave no promotion or task writes', async () => {
    for (const mode of ['unavailable', 'uncertain', 'no'] as const) {
      const item = await fixture();
      const observed = { id: 'pending-profile-gap', kind: 'knowledge_gap' as const, slug: 'pending-profile-gap', title: 'Full AC-7 specifications', status: 'active' as const, metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.device.id] } };
      const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
      const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
      const fake = readings(), heldPort = fakePort(() => noulAnswer(mode === 'uncertain' ? 0.5 : 0.01));
      installJudgmentPort({ ...fake.port, async ask(request) {
        if ('repairUseful' in request.questions) {
          if (mode === 'unavailable') throw new Error('Synthetic first usefulness outage');
          if ((request.state as unknown as State).fact?.title === ports) return heldPort.port.ask(request);
        }
        return fake.port.ask(request);
      } });
      const before = snapshot(item.store);
      await expect(promoteRepairSources({ store: item.store }, spaceId, gap, [item.source.id], task, Date.now() + 5_000)).rejects.toMatchObject({ reason: mode === 'no' ? 'not-useful' : mode });
      expect(snapshot(item.store)).toBe(before);
    }
  });
  test('a same-source extraction in another concrete space cannot be read through broad aliases', async () => {
    const item = await fixture();
    const foreign = await item.store.upsertExtraction({ sourceId: item.source.id, extractorId: 'synthetic', format: 'text', excerpt: 'FOREIGN_PRIVATE_EXTRACTION',
      metadata: { knowledgeSpaceId: 'homeassistant:another-house', namespace: 'homeassistant' } });
    const fake = readings();
    const before = snapshot(item.store);
    await expect(buildDevicePageProfileFacts({ ...item, spaceId, installationId: 'profile-readings', sources: [item.source],
      sourceReader: createHomeGraphPageSourceReader() })).rejects.toBeInstanceOf(KnowledgeRepairProfileHeldError);
    expect(fake.requests).toHaveLength(0); expect(snapshot(item.store)).toBe(before);
    await expect(deriveRepairProfileFactPass([{ query: 'AC-7 full profile', source: item.source, extraction: foreign, text: repairProfileSourceText(foreign) }])).rejects.toMatchObject({ reason: 'foreign-space' });
    expect(fake.requests).toHaveLength(0);
  });
  test('actual minted reference projection is bound to stored records, while JSON-shaped proof grants nothing', async () => {
    const item = await fixture();
    const minted = await item.store.upsertSource({ ...item.source, id: '4111111111111111', canonicalUri: 'homegraph://4111111111111111', sourceUri: 'homegraph://4111111111111111' });
    registerGeneratedKnowledgeSourceReferences(item.store, minted, { id: minted.id, canonicalUri: minted.canonicalUri!, sourceUri: minted.sourceUri });
    const extraction = await item.store.upsertExtraction({ sourceId: minted.id, extractorId: 'synthetic', format: 'text', excerpt: text, metadata: { knowledgeSpaceId: spaceId } });
    registerGeneratedKnowledgeExtractionReferences(item.store, minted, extraction, extraction.id);
    const captured = captureKnowledgeSourceReferences(item.store, minted, extraction);
    const fake = readings();
    expect((await deriveRepairProfileFactPass([{ query: 'Full AC-7 specifications', source: minted, extraction, text: repairProfileSourceText(extraction), structuralReferences: captured }]))[0]).toHaveLength(2);
    expect(JSON.stringify(fake.requests)).not.toContain(minted.id);
    const count = fake.requests.length;
    await expect(deriveRepairProfileFactPass([{ query: 'Full AC-7 specifications', source: structuredClone(minted), extraction, text, structuralReferences: structuredClone(captured) }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(count);
  });
});
