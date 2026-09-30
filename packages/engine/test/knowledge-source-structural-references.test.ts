import * as crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { homeGraphSourceId, namespacedCanonicalUri } from '../sdk/src/platform/knowledge/home-graph/helpers.js';
import { prepareSourceLinkedRepairProfileFacts } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { prepareGeneratedFactSupport, type GeneratedFactSupportInput } from '../sdk/src/platform/knowledge/semantic/verification/generated-fact-support.js';
import { withStoredKnowledgeSourceReferences } from '../sdk/src/platform/knowledge/semantic/verification/structural-references.js';
import { captureKnowledgeSourceReferences, knowledgeSourceJudgmentUris, projectKnowledgeSourceReferences } from '../sdk/src/platform/knowledge/source-structural-references.js';
import { judgmentInputProblem, JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../sdk/src/platform/knowledge/semantic/verification/types.js';
import { supportHash } from '../sdk/src/platform/knowledge/semantic/verification/projection.js';

import { sourceRankingContent } from '../sdk/src/platform/knowledge/semantic/answer-source-ranking.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { sourceSemanticHash } from '../sdk/src/platform/knowledge/semantic/utils.js';

const spaceId = 'homeassistant:house';
let previous: JudgmentPort | undefined; const roots: string[] = [], services: HomeGraphService[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { services.splice(0).forEach((service) => service.dispose()); installJudgmentPort(previous); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function readings() { const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port); return fake; }
async function fixture(hex = '0000020d') {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-source-references-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const service = new HomeGraphService(store, artifactStore); services.push(service);
  const random = spyOn(crypto, 'randomUUID').mockReturnValue(`${hex}-0000-4000-8000-000000000000`);
  let result: Awaited<ReturnType<HomeGraphService['ingestNote']>>;
  try { result = await service.ingestNote({ installationId: 'house', title: 'AC-7 manual', body: 'AC-7 has four HDMI ports. It does not support Bluetooth.', category: 'manual' }); }
  finally { random.mockRestore(); }
  const source = store.getSource(result.source.id)!; const extraction = store.getExtractionBySourceId(source.id)!;
  return { store, source, extraction, service, artifactId: result.artifactId!, dbPath: store.storagePath };
}
function candidate(source: GeneratedFactSupportInput['source'], extraction: GeneratedFactSupportInput['extraction']): GeneratedFactSupportInput {
  return { spaceId, source, extraction, subjects: [], claim: { id: 'synthetic-claim', kind: 'specification', title: 'AC-7 ports', summary: 'AC-7 has four HDMI ports.' } };
}

describe('fresh generated source and extraction references (THE36)', () => {
  test('the real generator reproduces a protected-shaped source identity without changing its value', () => {
    expect(homeGraphSourceId(spaceId, 'note', 'synthetic-artifact-323')).toBe('hg-src-1470179648492cbe3c32885b');
    expect(judgmentInputProblem(homeGraphSourceId(spaceId, 'note', 'synthetic-artifact-323'))).toBe('card-material');
    expect(homeGraphSourceId(spaceId, 'note', 'artifact-0000020d')).toBe('hg-src-4379310550672ab16c7e530b');
    expect(judgmentInputProblem(homeGraphSourceId(spaceId, 'note', 'artifact-0000020d'))).toBe('card-material');
    expect(judgmentInputProblem(namespacedCanonicalUri(spaceId, 'source', 'artifact-00001af0'))).toBe('card-material');
  });
  test('actual artifact ingestion and supported fact planning minimize fresh IDs while retaining exact receipts', async () => {
    const fake = readings(); const { store, source, extraction } = await fixture();
    expect(source.id).toBe('hg-src-4379310550672ab16c7e530b');
    const prepared = await prepareSourceLinkedRepairProfileFacts([{ store, source, extraction, spaceId, subjects: [], authority: 'secondary',
      title: 'AC-7 ports', summary: 'AC-7 has four HDMI ports.', evidence: 'AC-7 has four HDMI ports.', extractor: 'synthetic',
      classification: { kind: 'specification', title: 'AC-7 ports', summary: 'AC-7 has four HDMI ports.', value: 'four HDMI ports', labels: [], aliases: [] } }]);
    const receipts = (prepared.plans[0]!.writeData.factMetadata.generatedFactSupport as { receipts: { sourceId: string; sourceHash: string; extractionId: string; extractionHash: string }[] }).receipts;
    expect(receipts.every((receipt) => receipt.sourceId === source.id && receipt.sourceHash === supportHash(source)
      && receipt.extractionId === extraction.id && receipt.extractionHash === supportHash(extraction))).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain(source.id); expect(JSON.stringify(fake.requests)).not.toContain(extraction.id);
    expect(JSON.stringify(fake.requests)).toContain('four HDMI ports');
    expect((await prepared.write())[0]!.sourceId).toBe(source.id);
  });
  test('fresh local URI references are omitted but their exact local meaning is unchanged', async () => {
    const fake = readings(); const { store, source, extraction } = await fixture('00001af0');
    expect(judgmentInputProblem(source.canonicalUri)).toBe('card-material');
    const input = withStoredKnowledgeSourceReferences(candidate(source, extraction), store, source, extraction);
    const [plan] = await prepareGeneratedFactSupport([input]);
    expect(JSON.stringify(fake.requests)).not.toContain(source.canonicalUri!); expect(JSON.stringify(fake.requests)).not.toContain(source.id);
    const node = await store.upsertNode({ kind: 'fact', slug: 'local-uri-supported-fact', title: 'AC-7 ports', summary: 'AC-7 has four HDMI ports.', sourceId: source.id, metadata: { knowledgeSpaceId: spaceId } });
    expect(node.status).toBe('active'); expect(JSON.stringify(fake.requests)).not.toContain(source.canonicalUri!);
    expect(sourceRankingContent(source).uri).toBe('');
    expect(sourceRankingContent(structuredClone(source)).uri).toBe(source.canonicalUri!);
    expect(plan!.sourceHash).toBe(supportHash(source)); expect(store.getSource(source.id)!.canonicalUri).toBe(source.canonicalUri);
  });
  test('copied inputs, unknown persisted records and wrong stores never inherit the capsule', async () => {
    const fake = readings(); const { store, source, extraction, dbPath } = await fixture();
    const bound = withStoredKnowledgeSourceReferences(candidate(source, extraction), store, source, extraction);
    const requestCount = fake.requests.length;
    await expect(prepareGeneratedFactSupport([structuredClone(bound)])).rejects.toBeInstanceOf(JudgmentInputError);
    const reloaded = new KnowledgeStore({ dbPath }); await reloaded.init();
    const sourceCopy = reloaded.getSource(source.id)!, extractionCopy = reloaded.getExtractionBySourceId(source.id)!;
    await expect(prepareGeneratedFactSupport([withStoredKnowledgeSourceReferences(candidate(sourceCopy, extractionCopy), reloaded, sourceCopy, extractionCopy)])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(captureKnowledgeSourceReferences(reloaded, source, extraction)).toBeUndefined();
    expect(fake.requests).toHaveLength(requestCount);
  });
  test('changed origin, extraction or current source invalidates the captured proof before requests', async () => {
    const fake = readings(); const { store, source, extraction } = await fixture();
    const proof = captureKnowledgeSourceReferences(store, source, extraction);
    expect(proof).toBeDefined();
    expect(() => projectKnowledgeSourceReferences({ ...source, metadata: { ...source.metadata, origin: 'changed' } }, extraction, proof)).toThrow(KnowledgeGeneratedFactSupportHeldError);
    expect(() => projectKnowledgeSourceReferences(source, { ...extraction, excerpt: 'Changed extraction' }, proof)).toThrow(KnowledgeGeneratedFactSupportHeldError);
    expect(() => projectKnowledgeSourceReferences(source, { ...extraction, sourceId: 'different-source' }, proof)).toThrow(KnowledgeGeneratedFactSupportHeldError);
    const bound = withStoredKnowledgeSourceReferences(candidate(source, extraction), store, source, extraction);
    await store.upsertSource({ ...source, summary: 'Concurrent changed source' });
    const requestCount = fake.requests.length;
    await expect(prepareGeneratedFactSupport([bound])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(fake.requests).toHaveLength(requestCount);
  });

  test('external URI values remain ordinary evidence and protected values hold before any request', async () => {
    const fake = readings(); const { store, service, artifactId } = await fixture();
    const external = 'https://manuals.example.test/ac-7?edition=two';
    const result = await service.ingestArtifact({ installationId: 'house', artifactId, uri: external, title: 'External AC-7 manual' });
    const source = store.getSource(result.source.id)!, extraction = store.getExtractionBySourceId(source.id)!;
    expect(knowledgeSourceJudgmentUris(source).sourceUri).toBe(external);
    await prepareGeneratedFactSupport([withStoredKnowledgeSourceReferences(candidate(source, extraction), store, source, extraction)]);
    expect(JSON.stringify(fake.requests)).toContain(external);
    const protectedResult = await service.ingestArtifact({ installationId: 'house', artifactId, uri: 'https://manuals.example.test/4111111111111111', title: 'Protected external URI' });
    const protectedSource = store.getSource(protectedResult.source.id)!, protectedExtraction = store.getExtractionBySourceId(protectedSource.id)!;
    const before = fake.requests.length;
    await expect(prepareGeneratedFactSupport([withStoredKnowledgeSourceReferences(candidate(protectedSource, protectedExtraction), store, protectedSource, protectedExtraction)])).rejects.toBeInstanceOf(JudgmentInputError);
    await expect(store.upsertNode({ kind: 'fact', slug: 'external-uri-held', title: 'AC-7 ports', sourceId: protectedSource.id, metadata: { knowledgeSpaceId: spaceId } })).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(before);
  });
  test('duplicate source mappings remain exact and conflicting or mismatched mappings preflight the whole pass', async () => {
    const fake = readings(); const { store, source, extraction } = await fixture();
    const bound = withStoredKnowledgeSourceReferences(candidate(source, extraction), store, source, extraction);
    const plans = await prepareGeneratedFactSupport([bound, bound]);
    expect(plans).toHaveLength(2); expect(plans[0]!.receipts).toEqual(plans[1]!.receipts);
    expect(plans.every((plan) => plan.sourceId === source.id && plan.extractionId === extraction.id)).toBe(true);
    const conflicting = withStoredKnowledgeSourceReferences(candidate(source, extraction), store, source, extraction);
    Object.assign(conflicting, { extraction: { ...extraction, sourceId: 'mismatched-source' } });
    const before = fake.requests.length;
    await expect(prepareGeneratedFactSupport([bound, conflicting])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(fake.requests).toHaveLength(before);
    const proof = captureKnowledgeSourceReferences(store, source, extraction);
    const other = await fixture('00001af0');
    expect(() => projectKnowledgeSourceReferences(other.source, other.extraction, proof)).toThrow(KnowledgeGeneratedFactSupportHeldError);
    expect(projectKnowledgeSourceReferences(source, extraction, { ...proof })).toBeUndefined();
  });
  test('in-place source or extraction mutation cannot refresh origin by capturing a new proof', async () => {
    readings(); const first = await fixture();
    first.source.metadata.origin = 'changed after producer mint';
    expect(() => captureKnowledgeSourceReferences(first.store, first.source, first.extraction)).toThrow(KnowledgeGeneratedFactSupportHeldError);
    expect(() => knowledgeSourceJudgmentUris(first.source)).toThrow(KnowledgeGeneratedFactSupportHeldError);
    const second = await fixture('00001af0');
    second.extraction.metadata.origin = 'changed after producer mint';
    expect(() => captureKnowledgeSourceReferences(second.store, second.source, second.extraction)).toThrow(KnowledgeGeneratedFactSupportHeldError);
  });
  test('actual minted-URI enrichment minimizes generation input while keeping original semantic hash and receipts', async () => {
    const fake = readings(); const { store, source, extraction } = await fixture('00001af0');
    const originalHash = sourceSemanticHash(source, extraction); const prompts: string[] = [];
    const result = await enrichKnowledgeSource({ store, llm: { async completeText() { throw new Error('Unexpected text generation in enrichment fixture'); }, async completeJson(input) {
      prompts.push(input.prompt); return { facts: [{ kind: 'specification', title: 'AC-7 ports', summary: 'AC-7 has four HDMI ports.', evidence: 'AC-7 has four HDMI ports.', confidence: 12 }], entities: [], relations: [], gaps: [] };
    } } }, source, { force: true, knowledgeSpaceId: spaceId });
    expect(prompts).toHaveLength(1); expect(JSON.stringify(prompts)).not.toContain(source.canonicalUri!);
    expect(JSON.stringify(prompts)).not.toContain(source.id); expect(JSON.stringify(prompts)).toContain('four HDMI ports');
    expect(result.facts.length).toBeGreaterThan(0); expect(result.facts.every((fact) => fact.status === 'active')).toBe(true);
    expect(store.getSemanticEnrichmentState(source.id)!.metadata.textHash).toBe(originalHash);
    expect(sourceSemanticHash(store.getSource(source.id)!, store.getExtractionBySourceId(source.id))).toBe(originalHash);
    expect(JSON.stringify(fake.requests)).not.toContain(source.canonicalUri!);
  });
  test('real protected semantic content is never hidden by a structural capsule', async () => {
    const fake = readings(); const { store, source, extraction } = await fixture();
    const input = candidate(source, extraction); const bound = withStoredKnowledgeSourceReferences({ ...input, claim: { ...input.claim, summary: 'Synthetic card material 4111111111111111' } }, store, source, extraction);
    const requestCount = fake.requests.length;
    await expect(prepareGeneratedFactSupport([bound])).rejects.toBeInstanceOf(JudgmentInputError); expect(fake.requests).toHaveLength(requestCount);
  });
});
