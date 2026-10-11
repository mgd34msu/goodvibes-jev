import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { KnowledgeGraphqlService } from '../sdk/src/platform/knowledge/graphql.js';
import { createKnowledgeApi } from '../sdk/src/platform/knowledge/knowledge-api.js';
import { KnowledgeService } from '../sdk/src/platform/knowledge/service.js';
import { knowledgeSpaceMetadata } from '../sdk/src/platform/knowledge/spaces.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../sdk/src/platform/state/index.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

const readings = useKnowledgeAnswerReadings();
const disposables = trackDisposables();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-graphql-scope-'));
  roots.push(root);
  const config = disposables.add(new ConfigManager({ configDir: join(root, 'config') }), value => value.stopWatchingConfigFiles());
  const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: config }),
    enableVectorIndex: false,
  });
  await memoryStore.init();
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const service = disposables.add(new KnowledgeService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }), undefined, {
    memoryRegistry: new MemoryRegistry(memoryStore),
  }));
  const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Outbox recovery guide', summary: 'Restore committed events before resuming workers.', status: 'indexed' });
  const node = await store.upsertNode({ kind: 'topic', slug: 'outbox-recovery', title: 'Outbox recovery', summary: 'Restore committed events before resuming workers.', sourceId: source.id, confidence: 95 });
  const issue = await store.upsertIssue({ severity: 'info', code: 'outbox.retry', message: 'Replay the committed outbox events.', sourceId: source.id, nodeId: node.id });
  const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id, relation: 'documents' });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'text', format: 'text', excerpt: 'Restore committed events before resuming workers.', sections: [], links: [], estimatedTokens: 10 });
  const foreignSource = await store.upsertSource({ connectorId: 'homeassistant', sourceType: 'document', title: 'Private kitchen lamp passport', status: 'indexed', metadata: knowledgeSpaceMetadata('homeassistant:fixture') });
  const foreignNode = await store.upsertNode({ kind: 'ha_device', slug: 'private-kitchen-lamp', title: 'Private kitchen lamp', confidence: 95, metadata: knowledgeSpaceMetadata('homeassistant:fixture') });
  await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: foreignNode.id, relation: 'references' });
  const foreignExtraction = await store.upsertExtraction({ sourceId: foreignSource.id, extractorId: 'text', format: 'text', excerpt: 'Private kitchen device telemetry.', sections: [], links: [], estimatedTokens: 5 });
  readings.set({ initialEvidenceCandidates: [
    ['source', 'Outbox recovery guide', 0.99],
    ['node', 'Outbox recovery', 0.99],
  ], excerpts: [['Restore committed events before resuming workers.', 0.99]], scope: [
    ['source', 'Outbox recovery guide', 0.99],
    ['node', 'Outbox recovery', 0.99],
    ['issue', 'Replay the committed outbox events.', 0.99],
  ] });
  return { store, service, graphql: new KnowledgeGraphqlService(service), source, node, issue, edge, extraction, foreignSource, foreignNode, foreignExtraction };
}

