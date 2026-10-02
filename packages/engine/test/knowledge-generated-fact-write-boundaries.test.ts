import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { writeKnowledgeNodeRow } from '../sdk/src/platform/knowledge/store-node-history.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createKnowledgeNodeOperatorMutation, KnowledgeNodeMutationHeldError } from '../sdk/src/platform/knowledge/store-node-authority.js';
import { semanticHash } from '../sdk/src/platform/knowledge/semantic/utils.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { prepareSourceLinkedRepairProfileFacts, type SourceLinkedRepairProfileFactInput } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { writeSupportedRepairSubjectLinks } from '../sdk/src/platform/knowledge/semantic/repair-subject-write-plan.js';
import { withSupportBudget } from '../sdk/src/platform/knowledge/semantic/support-budget.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../sdk/src/platform/knowledge/semantic/verification/types.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';
import type { KnowledgeSemanticExtraction, KnowledgeSemanticLlm } from '../sdk/src/platform/knowledge/semantic/types.js';
import { settleEvents } from './_helpers/test-timeout.js';

const spaceId = 'support-write-space';
const text = 'AC-7 has four HDMI inputs. AC-7 power consumption is 25 W. AC-7 does not support Bluetooth.';
let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function readings(probability: (name: string, state: unknown) => number = () => 0.99) {
  const fake = fakePort((name, question, state) => name === 'authority'
    ? choiceAnswer(question, 'secondary', 0.99) : noulAnswer(probability(name, state)));
  installJudgmentPort(fake.port); return fake;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-fact-support-write-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const subject = await store.upsertNode({ id: 'subject:AC-7', kind: 'knowledge_entity', slug: 'ac-7', title: 'AC-7', status: 'active', metadata: { knowledgeSpaceId: spaceId, entityKind: 'device', model: 'AC-7' } });
  const source = await store.upsertSource({ id: 'Source:Alpha', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 reference', summary: text, status: 'indexed', metadata: { knowledgeSpaceId: spaceId, privateInternal: 'PRIVATE_METADATA_MUST_NOT_LEAVE', sourceDiscovery: { linkedObjectIds: [subject.id] } } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: text, sections: [], structure: { text }, metadata: { knowledgeSpaceId: spaceId } });
  const input: SourceLinkedRepairProfileFactInput = {
    store, source, extraction, spaceId, subjects: [subject], authority: 'secondary', title: 'HDMI inputs',
    summary: 'AC-7 has four HDMI inputs.', evidence: 'AC-7 has four HDMI inputs.',
    classification: { kind: 'specification', title: 'HDMI inputs', summary: 'AC-7 has four HDMI inputs.', value: 'four HDMI inputs', labels: ['HDMI'], aliases: ['HDMI inputs'] }, extractor: 'synthetic',
  };
  return { store, subject, source, extraction, input };
}
/** Simulate records already on disk before the serving gate, not new automatic approvals. */
async function loadLegacyFacts(store: KnowledgeStore, facts: readonly KnowledgeNodeRecord[]): Promise<KnowledgeStore> {
  const sqlite = new SQLiteStore(store.storagePath); await sqlite.init(createSchema, { schemaVersion: 2 });
  for (const fact of facts) writeKnowledgeNodeRow(sqlite, fact);
  await sqlite.save();
  const reloaded = new KnowledgeStore({ dbPath: store.storagePath }); await reloaded.init(); return reloaded;
}
function snapshot(store: KnowledgeStore) {
  return JSON.stringify({ sources: store.listSources(), extractions: store.listExtractions(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() });
}
function extractionResult(title = 'HDMI inputs'): KnowledgeSemanticExtraction {
  return { extractor: 'llm', entities: [{ title: 'AC-7', kind: 'device', summary: 'AC-7 has four HDMI inputs.' }],
    facts: [{ kind: 'specification', title, summary: 'AC-7 has four HDMI inputs.', value: 'four HDMI inputs', evidence: 'AC-7 has four HDMI inputs.', labels: ['HDMI'] }],
    relations: [], gaps: [], wikiPage: { title: 'AC-7 reference', markdown: '# AC-7\nAC-7 has four HDMI inputs.' },
  };
}
function llm(value: KnowledgeSemanticExtraction, prompts: string[] = []): KnowledgeSemanticLlm {
  return { async completeJson(input) { prompts.push(input.prompt); return value; }, async completeText() { return null; } };
}

describe('generated fact support persistence boundaries', () => {
  test('single-source preparation verifies fields and attachment, then writes without new requests', async () => {
    const { store, input, source, extraction } = await fixture(); const fake = readings(); const before = snapshot(store);
    const prepared = await prepareSourceLinkedRepairProfileFacts([input]);
    expect(snapshot(store)).toBe(before);
    expect(fake.requests.some((request) => 'supported' in request.questions)).toBe(true);
    expect(fake.requests.some((request) => 'attached' in request.questions)).toBe(true);
    const calls = fake.requests.length;
    const [fact] = await prepared.write();
    expect(fake.requests).toHaveLength(calls);
    const support = fact!.metadata.generatedFactSupport as { receipts: { sourceId: string; extractionId: string; outcome: string }[] };
    expect(support.receipts.length).toBeGreaterThan(0);
    expect(support.receipts.every((receipt) => receipt.sourceId === source.id && receipt.extractionId === extraction.id && receipt.outcome === 'act')).toBe(true);
    expect(store.edgesFor('node', fact!.id).every((edge) => Boolean(edge.metadata.generatedFactSupport))).toBe(true);
  });
  test('a later unsupported claim prevents every earlier profile write', async () => {
    const { store, input } = await fixture();
    readings((_name, state) => (state as { claim: { title: string } }).claim.title === 'Invented Bluetooth' ? 0.01 : 0.99);
    const before = snapshot(store);
    await expect(prepareSourceLinkedRepairProfileFacts([input, { ...input, title: 'Invented Bluetooth', summary: 'AC-7 supports Bluetooth.' }])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(snapshot(store)).toBe(before);
  });
  test('old derivation cannot borrow a replacement extraction snapshot', async () => {
    const { store, input, source } = await fixture(); const fake = readings();
    await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has two HDMI inputs.', metadata: { knowledgeSpaceId: spaceId } });
    const before = snapshot(store);
    await expect(prepareSourceLinkedRepairProfileFacts([input])).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
  });
  test('scope mismatch holds before sending protected foreign evidence', async () => {
    const { store, input } = await fixture(); const fake = readings();
    const foreign = await store.upsertSource({ ...input.source, id: 'foreign', metadata: { knowledgeSpaceId: 'foreign-space' }, summary: 'Authorization: Bearer synthetic-foreign' });
    const foreignExtraction = await store.upsertExtraction({ sourceId: foreign.id, extractorId: 'synthetic', format: 'text', excerpt: 'Authorization: Bearer synthetic-foreign', metadata: { knowledgeSpaceId: 'foreign-space' } });
    const before = snapshot(store);
    await expect(prepareSourceLinkedRepairProfileFacts([{ ...input, source: foreign, extraction: foreignExtraction }])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
  });
  test('metadata adapters cannot replace attested content after it is verified', async () => {
    const { store, input } = await fixture(); readings(); const before = snapshot(store);
    await expect(prepareSourceLinkedRepairProfileFacts([{ ...input, metadataBuilder: (metadata) => ({ ...metadata, knowledgeSpaceId: spaceId, value: 'eight HDMI inputs' }) }])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(snapshot(store)).toBe(before);
  });
  test('duplicate canonical facts retain distinct exact-case source receipts', async () => {
    const { store, input } = await fixture(); readings();
    const source = await store.upsertSource({ ...input.source, id: 'source:alpha', title: 'Second AC-7 reference' });
    const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: text, metadata: { knowledgeSpaceId: spaceId } });
    const prepared = await prepareSourceLinkedRepairProfileFacts([input, { ...input, source, extraction }]);
    const facts = await prepared.write(); const fact = store.getNode(facts[0]!.id)!;
    expect(facts[1]!.id).toBe(fact.id);
    expect(fact.metadata.sourceIds).toEqual(['Source:Alpha', 'source:alpha']);
    const receipts = (fact.metadata.generatedFactSupport as { receipts: { sourceId: string }[] }).receipts;
    expect(new Set(receipts.map((receipt) => receipt.sourceId))).toEqual(new Set(['Source:Alpha', 'source:alpha']));
    expect(store.listEdges().filter((edge) => edge.relation === 'supports_fact')).toHaveLength(2);
  });
  test('an unsupported extracted fact holds entities, wiki, edges and enrichment state before mutation', async () => {
    const { store, source } = await fixture(); readings((name) => name === 'supported' ? 0.01 : 0.99);
    const before = snapshot(store);
    await expect(enrichKnowledgeSource({ store, llm: llm(extractionResult()) }, source, { force: true, knowledgeSpaceId: spaceId })).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(snapshot(store)).toBe(before); expect(store.getSemanticEnrichmentState(source.id)).toBeNull();
  });
  test('generation does not transmit arbitrary source metadata', async () => {
    const { store, source } = await fixture(); const fake = readings(); const prompts: string[] = [];
    await enrichKnowledgeSource({ store, llm: llm(extractionResult(), prompts) }, source, { force: true, knowledgeSpaceId: spaceId });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain('PRIVATE_METADATA_MUST_NOT_LEAVE');
    expect(JSON.stringify(fake.requests)).not.toContain('PRIVATE_METADATA_MUST_NOT_LEAVE');
    expect(store.listNodes().find((node) => node.kind === 'fact')?.metadata.generatedFactSupport).toBeDefined();
  });
  test('a source change during generation holds before support requests or writes', async () => {
    const { store, source } = await fixture(); const fake = readings();
    const started = Promise.withResolvers<void>(), released = Promise.withResolvers<KnowledgeSemanticExtraction>();
    const run = enrichKnowledgeSource({ store, llm: { async completeJson() { started.resolve(); return released.promise; }, async completeText() { return null; } } }, source, { force: true });
    const outcome = run.catch((error: unknown) => error);
    await started.promise; await store.upsertSource({ ...source, summary: 'Concurrent corrected source.' }); const before = snapshot(store);
    released.resolve(extractionResult()); expect(await outcome).toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
  });
  test('deadline cancellation prevents ignored-signal generation from making late writes', async () => {
    const { store, source } = await fixture(); const fake = readings(); const released = Promise.withResolvers<KnowledgeSemanticExtraction>();
    const before = snapshot(store);
    await expect(withSupportBudget((signal) => enrichKnowledgeSource({ store, llm: { async completeJson() { return released.promise; }, async completeText() { return null; } } }, source, { force: true, signal }), 10)).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    released.resolve(extractionResult()); await settleEvents(10);
    expect(snapshot(store)).toBe(before); expect(fake.requests).toHaveLength(0);
  });
  test('a later unsupported legacy active fact prevents all subject-link rewrites', async () => {
    const fixtureState = await fixture(); const { source, subject } = fixtureState;
    const legacy = ['HDMI inputs', 'Invented Bluetooth'].map((title, index): KnowledgeNodeRecord => ({
      id: `legacy-${index}`, kind: 'fact', slug: title, title, summary: index === 0 ? 'AC-7 has four HDMI inputs.' : 'AC-7 supports Bluetooth.',
      aliases: [], confidence: 90, status: 'active', sourceId: source.id, createdAt: 1, updatedAt: 1,
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', sourceIds: [source.id] },
    }));
    const store = await loadLegacyFacts(fixtureState.store, legacy);
    const gap = await store.upsertNode({ id: 'gap', kind: 'knowledge_gap', slug: 'gap', title: 'AC-7 specifications', metadata: { knowledgeSpaceId: spaceId } });
    for (const fact of legacy) await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: fact.id, relation: 'supports_fact', metadata: { knowledgeSpaceId: spaceId } });
    readings((_name, state) => (state as { claim: { title: string } }).claim.title === 'Invented Bluetooth' ? 0.01 : 0.99);
    const before = snapshot(store);
    await expect(writeSupportedRepairSubjectLinks({ store, spaceId, gap, subjects: [subject], sourceIds: [source.id], candidate: () => true })).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(snapshot(store)).toBe(before);
  });
  test('missing extraction is an explicit no-write skip before generation, not a summary-derived claim', async () => {
    const { store, source } = await fixture(); const fake = readings(); let calls = 0;
    const metadataOnly = await store.upsertSource({ ...source, id: 'metadata-only' });
    const before = snapshot(store);
    const result = await enrichKnowledgeSource({ store, llm: { async completeJson() { calls++; return extractionResult(); }, async completeText() { return null; } } }, metadataOnly, { force: true });
    expect(result.skipped).toBe(true); expect(result.reason).toContain('extracted source evidence');
    expect(calls).toBe(0); expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
  });
  test('rereading unchanged claims updates receipts without unbounded per-decision duplication', async () => {
    const { store, input } = await fixture(); const fake = readings(); let decision = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), decisionId: `synthetic-decision-${++decision}` }; } });
    const first = await prepareSourceLinkedRepairProfileFacts([input]);
    const [fact] = await first.write();
    const original = (fact!.metadata.generatedFactSupport as { receipts: { receiptId: string }[] }).receipts;
    const second = await prepareSourceLinkedRepairProfileFacts([input]); await second.write();
    const latest = (store.getNode(fact!.id)!.metadata.generatedFactSupport as { receipts: { receiptId: string }[] }).receipts;
    expect(latest).toHaveLength(original.length);
    expect(latest.map((receipt) => receipt.receiptId)).not.toEqual(original.map((receipt) => receipt.receiptId));
    expect(store.listNodes().filter((node) => node.kind === 'fact')).toHaveLength(1);
  });

  test('legacy metadata-only source links do not bypass support verification', async () => {
    const fixtureState = await fixture(); const { source, subject } = fixtureState;
    const store = await loadLegacyFacts(fixtureState.store, [{ id: 'legacy-unverified', kind: 'fact', slug: 'unverified', title: 'Invented Bluetooth', summary: 'AC-7 supports Bluetooth.',
      aliases: [], status: 'active', confidence: 90, createdAt: 1, updatedAt: 1,
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', sourceIds: [source.id], subjectIds: [subject.id] },
    }]);
    const gap = await store.upsertNode({ id: 'gap', kind: 'knowledge_gap', slug: 'gap', title: 'AC-7 specifications', metadata: { knowledgeSpaceId: spaceId } });
    const fake = readings(() => 0.01); const before = snapshot(store);
    await expect(writeSupportedRepairSubjectLinks({ store, spaceId, gap, subjects: [subject], sourceIds: [source.id], candidate: () => true })).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(fake.requests.length).toBeGreaterThan(0); expect(snapshot(store)).toBe(before);
  });

  test('a foreign requested space holds before even the generation model sees source text', async () => {
    const { store, source } = await fixture(); const fake = readings(); const prompts: string[] = []; const before = snapshot(store);
    await expect(enrichKnowledgeSource({ store, llm: llm(extractionResult(), prompts) }, source, { force: true, knowledgeSpaceId: 'other-space' })).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(prompts).toHaveLength(0); expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
  });
  test('an aggregate Home Assistant alias preserves the concrete source space on writes', async () => {
    const { store, source } = await fixture(); readings();
    const concrete = 'homeassistant:fixture-house';
    const scoped = await store.upsertSource({ ...source, id: 'scoped-source', metadata: { knowledgeSpaceId: concrete } });
    await store.upsertExtraction({ sourceId: scoped.id, extractorId: 'synthetic', format: 'text', excerpt: text, metadata: { knowledgeSpaceId: concrete } });
    const result = await enrichKnowledgeSource({ store, llm: llm(extractionResult()) }, scoped, { force: true, knowledgeSpaceId: 'homeassistant' });
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts.every((fact) => fact.metadata.knowledgeSpaceId === concrete)).toBe(true);
    expect(store.listNodesInSpace('homeassistant')).toHaveLength(0);
  });

  test('a later operator-rejected profile holds the full prepared pass before earlier writes', async () => {
    const { store, input } = await fixture(); readings();
    const [fact] = await (await prepareSourceLinkedRepairProfileFacts([input])).write();
    await store.upsertNode({ ...fact!, status: 'stale' }, createKnowledgeNodeOperatorMutation(fact!, { action: 'reject' }));
    const before = snapshot(store);
    await expect(prepareSourceLinkedRepairProfileFacts([{ ...input, title: 'Power usage', summary: 'AC-7 power consumption is 25 W.' }, input])).rejects.toBeInstanceOf(KnowledgeNodeMutationHeldError);
    expect(snapshot(store)).toBe(before);
  });

  test('a reviewed wiki conflict holds new entities and facts before any enrichment write', async () => {
    const { store, source } = await fixture(); readings();
    const wiki = await store.upsertNode({ id: `sem-page-${semanticHash(spaceId, source.id)}`, kind: 'wiki_page', slug: 'reviewed-page',
      title: 'Operator reference', summary: 'Operator correction', sourceId: source.id, metadata: { knowledgeSpaceId: spaceId } });
    await store.upsertNode({ ...wiki, status: 'active' }, createKnowledgeNodeOperatorMutation(wiki, { action: 'accept' }));
    const before = snapshot(store);
    await expect(enrichKnowledgeSource({ store, llm: llm(extractionResult()) }, source, { force: true })).rejects.toBeInstanceOf(KnowledgeNodeMutationHeldError);
    expect(snapshot(store)).toBe(before); expect(store.getSemanticEnrichmentState(source.id)).toBeNull();
  });

  test('reviewed superseded content cannot be marked stale after other new writes', async () => {
    const { store, source } = await fixture(); readings();
    const old = await store.upsertNode({ id: 'reviewed-old-entity', kind: 'knowledge_entity', slug: 'reviewed-old', title: 'Operator entity',
      sourceId: source.id, metadata: { knowledgeSpaceId: spaceId, semanticKind: 'entity' } });
    await store.upsertNode({ ...old, status: 'active' }, createKnowledgeNodeOperatorMutation(old, { action: 'accept' }));
    const before = snapshot(store);
    await expect(enrichKnowledgeSource({ store, llm: llm(extractionResult()) }, source, { force: true })).rejects.toBeInstanceOf(KnowledgeNodeMutationHeldError);
    expect(snapshot(store)).toBe(before);
  });

  test('a prepared profile rechecks a later operator decision at write time', async () => {
    const { store, input } = await fixture(); readings();
    const [fact] = await (await prepareSourceLinkedRepairProfileFacts([input])).write();
    const prepared = await prepareSourceLinkedRepairProfileFacts([input]);
    await store.upsertNode({ ...fact!, status: 'stale' }, createKnowledgeNodeOperatorMutation(fact!, { action: 'reject' }));
    const before = snapshot(store);
    await expect(prepared.write()).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError); // Whole-pass snapshot sees the operator decision first.
    expect(snapshot(store)).toBe(before);
  });

  test('a lifecycle stop during generation holds before support requests and writes', async () => {
    const { store, source } = await fixture(); const fake = readings(); let stopped = false;
    const started = Promise.withResolvers<void>(), released = Promise.withResolvers<KnowledgeSemanticExtraction>();
    const before = snapshot(store);
    const run = enrichKnowledgeSource({ store, llm: { async completeJson() { started.resolve(); return released.promise; }, async completeText() { return null; } } },
      source, { force: true, shouldStop: () => stopped });
    const outcome = run.catch((error: unknown) => error);
    await started.promise; stopped = true; released.resolve(extractionResult());
    expect(await outcome).toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
  });
  test('a lifecycle stop invalidates a prepared profile before write entry', async () => {
    const { store, input } = await fixture(); readings(); let stopped = false;
    const prepared = await prepareSourceLinkedRepairProfileFacts([input], { shouldStop: () => stopped });
    const before = snapshot(store); stopped = true;
    await expect(prepared.write()).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(snapshot(store)).toBe(before);
  });

});
