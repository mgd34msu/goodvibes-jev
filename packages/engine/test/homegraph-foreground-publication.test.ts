import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, spyOn, test } from 'bun:test';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

useKnowledgeAnswerReadings();

for (const pageKind of ['passport', 'room'] as const) {
  test(`manual ${pageKind} publication drains its same-space background pump before creating an artifact`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-foreground-'));
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
    const semantic = new KnowledgeSemanticService(store);
    const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
    const entered = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let backgroundSignal: AbortSignal | undefined;
    let backgroundDrained = false;
    let generatedArtifacts = 0;
    const selfImprove = semantic.selfImprove.bind(semantic);
    const background = spyOn(semantic, 'selfImprove').mockImplementation(async (input = {}, options = {}) => {
      if (input.reason !== 'homegraph-sync' || backgroundSignal) return selfImprove(input, options);
      const signal = input.signal;
      if (!signal) throw new Error('Scheduled background pump omitted its cancellation signal.');
      backgroundSignal = signal;
      entered.resolve();
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      try { return await selfImprove(input, options); }
      finally { backgroundDrained = true; finished.resolve(); }
    });
    const createArtifact = artifactStore.create.bind(artifactStore);
    const artifact = spyOn(artifactStore, 'create').mockImplementation(async (input, ownership) => {
      if (input.metadata?.generatedKnowledgePage === true) {
        generatedArtifacts += 1;
        expect(backgroundSignal?.aborted).toBe(true);
        expect(backgroundDrained).toBe(true);
      }
      return createArtifact(input, ownership);
    });
    try {
      await service.syncSnapshot({
        installationId: 'foreground-house', pageAutomation: { enabled: false },
        areas: [{ id: 'living-room', name: 'Living Room' }],
        devices: [{ id: 'reference-device', name: 'Reference device', areaId: 'living-room' }],
      });
      expect(generatedArtifacts).toBe(0);
      await entered.promise;
      const page = pageKind === 'passport'
        ? await service.refreshDevicePassport({ installationId: 'foreground-house', deviceId: 'reference-device' })
        : await service.generateRoomPage({ installationId: 'foreground-house', areaId: 'living-room' });
      expect(generatedArtifacts).toBeGreaterThan(0);
      expect(backgroundSignal?.aborted).toBe(true);
      expect(backgroundDrained).toBe(true);
      const source = page.source;
      if (!source) throw new Error('Successful foreground publication omitted its source.');
      expect(store.getSourceSnapshot({ id: source.id }).source).toEqual(source);
      expect(artifactStore.get(page.artifact.id)).toBeDefined();
    } finally {
      service.dispose();
      if (backgroundSignal) await finished.promise;
      artifact.mockRestore(); background.mockRestore();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}
