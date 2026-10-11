import { repairSubjectFixtureReading } from './_helpers/repair-subject-fixture-readings.js';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { createKnowledgeFactQualityReader } from '../sdk/src/platform/knowledge/semantic/fact-quality.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { classifyGap } from '../sdk/src/platform/knowledge/semantic/self-improvement-gap-context.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import type { KnowledgeSemanticLlm } from '../sdk/src/platform/knowledge/semantic/types.js';
const spaceId = 'fact-quality-callers';
const sourceText = 'Model K has a mass of 12 kg. Model K does not support Bluetooth. Replace its filter every six months.';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function readings(probability = 0.99) {
  const fake = fakePort((name, _question, state) => {
    if (name === 'repairSubjectSelected') return noulAnswer(repairSubjectFixtureReading(state));
    const input = state as { fact?: { title?: string; value?: unknown } };
    if (name === 'repairUseful') return noulAnswer(input.fact?.title === 'Mass' && input.fact.value === '12 kg' ? probability : 0.01);
    if (['supported', 'attached', 'serve'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unscripted fact-quality question ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
async function fixture() {
  readings();
  const root = mkdtempSync(join(tmpdir(), 'knowledge-fact-quality-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const raw = { id: 'model-k', kind: 'ha_device' as const, slug: 'model-k', title: 'Model K', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, model: 'Model K' } };
  const subject = await upsertObservedKnowledgeNode(store, raw, 'home-assistant-snapshot', raw, () => raw);
  const source = await store.upsertSource({ id: 'model-k-manual', connectorId: 'fixture', sourceType: 'manual', title: 'Model K manual', status: 'indexed',
    metadata: { knowledgeSpaceId: spaceId, sourceDiscovery: { linkedObjectIds: [subject.id] } } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', excerpt: sourceText, metadata: { knowledgeSpaceId: spaceId } });
  const fact = await store.upsertNode({ id: 'mass', kind: 'fact', slug: 'mass', title: 'Mass', summary: 'Model K has a mass of 12 kg.', sourceId: source.id, status: 'active',
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', value: '12 kg', evidence: 'Model K has a mass of 12 kg.', subject: subject.title,
      sourceIds: [source.id], subjectIds: [subject.id], linkedObjectIds: [subject.id], extractor: 'repair-promotion' } });
  const observed = { id: 'mass-gap', kind: 'knowledge_gap' as const, slug: 'mass-gap', title: 'What is the mass of Model K?', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, repairStatus: 'repaired', linkedObjectIds: [subject.id] } };
  const gap = await upsertObservedKnowledgeNode(store, observed, 'research-task', observed, () => observed);
  return { store, subject, source, extraction, fact, gap };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function snapshot(item: Fixture) { return JSON.stringify({ nodes: item.store.listNodes(), sources: item.store.listSources(), edges: item.store.listEdges(), issues: item.store.listIssues(), semantic: item.store.getSemanticEnrichmentState(item.source.id) }); }
const llm: KnowledgeSemanticLlm = { async completeText() { return null; }, async completeJson() {
  return { entities: [], facts: [{ kind: 'specification', title: 'Mass', value: '12 kg', summary: 'Model K has a mass of 12 kg.', evidence: 'Model K has a mass of 12 kg.' }], relations: [], gaps: [] };
} };
function reader(item: Fixture, signal?: AbortSignal) { return createKnowledgeFactQualityReader(item.store, { spaceId, query: 'Model K reference', subjects: [item.subject], signal }); }

describe('shared fact quality at live callers', () => {
  test('enrichment accepts a concrete mass claim without any old feature keyword and renders it', async () => {
    const item = await fixture(); const fake = readings();
    const result = await enrichKnowledgeSource({ store: item.store, llm }, item.source, { force: true });
    expect(result.facts.some((fact) => fact.metadata.value === '12 kg')).toBe(true);
    expect(result.wikiPage?.metadata.markdown).toContain('12 kg');
    expect(fake.requests.filter((request) => 'repairUseful' in request.questions)).toHaveLength(1);
    expect(JSON.stringify(fake.requests)).toContain(sourceText);
  });
  test('negative enrichment does not reintroduce rejected claims through fallback page text', async () => {
    const item = await fixture(); readings(0.01);
    const result = await enrichKnowledgeSource({ store: item.store, llm }, item.source, { force: true });
    expect(result.facts).toHaveLength(0);
    expect(result.wikiPage?.metadata.markdown).not.toContain('12 kg');
  });
  test('missing, malformed and unsettled enrichment preserves all previous records and state', async () => {
    for (const mode of ['missing', 'malformed', 'unsettled'] as const) {
      const item = await fixture(); const fake = readings(mode === 'unsettled' ? 0.5 : 0.99);
      if (mode === 'missing') installJudgmentPort(undefined);
      if (mode === 'malformed') installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request);
        return 'repairUseful' in request.questions ? { ...result, answers: {} } as typeof result : result; } });
      const before = snapshot(item);
      await expect(enrichKnowledgeSource({ store: item.store, llm }, item.source, { force: true })).rejects.toThrow();
      expect(snapshot(item)).toBe(before);
    }
  });
  test('cancellation or replaced subject/source during enrichment readings prevents writes', async () => {
    for (const mutation of ['abort', 'subject', 'source', 'port'] as const) {
      const item = await fixture(), controller = new AbortController(), fake = readings(); let changed = false;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if ('repairUseful' in request.questions && !changed) {
          changed = true;
          if (mutation === 'abort') controller.abort();
          if (mutation === 'subject') await item.store.replaceNodeRecord({ ...item.subject, title: 'Replacement model' });
          if (mutation === 'source') await item.store.replaceSourceRecord({ ...item.source, status: 'stale' });
          if (mutation === 'port') installJudgmentPort(fake.port);
        }
        return result;
      } });
      await expect(enrichKnowledgeSource({ store: item.store, llm }, item.source, { force: true, signal: controller.signal })).rejects.toThrow();
      expect(item.store.listNodes().filter((node) => node.metadata.semanticKind === 'wiki_page')).toHaveLength(0);
      expect(item.store.getSemanticEnrichmentState(item.source.id)).toBeNull();
      expect(item.store.getNode(item.fact.id)).toEqual(item.fact);
    }
  });
  test('port retirement inside the final prepared-node await cannot commit a late fact', async () => {
    const item = await fixture(); const fake = readings(); const original = item.store.upsertPreparedNode.bind(item.store);
    const write = spyOn(item.store, 'upsertPreparedNode').mockImplementation(async (...args) => { installJudgmentPort({ ...fake.port }); return original(...args); });
    const before = snapshot(item);
    try { await expect(enrichKnowledgeSource({ store: item.store, llm }, item.source, { force: true })).rejects.toThrow(); }
    finally { write.mockRestore(); }
    expect(snapshot(item)).toBe(before);
  });
  test('repaired gap classification awaits actual useful facts instead of keyword guesses', async () => {
    const item = await fixture(); readings();
    const context = { gap: item.gap, sources: [item.source], linkedObjects: [item.subject], facts: [item.fact], repairSourceIds: [item.source.id] };
    const result = await classifyGap(context, false, [], item.store);
    expect(result.status).toBe('repaired'); result.assertCurrent?.();
    readings(0.01);
    expect((await classifyGap(context, false, [], item.store)).action).toBe('repair');
    installJudgmentPort(undefined);
    await expect(classifyGap(context, false, [], item.store)).rejects.toMatchObject({ reason: 'unconfigured' });
  });
  test('complete late candidate privacy preflight precedes both page and canonical requests', async () => {
    const item = await fixture(); const fake = readings();
    const protectedFact = { ...item.fact, id: 'proposal', metadata: { ...item.fact.metadata, evidence: { password: 'fixture-protected' } } };
    const quality = createKnowledgeFactQualityReader(item.store, { spaceId, query: 'Model K page', subjects: [item.subject], proposedFacts: new Set([protectedFact]) });
    await expect(quality.prepare([item.fact, protectedFact])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('a prepared plan keeps exact row, source, subject, policy and graph authority at final consumption', async () => {
    const item = await fixture(); readings(); const quality = await reader(item).prepare([item.fact]);
    expect(quality.accepts(item.fact)).toBe(true);
    await item.store.replaceSourceRecord({ ...item.source, title: 'Retired evidence' });
    expect(() => quality.accepts(item.fact)).toThrow();
  });
});

test('active graph-only provenance is read rather than silently filtered', async () => {
  const item = await fixture(); readings();
  const { reviewKnowledgeNodeRecord } = await import('../sdk/src/platform/knowledge/service-node-admin.js');
  const draft = await item.store.upsertNode({ id: 'graph-only', kind: 'fact', slug: 'graph-only', title: 'Mass', summary: 'Model K has a mass of 12 kg.', status: 'draft',
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', value: '12 kg', evidence: 'Model K has a mass of 12 kg.' } });
  await reviewKnowledgeNodeRecord(item.store, { id: draft.id, decision: 'accept' });
  await item.store.upsertEdge({ fromKind: 'source', fromId: item.source.id, toKind: 'node', toId: draft.id, relation: 'supports_fact' });
  const current = item.store.getNode(draft.id)!;
  expect(current.sourceId).toBeUndefined(); expect(current.metadata.sourceIds).toBeUndefined();
  const plan = await reader(item).prepare([current]);
  expect(plan.accepts(current)).toBe(true);
});

test('acknowledged proposal writes advance only their own rows and retain unrelated bindings', async () => {
  const item = await fixture(); readings();
  const proposal = { ...item.fact, id: 'new-mass', slug: 'new-mass' };
  const quality = await createKnowledgeFactQualityReader(item.store, { spaceId, query: 'Model K specifications', subjects: [item.subject],
    proposedFacts: new Set([proposal]) }).prepare([item.fact, proposal]);
  const written = await item.store.upsertNode(proposal);
  quality.acknowledgeWritten(written);
  const edge = await item.store.upsertEdge({ fromKind: 'source', fromId: item.source.id, toKind: 'node', toId: written.id, relation: 'supports_fact' });
  quality.acknowledgeEdgeWritten(edge); quality.assertCurrent();
  const { reviewKnowledgeNodeRecord } = await import('../sdk/src/platform/knowledge/service-node-admin.js');
  await reviewKnowledgeNodeRecord(item.store, { id: item.fact.id, decision: 'reject' });
  expect(() => quality.assertCurrent()).toThrow();
  expect(item.store.getNode(written.id)).toBe(written);
});

test('unavailable repaired-gap quality leaves preexisting refinement task untouched', async () => {
  const item = await fixture();
  await item.store.upsertEdge({ fromKind: 'source', fromId: item.source.id, toKind: 'node', toId: item.fact.id, relation: 'supports_fact' });
  await item.store.upsertEdge({ fromKind: 'source', fromId: item.source.id, toKind: 'node', toId: item.gap.id, relation: 'repairs_gap' });
  const { runKnowledgeSemanticSelfImprovement } = await import('../sdk/src/platform/knowledge/semantic/self-improvement.js');
  const { upsertRefinementTaskForGap } = await import('../sdk/src/platform/knowledge/semantic/self-improvement-tasks.js');
  await upsertRefinementTaskForGap(item.store, spaceId, { gap: item.gap, sources: [item.source], linkedObjects: [item.subject] }, 'manual', 'blocked', 'Existing task must remain unchanged.');
  const before = JSON.stringify(item.store.listRefinementTasks());
  installJudgmentPort(undefined);
  await expect(runKnowledgeSemanticSelfImprovement({ store: item.store, activeGapRepairs: new Set() },
    { knowledgeSpaceId: spaceId, gapIds: [item.gap.id] })).rejects.toThrow();
  expect(JSON.stringify(item.store.listRefinementTasks())).toBe(before);
});


test('repaired gap classification preserves an existing terminal task after positive reading', async () => {
  const item = await fixture();
  const { upsertRefinementTaskForGap } = await import('../sdk/src/platform/knowledge/semantic/self-improvement-tasks.js');
  const context = { gap: item.gap, sources: [item.source], linkedObjects: [item.subject], facts: [item.fact], repairSourceIds: [item.source.id] };
  const terminal = await upsertRefinementTaskForGap(item.store, spaceId, context, 'manual', 'closed', 'Already completed.');
  const classification = await classifyGap(context, false, [], item.store);
  expect(classification.status).toBe('repaired');
  const result = await upsertRefinementTaskForGap(item.store, spaceId, context, 'manual', 'detected', 'Recheck.', {}, classification.assertCurrent);
  expect(result).toBe(terminal); expect(item.store.getRefinementTask(terminal.id)).toBe(terminal);
});

test('original usefulness retirement during task upsert await preserves previous task', async () => {
  const item = await fixture(); const fake = readings();
  const { upsertRefinementTaskForGap } = await import('../sdk/src/platform/knowledge/semantic/self-improvement-tasks.js');
  const context = { gap: item.gap, sources: [item.source], linkedObjects: [item.subject], facts: [item.fact], repairSourceIds: [item.source.id] };
  const previous = await upsertRefinementTaskForGap(item.store, spaceId, context, 'manual', 'blocked', 'Existing state.');
  const classification = await classifyGap(context, false, [], item.store);
  const original = item.store.upsertRefinementTask.bind(item.store);
  const write = spyOn(item.store, 'upsertRefinementTask').mockImplementation(async (...args) => {
    installJudgmentPort({ ...fake.port }); return original(...args);
  });
  try { await expect(upsertRefinementTaskForGap(item.store, spaceId, context, 'manual', 'detected', 'Recheck.', {}, classification.assertCurrent)).rejects.toThrow(); }
  finally { write.mockRestore(); }
  expect(item.store.getRefinementTask(previous.id)).toBe(previous);
});

test('negative usefulness classification retains authority through task commit', async () => {
  const item = await fixture(); const fake = readings(0.01);
  const context = { gap: item.gap, sources: [item.source], linkedObjects: [item.subject], facts: [item.fact], repairSourceIds: [item.source.id] };
  const classification = await classifyGap(context, false, [], item.store);
  expect(classification.action).toBe('repair'); expect(classification.assertCurrent).toBeDefined();
  const { upsertRefinementTaskForGap } = await import('../sdk/src/platform/knowledge/semantic/self-improvement-tasks.js');
  const original = item.store.upsertRefinementTask.bind(item.store);
  const write = spyOn(item.store, 'upsertRefinementTask').mockImplementation(async (...args) => { installJudgmentPort({ ...fake.port }); return original(...args); });
  try { await expect(upsertRefinementTaskForGap(item.store, spaceId, context, 'manual', 'detected', 'Negative evidence requires repair.', {}, classification.assertCurrent)).rejects.toThrow(); }
  finally { write.mockRestore(); }
  expect(item.store.listRefinementTasks()).toHaveLength(0);
});
