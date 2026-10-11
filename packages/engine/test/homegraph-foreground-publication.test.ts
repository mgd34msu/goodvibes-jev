import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, spyOn, test } from 'bun:test';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createAsyncDisposalScope } from '../sdk/src/platform/runtime/async-disposal.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

const answerReadings = useKnowledgeAnswerReadings();

async function answerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-answer-tail-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const semantic = new KnowledgeSemanticService(store);
  const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
  const query = 'Does the reference device have local control?';
  const body = 'The reference device includes local control through its front panel.';
  answerReadings.set({ initialEvidence: [['Reference manual', 0.99]], initialEvidenceDefault: 0.01, sources: [['Reference manual', 0.99]],
    excerpts: [[body, 0.99]], objectAlignment: [{ query, objects: [
      { title: 'Reference device', concreteObject: 0.99, integrationObject: 0.01, aligned: 0.99 },
    ] }] });
  await service.syncSnapshot({ installationId: 'tail-house', pageAutomation: { enabled: false },
    devices: [{ id: 'reference-device', name: 'Reference device' }] });
  const source = await store.upsertSource({ connectorId: 'fixture', sourceType: 'manual', title: 'Reference manual',
    canonicalUri: 'manual://reference', status: 'indexed', metadata: { knowledgeSpaceId: 'homeassistant:tail-house' } });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', excerpt: body,
    metadata: { knowledgeSpaceId: 'homeassistant:tail-house' } });
  await service.linkKnowledge({ installationId: 'tail-house', sourceId: source.id,
    target: { kind: 'device', id: 'reference-device', relation: 'has_manual' } });
  return { root, store, artifactStore, semantic, service, query, source };
}

test('the selected-source enrichment tail starts after actual ask page publication', async () => {
  const f = await answerFixture();
  const entered = Promise.withResolvers<void>();
  let enrichmentCalls = 0;
  const enrich = spyOn(f.semantic, 'enrichSources').mockImplementation(async (sources, input) => {
    try {
      enrichmentCalls += 1;
      const pageSource = f.store.listSources().find(source => source.metadata.automation === 'ask-refresh');
      expect(pageSource).toBeDefined();
      if (!pageSource?.artifactId) throw new Error('Enrichment started before the generated page was published.');
      expect(f.artifactStore.get(pageSource.artifactId)).toBeDefined();
      expect(sources.map(source => source.id)).toEqual([f.source.id]);
      expect(input?.signal?.aborted).toBe(false);
      entered.resolve();
      return [];
    } catch (error) { entered.reject(error); throw error; }
  });
  const createArtifact = f.artifactStore.create.bind(f.artifactStore);
  const create = spyOn(f.artifactStore, 'create').mockImplementation(async (input, ownership) => {
    if (input.metadata?.automation === 'ask-refresh') expect(enrichmentCalls).toBe(0);
    return createArtifact(input, ownership);
  });
  try {
    const answer = await f.service.ask({ installationId: 'tail-house', query: f.query });
    expect(answer.results.some(result => result.source?.id === f.source.id)).toBe(true);
    await entered.promise;
    expect(enrichmentCalls).toBe(1);
  } finally {
    await f.service.dispose(); create.mockRestore(); enrich.mockRestore();
    await f.store.close(); rmSync(f.root, { recursive: true, force: true });
  }
});

test('manual publication aborts and drains the active selected-source tail before capturing page inputs', async () => {
  const f = await answerFixture();
  const entered = Promise.withResolvers<AbortSignal>();
  const stopped = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let drained = false;
  let manualPublication = false;
  let activeSignal: AbortSignal | undefined;
  const enrichSources = f.semantic.enrichSources.bind(f.semantic);
  let calls = 0;
  const enrich = spyOn(f.semantic, 'enrichSources').mockImplementation(async (sources, input = {}) => {
    if (++calls !== 1) return [];
    const signal = input.signal;
    if (!signal) throw new Error('Selected-source tail omitted its native cancellation signal.');
    activeSignal = signal;
    entered.resolve(signal);
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    stopped.resolve();
    await release.promise;
    try { return await enrichSources(sources, input); }
    finally { drained = true; finished.resolve(); }
  });
  const createArtifact = f.artifactStore.create.bind(f.artifactStore);
  const create = spyOn(f.artifactStore, 'create').mockImplementation(async (input, ownership) => {
    if (manualPublication && input.metadata?.generatedKnowledgePage === true) expect(drained).toBe(true);
    return createArtifact(input, ownership);
  });
  try {
    await f.service.ask({ installationId: 'tail-house', query: f.query });
    const signal = await entered.promise;
    manualPublication = true;
    const page = f.service.refreshDevicePassport({ installationId: 'tail-house', deviceId: 'reference-device' });
    await stopped.promise;
    expect(signal.aborted).toBe(true);
    expect(drained).toBe(false);
    release.resolve();
    const result = await page;
    expect(drained).toBe(true);
    expect(f.artifactStore.get(result.artifact.id)).toBeDefined();
  } finally {
    const closing = f.service.dispose(); release.resolve(); await closing; if (activeSignal) await finished.promise;
    create.mockRestore(); enrich.mockRestore();
    await f.store.close(); rmSync(f.root, { recursive: true, force: true });
  }
});

