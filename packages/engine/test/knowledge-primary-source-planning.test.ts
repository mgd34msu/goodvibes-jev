import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { prepareSourceLinkedRepairProfileFacts, promoteRepairSources, type SourceLinkedRepairProfileFactInput } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { judgmentInputProblem, JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../sdk/src/platform/knowledge/semantic/verification/types.js';
import { createSemanticPrimarySourcePlanner, createSemanticWriteGuard } from '../sdk/src/platform/knowledge/semantic/primary-source-plan.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';
import type { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';
import { semanticFactId, semanticHash } from '../sdk/src/platform/knowledge/semantic/utils.js';
import type { KnowledgeSemanticFactInput, KnowledgeSemanticLlm } from '../sdk/src/platform/knowledge/semantic/types.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

const spaceId = 'primary-plan-space';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function readings(value: (purpose: string, title: string) => number = () => 0.97) {
  const fake = fakePort((name, question, state) => {
    const input = state as { purpose: string; candidate: { title: string } };
    if (name === 'supported' || name === 'attached') return noulAnswer(0.99);
    if (name === 'useful') return noulAnswer(value(input.purpose, input.candidate.title));
    if (name === 'authority') return choiceAnswer(question, 'secondary', 0.97);
    throw new Error(`Unexpected question ${name}`);
  });
  installJudgmentPort(fake.port);
  return fake;
}
async function fixture() {
  const { store } = createStores();
  const subject = await store.upsertNode({ id: 'subject', kind: 'knowledge_entity', slug: 'synthetic-device', title: 'Synthetic TV-123', status: 'active', metadata: { knowledgeSpaceId: spaceId, entityKind: 'device' } });
  const source = await addSource(store, 'current', subject.id);
  const a = await addSource(store, 'a', subject.id);
  const b = await addSource(store, 'b', subject.id);
  return { store, subject, source, a, b };
}
async function addSource(store: KnowledgeStore, id: string, subjectId: string, scope = spaceId) {
  const source = await store.upsertSource({ id, connectorId: 'synthetic', sourceType: 'manual', title: id, status: 'indexed', summary: 'Synthetic reference describing concrete supported device claims in detail.', metadata: { knowledgeSpaceId: scope, sourceDiscovery: { linkedObjectIds: [subjectId] } } });
  const names = ['First claim', 'Second claim', 'Later claim', 'Old shared claim', 'New unique claim', 'Exact display claim', 'Versioned claim', 'Collision claim'];
  const text = [
    'Synthetic TV-123 is also called Fresh entity and Collision in this synthetic fixture. It has four HDMI ports. Four HDMI ports. HDMI ports are 4.',
    'First HDMI claim and Later HDMI claim are section labels for the four HDMI ports. Evidence 0, Evidence 1 and Evidence 2 each report four HDMI ports.',
    ...names.map((name) => `${name} claim supported by the synthetic reference. ${name} evidence.`),
    'Capped claim 0 through Capped claim 160 are synthetic note labels; each claim is supported by the synthetic reference, and each corresponding Capped claim evidence refers to that same statement.',
  ].join(' ');
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: text, metadata: { knowledgeSpaceId: scope } });
  return source;
}
function claim(title: string): KnowledgeSemanticFactInput { return { kind: 'note', title, summary: `${title} claim supported by the synthetic reference.`, evidence: `${title} evidence`, confidence: 90 }; }
async function seedFact(store: KnowledgeStore, subject: KnowledgeNodeRecord, fact: KnowledgeSemanticFactInput, sources: readonly KnowledgeSourceRecord[]) {
  const id = semanticFactId({ spaceId, kind: fact.kind, title: fact.title, summary: fact.summary, value: fact.value, subjectIds: [subject.id], fallbackScope: sources[0]!.id });
  const node = await store.upsertNode({ id, kind: 'fact', slug: id, title: fact.title, summary: fact.summary, status: 'active', sourceId: sources[0]!.id, metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: fact.kind, subjectIds: [subject.id], sourceIds: sources.map((source) => source.id) } });
  for (const source of sources) await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: id, relation: 'supports_fact', metadata: { knowledgeSpaceId: spaceId } });
  return node;
}
function enrich(store: KnowledgeStore, source: KnowledgeSourceRecord, facts: readonly KnowledgeSemanticFactInput[], entities = [{ title: 'Fresh entity', confidence: 90 }]) {
  const llm: KnowledgeSemanticLlm = { async completeJson() { return { entities, facts, relations: [], gaps: [], wikiPage: { markdown: '# Synthetic page' } }; }, async completeText() { return null; } };
  return enrichKnowledgeSource({ store, llm }, source, { force: true, knowledgeSpaceId: spaceId });
}
function graph(store: KnowledgeStore) { return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() }); }
function profileInput(store: KnowledgeStore, source: KnowledgeSourceRecord, subject: KnowledgeNodeRecord, title = 'HDMI ports'): SourceLinkedRepairProfileFactInput {
  return { store, source, extraction: store.getExtractionBySourceId(source.id), spaceId, subjects: [subject], authority: 'secondary', title, summary: 'The device has four HDMI ports.', evidence: 'Four HDMI ports', classification: { kind: 'specification', title, summary: 'The device has four HDMI ports.', value: '4', labels: ['hdmi'], aliases: [] }, extractor: 'synthetic-profile' };
}

