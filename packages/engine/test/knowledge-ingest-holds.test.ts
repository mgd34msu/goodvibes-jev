import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { finalizeKnowledgeIngestedSource } from '../sdk/src/platform/knowledge/ingest-compile.js';
import { ingestKnowledgeArtifact, ingestKnowledgeUrl } from '../sdk/src/platform/knowledge/ingest-inputs.js';
import { prepareKnowledgeExtraction } from '../sdk/src/platform/knowledge/prepared-extraction.js';
import { KnowledgeExtractionJudgmentHoldError } from '../sdk/src/platform/knowledge/extraction-policy.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { createCompressedPdfBuffer } from './_helpers/homegraph-service-fixtures.js';

let previous: JudgmentPort | undefined;
let root: string;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
  root = mkdtempSync(join(tmpdir(), 'knowledge-regular-ingest-hold-'));
});
afterEach(() => {
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
const URL = 'https://example.invalid/synthetic-manual.pdf';
const TEXT = 'A synthetic manual explains local control.';
const modes = ['uncertain', 'missing', 'unavailable'] as const;
function hold(mode: typeof modes[number]): void {
  installJudgmentPort(mode === 'missing' ? undefined : fakePort(() => {
    if (mode === 'unavailable') throw new Error('Synthetic port outage');
    return noulAnswer(0.5);
  }).port);
}

for (const route of ['artifact', 'url'] as const) {
  describe(`regular ${route} ingestion`, () => {
    for (const mode of modes) {
      test(`preserves new and existing source state when judgment is ${mode}`, async () => {
        const ctx = context();
        await ctx.store.init();
        const artifact = await ctx.artifactStore.createFromStream({ kind: 'document', filename: 'manual.pdf', mimeType: 'application/pdf', sourceUri: URL, stream: [createCompressedPdfBuffer(TEXT)] });
        const fetch = spyOn(ctx.artifactStore, 'create').mockResolvedValue(artifact);
        const ingest = (title: string) => route === 'artifact'
          ? ingestKnowledgeArtifact(ctx, { artifactId: artifact.id, uri: URL, title, sourceType: 'document' })
          : ingestKnowledgeUrl(ctx, { url: URL, title, sourceType: 'document' });
        try {
          const before = ctx.store.status();
          hold(mode);
          await expect(ingest('Not yet published')).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
          expect(ctx.store.status()).toEqual(before);
          expect(ctx.store.listSources()).toHaveLength(0);
          expect((await ctx.artifactStore.readContent(artifact.id)).buffer).toEqual(createCompressedPdfBuffer(TEXT));
          installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
          const first = await ingest('Keep this title');
          expect(first.source.status).toBe('indexed');
          const source = ctx.store.getSource(first.source.id);
          const extraction = ctx.store.getExtractionBySourceId(first.source.id);
          const status = ctx.store.status();
          hold(mode);
          await expect(ingest('Do not overwrite this source')).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
          expect(ctx.store.getSource(first.source.id)).toEqual(source);
          expect(ctx.store.getExtractionBySourceId(first.source.id)).toEqual(extraction);
          expect(ctx.store.status()).toEqual(status);
          expect(ctx.store.listSources()).toHaveLength(1);
        } finally { fetch.mockRestore(); }
      });
    }
  });
}

test('protected extraction text never creates a pending source', async () => {
  const ctx = context();
  await ctx.store.init();
  const artifact = await ctx.artifactStore.createFromStream({ kind: 'document', filename: 'private.pdf', mimeType: 'application/pdf', stream: [createCompressedPdfBuffer('password=synthetic-fixture')] });
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(fake.port);
  await expect(ingestKnowledgeArtifact(ctx, { artifactId: artifact.id, sourceType: 'document' })).rejects.toBeInstanceOf(JudgmentInputError);
  expect(ctx.store.listSources()).toHaveLength(0);
  expect(fake.requests).toHaveLength(0);
});

test('a prepared result is bound to source, artifact and immutable artifact bytes and consumed once', async () => {
  const ctx = context();
  const first = await ctx.artifactStore.createFromStream({ kind: 'document', filename: 'first.txt', mimeType: 'text/plain', stream: ['First document.'] });
  const other = await ctx.artifactStore.createFromStream({ kind: 'document', filename: 'other.txt', mimeType: 'text/plain', stream: ['Other document.'] });
  const source = await ctx.store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Original', status: 'indexed', tags: [] });
  const token = await prepareKnowledgeExtraction(ctx, source.id, first.id);
  const base = { sourceId: source.id, artifactId: first.id, preparedExtraction: token, connectorId: 'manual', sourceType: 'document' as const, tags: [], metadata: {} };
  await expect(finalizeKnowledgeIngestedSource(ctx, { ...base, sourceId: 'another-source' })).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
  await expect(finalizeKnowledgeIngestedSource(ctx, { ...base, artifactId: other.id })).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
  expect(ctx.store.getExtractionBySourceId(source.id)).toBeNull();
  expect(ctx.store.getSource(source.id)).toEqual(source);
  const originalRecord = ctx.artifactStore.getRecord(first.id)!;
  const changed = spyOn(ctx.artifactStore, 'getRecord').mockReturnValue({ ...originalRecord, sha256: 'changed-fingerprint' });
  try { await expect(finalizeKnowledgeIngestedSource(ctx, base)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError); }
  finally { changed.mockRestore(); }
  expect(ctx.store.getExtractionBySourceId(source.id)).toBeNull();
  const result = await finalizeKnowledgeIngestedSource(ctx, base);
  expect(result.extraction.summary).toBe('First document.');
  await expect(finalizeKnowledgeIngestedSource(ctx, base)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
  expect(ctx.store.getExtractionBySourceId(source.id)).toEqual(result.extraction);
  // Stored artifact integrity is checked before any extraction is judged.
  const record = ctx.artifactStore.getRecord(other.id)!;
  writeFileSync(record.contentPath, 'Corrupted bytes.');
  await expect(prepareKnowledgeExtraction(ctx, source.id, other.id)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
});

test('ordinary parse failures retain the failed-record path', async () => {
  const ctx = context();
  const artifact = await ctx.artifactStore.createFromStream({ kind: 'document', filename: 'empty.pdf', mimeType: 'application/pdf', stream: [createCompressedPdfBuffer('')] });
  const result = await ingestKnowledgeArtifact(ctx, { artifactId: artifact.id, title: 'Empty PDF', sourceType: 'document' });
  expect(result.source.status).toBe('failed');
  expect(result.source.crawlError).toContain('PDF extraction failed');
  expect(ctx.store.getExtractionBySourceId(result.source.id)).toBeNull();
  expect(ctx.artifactStore.getRecord(artifact.id)).not.toBeNull();
});
