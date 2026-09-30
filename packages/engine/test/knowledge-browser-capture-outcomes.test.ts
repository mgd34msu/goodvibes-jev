import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { ingestBrowserKnowledge } from '../sdk/src/platform/knowledge/browser-history/ingest.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { RuntimeEventBus, type KnowledgeEvent } from '../sdk/src/platform/runtime/events/index.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { runKnowledgeServiceJobByKind, type KnowledgeServiceJobRunnerContext } from '../sdk/src/platform/knowledge/service-jobs.js';
import { createDaemonKnowledgeRouteHandlers } from '../daemon-sdk/src/knowledge-routes.js';
import type { DaemonKnowledgeRouteContext } from '../daemon-sdk/src/knowledge-route-types.js';
import { KNOWLEDGE_BROWSER_SYNC_RESULT_SCHEMA } from '../sdk/src/platform/control-plane/operator-contract-schemas-knowledge.js';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.js';

let root: string;
let previous: JudgmentPort | undefined;
const opened: KnowledgeStore[] = [];
const uri = 'https://synthetic.example.test/aurora';
const sqlite = (store: KnowledgeStore) => (store as unknown as { sqlite: SQLiteStore }).sqlite;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-browser-outcomes-'));
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
  opened.splice(0).forEach((store) => sqlite(store).close());
  rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const home = join(root, 'synthetic-home');
  const profile = join(home, '.config', 'chromium', 'Default');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: {
    type: 'folder', name: 'Synthetic bookmarks', children: [
      { type: 'url', id: '1', name: 'Aurora reference', url: uri },
    ],
  } } }));
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath });
  opened.push(store);
  await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const bus = new RuntimeEventBus();
  const events: KnowledgeEvent[] = [];
  bus.onDomain('knowledge', (event) => { events.push(event.payload); });
  const context = {
    store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(),
    emitIfReady: (fn: (bus: RuntimeEventBus, context: { traceId: string; sessionId: string; source: string }) => void) => {
      fn(bus, { traceId: 'synthetic-browser', sessionId: 'synthetic-session', source: 'test' });
    },
    syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [],
  };
  const options = { homeOverride: home, browsers: ['chromium'] as const, sourceKinds: ['bookmark'] as const };
  const ingest = () => ingestBrowserKnowledge(context, options);
  const reopen = async () => {
    const copy = new KnowledgeStore({ dbPath });
    opened.push(copy);
    await copy.init();
    return copy;
  };
  return { store, artifactStore, context, options, events, ingest, reopen };
}

async function retainRichSource(f: Awaited<ReturnType<typeof fixture>>) {
  const artifact = await f.artifactStore.createFromStream({ kind: 'document', filename: 'synthetic-manual.txt',
    mimeType: 'text/plain', sourceUri: uri, stream: ['Richer reference content remains available.'] });
  const source = await f.store.upsertSource({ id: 'retained-source', connectorId: 'synthetic-manual',
    sourceType: 'manual', canonicalUri: uri, sourceUri: uri, title: 'Aurora Runtime manual',
    summary: 'Retained rich source summary', artifactId: artifact.id, contentHash: 'retained-hash', status: 'indexed',
    tags: ['project:Aurora Runtime'], metadata: { retained: true } });
  const extraction = await f.store.upsertExtraction({ sourceId: source.id, artifactId: artifact.id, extractorId: 'synthetic-rich',
    format: 'text', summary: 'Aurora Runtime reference', excerpt: 'Richer reference content remains available.',
    sections: ['Reference'], links: [] });
  return { source, extraction };
}

function settle() {
  const fake = fakePort((name) => noulAnswer(name === 'alias' ? 0.01 : 0.99));
  installJudgmentPort(fake.port);
  return fake;
}

