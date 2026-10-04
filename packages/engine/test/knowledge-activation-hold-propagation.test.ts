import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeNodeActivationHeldError } from '../sdk/src/platform/knowledge/activation/types.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { buildHomeGraphMetadata, isGeneratedPageSource } from '../sdk/src/platform/knowledge/home-graph/helpers.js';
import { refreshDevicePagesForHomeGraphAsk } from '../sdk/src/platform/knowledge/home-graph/ask-page-refresh.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { promoteRepairSources } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';

const spaceId = 'homeassistant:activation-propagation', installationId = 'activation-propagation';
const initialText = 'The laboratory recorded a sample from the reference device for later examination.';
const capturedText = `${initialText}\n\nAC-7 resolution: 4K.`;
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function metadata(extra: Record<string, unknown> = {}) { return buildHomeGraphMetadata(spaceId, installationId, extra); }
function snapshot(store: KnowledgeStore) {
  return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), sources: store.listSources(),
    extractions: store.listExtractions(), issues: store.listIssues(), tasks: store.listRefinementTasks(),
    revisions: store.listNodes().flatMap((node) => store.listNodeRevisions(node.id)) });
}
async function fixture(excerpt = initialText) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-activation-propagation-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath });
  await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const observed = { id: 'device', kind: 'ha_device' as const, slug: 'device', title: 'AC-7', status: 'active' as const,
    metadata: metadata({ model: 'AC-7', entityKind: 'device', homeAssistant: { objectId: 'device', objectKind: 'device' } }) };
  const device = await upsertObservedKnowledgeNode(store, observed, 'home-assistant-snapshot', observed, () => observed);
  const source = await store.upsertSource({ id: 'manual', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 manual',
    status: 'indexed', canonicalUri: 'https://example.test/ac-seven', metadata: metadata() });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt, metadata: metadata() });
  installJudgmentPort(fakePort((name) => {
    if (name === 'serve') return noulAnswer(0.99);
    throw new Error(`Unscripted seed question: ${name}`);
  }).port);
  const fact = await store.upsertNode({ id: 'existing-fact', kind: 'fact', slug: 'existing-fact', title: 'Sample observation',
    summary: excerpt, sourceId: source.id, metadata: metadata({ semanticKind: 'fact', factKind: 'specification',
      value: excerpt, evidence: excerpt, sourceId: source.id, subjectIds: [device.id] }) });
  const protectedSource = await store.upsertSource({ id: 'protected-source', connectorId: 'synthetic', sourceType: 'manual',
    title: 'Operator reference', status: 'indexed', metadata: metadata() });
  await store.upsertExtraction({ sourceId: protectedSource.id, extractorId: 'synthetic', format: 'text', excerpt: initialText, metadata: metadata() });
  const protectedFacts = [];
  for (const decision of ['accept', 'reject'] as const) {
    const node = await store.upsertNode({ ...fact, id: `protected-${decision}`, slug: `protected-${decision}`, sourceId: protectedSource.id,
      metadata: metadata({ semanticKind: 'fact', factKind: 'note', evidence: initialText }) });
    await reviewKnowledgeNodeRecord(store, { id: node.id, decision, reviewer: 'fixture-operator' });
    protectedFacts.push(store.getNode(node.id)!);
  }
  return { store, artifactStore, device, source, fact, protectedFacts,
    async reload() { const reopened = new KnowledgeStore({ dbPath }); await reopened.init(); return reopened; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function ask(item: Fixture, includeFact = true) {
  return refreshDevicePagesForHomeGraphAsk({ ...item, spaceId, installationId, answer: { ok: true, spaceId, query: 'What was observed?', results: [],
    answer: { text: initialText, mode: 'standard', confidence: 99, sources: [item.source], facts: includeFact ? [item.fact] : [], linkedObjects: [item.device] } } });
}
function askReadings(serve: number) {
  const fake = fakePort((name, question) => {
    if (name === 'authority') return choiceAnswer(question, 'official-vendor', 0.99);
    if (name === 'useful') return noulAnswer(0.99);
    if (name === 'serve') return noulAnswer(serve);
    if (name === 'wanted') return noulAnswer(0.01);
    if (['manufacturerPresent', 'modelPresent', 'batteryApplicable', 'batteryTypePresent'].includes(name)) return noulAnswer(0.01);
    throw new Error(`Unscripted Ask question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
function expectProtected(store: KnowledgeStore, item: Fixture) {
  for (const fact of item.protectedFacts) expect(store.getNode(fact.id)).toEqual(fact);
}

describe('required activation holds across knowledge refresh catches', () => {
  test('Ask propagates an explicit activation no and never generates a passport or claims a refresh', async () => {
    const item = await fixture('AC-7 supports 4K UHD resolution.'), fake = askReadings(0.01);
    await expect(ask(item)).rejects.toMatchObject({ name: 'KnowledgeNodeActivationHeldError', reason: 'no' });
    expect(fake.requests.filter((request) => 'serve' in request.questions)).toHaveLength(1);
    const reopened = await item.reload();
    expect(reopened.getNode(item.fact.id)).toEqual(item.fact);
    expectProtected(reopened, item);
    // Source capture/linking settled before the required fact write; retain that prefix.
    expect(reopened.getSource(item.source.id)).not.toBeNull();
    expect(reopened.listEdges().map((edge) => edge.relation)).toEqual(['source_for']);
    expect(reopened.listNodes().filter((node) => node.kind === 'ha_device_passport')).toHaveLength(0);
    expect(reopened.listSources().filter(isGeneratedPageSource)).toHaveLength(0);
    expect(item.artifactStore.list()).toHaveLength(0);
  });

  test('Ask propagates a required profile activation hold from the passport refresh catch too', async () => {
    const item = await fixture('AC-7 resolution: 4K.');
    const fake = fakePort((name, question, state) => {
      const input = state as { category?: { title: string } };
      if (name === 'authority') return choiceAnswer(question, 'official-vendor', 0.99);
      if (name === 'wanted') return noulAnswer(input.category?.title === 'Display and picture specifications' ? 0.99 : 0.01);
      if (name === 'serve') return noulAnswer(0.5);
      if (['useful', 'selected', 'profileSupported', 'supported', 'attached'].includes(name)) return noulAnswer(0.99);
      throw new Error(`Unscripted passport question: ${name}`);
    });
    installJudgmentPort(fake.port);
    await expect(ask(item, false)).rejects.toMatchObject({ name: 'KnowledgeNodeActivationHeldError', reason: 'uncertain' });
    const reopened = await item.reload();
    expect(reopened.getNode(item.fact.id)).toEqual(item.fact);
    expectProtected(reopened, item);
    expect(reopened.listNodes().filter((node) => node.kind === 'ha_device_passport')).toHaveLength(0);
    expect(reopened.listSources().filter(isGeneratedPageSource)).toHaveLength(0);
    expect(item.artifactStore.list()).toHaveLength(0);
  });

  test('Ask retains its ordinary bookkeeping failure fallback and honestly counts the generated passport', async () => {
    const item = await fixture('AC-7 supports 4K UHD resolution.'); askReadings(0.99);
    const applyPreparedIngest = item.store.applyPreparedIngest.bind(item.store);
    let injected = false;
    item.store.applyPreparedIngest = async (input, prepareGraph, options) => applyPreparedIngest(input, async (stage) => {
      const graph = await prepareGraph(stage);
      if (graph.nodes.some((node) => node.id === item.fact.id)) {
        injected = true;
        throw new Error('Synthetic bookkeeping write unavailable');
      }
      return graph;
    }, options);
    expect(await ask(item)).toEqual({ requested: true, refreshed: 1 });
    expect(injected).toBe(true);
    const reopened = await item.reload();
    expect(reopened.getNode(item.fact.id)).toEqual(item.fact);
    expectProtected(reopened, item);
    expect(reopened.listNodes().filter((node) => node.kind === 'ha_device_passport')).toHaveLength(1);
    expect(reopened.listSources().filter(isGeneratedPageSource)).toHaveLength(1);
    expect(item.artifactStore.list()).toHaveLength(1);
  });

  test('repair propagates a real enrichment activation hold without fallback, while retaining raw capture and earlier links', async () => {
    const item = await fixture(), { gap, task } = await repairTask(item);
    let phase: 'promotion' | 'enrichment' | 'fallback' = 'promotion';
    const fake = repairReadings(() => phase);
    let held: unknown, atHold = '', requestsAtHold = 0, earlierLink = false;
    const pending = promoteRepairSources({ store: item.store, enrichSource: async (_sourceId, options) => {
      // The earlier independently settled subject-link phase remains durable.
      earlierLink = item.store.listEdges().some((edge) => edge.fromId === item.fact.id && edge.relation === 'describes');
      await captureRepairText(item);
      phase = 'enrichment';
      try {
        return await enrichKnowledgeSource({ store: item.store, llm: {
          async completeJson() {
            return { facts: [{ kind: 'specification', title: 'Enrichment display claim', value: '4K',
              summary: 'AC-7 resolution: 4K.', evidence: 'AC-7 resolution: 4K.', confidence: 99 }] };
          },
          async completeText() { throw new Error('Unexpected free-text completion'); },
        } }, item.store.getSource(item.source.id)!, options);
      } catch (error) {
        held = error; atHold = snapshot(item.store); requestsAtHold = fake.requests.length; throw error;
      } finally { phase = 'fallback'; }
    } }, spaceId, gap, [item.source.id], task, Date.now() + 10_000);
    await expect(pending).rejects.toBeInstanceOf(KnowledgeNodeActivationHeldError);
    expect(held).toMatchObject({ reason: 'no' });
    expect(earlierLink).toBe(true);
    expect(atHold).not.toBe(''); expect(snapshot(item.store)).toBe(atHold);
    expect(fake.requests).toHaveLength(requestsAtHold);
    expect(item.store.getSemanticEnrichmentState(item.source.id)).toBeNull();
    const reopened = await item.reload();
    expect(snapshot(reopened)).toBe(atHold);
    expect(reopened.getExtractionBySourceId(item.source.id)?.excerpt).toBe(capturedText);
    expect(reopened.getRefinementTask(task.id)).toEqual(task);
    expectProtected(reopened, item);
  });

  test('repair still promotes captured evidence and updates its task after an ordinary enrichment failure', async () => {
    const item = await fixture(), { gap, task } = await repairTask(item);
    let phase: 'promotion' | 'fallback' = 'promotion';
    repairReadings(() => phase);
    const result = await promoteRepairSources({ store: item.store, enrichSource: async () => {
      await captureRepairText(item); phase = 'fallback'; throw new Error('Synthetic extraction worker unavailable');
    } }, spaceId, gap, [item.source.id], task, Date.now() + 10_000);
    expect(result).toEqual({ promotedFactCount: 2, repairComplete: false, promotedSourceIds: [item.source.id] });
    const reopened = await item.reload();
    const promoted = reopened.listNodes().find((node) => node.title === 'Display and picture specifications');
    expect(promoted?.status).toBe('active');
    expect(reopened.listEdges().some((edge) => edge.fromId === promoted?.id && edge.toId === item.device.id && edge.relation === 'describes')).toBe(true);
    const currentTask = reopened.getRefinementTask(task.id)!;
    expect(currentTask.state).toBe('applying'); expect(currentTask.promotedFactCount).toBe(2);
    expect(currentTask.trace.some((entry) => entry.message === 'Repair source enrichment did not finish for one accepted source.')).toBe(true);
    expectProtected(reopened, item);
  });
});

async function repairTask(item: Fixture) {
  const observed = { id: 'repair-gap', kind: 'knowledge_gap' as const, slug: 'repair-gap', title: 'Full AC-7 specifications',
    status: 'active' as const, metadata: metadata({ linkedObjectIds: [item.device.id] }) };
  const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
  const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
  return { gap, task };
}
async function captureRepairText(item: Fixture) {
  await item.store.upsertExtraction({ sourceId: item.source.id, extractorId: 'synthetic', format: 'text', excerpt: capturedText, metadata: metadata({ capturedBy: 'repair-worker' }) });
}
function repairReadings(phase: () => string) {
  const fake = fakePort((name, question, state) => {
    const item = state as { category?: { title: string }; candidate?: { text?: string } };
    if (name === 'authority') return choiceAnswer(question, 'secondary', 0.99);
    if (name === 'wanted') return noulAnswer(phase() === 'fallback' && item.category?.title === 'Display and picture specifications' ? 0.99 : 0.01);
    if (name === 'selected') return noulAnswer(item.candidate?.text === 'AC-7 resolution: 4K.' ? 0.99 : 0.01);
    if (name === 'serve') return noulAnswer(phase() === 'enrichment' ? 0.01 : 0.99);
    if (['useful', 'repairUseful', 'profileSupported', 'supported', 'attached'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unscripted repair question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
