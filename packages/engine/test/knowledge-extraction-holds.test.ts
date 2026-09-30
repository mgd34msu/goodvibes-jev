import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { homeAssistantKnowledgeSpaceId } from '../sdk/src/platform/knowledge/spaces.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { recompileKnowledgeSource } from '../sdk/src/platform/knowledge/ingest-compile.js';
import { reindexHomeGraphSources } from '../sdk/src/platform/knowledge/home-graph/reindex.js';
import { KNOWLEDGE_EXTRACTOR_VERSION, KnowledgeExtractionJudgmentHoldError } from '../sdk/src/platform/knowledge/extraction-policy.js';
import { createCompressedPdfBuffer } from './_helpers/homegraph-service-fixtures.js';

let previous: JudgmentPort | undefined;
let root: string;
let service: HomeGraphService | undefined;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
  root = mkdtempSync(join(tmpdir(), 'knowledge-extraction-hold-'));
});
afterEach(() => {
  service?.dispose();
  service = undefined;
  installJudgmentPort(previous);
  rmSync(root, { recursive: true, force: true });
});

function context() {
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  return {
    store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(),
    emitIfReady: () => {}, syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [],
  };
}

const failures = ['uncertain', 'missing', 'unavailable'] as const;
function hold(mode: typeof failures[number]): void {
  installJudgmentPort(mode === 'missing' ? undefined : fakePort(() => {
    if (mode === 'unavailable') throw new Error('Synthetic unavailable judgment');
    return noulAnswer(0.5);
  }).port);
}

describe('extraction holds preserve artifacts and stored knowledge', () => {
  for (const mode of failures) {
    test(`Home Graph artifact ingestion makes no knowledge writes when judgment is ${mode}`, async () => {
      const { store, artifactStore } = context();
      await store.init();
      const artifact = await artifactStore.createFromStream({
        kind: 'document', filename: 'synthetic.pdf', mimeType: 'application/pdf',
        stream: [createCompressedPdfBuffer('The synthetic manual supports local control.')],
      });
      service = new HomeGraphService(store, artifactStore);
      const before = store.status();
      hold(mode);
      await expect(service.ingestArtifact({ installationId: 'test-home', artifactId: artifact.id })).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
      expect(store.status()).toEqual(before);
      expect(store.listSources()).toHaveLength(0);
      expect(store.listNodes()).toHaveLength(0);
      expect(store.listEdges()).toHaveLength(0);
      expect((await artifactStore.readContent(artifact.id)).buffer).toEqual(createCompressedPdfBuffer('The synthetic manual supports local control.'));
      installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
      const ingested = await service.ingestArtifact({ installationId: 'test-home', artifactId: artifact.id, title: 'Keep this source title' });
      const indexed = store.getSource(ingested.source.id);
      const extracted = store.getExtractionBySourceId(ingested.source.id);
      const indexedStatus = store.status();
      hold(mode);
      await expect(service.ingestArtifact({ installationId: 'test-home', artifactId: artifact.id, title: 'Do not publish this replacement' })).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
      expect(store.getSource(ingested.source.id)).toEqual(indexed);
      expect(store.getExtractionBySourceId(ingested.source.id)).toEqual(extracted);
      expect(store.status()).toEqual(indexedStatus);
    });

    test(`recompile and reindex preserve the prior extraction when judgment is ${mode}`, async () => {
      const ctx = context();
      await ctx.store.init();
      const source = await ctx.store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Manual', status: 'indexed', artifactId: 'kept-artifact', tags: [] });
      const extraction = await ctx.store.upsertExtraction({ sourceId: source.id, extractorId: 'text', format: 'text', summary: 'Existing useful-looking text', structure: { searchText: 'Existing useful-looking text' }, metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION } });
      const before = ctx.store.status();
      hold(mode);
      await expect(recompileKnowledgeSource(ctx, source)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
      let extracts = 0;
      await expect(reindexHomeGraphSources({
        spaceId: 'test-home', sources: [source], artifactStore: ctx.artifactStore,
        extractionBySourceId: new Map([[source.id, extraction]]),
        extract: async () => { extracts += 1; return undefined; },
      })).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
      expect(extracts).toBe(0);
      expect(ctx.store.status()).toEqual(before);
      expect(ctx.store.getExtractionBySourceId(source.id)).toEqual(extraction);
      expect(ctx.store.listEdges()).toHaveLength(0);
    });
  }

  test('ask repair finishes all readability checks before replacing its extraction or linking nodes', async () => {
    const ctx = context();
    const artifact = await ctx.artifactStore.createFromStream({ kind: 'document', filename: 'manual.pdf', mimeType: 'application/pdf', stream: [createCompressedPdfBuffer('Manual features include local control.')] });
    const spaceId = homeAssistantKnowledgeSpaceId('test-home');
    const source = await ctx.store.upsertSource({ connectorId: 'homeassistant', sourceType: 'manual', title: 'Manual features', status: 'indexed', artifactId: artifact.id, tags: [], metadata: { knowledgeSpaceId: spaceId } });
    const old = await ctx.store.upsertExtraction({ sourceId: source.id, artifactId: artifact.id, extractorId: 'pdf', format: 'pdf', summary: 'PDF extraction produced limited text', metadata: { extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION } });
    const before = ctx.store.status();
    let calls = 0;
    installJudgmentPort(fakePort(() => noulAnswer(++calls === 3 ? 0.5 : 0.99)).port);
    service = new HomeGraphService(ctx.store, ctx.artifactStore);
    await expect(service.ask({ installationId: 'test-home', query: 'manual features' })).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(calls).toBe(3);
    expect(ctx.store.getExtractionBySourceId(source.id)).toEqual(old);
    expect(ctx.store.status()).toEqual(before);
    expect(ctx.store.listEdges()).toHaveLength(0);
  });

  test('older extractor versions regenerate from the same retained artifact', async () => {
    const ctx = context();
    const artifact = await ctx.artifactStore.createFromStream({ kind: 'document', filename: 'retained.txt', mimeType: 'text/plain', stream: ['The retained artifact contains updated instructions.'] });
    const source = await ctx.store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Retained manual', status: 'indexed', artifactId: artifact.id, tags: [] });
    await ctx.store.upsertExtraction({ sourceId: source.id, artifactId: artifact.id, extractorId: 'old', format: 'text', summary: 'Old extraction', metadata: { extractorVersion: 0 } });
    await recompileKnowledgeSource(ctx, source);
    expect(ctx.store.getExtractionBySourceId(source.id)?.summary).toContain('updated instructions');
    expect(ctx.store.getSource(source.id)?.artifactId).toBe(artifact.id);
    expect((await ctx.artifactStore.readContent(artifact.id)).buffer.toString()).toBe('The retained artifact contains updated instructions.');
  });
});
