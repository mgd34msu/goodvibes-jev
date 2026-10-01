import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { ingestKnowledgeArtifact } from '../sdk/src/platform/knowledge/ingest-inputs.js';
import { KnowledgeExtractionJudgmentHoldError } from '../sdk/src/platform/knowledge/extraction-policy.js';
import { htmlExtractionPort } from './_helpers/html-extraction-readings.js';

let root: string;
let previous: JudgmentPort | undefined;
let service: HomeGraphService | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); root = mkdtempSync(join(tmpdir(), 'html-ingest-hold-')); });
afterEach(() => { service?.dispose(); service = undefined; installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); });

for (const route of ['regular', 'homegraph'] as const) {
  describe(`${route} HTML ingestion`, () => {
    for (const mode of ['uncertain', 'missing', 'unavailable'] as const) {
      test(`holds ${mode} readings without replacing prior source or extraction`, async () => {
        const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
        const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
        const context = { store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(), emitIfReady: () => {}, syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [] };
        await store.init();
        const html = '<title>Synthetic manual</title><article><h1>Synthetic manual</h1><p>Local control instructions.</p></article>';
        const uri = 'https://example.invalid/manual.html';
        const artifact = await artifactStore.createFromStream({ kind: 'document', mimeType: 'text/html', filename: 'manual.html', sourceUri: uri, stream: [html] });
        service = new HomeGraphService(store, artifactStore);
        const homegraph = service;
        const ingest = (title: string) => route === 'regular'
          ? ingestKnowledgeArtifact(context, { artifactId: artifact.id, uri, title, sourceType: 'document' })
          : homegraph.ingestArtifact({ installationId: 'test-home', artifactId: artifact.id, title });
        const hold = () => installJudgmentPort(mode === 'missing' ? undefined : fakePort(() => {
          if (mode === 'unavailable') throw new Error('Synthetic unavailable port');
          return noulAnswer(0.5);
        }).port);
        const before = store.status();
        hold();
        await expect(ingest('Not yet indexed')).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
        expect(store.status()).toEqual(before);
        expect(store.listSources()).toHaveLength(0);
        installJudgmentPort(htmlExtractionPort().port);
        const first = await ingest('Keep this source');
        const source = store.getSource(first.source.id);
        const extraction = store.getExtractionBySourceId(first.source.id);
        const indexed = store.status();
        hold();
        await expect(ingest('Do not replace this source')).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
        expect(store.getSource(first.source.id)).toEqual(source);
        expect(store.getExtractionBySourceId(first.source.id)).toEqual(extraction);
        expect(store.status()).toEqual(indexed);
        expect((await artifactStore.readContent(artifact.id)).buffer.toString()).toBe(html);
      });
    }
  });
}
