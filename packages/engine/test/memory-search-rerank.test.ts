/**
 * MemoryStore search ranking: retrieval (the SQL filter, the vector index) is
 * code, and the `engine.state.memory-search` rerank orders what retrieval found
 * whenever there is a query. With no query the order is structural
 * (compareByTrust: unflagged first, then confidence, then recency). The review
 * queue is ordered by the `engine.state.memory-review-priority` reading.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { MemoryEmbeddingProviderRegistry, MemoryStore } from '../sdk/src/platform/state/index.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function openStore(enableVectorIndex: boolean): Promise<MemoryStore> {
  const root = mkdtempSync(join(tmpdir(), 'gv-memory-rerank-'));
  roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const store = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex,
  });
  await store.init();
  return store;
}

const MATCH: Record<string, number> = {
  'deploy note: staging uses deploy/staging.sh': 0.62,
  'deploy note: production rollouts are blue-green via deploy/rollout.sh': 0.94,
  'deploy note: the deploy bot posts to #releases': 0.2,
};

describe('MemoryStore.search with a query', () => {
  const readings = useMemoryReadings({ searchMatch: (_query, candidate) => MATCH[candidate.summary] ?? 0.05 });

  test('orders what the SQL filter retrieved by the rerank, not by where the words appear', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'runbook', summary: 'deploy note: the deploy bot posts to #releases', review: { confidence: 95 } });
    await store.add({ cls: 'runbook', summary: 'deploy note: staging uses deploy/staging.sh', review: { confidence: 90 } });
    await store.add({ cls: 'runbook', summary: 'deploy note: production rollouts are blue-green via deploy/rollout.sh', review: { confidence: 60 } });
    await store.add({ cls: 'fact', summary: 'the test runner is bun test' });

    const found = await store.search({ query: 'deploy', limit: 2 });
    expect(found.map((record) => record.summary)).toEqual([
      'deploy note: production rollouts are blue-green via deploy/rollout.sh',
      'deploy note: staging uses deploy/staging.sh',
    ]);
    // Only the three records the SQL filter retrieved were read, each in its own request.
    expect(readings.requests).toHaveLength(3);
    expect(readings.requests.map((request) => (request.state as { query: string }).query)).toEqual(['deploy', 'deploy', 'deploy']);
    store.close();
  });

  test('only the shortlist is reranked; the rest follow in retrieval order', async () => {
    readings.use({ searchMatch: () => 0.9 });
    const store = await openStore(false);
    for (let index = 0; index < 20; index += 1) {
      await store.add({ cls: 'fact', summary: `alpha note ${index}`, review: { confidence: 40 + index } });
    }
    const found = await store.search({ query: 'alpha', limit: 1 });
    expect(found).toHaveLength(1);
    // limit 1 reranks max(1*4, 12) = 12 of the 20 retrieved records.
    expect(readings.requests).toHaveLength(12);
    store.close();
  });

  test('no query: structural order, no request', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'fact', summary: 'flagged but confident', review: { state: 'stale', confidence: 99 } });
    await store.add({ cls: 'fact', summary: 'modest', review: { confidence: 60 } });
    await store.add({ cls: 'fact', summary: 'confident', review: { confidence: 80 } });
    const found = await store.search({});
    expect(found.map((record) => record.summary)).toEqual(['confident', 'modest', 'flagged but confident']);
    expect(store.retrieve({}).map((record) => record.summary)).toEqual(['confident', 'modest', 'flagged but confident']);
    expect(readings.requests).toHaveLength(0);
    store.close();
  });

  test('a query search with no judgment port installed throws', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'fact', summary: 'alpha' });
    const previous = installJudgmentPort(undefined);
    try {
      await expect(store.search({ query: 'alpha' })).rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally {
      installJudgmentPort(previous);
      store.close();
    }
  });
});

describe('MemoryStore.searchSemantic', () => {
  const readings = useMemoryReadings({ searchMatch: (_query, candidate) => MATCH[candidate.summary] ?? 0.05 });

  test('the vector index shortlists, the rerank orders, and score is the probability on 0 to 100', async () => {
    const store = await openStore(true);
    await store.add({ cls: 'runbook', summary: 'deploy note: staging uses deploy/staging.sh' });
    await store.add({ cls: 'runbook', summary: 'deploy note: production rollouts are blue-green via deploy/rollout.sh' });
    await store.add({ cls: 'runbook', summary: 'deploy note: the deploy bot posts to #releases' });
    await store.rebuildVectorIndexAsync();
    expect(store.vectorStats().available).toBe(true);

    const candidates = store.semanticCandidates({ query: 'how do we deploy to production' });
    expect(candidates.length).toBe(3);
    expect(readings.requests).toHaveLength(0);

    const results = await store.searchSemantic({ query: 'how do we deploy to production', limit: 2 });
    expect(results.map((entry) => entry.record.summary)).toEqual([
      'deploy note: production rollouts are blue-green via deploy/rollout.sh',
      'deploy note: staging uses deploy/staging.sh',
    ]);
    expect(results[0]!.score).toBeCloseTo(94);
    expect(results[0]!.similarity).toBeGreaterThan(0);
    expect(readings.requests).toHaveLength(3);
    store.close();
  });

  test('with the index disabled the literal search is reranked and reported with similarity 0', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'runbook', summary: 'deploy note: staging uses deploy/staging.sh' });
    await store.add({ cls: 'runbook', summary: 'deploy note: production rollouts are blue-green via deploy/rollout.sh' });
    const results = await store.searchSemantic({ query: 'deploy' });
    expect(results.map((entry) => entry.record.summary)).toEqual([
      'deploy note: production rollouts are blue-green via deploy/rollout.sh',
      'deploy note: staging uses deploy/staging.sh',
    ]);
    expect(results.map((entry) => entry.similarity)).toEqual([0, 0]);
    expect(results[1]!.score).toBeCloseTo(62);
    store.close();
  });

  test('no query: retrieval order, score is the record confidence, no request', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'fact', summary: 'one', review: { confidence: 70 } });
    const results = await store.searchSemantic({});
    expect(results.map((entry) => entry.score)).toEqual([70]);
    expect(readings.requests).toHaveLength(0);
    store.close();
  });
});

describe('MemoryStore.reviewQueue', () => {
  const readings = useMemoryReadings({
    reviewPriority: (record) => ({ 'unverified guess': 0.97, 'stale runtime note': 0.8, 'reviewed convention': 0.1 })[record.summary] ?? 0.5,
  });

  test('orders candidates by the review-priority reading, one request each, carrying review state and confidence', async () => {
    const store = await openStore(false);
    await store.add({ cls: 'pattern', summary: 'reviewed convention', review: { state: 'reviewed', confidence: 92 } });
    await store.add({ cls: 'constraint', summary: 'stale runtime note', review: { state: 'stale', confidence: 70, staleReason: 'aged out' } });
    await store.add({ cls: 'incident', summary: 'unverified guess', review: { confidence: 35 } });
    const queue = await store.reviewQueue(2);
    expect(queue.map((record) => record.summary)).toEqual(['unverified guess', 'stale runtime note']);
    expect(readings.requests).toHaveLength(3);
    const states = readings.requests.map((request) => (request.state as { record: Record<string, unknown> }).record);
    expect(states).toContainEqual({ review_state: 'stale', confidence: 70, stale_reason: 'aged out', class: 'constraint', summary: 'stale runtime note', tags: [] });
    store.close();
  });

  test('an empty queue makes no request; a non-empty one with no port installed throws', async () => {
    const store = await openStore(false);
    expect(await store.reviewQueue(5)).toEqual([]);
    expect(readings.requests).toHaveLength(0);
    await store.add({ cls: 'fact', summary: 'anything' });
    const previous = installJudgmentPort(undefined);
    try {
      await expect(store.reviewQueue(5)).rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally {
      installJudgmentPort(previous);
      store.close();
    }
  });
});