describe('knowledge GraphQL scope selections', () => {
  test('awaits real scoped collections, item views, extractions and neighbor edges', async () => {
    const { graphql, service, source, node, issue, edge, extraction, foreignSource, foreignNode } = await fixture();
    const result = await graphql.execute({
      query: `query($source: String!, $foreignSource: String!, $foreignNode: String!) {
        sources { id }
        nodes { id }
        issues { id }
        extractions { id sourceId }
        itemView(kind: "source", id: $source) { source { id } linkedNodes { id } }
        neighbors(kind: "source", id: $source) { id }
        sourceExtraction(sourceId: $source) { id }
        foreignItem: itemView(kind: "node", id: $foreignNode) { node { id } }
        foreignExtraction: sourceExtraction(sourceId: $foreignSource) { id }
        foreignNeighbors: neighbors(kind: "node", id: $foreignNode) { id }
      }`,
      variables: { source: source.id, foreignSource: foreignSource.id, foreignNode: foreignNode.id },
      admin: false,
      scopes: ['read:knowledge'],
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      sources: [{ id: source.id }],
      nodes: [{ id: node.id }],
      issues: [{ id: issue.id }],
      extractions: [{ id: extraction.id, sourceId: source.id }],
      itemView: { source: { id: source.id }, linkedNodes: [{ id: node.id }] },
      neighbors: [{ id: edge.id }],
      sourceExtraction: { id: extraction.id },
      foreignItem: null,
      foreignExtraction: null,
      foreignNeighbors: [],
    });
    expect((await service.getItems([node.id, foreignNode.id])).map(item => item.node?.id)).toEqual([node.id]);
  });

  test('holds uncertain scope readings without publishing records or read usage', async () => {
    const { graphql, store } = await fixture();
    readings.set({ scope: [
      ['source', 'Outbox recovery guide', 0.5],
      ['node', 'Outbox recovery', 0.99],
      ['issue', 'Replay the committed outbox events.', 0.99],
    ] });
    const usageBefore = store.listUsageRecords(100);
    const result = await graphql.execute({ query: '{ sources { id title } }', admin: false, scopes: ['read:knowledge'] });
    expect(result.data).toBeNull();
    expect(result.errors?.some(error => error.message.includes('Knowledge scope selection held: uncertain'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Outbox recovery guide');
    expect(store.listUsageRecords(100)).toEqual(usageBefore);
  });

  test('forwards retained ownership into real GraphQL search and packet composition', async () => {
    const { graphql, source, node } = await fixture();
    let checks = 0;
    const result = await graphql.execute({
      query: '{ search(query: "Outbox recovery") { id } packet(task: "Outbox recovery") { task items { id } } }',
      admin: false,
      scopes: ['read:knowledge'],
      scopeOptions: { assertCurrent: () => { checks += 1; }, shouldStop: () => false },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({
      search: expect.arrayContaining([{ id: source.id }]),
      packet: { task: 'Outbox recovery', items: expect.arrayContaining([{ id: node.id }]) },
    });
    expect(checks).toBeGreaterThan(2);
  });

  test('public grouped retrieval keeps item and extraction getters scoped and cancellable', async () => {
    const { store, service, node, source, extraction, foreignNode, foreignSource, foreignExtraction } = await fixture();
    const api = createKnowledgeApi(service);
    expect((await api.graph.items.get(node.id))?.node?.id).toBe(node.id);
    expect(await api.graph.items.get(foreignNode.id)).toBeNull();
    expect((await api.graph.extractions.get(extraction.id))?.id).toBe(extraction.id);
    expect(await api.graph.extractions.get(foreignExtraction.id)).toBeNull();
    expect((await api.graph.extractions.getBySourceId(source.id))?.id).toBe(extraction.id);
    expect(await api.graph.extractions.getBySourceId(foreignSource.id)).toBeNull();
    const aborted = AbortSignal.abort();
    const sourcesBefore = store.listSources();
    await expect(api.graph.items.get(node.id, {}, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.graph.extractions.get(extraction.id, {}, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.graph.extractions.getBySourceId(source.id, {}, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.sources.list(100, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.graph.nodes.list(100, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.graph.issues.list(100, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.status.get({}, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.graph.items.neighbors('source', source.id, {}, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.graph.map({}, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.graph.items.search('Outbox recovery', 10, { signal: aborted })).rejects.toThrow('Knowledge evidence relevance held (aborted)');
    await expect(api.projections.listTargets(25, {}, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.projections.render({ kind: 'source', id: source.id }, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    await expect(api.projections.materialize({ kind: 'source', id: source.id }, { signal: aborted })).rejects.toThrow('Knowledge scope selection held: aborted');
    expect(store.listSources()).toEqual(sourcesBefore);
  });

  test('retains the supplied mutation authority before awaiting module readiness', async () => {
    const { graphql, store } = await fixture();
    const schedulesBefore = store.listSchedules();
    const input = { query: 'mutation { deleteSchedule(id: "unrelated") }', admin: false, scopes: ['read:knowledge'] };
    const pending = graphql.execute(input);
    input.admin = true;
    input.scopes.push('write:knowledge');
    const result = await pending;
    expect(result.errors?.some(error => error.message.includes('requires admin access'))).toBe(true);
    expect(store.listSchedules()).toEqual(schedulesBefore);
  });

  test('forwards GraphQL request cancellation through a pending scope reading', async () => {
    const { graphql, store } = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const model = fakePort((name, _question, state) => {
      if (name !== 'included' || !state || typeof state !== 'object' || !('candidate' in state)) {
        throw new Error('Unexpected pending scope fixture.');
      }
      const candidate = state.candidate;
      if (!candidate || typeof candidate !== 'object' || !('content' in candidate)) throw new Error('Missing scope content.');
      const content = candidate.content;
      if (!content || typeof content !== 'object') throw new Error('Missing scope content.');
      const title = 'title' in content ? content.title : 'message' in content ? content.message : undefined;
      if (typeof title !== 'string' || !['Outbox recovery guide', 'Outbox recovery', 'Replay the committed outbox events.'].includes(title)) {
        throw new Error('Unscripted pending scope candidate.');
      }
      return noulAnswer(0.99);
    });
    const delayed: JudgmentPort = {
      ...model.port,
      async ask(request) {
        entered.resolve();
        await release.promise;
        return model.port.ask(request);
      },
    };
    const previous = installJudgmentPort(delayed);
    const controller = new AbortController();
    const usageBefore = store.listUsageRecords(100);
    try {
      const pending = graphql.execute({ query: '{ sources { id title } }', admin: false, scopes: ['read:knowledge'], scopeOptions: { signal: controller.signal } });
      const outcome = pending.then(value => ({ kind: 'completed' as const, value }), error => ({ kind: 'failed' as const, error }));
      await Promise.race([entered.promise, outcome.then(result => {
        throw new Error(`Scope request ended before model dispatch: ${result.kind === 'failed' ? String(result.error) : 'completed'}`);
      })]);
      controller.abort();
      release.resolve();
      const result = await outcome;
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') throw new Error('Cancelled scope request unexpectedly completed.');
      expect(result.error).toBeInstanceOf(Error);
      expect(String(result.error)).toContain('Knowledge scope selection held: aborted');
      expect(store.listUsageRecords(100)).toEqual(usageBefore);
    } finally {
      release.resolve();
      installJudgmentPort(previous);
    }
  });
});
