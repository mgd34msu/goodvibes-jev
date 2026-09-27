/**
 * Passive knowledge injection, turn-knowledge-injection.ts unit suite.
 *
 * buildPerTurnKnowledgeInjection is a pure function of its inputs (no agent loop, no
 * feature flag, no AgentRecord) so every honesty/budget/floor behavior is exercised
 * directly here. The orchestrator-runner integration suite
 * (test/orchestrator-runner-turn-knowledge-injection.test.ts) covers the caller-side
 * wiring: the new-input re-retrieval guard, the cache-compounding fix, and the
 * flag/budget-0 byte-identical no-op.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPerTurnKnowledgeInjection,
  deriveTurnKnowledgeQuery,
  recordTurnInjection,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
  defaultTurnKnowledgeBudgetTokens,
  type TurnInjectionRecord,
} from '../sdk/src/platform/agents/turn-knowledge-injection.js';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
} from '../sdk/src/platform/state/index.js';
import type { MemoryRecord } from '../sdk/src/platform/state/memory-store.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ProviderMessage } from '../sdk/src/platform/providers/interface.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

// Knowledge ranking reads through the judgment port; the fake reads a record as
// relevant (0.95, score 180.5) when it shares a word with the query and as not
// relevant (0.05, dropped) otherwise.
const readings = useMemoryReadings();

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

function fakeRegistry(records: MemoryRecord[]) {
  return { getAll: () => records };
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deriveTurnKnowledgeQuery', () => {
  test('turn 1 (conversation tail === task) collapses to the task with no duplication', async () => {
    const tail: ProviderMessage[] = [{ role: 'user', content: 'fix the auth module' }];
    expect(deriveTurnKnowledgeQuery('fix the auth module', tail)).toBe('fix the auth module');
  });

  test('a later steer message is folded into the query alongside the frozen task', async () => {
    const tail: ProviderMessage[] = [
      { role: 'user', content: 'fix the auth module' },
      { role: 'assistant', content: 'working on it' },
      { role: 'user', content: 'focus on rate limiting specifically' },
    ];
    expect(deriveTurnKnowledgeQuery('fix the auth module', tail)).toBe('fix the auth module focus on rate limiting specifically');
  });

  test('multimodal user content (ContentPart[]) extracts only the text parts', async () => {
    const tail: ProviderMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'rate limiting' }, { type: 'image', data: 'x', mediaType: 'image/png' }] },
    ];
    expect(deriveTurnKnowledgeQuery('fix the auth module', tail)).toBe('fix the auth module rate limiting');
  });
});

describe('buildPerTurnKnowledgeInjection: query derivation pulls records the frozen task alone would miss', () => {
  test('a steer word retrieves a record with no overlap with the frozen task', async () => {
    // Against the frozen task alone the record reads as not relevant; only the steer's
    // "rate limiting" makes it read as relevant, so this genuinely exercises query
    // derivation rather than a trusted record clearing the floor on its own.
    const records = [
      makeRecord({ id: 'mem_ratelimit', summary: 'rate limiting uses a token bucket, 100 req/min', tags: ['rate-limiting'], reviewState: 'fresh', confidence: 55 }),
    ];
    const registry = fakeRegistry(records);
    const tail: ProviderMessage[] = [
      { role: 'user', content: 'update the docs' },
      { role: 'user', content: 'actually focus on rate limiting' },
    ];

    const frozenTaskOnly = await buildPerTurnKnowledgeInjection({
      memoryRegistry: registry,
      task: 'update the docs',
      conversationTail: [{ role: 'user', content: 'update the docs' }],
      budgetTokens: 2000,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(frozenTaskOnly.block).toBeNull(); // the frozen task alone never mentions rate limiting

    const withSteer = await buildPerTurnKnowledgeInjection({
      memoryRegistry: registry,
      task: 'update the docs',
      conversationTail: tail,
      budgetTokens: 2000,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 2,
    });
    expect(withSteer.block).not.toBeNull();
    expect(withSteer.record.injectedIds).toEqual(['mem_ratelimit']);
    expect(withSteer.record.query).toContain('rate limiting');
  });
});

describe('buildPerTurnKnowledgeInjection: relevance floor (stage 2)', () => {
  test('all candidates below the floor => block===null, honest reason, zero injectedIds', async () => {
    const records = [
      makeRecord({ id: 'mem_weak', summary: 'a barely-related note about auth', tags: ['auth'], reviewState: 'fresh', confidence: 55 }),
    ];
    const result = await buildPerTurnKnowledgeInjection({
      memoryRegistry: fakeRegistry(records),
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 2000,
      relevanceFloor: 10_000, // impossibly high, nothing can clear it
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(result.block).toBeNull();
    expect(result.record.injectedIds).toEqual([]);
    expect(result.record.tokenCost).toBe(0);
    expect(result.record.reason).toBe('no records cleared relevance floor');
    expect(result.record.candidatesConsidered).toBeGreaterThan(0);
  });

  test('a record that clears the floor is injected', async () => {
    const records = [
      makeRecord({ id: 'mem_strong', summary: 'auth module uses JWT, rotate every 15 minutes', tags: ['auth'], reviewState: 'reviewed', confidence: 90 }),
    ];
    const result = await buildPerTurnKnowledgeInjection({
      memoryRegistry: fakeRegistry(records),
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 2000,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(result.block).not.toBeNull();
    expect(result.record.injectedIds).toEqual(['mem_strong']);
    expect(result.record.reason).toBeUndefined();
  });
});

describe('buildPerTurnKnowledgeInjection: token budget (greedy trim)', () => {
  const records = [
    makeRecord({ id: 'mem_1', summary: 'auth module note one, reviewed and trusted for JWT rotation', tags: ['auth'], reviewState: 'reviewed', confidence: 90 }),
    makeRecord({ id: 'mem_2', summary: 'auth module note two, fresh and relevant to rate limiting policy', tags: ['auth'], reviewState: 'fresh', confidence: 70 }),
    makeRecord({ id: 'mem_3', summary: 'auth module note three, fresh and relevant to session expiry', tags: ['auth'], reviewState: 'fresh', confidence: 60 }),
  ];

  test('drops the lowest-scored entries first to fit the budget; tokenCost never exceeds it', async () => {
    const relevance: Record<string, number> = { mem_1: 0.95, mem_2: 0.85, mem_3: 0.7 };
    readings.use({ relevance: (_task, _scope, record) => ({ relevant: relevance[records.find((entry) => entry.summary === record.summary)!.id]! }) });
    const full = await buildPerTurnKnowledgeInjection({
      memoryRegistry: fakeRegistry(records),
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 100_000,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(full.record.injectedIds).toEqual(['mem_1', 'mem_2', 'mem_3']);
    expect(full.record.droppedForBudget).toEqual([]);

    // Budget one token short of what fits all three, mem_3 (the lowest-scored
    // surviving entry) is exactly what should get dropped.
    const tight = await buildPerTurnKnowledgeInjection({
      memoryRegistry: fakeRegistry(records),
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: full.record.tokenCost - 1, // one token short of fitting all three
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(tight.record.injectedIds).toEqual(['mem_1', 'mem_2']);
    expect(tight.record.droppedForBudget).toEqual(['mem_3']);
    expect(tight.record.tokenCost).toBeLessThanOrEqual(tight.record.budgetTokens);
    expect(tight.block).not.toBeNull();
  });

  test('single-entry-over-budget => nothing (block===null), not a truncated block', async () => {
    const result = await buildPerTurnKnowledgeInjection({
      memoryRegistry: fakeRegistry([records[0]!]),
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 1, // the single highest-scoring record cannot possibly fit in 1 token
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(result.block).toBeNull();
    expect(result.record.injectedIds).toEqual([]);
    expect(result.record.droppedForBudget).toEqual(['mem_1']);
    expect(result.record.tokenCost).toBe(0);
    expect(result.record.reason).toBe('single highest-scoring record exceeds budget');
  });

  test('budgetTokens<=0 is a correct (if wasteful) all-dropped case, not a crash', async () => {
    const result = await buildPerTurnKnowledgeInjection({
      memoryRegistry: fakeRegistry(records),
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 0,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(result.block).toBeNull();
    expect(result.record.injectedIds).toEqual([]);
    expect(result.record.droppedForBudget).toEqual(['mem_3', 'mem_2', 'mem_1']);
  });
});

describe('buildPerTurnKnowledgeInjection: dedupe against alreadyInjectedIds', () => {
  test('ids already surfaced (e.g. the spawn-time baseline) are never re-listed', async () => {
    const records = [
      makeRecord({ id: 'mem_1', summary: 'auth module JWT rotation', tags: ['auth'], reviewState: 'reviewed', confidence: 90 }),
      makeRecord({ id: 'mem_2', summary: 'auth module rate limiting', tags: ['auth'], reviewState: 'fresh', confidence: 70 }),
    ];
    const result = await buildPerTurnKnowledgeInjection({
      memoryRegistry: fakeRegistry(records),
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 2000,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: ['mem_1'],
      turn: 2,
    });
    expect(result.record.injectedIds).toEqual(['mem_2']);
    expect(result.record.injectedIds).not.toContain('mem_1');
  });
});

describe('buildPerTurnKnowledgeInjection: embeddings backend honesty', () => {
  test('a registry with vectorStats reporting enabled+available => embeddingBackend "available"', async () => {
    const records = [makeRecord({ id: 'mem_1', summary: 'auth module JWT rotation', tags: ['auth'], reviewState: 'reviewed', confidence: 90 })];
    const registry = {
      getAll: () => records,
      vectorStats: () => ({
        backend: 'sqlite-vec' as const,
        enabled: true,
        available: true,
        path: ':memory:',
        dimensions: 384,
        indexedRecords: 1,
        embeddingProviderId: 'fake',
        embeddingProviderLabel: 'fake',
      }),
    };
    const result = await buildPerTurnKnowledgeInjection({
      memoryRegistry: registry,
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 2000,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(result.record.embeddingBackend).toBe('available');
  });

  test('a registry with no vectorStats method at all => embeddingBackend "fallback-lexical"', async () => {
    const records = [makeRecord({ id: 'mem_1', summary: 'auth module JWT rotation', tags: ['auth'], reviewState: 'reviewed', confidence: 90 })];
    const result = await buildPerTurnKnowledgeInjection({
      memoryRegistry: fakeRegistry(records),
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 2000,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(result.record.embeddingBackend).toBe('fallback-lexical');
  });

  test('a REAL MemoryStore with enableVectorIndex:false still injects via lexical fallback, embeddingBackend "fallback-lexical"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-turn-knowledge-lexical-'));
    tmpRoots.push(root);
    const configManager = new ConfigManager({ configDir: join(root, 'config') });
    const store = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      enableVectorIndex: false,
    });
    await store.init();
    await store.add({
      cls: 'fact',
      summary: 'auth module uses JWT, rotate every 15 minutes',
      tags: ['auth'],
      review: { state: 'reviewed', confidence: 90 },
    });
    const registry = new MemoryRegistry(store);

    expect(registry.vectorStats().enabled).toBe(false);
    expect(registry.vectorStats().available).toBe(false);

    const result = await buildPerTurnKnowledgeInjection({
      memoryRegistry: registry,
      task: 'fix the auth module',
      conversationTail: [{ role: 'user', content: 'fix the auth module' }],
      budgetTokens: 2000,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(result.block).not.toBeNull();
    expect(result.record.injectedIds.length).toBe(1);
    expect(result.record.embeddingBackend).toBe('fallback-lexical');
  });
});

describe('defaultTurnKnowledgeBudgetTokens', () => {
  test('caps at 800 for large/unknown context windows', async () => {
    expect(defaultTurnKnowledgeBudgetTokens(0)).toBe(800);
    expect(defaultTurnKnowledgeBudgetTokens(1_000_000)).toBe(800);
  });

  test('scales down to 3% for small context windows', async () => {
    expect(defaultTurnKnowledgeBudgetTokens(10_000)).toBe(300);
  });
});

describe('recordTurnInjection: bounded ring', () => {
  function makeTurnRecord(turn: number): TurnInjectionRecord {
    return {
      turn,
      query: `q${turn}`,
      candidatesConsidered: 0,
      codeCandidatesConsidered: 0,
      injectedIds: [],
      injectedSources: [],
      droppedForBudget: [],
      tokenCost: 0,
      budgetTokens: 100,
      relevanceFloor: 10,
      ingestModes: [],
      embeddingBackend: 'fallback-lexical',
      reason: 'no records cleared relevance floor',
    };
  }

  test('grows normally under the retention cap', async () => {
    let ring: TurnInjectionRecord[] | undefined;
    ring = recordTurnInjection(ring, makeTurnRecord(1), 3);
    ring = recordTurnInjection(ring, makeTurnRecord(2), 3);
    expect(ring.map((r) => r.turn)).toEqual([1, 2]);
  });

  test('evicts the oldest entry once retention is exceeded', async () => {
    let ring: TurnInjectionRecord[] | undefined;
    for (let turn = 1; turn <= 5; turn++) {
      ring = recordTurnInjection(ring, makeTurnRecord(turn), 3);
    }
    expect(ring!.map((r) => r.turn)).toEqual([3, 4, 5]);
  });
});