describe('primary source persistence preplanning', () => {
  test('uncertain and unavailable primary readings leave no entity, fact, support or state writes', async () => {
    for (const mode of ['uncertain', 'unavailable', 'missing'] as const) {
      const { store, subject, source, a } = await fixture();
      const fact = claim('First claim'); await seedFact(store, subject, fact, [a]);
      const before = graph(store);
      if (mode === 'uncertain') readings(() => 0.65);
      else if (mode === 'missing') installJudgmentPort(undefined);
      else { const fake = readings(); installJudgmentPort({ ...fake.port, async ask() { throw new Error('Synthetic unavailable port'); } }); }
      await expect(enrich(store, source, [fact])).rejects.toThrow();
      expect(graph(store)).toBe(before);
      expect(store.getSemanticEnrichmentState(source.id)).toBeNull();
    }
  });

  test('a later held claim prevents writes for earlier settled claims', async () => {
    const { store, subject, source, a } = await fixture();
    const first = claim('First claim'), later = claim('Later claim');
    await seedFact(store, subject, first, [a]); await seedFact(store, subject, later, [a]);
    const before = graph(store); const fake = readings((purpose) => purpose.includes('Later claim') ? 0.65 : 0.98);
    await expect(enrich(store, source, [first, later])).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(fake.requests.length).toBeGreaterThan(2);
    expect(graph(store)).toBe(before);
  });

  test('supersession preferences settle before new entities, facts and support detaches', async () => {
    const { store, subject, source, a, b } = await fixture();
    const old = await seedFact(store, subject, claim('Old shared claim'), [source, a, b]);
    const before = graph(store); readings(() => 0.65);
    await expect(enrich(store, source, [claim('New unique claim')])).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(graph(store)).toBe(before);
    expect(store.getNode(old.id)?.metadata.sourceIds).toEqual([source.id, a.id, b.id]);
  });

  test('resolved supersession keeps indexed same-space supports and deactivates the replaced source', async () => {
    const { store, subject, source, a, b } = await fixture();
    const old = await seedFact(store, subject, claim('Old shared claim'), [source, a, b]);
    readings((_purpose, title) => title === 'b' ? 0.98 : 0.9);
    await enrich(store, source, [claim('New unique claim')]);
    expect(store.getNode(old.id)?.sourceId).toBe(b.id);
    expect(store.getNode(old.id)?.metadata.sourceIds).toEqual([a.id, b.id]);
    const oldSupport = store.listEdges().find((edge) => edge.fromId === source.id && edge.toId === old.id && edge.relation === 'supports_fact');
    expect(oldSupport?.metadata.deleted).toBe(true);
  });

  test('foreign-space source content never reaches the model; each question includes its claim and subject', async () => {
    const { store, subject, source, a } = await fixture();
    const foreign = await addSource(store, 'FOREIGN_PRIVATE_SOURCE_MARKER', subject.id, 'other-space');
    const fact = claim('Exact display claim'); await seedFact(store, subject, fact, [a, foreign]);
    const fake = readings();
    const planner = createSemanticPrimarySourcePlanner(store, createSemanticWriteGuard(store));
    await planner.prepare(spaceId, { kind: fact.kind, title: fact.title, summary: fact.summary,
      subjects: [subject] }, [source.id, a.id, foreign.id])();
    const requests = JSON.stringify(fake.requests);
    expect(fake.requests).toHaveLength(2);
    expect(requests).not.toContain('FOREIGN_PRIVATE_SOURCE_MARKER');
    expect(requests).toContain('Exact display claim'); expect(requests).toContain(subject.title);
    const before = graph(store); const writes = readings();
    await expect(enrich(store, source, [fact])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(writes.requests).toHaveLength(0); expect(graph(store)).toBe(before);
  });

  test('identical claim/support sets reuse readings while distinct claims select independent winners', async () => {
    const { store, subject, source, a } = await fixture();
    const first = claim('First claim'), second = claim('Second claim');
    const firstNode = await seedFact(store, subject, first, [a]); const secondNode = await seedFact(store, subject, second, [a]);
    const fake = readings((purpose, title) => (purpose.includes('First claim') ? title === 'a' : title === 'current') ? 0.99 : 0.9);
    await enrich(store, source, [first, first, second]);
    expect(fake.requests.filter((request) => 'useful' in request.questions)).toHaveLength(4);
    expect(store.getNode(firstNode.id)?.sourceId).toBe(a.id); expect(store.getNode(secondNode.id)?.sourceId).toBe(source.id);
  });

  test('changed source versions are refused before any affected pass writes', async () => {
    const { store, subject, source, a } = await fixture();
    const fact = claim('Versioned claim'); await seedFact(store, subject, fact, [a]);
    const before = graph(store); const fake = readings(); let changed = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (!changed) { changed = true; await store.replaceSourceRecord({ ...a, summary: 'Changed during the reading.' }); }
      return fake.port.ask(request);
    } });
    await expect(enrich(store, source, [fact])).rejects.toThrow('changed');
    expect(graph(store)).toBe(before);
  });

  test('changed fact versions and support edges are refused without overwriting concurrent edits', async () => {
    for (const changedRecord of ['fact', 'edge'] as const) {
      const { store, subject, source, a } = await fixture();
      const fact = claim('Versioned claim'); const original = await seedFact(store, subject, fact, [a]);
      const fake = readings(); let changed = false, concurrentGraph = '';
      installJudgmentPort({ ...fake.port, async ask(request) {
        if (!changed) { changed = true;
          if (changedRecord === 'fact') await store.upsertNode({ ...original, summary: 'Concurrent corrected claim.' });
          else await store.upsertEdge({ fromKind: 'source', fromId: a.id, toKind: 'node', toId: original.id, relation: 'supports_fact', weight: 0.1, metadata: { knowledgeSpaceId: spaceId, changed: true } });
          concurrentGraph = graph(store);
        }
        return fake.port.ask(request);
      } });
      await expect(enrich(store, source, [fact])).rejects.toThrow('changed');
      expect(graph(store)).toBe(concurrentGraph);
    }
  });

  test('entity-ID collision uses the post-entity subject overlay before fact ID planning', async () => {
    readings();
    const { store, source } = await fixture();
    const entityId = `sem-entity-${semanticHash(spaceId, source.id, 'Collision')}`;
    await store.upsertNode({ id: entityId, kind: 'knowledge_entity', slug: 'collision', title: 'Old TV-987', status: 'active', metadata: { knowledgeSpaceId: spaceId, entityKind: 'device' } });
    await store.replaceSourceRecord({ ...source, metadata: { ...source.metadata, sourceDiscovery: { linkedObjectIds: [entityId] } } });
    const current = store.getSource(source.id)!; const fact = claim('Collision claim');
    await enrich(store, current, [fact], [{ title: 'Collision', confidence: 90 }]);
    const id = semanticFactId({ spaceId, kind: fact.kind, title: fact.title, summary: fact.summary, subjectIds: [], fallbackScope: source.id });
    expect(store.getNode(id)?.metadata.subjectIds).toBeUndefined();
    expect(store.getNode(entityId)?.metadata.semanticKind).toBe('entity');
  });

  test('prepared duplicate canonical facts preserve source union, per-source supports and last-writer fields', async () => {
    const { store, subject, source, a, b } = await fixture(); readings();
    const inputs = [source, a, b].map((candidate, index) => ({ ...profileInput(store, candidate, subject), evidence: `Evidence ${index}`, confidence: 70 + index, factMetadata: { lastWriter: index } }));
    const before = graph(store); const prepared = await prepareSourceLinkedRepairProfileFacts(inputs);
    expect(graph(store)).toBe(before); expect(new Set(prepared.plans.map((plan) => plan.factId)).size).toBe(1);
    inputs[2]!.evidence = 'Changed caller input after preparation';
    expect(Object.isFrozen(prepared.plans[2]!.input.classification)).toBe(true);
    prepared.assertCurrent(); installJudgmentPort(undefined); // Applying resolved plans never rereads a judgment.
    const written = await store.batch(() => prepared.write());
    const fact = store.getNode(written[0]!.id)!;
    expect(fact.metadata.sourceIds).toEqual([source.id, a.id, b.id]); expect(fact.metadata.evidence).toBe('Evidence 2');
    expect(fact.metadata.lastWriter).toBe(2); expect(fact.confidence).toBe(72);
    expect(store.listEdges().filter((edge) => edge.toId === fact.id && edge.relation === 'supports_fact').map((edge) => edge.fromId).sort()).toEqual([source.id, a.id, b.id].sort());
  });

  test('later held prepared profile claim prevents all profile writes', async () => {
    const { store, subject, source, a } = await fixture();
    const first = profileInput(store, source, subject, 'First HDMI claim'), second = profileInput(store, source, subject, 'Later HDMI claim');
    const before = graph(store); readings((purpose) => purpose.includes('Later HDMI claim') ? 0.65 : 0.97);
    await expect(prepareSourceLinkedRepairProfileFacts([first, { ...first, source: a, extraction: store.getExtractionBySourceId(a.id) }, second, { ...second, source: a, extraction: store.getExtractionBySourceId(a.id) }])).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(graph(store)).toBe(before);
  });

  test('absent, excluded, single-source, extraction and subject snapshots cannot be silently replaced', async () => {
    readings();
    for (const change of ['missing', 'excluded', 'single', 'extraction', 'subject'] as const) {
      const { store, subject, source, a } = await fixture();
      const input = profileInput(store, source, subject); let missingId = '';
      if (change === 'missing' || change === 'excluded') {
        const prepared = await prepareSourceLinkedRepairProfileFacts([input]); await prepared.write();
        const node = store.getNode(prepared.plans[0]!.factId)!;
        missingId = change === 'missing' ? 'newly-arrived' : a.id;
        if (change === 'excluded') await store.replaceSourceRecord({ ...a, status: 'failed' });
        await store.upsertNode({ ...node, metadata: { ...node.metadata, sourceIds: [source.id, missingId] } });
      }
      if (change === 'missing' || change === 'excluded') {
        const before = graph(store);
        await expect(prepareSourceLinkedRepairProfileFacts([input])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
        expect(graph(store)).toBe(before);
        continue;
      }
      const prepared = await prepareSourceLinkedRepairProfileFacts([input]);
      if (change === 'single') await store.replaceSourceRecord({ ...source, summary: 'Changed single source' });
      if (change === 'extraction') await store.upsertExtraction({ sourceId: source.id, extractorId: 'test', format: 'text', excerpt: 'Changed extracted evidence' });
      if (change === 'subject') await store.upsertNode({ ...subject, title: 'Changed subject' });
      expect(() => prepared.assertCurrent()).toThrow('changed');
    }
  });

  test('oversized support sets and aborted preparations are typed holds before writes or requests', async () => {
    readings();
    const { store, subject, source } = await fixture();
    const input = profileInput(store, source, subject);
    const prepared = await prepareSourceLinkedRepairProfileFacts([input]);
    await prepared.write();
    const sources = [source];
    for (let index = 0; index < 50; index++) sources.push(await addSource(store, `bounded-${index}`, subject.id));
    const fact = store.getNode(prepared.plans[0]!.factId)!;
    await store.upsertNode({ ...fact, metadata: { ...fact.metadata, sourceIds: sources.map((candidate) => candidate.id) } });
    const before = graph(store); const fake = readings();
    await expect(prepareSourceLinkedRepairProfileFacts([input])).rejects.toBeInstanceOf(JudgmentInputError);
    const controller = new AbortController(); controller.abort();
    await expect(prepareSourceLinkedRepairProfileFacts([input], { signal: controller.signal })).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    await expect(prepareSourceLinkedRepairProfileFacts([], { signal: controller.signal })).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(fake.requests).toHaveLength(0); expect(graph(store)).toBe(before);
  });

  test('fact cap is applied before planning active IDs, including the overflow fact supersession', async () => {
    const { store, subject, source, a, b } = await fixture();
    const facts = Array.from({ length: 161 }, (_, index) => claim(`Capped claim ${index}`));
    await seedFact(store, subject, facts[160]!, [source, a, b]);
    const before = graph(store); const fake = readings(() => 0.65);
    await expect(enrich(store, source, facts)).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(fake.requests.filter((request) => 'useful' in request.questions)).toHaveLength(2); expect(graph(store)).toBe(before);
  });

  test('promotion propagates a quality hold without its enrichment fallback writes', async () => {
    readings();
    const { store, subject, source } = await fixture();
    const gap = await store.upsertNode({ id: 'gap', kind: 'knowledge_gap', slug: 'gap', title: 'Full device specifications', metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [subject.id] } });
    const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
    const beforeTask = store.getRefinementTask(task.id); let graphAtHold = '';
    await expect(promoteRepairSources({ store, enrichSource: async () => { graphAtHold = graph(store); throw new KnowledgeSourceQualityHeldError(); } }, spaceId, gap, [source.id], task, Date.now() + 20_000)).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(graph(store)).toBe(graphAtHold); expect(store.getRefinementTask(task.id)).toEqual(beforeTask);
  });
  test('a repair intent or operator state change is not treated as a timestamp-only refresh', async () => {
    for (const change of ['title', 'status', 'provenance'] as const) {
      const { store, subject, source } = await fixture();
      const gap = await store.upsertNode({ id: 'gap', kind: 'knowledge_gap', slug: 'gap', title: 'Full device specifications', status: 'active', metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [subject.id] } });
      const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
      await store.upsertNode({ ...gap,
        ...(change === 'title' ? { title: 'Changed repair question' } : {}),
        ...(change === 'status' ? { status: 'stale' as const } : {}),
        ...(change === 'provenance' ? { metadata: { ...gap.metadata, operatorReview: 'rejected' } } : {}),
      });
      const before = graph(store); const beforeTask = store.getRefinementTask(task.id);
      const fake = readings();
      await expect(promoteRepairSources({ store }, spaceId, gap, [source.id], task, Date.now() + 20_000)).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
      expect(graph(store)).toBe(before); expect(store.getRefinementTask(task.id)).toEqual(beforeTask);
      expect(fake.requests).toHaveLength(0);
    }
  });

  test('a protected later claim prevents requests for earlier primary choices', async () => {
    const { store, subject, source, a } = await fixture();
    const first = claim('First claim');
    const later = { ...claim('Later claim'), evidence: 'Authorization: Bearer synthetic-private-value' };
    await seedFact(store, subject, first, [a]); await seedFact(store, subject, later, [a]);
    const before = graph(store); const fake = readings();
    await expect(enrich(store, source, [first, later])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0); expect(graph(store)).toBe(before);
  });

  test('prepared write rechecks source and operator state without relying on its caller', async () => {
    readings();
    for (const change of ['source', 'subject'] as const) {
      const { store, subject, source } = await fixture();
      const prepared = await prepareSourceLinkedRepairProfileFacts([profileInput(store, source, subject)]);
      if (change === 'source') await store.upsertSource({ ...source, summary: 'Concurrent corrected source content.' });
      else await store.upsertNode({ ...subject, metadata: { ...subject.metadata, operatorReview: 'rejected' } });
      const before = graph(store);
      await expect(prepared.write()).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
      expect(graph(store)).toBe(before);
    }
  });

  test('whole subject records project only declared identity fields, never timestamps or unrelated metadata', async () => {
    const { store, subject, source, a } = await fixture(); const fake = readings();
    let timestamp = 1790763900000;
    while (judgmentInputProblem(timestamp) !== 'card-material') timestamp++;
    const fullSubject = { ...subject, createdAt: timestamp, updatedAt: timestamp,
      metadata: { privateMarker: 'UNRELATED_PRIVATE_SUBJECT_METADATA', authorization: 'Bearer synthetic-private-metadata' },
    };
    const planner = createSemanticPrimarySourcePlanner(store, createSemanticWriteGuard(store));
    await planner.prepare(spaceId, { kind: 'note', title: 'Exact claim', subjects: [fullSubject] }, [source.id, a.id])();
    const requests = JSON.stringify(fake.requests);
    expect(fake.requests).toHaveLength(2); expect(requests).toContain(subject.title); expect(requests).toContain(subject.id);
    expect(requests).not.toContain(String(timestamp)); expect(requests).not.toContain('UNRELATED_PRIVATE_SUBJECT_METADATA');
    expect(requests).not.toContain('synthetic-private-metadata');
  });
  test('consumed identity accessors are refused without invocation; omitted accessors never run', async () => {
    const { store, subject, source, a } = await fixture(); const fake = readings(); let calls = 0;
    const omitted = { ...subject }; Object.defineProperty(omitted, 'metadata', { enumerable: true, get() { calls++; return {}; } });
    const planner = createSemanticPrimarySourcePlanner(store, createSemanticWriteGuard(store));
    await planner.prepare(spaceId, { kind: 'note', title: 'Exact claim', subjects: [omitted] }, [source.id, a.id])();
    expect(calls).toBe(0);
    const consumed = { ...subject }; Object.defineProperty(consumed, 'title', { enumerable: true, get() { calls++; return 'unsafe'; } });
    const before = fake.requests.length;
    expect(() => planner.prepare(spaceId, { kind: 'note', title: 'Exact claim', subjects: [consumed] }, [source.id, a.id])).toThrow(JudgmentInputError);
    expect(calls).toBe(0); expect(fake.requests).toHaveLength(before);
  });
  test('protected semantic claim fields still hold before any primary-source request', async () => {
    const { store, subject, source, a } = await fixture(); const fake = readings();
    const planner = createSemanticPrimarySourcePlanner(store, createSemanticWriteGuard(store));
    expect(() => planner.prepare(spaceId, { kind: 'note', title: 'Authorization: Bearer synthetic-secret', subjects: [subject] }, [source.id, a.id])).toThrow(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });

});