describe('browser capture and compilation outcomes', () => {
  test('alias hold reports retained capture, preserves rich evidence and retries the same source', async () => {
    const f = await fixture();
    const retained = await retainRichSource(f);
    const result = await f.ingest();
    expect(result).toMatchObject({ imported: 0, failed: 1, captured: 1, sources: [], outcomes: [{
      canonicalUri: uri, sourceId: retained.source.id, capture: 'completed', compilation: 'held',
    }] });
    expect(result.capturedSources).toHaveLength(1);
    expect(result.errors[0]).toContain('Browser capture retained; compilation held:');
    expect(result.outcomes[0]?.error).toContain('Knowledge entity aliases are on hold');
    expect(f.events.map((event) => event.type)).toEqual(['KNOWLEDGE_INGEST_STARTED', 'KNOWLEDGE_INGEST_FAILED']);
    expect(f.events[1]).toMatchObject({ sourceId: retained.source.id, error: result.outcomes[0]?.error });
    const reopened = await f.reopen();
    expect(reopened.getSource(retained.source.id)).toEqual(result.capturedSources[0]!);
    expect(reopened.getSource(retained.source.id)).toMatchObject({ connectorId: retained.source.connectorId,
      sourceType: 'manual', artifactId: retained.source.artifactId, summary: retained.source.summary, contentHash: 'retained-hash',
      metadata: { retained: true, browserObservationCount: 1, browserSourceKinds: ['bookmark'] } });
    expect(reopened.getExtractionBySourceId(retained.source.id)).toEqual(retained.extraction);
    expect(reopened.listNodes().map((node) => node.kind)).toEqual(['source_group']);
    expect(reopened.listEdges().map((edge) => edge.relation)).toEqual(['bookmarked_in_browser_profile']);

    settle();
    const retried = await f.ingest();
    expect(retried).toMatchObject({ imported: 1, failed: 0, captured: 1, errors: [], outcomes: [{
      sourceId: retained.source.id, capture: 'completed', compilation: 'completed',
    }] });
    expect(retried.sources).toEqual(retried.capturedSources);
    const graph = f.store.listNodes().map((node) => node.id).sort();
    expect(f.store.listNodes().find((node) => node.kind === 'project')?.status).toBe('active');
    expect((await f.ingest()).sources[0]?.id).toBe(retained.source.id);
    const replayed = await f.reopen();
    expect(replayed.listSources()).toHaveLength(1);
    expect(replayed.listNodes().map((node) => node.id).sort()).toEqual(graph);
    expect(replayed.listEdges().filter((edge) => edge.relation === 'bookmarked_in_browser_profile')).toHaveLength(1);
    expect(replayed.getExtractionBySourceId(retained.source.id)).toEqual(retained.extraction);
  });

  test('activation hold preserves earlier accepted graph while reporting new capture honestly', async () => {
    const f = await fixture();
    await retainRichSource(f);
    settle();
    const first = await f.ingest();
    expect(first.imported).toBe(1);
    const project = f.store.listNodes().find((node) => node.kind === 'project')!;
    expect(project.status).toBe('active');
    await f.store.upsertSource({ ...first.sources[0]!, tags: [...first.sources[0]!.tags, 'new-staged-topic'] });
    const reader = fakePort((name) => noulAnswer(name === 'serve' ? 0.01 : 0.99));
    installJudgmentPort(reader.port);
    f.events.length = 0;
    const result = await f.ingest();
    expect(reader.requests.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ imported: 0, failed: 1, captured: 1, sources: [], outcomes: [{
      sourceId: project.metadata.compiledFrom, capture: 'completed', compilation: 'held',
    }] });
    expect(result.errors[0]).toContain('Knowledge node activation held');
    const reopened = await f.reopen();
    expect(reopened.getSource(result.outcomes[0]!.sourceId!)).toEqual(result.capturedSources[0]!);
    expect(reopened.getNode(project.id)).toEqual(project);
    expect(reopened.listNodes().some((node) => node.title === 'new-staged-topic')).toBe(false);
    expect(f.events.some((event) => event.type === 'KNOWLEDGE_INGEST_COMPLETED' || event.type === 'KNOWLEDGE_COMPILE_COMPLETED')).toBe(false);
  });

  test('completed compilation can retain pending-review drafts without asserting factual acceptance', async () => {
    const f = await fixture();
    await retainRichSource(f);
    installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    const result = await f.ingest();
    expect(result).toMatchObject({ imported: 1, failed: 0, captured: 1, outcomes: [{ compilation: 'completed' }] });
    const reopened = await f.reopen();
    const project = reopened.listNodes().find((node) => node.kind === 'project')!;
    expect(project.status).toBe('draft');
    expect(project.metadata.reviewProvenance).toMatchObject({ state: 'pending-review' });
    expect(reopened.listNodes().find((node) => node.kind === 'source_group')?.status).toBe('active');
  });

  test('operational compile failure is failed, retains capture and rolls back compiler writes', async () => {
    const f = await fixture();
    const database = sqlite(f.store), run = database.run.bind(database);
    let edgeWrites = 0;
    database.run = (sql, params) => {
      if (sql.includes('INSERT OR REPLACE INTO knowledge_edges') && ++edgeWrites === 2) {
        throw new Error('Synthetic compiler SQL failure');
      }
      run(sql, params);
    };
    let result;
    try { result = await f.ingest(); }
    finally { database.run = run; }
    expect(edgeWrites).toBe(2);
    expect(result).toMatchObject({ imported: 0, failed: 1, captured: 1, sources: [], outcomes: [{
      capture: 'completed', compilation: 'failed',
    }] });
    expect(result.errors[0]).toContain('Browser capture retained; compilation failed: Synthetic compiler SQL failure');
    const reopened = await f.reopen();
    expect(reopened.getSource(result.outcomes[0]!.sourceId!)).toEqual(result.capturedSources[0]!);
    expect(reopened.listExtractions()[0]?.extractorId).toBe('browser-history');
    expect(reopened.listNodes().map((node) => node.kind)).toEqual(['source_group']);
    expect(reopened.listEdges().map((edge) => edge.relation)).toEqual(['bookmarked_in_browser_profile']);
    expect((await f.ingest()).outcomes[0]?.compilation).toBe('completed');
  });

  test('capture failure before storing the source has no retained capture or compilation', async () => {
    const f = await fixture();
    const failure = spyOn(f.store, 'upsertSource').mockRejectedValueOnce(new Error('Synthetic source write failure'));
    let result;
    try { result = await f.ingest(); }
    finally { failure.mockRestore(); }
    expect(result).toMatchObject({ imported: 0, failed: 1, captured: 0, sources: [], capturedSources: [], outcomes: [{
      canonicalUri: uri, capture: 'failed', compilation: 'not-attempted',
    }] });
    expect(result.outcomes[0]?.sourceId).toBeUndefined();
    expect((await f.reopen()).listSources()).toEqual([]);
  });

  test('capture failure after storing the source reports its partial durable identity for retry', async () => {
    const f = await fixture();
    const failure = spyOn(f.store, 'upsertExtraction').mockRejectedValueOnce(new Error('Synthetic extraction write failure'));
    let result;
    try { result = await f.ingest(); }
    finally { failure.mockRestore(); }
    expect(result).toMatchObject({ imported: 0, failed: 1, captured: 0, capturedSources: [], sources: [], outcomes: [{
      canonicalUri: uri, capture: 'partial', compilation: 'not-attempted',
    }] });
    expect(result.errors[0]).toContain('Browser capture partially retained; compilation not attempted:');
    const reopened = await f.reopen();
    expect(reopened.listSources().map((source) => source.id)).toEqual([result.outcomes[0]!.sourceId!]);
    expect(reopened.listExtractions()).toEqual([]);
    expect(reopened.listNodes()).toEqual([]);
    const retried = await f.ingest();
    expect(retried).toMatchObject({ imported: 1, failed: 0, captured: 1 });
    expect(retried.sources[0]?.id).toBe(result.outcomes[0]?.sourceId);
    expect((await f.reopen()).listSources()).toHaveLength(1);
  });

  test('daemon response, contract validation and job summary preserve held capture outcomes', async () => {
    const f = await fixture();
    await retainRichSource(f);
    const handlers = createDaemonKnowledgeRouteHandlers({
      requireAdmin: () => null,
      parseOptionalJsonBody: async () => f.options,
      knowledgeService: { syncBrowserHistory: f.ingest },
    } as unknown as DaemonKnowledgeRouteContext);
    const response = await handlers.postKnowledgeSyncBrowserHistory(new Request('https://daemon.invalid/api/knowledge/ingest/browser-history', { method: 'POST' }));
    const wire = await response.json();
    expect(response.status).toBe(201);
    expect(wire).toMatchObject({ imported: 0, failed: 1, captured: 1, outcomes: [{ capture: 'completed', compilation: 'held' }] });
    expect(firstJsonSchemaFailure(KNOWLEDGE_BROWSER_SYNC_RESULT_SCHEMA, wire)).toBeUndefined();
    const result = await f.ingest();
    const summary = await runKnowledgeServiceJobByKind('sync-browser-history', { limit: 7 }, {
      syncBrowserHistory: async (input) => { expect(input.limit).toBe(7); return result; },
    } as KnowledgeServiceJobRunnerContext);
    expect(summary).toEqual({ imported: 0, failed: 1, captured: 1, capturePartial: 0, captureFailed: 0,
      compilationHeld: 1, compilationFailed: 0, outcomes: result.outcomes, profileCount: 1, errorCount: 1 });
    expect(summary.outcomes).toEqual(wire.outcomes);
    expect((await f.reopen()).getSource(result.outcomes[0]!.sourceId!)).toEqual(result.capturedSources[0]!);
  });
});
