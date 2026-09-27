/**
 * knowledge-injection.ts ranking: retrieval (confidence gate, review-state and
 * temporal exclusion, the vector index as shortlist builder) is code; the
 * order, the reason and the ingest mode come from the
 * `engine.state.knowledge-relevance` readings, one request per shortlisted
 * record. `selectKnowledgeForTask` is exactly the scored list, mapped to
 * injections and sliced to the limit.
 */
import { describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import {
  buildKnowledgeInjectionPrompt,
  KNOWLEDGE_SCORE_SCALE,
  selectKnowledgeForTask,
  selectKnowledgeForTaskScored,
} from '../sdk/src/platform/state/knowledge-injection.js';
import type { MemoryRecord, MemorySemanticSearchResult } from '../sdk/src/platform/state/memory-store.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

function makeRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'project',
    cls: 'fact',
    summary: 'a record',
    detail: undefined,
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeRegistry(records: MemoryRecord[], semantic: MemorySemanticSearchResult[] = []) {
  return {
    getAll: () => records,
    ...(semantic.length > 0 ? { semanticCandidates: () => semantic } : {}),
  };
}

const RELEVANCE: Record<string, number> = {
  'auth module uses JWT tokens': 0.93,
  'auth module rate limiting': 0.81,
  'auth module caching layer': 0.62,
  'auth module retry policy': 0.5,
  'unrelated deployment note': 0.04,
};

describe('knowledge-injection.ts: ranking through the knowledge-relevance readings', () => {
  const readings = useMemoryReadings({
    relevance: (_task, _scope, record) => ({ relevant: RELEVANCE[record.summary] ?? 0.05, taskMatch: 0.9 }),
  });

  test('orders by the relevant reading, drops a clear no, and never reads gated records', async () => {
    const records = [
      makeRecord({ id: 'mem_c', summary: 'auth module rate limiting', confidence: 65 }),
      makeRecord({ id: 'mem_b', summary: 'unrelated deployment note' }),
      makeRecord({ id: 'mem_a', summary: 'auth module uses JWT tokens', reviewState: 'reviewed', confidence: 70 }),
      makeRecord({ id: 'mem_d', summary: 'low confidence auth note', confidence: 40 }),
      makeRecord({ id: 'mem_e', summary: 'contradicted auth note', reviewState: 'contradicted', confidence: 90 }),
      makeRecord({ id: 'mem_x', summary: 'expired auth note', validUntil: Date.now() - 1000 }),
    ];
    const scored = await selectKnowledgeForTaskScored(makeRegistry(records), 'fix the auth module', [], 2);

    expect(scored.map((entry) => entry.injection.id)).toEqual(['mem_a', 'mem_c']);
    expect(scored[0]!.score).toBeCloseTo(0.93 * KNOWLEDGE_SCORE_SCALE);
    expect(scored[0]!.injection.reason).toBe('matched task');
    expect(scored[0]!.injection.ingestMode).toBe('keyword-ranked');
    expect(scored[0]!.injection.trustTier).toBe('reviewed');
    // Only the three gate-passing records were read, and with no write scope the
    // scope question is left out of each request.
    expect(readings.requests).toHaveLength(3);
    for (const request of readings.requests) {
      expect(Object.keys(request.questions).sort()).toEqual(['relevant', 'task_match']);
    }
  });

  test('selectKnowledgeForTask is the scored list mapped to injections and sliced to the limit', async () => {
    const records = ['auth module uses JWT tokens', 'auth module rate limiting', 'auth module caching layer', 'auth module retry policy']
      .map((summary, index) => makeRecord({ id: `mem_${index}`, summary }));
    const registry = makeRegistry(records);
    const scored = await selectKnowledgeForTaskScored(registry, 'fix the auth module', [], 2);
    // An uncertain reading (0.5) stays for the caller's floor; only a clear no is dropped.
    expect(scored.map((entry) => entry.injection.id)).toEqual(['mem_0', 'mem_1', 'mem_2', 'mem_3']);
    expect(scored[3]!.injection.reason).toBe('matched task');
    const sliced = await selectKnowledgeForTask(registry, 'fix the auth module', [], 2);
    expect(sliced).toEqual(scored.slice(0, 2).map((entry) => entry.injection));
  });

  test('an empty registry makes no request and yields nothing', async () => {
    const registry = makeRegistry([]);
    expect(await selectKnowledgeForTask(registry, 'anything', [], 3)).toEqual([]);
    expect(await selectKnowledgeForTaskScored(registry, 'anything', [], 3)).toEqual([]);
    expect(readings.requests).toHaveLength(0);
    expect(buildKnowledgeInjectionPrompt([])).toBeNull();
  });

  test('a scope match is reported as such, and the files the record names reach the reading', async () => {
    readings.use({ relevance: () => ({ relevant: 0.9, taskMatch: 0.1, scopeMatch: 0.92 }) });
    const record = makeRecord({ id: 'mem_scope', summary: 'login form keeps its CSRF token in a hidden field', provenance: [{ kind: 'file', ref: 'src/auth/login.ts' }] });
    const scored = await selectKnowledgeForTaskScored(makeRegistry([record]), 'unrelated task text', ['src/auth/login.ts'], 3);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.injection.reason).toBe('matched write scope');
    const state = readings.requests[0]!.state as { write_scope: string[]; record: { files: string[] } };
    expect(state.write_scope).toEqual(['src/auth/login.ts']);
    expect(state.record.files).toEqual(['src/auth/login.ts']);
  });

  test('vector candidates go first on the shortlist and label the ingest mode', async () => {
    readings.use({ relevance: (_task, _scope, record) => ({ relevant: 0.9, taskMatch: record.summary.startsWith('semantic and text') ? 0.9 : 0.1 }) });
    const hybrid = makeRecord({ id: 'hybrid', summary: 'semantic and text match' });
    const semanticOnly = makeRecord({ id: 'semantic', summary: 'semantic only' });
    const registry = makeRegistry([hybrid, semanticOnly], [
      { record: hybrid, distance: 0.2, similarity: 0.8, score: 80 },
      { record: semanticOnly, distance: 0.3, similarity: 0.71, score: 71 },
    ]);
    const scored = await selectKnowledgeForTaskScored(registry, 'task', [], 3);
    const byId = new Map(scored.map((entry) => [entry.injection.id, entry.injection]));
    expect(byId.get('hybrid')!.ingestMode).toBe('hybrid-ranked');
    expect(byId.get('hybrid')!.reason).toBe('matched task, matched sqlite-vec semantic index (80%)');
    expect(byId.get('semantic')!.ingestMode).toBe('semantic-ranked');
    expect(byId.get('semantic')!.reason).toBe('matched sqlite-vec semantic index (71%)');
  });

  test('only the shortlist is read: max(limit*4, 12) records', async () => {
    readings.use({ relevance: () => ({ relevant: 0.9 }) });
    const records = Array.from({ length: 30 }, (_, index) => makeRecord({ id: `mem_${index}`, summary: `note ${index}`, confidence: 60 + index }));
    const scored = await selectKnowledgeForTaskScored(makeRegistry(records), 'task', [], 2);
    expect(readings.requests).toHaveLength(12);
    // The top-up takes the most trusted records: highest confidence first.
    expect(scored.map((entry) => entry.injection.id)).toContain('mem_29');
    expect(scored.map((entry) => entry.injection.id)).not.toContain('mem_0');
  });

  test('a read with no judgment port installed throws', async () => {
    const previous = installJudgmentPort(undefined);
    try {
      await expect(selectKnowledgeForTaskScored(makeRegistry([makeRecord({ id: 'a' })]), 'task')).rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally {
      installJudgmentPort(previous);
    }
  });
});