for (const operation of ['reset', 'dispose'] as const) {
  test(`${operation} revokes an active selected-source tail and prevents later enrichment writes`, async () => {
    const f = await answerFixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let activeSignal: AbortSignal | undefined;
    const enrichSources = f.semantic.enrichSources.bind(f.semantic);
    const enrich = spyOn(f.semantic, 'enrichSources').mockImplementation(async (sources, input = {}) => {
      const signal = input.signal;
      if (!signal) throw new Error('Selected-source tail omitted its native cancellation signal.');
      activeSignal = signal; entered.resolve(signal);
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      stopped.resolve(); await release.promise;
      try { return await enrichSources(sources, input); }
      finally { finished.resolve(); }
    });
    const records = () => JSON.stringify({ sources: f.store.listSources(), nodes: f.store.listNodes(), edges: f.store.listEdges(), issues: f.store.listIssues() });
    try {
      await f.service.ask({ installationId: 'tail-house', query: f.query });
      const signal = await entered.promise;
      const before = records();
      const closing = operation === 'reset'
        ? f.service.resetSpace({ installationId: 'tail-house' })
        : f.service.dispose();
      let closed = false;
      void closing.then(() => { closed = true; });
      if (operation === 'dispose') expect(signal.aborted).toBe(true);
      await stopped.promise;
      expect(signal.aborted).toBe(true);
      expect(closed).toBe(false);
      expect(records()).toBe(before);
      release.resolve(); await finished.promise; await closing;
      expect(closed).toBe(true);
      if (operation === 'dispose') expect(records()).toBe(before);
      else {
        expect(f.store.getSource(f.source.id)).toBeNull();
        expect(f.store.listNodes().filter(node => node.metadata.knowledgeSpaceId === 'homeassistant:tail-house')).toEqual([]);
      }
    } finally {
      const closing = f.service.dispose(); release.resolve(); await closing; if (activeSignal) await finished.promise;
      enrich.mockRestore(); await f.store.close(); rmSync(f.root, { recursive: true, force: true });
    }
  });
}

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
      await service.dispose();
      if (backgroundSignal) await finished.promise;
      artifact.mockRestore(); background.mockRestore();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}

test('canonical runtime close aborts and drains a real sync pump before closing its knowledge store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-runtime-close-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const semantic = new KnowledgeSemanticService(store);
  const service = new HomeGraphService(store, artifactStore, { semanticService: semantic });
  const scope = createAsyncDisposalScope('actual HomeGraph runtime owner');
  let storeClosed = false;
  scope.registry.add('knowledge store', async () => { await store.close(); storeClosed = true; });
  scope.registry.add('home graph service', () => service.dispose());
  const entered = Promise.withResolvers<AbortSignal>();
  const stopped = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const selfImprove = semantic.selfImprove.bind(semantic);
  let captured: AbortSignal | undefined;
  const background = spyOn(semantic, 'selfImprove').mockImplementation(async (input = {}, options = {}) => {
    if (input.reason !== 'homegraph-sync' || captured) return selfImprove(input, options);
    const signal = input.signal;
    if (!signal) throw new Error('Scheduled background pump omitted its native cancellation signal.');
    captured = signal; entered.resolve(signal);
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    stopped.resolve(); await release.promise;
    return selfImprove(input, options);
  });
  const records = () => JSON.stringify({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() });
  try {
    await service.syncSnapshot({ installationId: 'close-house', pageAutomation: { enabled: false },
      devices: [{ id: 'reference-device', name: 'Reference device' }] });
    const signal = await entered.promise;
    const before = records();
    const closing = scope.close();
    expect(signal.aborted).toBe(true);
    expect(scope.close()).toBe(closing);
    await stopped.promise;
    expect(storeClosed).toBe(false);
    expect(records()).toBe(before);
    release.resolve(); await closing;
    expect(storeClosed).toBe(true);
    const reopened = new KnowledgeStore({ dbPath: store.storagePath });
    await reopened.init();
    expect(JSON.stringify({ sources: reopened.listSources(), nodes: reopened.listNodes(), edges: reopened.listEdges(), issues: reopened.listIssues() })).toBe(before);
    await reopened.close();
  } finally {
    release.resolve(); await scope.close(); background.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
