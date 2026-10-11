/** Deferred real artifact/SQLite persistence through the actual daemon media routes. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeService } from '../sdk/src/platform/knowledge/service.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { MultimodalService } from '../sdk/src/platform/multimodal/service.js';
import { buildMediaRouteContext } from '../sdk/src/platform/daemon/http/router-route-contexts.js';
import { createDaemonMediaRouteHandlers } from '../daemon-sdk/src/media-routes.js';

const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const request = (body: unknown, signal?: AbortSignal) => new Request('http://localhost/api/multimodal/writeback', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}) });

for (const phase of ['artifact', 'knowledge'] as const) for (const change of ['cancel', 'source', 'port', 'permission', 'generic-cancel'] as const) {
  test(`${change} during real ${phase} await leaves no canceled analysis or SQLite source`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'multimodal-fence-')); roots.push(root);
    const fake = fakePort((_name, _question, state) => noulAnswer((state as { candidate?: { term: string } }).candidate?.term === 'AI' ? 0.99 : 0.01));
    previous = installJudgmentPort(fake.port); installed = true;
    const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
    const knowledge = new KnowledgeService(store, artifacts, new KnowledgeConnectorRegistry(), { memoryRegistry: { add() {}, getAll: () => [], getStore: () => undefined } as never,
      semanticService: { enrichSource: async () => {}, queueBackgroundSelfImprove() {} } as never });
    const source = await artifacts.create({ kind: 'image', mimeType: 'image/png', text: 'image', filename: 'source.png' });
    const media = { status: async () => [], findProvider: () => ({ analyze: async () => ({ providerId: 'fixture', text: 'AI', labels: [], metadata: {} }) }) };
    const voice = { getStatus: async () => ({ providers: [] }) };
    const service = new MultimodalService(artifacts, media as never, voice as never, knowledge);
    let allowed = true;
    const handlers = createDaemonMediaRouteHandlers(buildMediaRouteContext({ artifactStore: artifacts, configManager: { get: () => undefined } as never,
      mediaProviders: media as never, voiceService: voice as never, webSearchService: {} as never, multimodalService: service,
      parseJsonBody: async req => await req.json() as Record<string, unknown>, requireAdmin: () => allowed ? null : new Response('Denied', { status: 403 }),
    }));
    const analyzed = await handlers.postMultimodalAnalyze(request({ artifactId: source.id }));
    expect(analyzed.status).toBe(201);
    const { analysis } = await analyzed.json() as { analysis: unknown };
    const entered = gate(), release = gate();
    const originalCreate = artifacts.createFromStream.bind(artifacts);
    const originalApply = store.applyPreparedIngest.bind(store);
    const artifactSpy = phase === 'artifact' ? spyOn(artifacts, 'createFromStream').mockImplementation(async (input, ownership) => originalCreate({ ...input,
      stream: (async function* () { yield Buffer.from('partial owned analysis'); entered.resolve(); await release.promise; if (change === 'generic-cancel') throw new Error('Synthetic spool error'); yield Buffer.from('rest'); })(), sizeBytes: undefined,
    }, ownership)) : undefined;
    const knowledgeSpy = phase === 'knowledge' ? spyOn(store, 'applyPreparedIngest').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; if (change === 'generic-cancel') throw new Error('Synthetic transaction preparation error'); return originalApply(...args);
    }) : undefined;
    const controller = new AbortController();
    const pending = handlers.postMultimodalWriteback(request({ analysis }, controller.signal));
    await entered.promise;
    if (change === 'cancel' || change === 'generic-cancel') controller.abort();
    if (change === 'source') artifacts.delete(source.id);
    if (change === 'port') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    if (change === 'permission') allowed = false;
    release.resolve();
    try {
      expect((await pending).status).toBe(400);
      expect(artifacts.list().map(item => item.id)).toEqual(change === 'source' ? [] : [source.id]);
      expect(readdirSync(artifacts.storagePath).filter(name => !name.startsWith(source.id))).toEqual([]);
      expect(store.listSources()).toHaveLength(0); expect(store.listExtractions()).toHaveLength(0); expect(store.listNodes()).toHaveLength(0);
      const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await reopened.init();
      expect(reopened.listSources()).toHaveLength(0); expect(reopened.listExtractions()).toHaveLength(0);
    } finally { artifactSpy?.mockRestore(); knowledgeSpy?.mockRestore(); }
  });
}

test('guarded ingestion reports the true commit before a later generic completion failure', async () => {
  const { ingestKnowledgeArtifact } = await import('../sdk/src/platform/knowledge/ingest-inputs.js');
  const root = mkdtempSync(join(tmpdir(), 'multimodal-commit-receipt-')); roots.push(root);
  previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); installed = true;
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const artifact = await artifacts.create({ kind: 'document', mimeType: 'text/plain', text: 'AI is the central topic.' });
  const context = { store, artifactStore: artifacts, connectorRegistry: new KnowledgeConnectorRegistry(), emitIfReady() {},
    syncReviewedMemory: async () => { throw new Error('Synthetic post-commit completion failure'); }, lint: async () => [], listConnectors: () => [] };
  let committed: string | undefined;
  await expect(ingestKnowledgeArtifact(context, { artifactId: artifact.id }, { assertCurrent() {}, onCommitted: id => { committed = id; } })).rejects.toThrow('Synthetic');
  expect(committed).toBeDefined(); expect(store.getSource(committed!)?.status).toBe('indexed');
  expect(artifacts.get(artifact.id)).not.toBeNull();
});
