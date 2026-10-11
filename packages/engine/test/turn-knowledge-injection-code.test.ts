/**
 * Stage B, turn-knowledge-injection.ts code-injection unit suite.
 *
 * buildPerTurnKnowledgeInjection now optionally merges repo code-index hits into the
 * SAME token budget / relevance floor as memory records, tagging each injected line with
 * its source. These are pure-function tests: a fake TurnCodeIndexSource supplies hits +
 * stats, so every honesty gate (empty / provider-mismatch / no-semantic-provider), the
 * supplied-relevance→floor projection, budget competition, dedupe, and the flag gate are exercised
 * directly.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildPerTurnKnowledgeInjection,
  CODE_RELEVANCE_TO_SCORE_SCALE,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
  type TurnCodeIndexSource,
} from '../sdk/src/platform/agents/turn-knowledge-injection.js';
import type { MemoryRecord } from '../sdk/src/platform/state/memory-store.js';
import type { CodeContextResult, CodeIndexStats } from '../sdk/src/platform/state/index.js';
import type { ProviderMessage } from '../sdk/src/platform/providers/interface.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

// Knowledge ranking reads through the judgment port; the fake reads a memory record
// as relevant (score 180.5) when it shares a word with the query.
useMemoryReadings();

function makeRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    scope: 'project', cls: 'fact', summary: 'a record', detail: undefined, tags: [],
    provenance: [], reviewState: 'fresh', confidence: 60, createdAt: 1, updatedAt: 1, ...overrides,
  };
}
function fakeMemory(records: MemoryRecord[]) {
  return { getAll: () => records };
}

function makeCodeHit(path: string, similarity: number, opts: { label?: 'semantic' | 'lexical'; symbol?: string; startLine?: number; endLine?: number } = {}): CodeContextResult {
  const startLine = opts.startLine ?? 10;
  const endLine = opts.endLine ?? 30;
  return {
    chunk: {
      chunkId: `${path}#${startLine}`,
      path,
      lang: 'ts',
      symbol: opts.symbol ?? 'doThing',
      kind: 'function',
      startLine,
      endLine,
      contentHash: 'h',
      mtimeMs: 1,
      fileHash: 'fh',
    },
    distance: 2 * (1 - similarity),
    similarity,
    label: opts.label ?? 'semantic',
  };
}

const HEALTHY_STATS: Pick<CodeIndexStats, 'available' | 'indexedChunks' | 'embeddingProviderMismatch' | 'semanticRetrievalAvailable'> = {
  available: true,
  indexedChunks: 42,
  embeddingProviderMismatch: undefined,
  semanticRetrievalAvailable: true,
};

function fakeCodeIndex(hits: CodeContextResult[], statsOverride: Partial<typeof HEALTHY_STATS> = {}): TurnCodeIndexSource {
  return {
    search: async () => hits,
    // These budget-only fixtures explicitly supply readings; canonical contrary-vector behavior has its own caller suite.
    rankForInjection: async (_query, hits) => ({ ranked: hits.map(hit => ({ hit, probability: hit.similarity })), assertCurrent: async () => {} }),
    stats: () => ({ ...HEALTHY_STATS, ...statsOverride }),
  };
}

const TAIL: ProviderMessage[] = [{ role: 'user', content: 'fix the auth module' }];

function baseInput(over: Partial<Parameters<typeof buildPerTurnKnowledgeInjection>[0]> = {}) {
  return {
    memoryRegistry: fakeMemory([]),
    task: 'fix the auth module',
    conversationTail: TAIL,
    budgetTokens: 4000,
    relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
    alreadyInjectedIds: [],
    turn: 1,
    ...over,
  };
}

describe('code injection: honest source labeling within the shared budget', () => {
  test('a code hit above the floor is injected, labeled source=code-index, ingestMode=its match label', async () => {
    // supplied probability 0.8 → score 152, above the default floor 95
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.8, { label: 'semantic', symbol: 'verify' })]);
    const result = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));

    expect(result.block).not.toBeNull();
    expect(result.record.injectedIds).toEqual(['src/auth.ts:10-30']);
    expect(result.record.injectedSources).toEqual(['code-index']);
    expect(result.record.ingestModes).toEqual(['semantic']);
    expect(result.record.codeCandidatesConsidered).toBe(1);
    expect(result.record.codeInjectionSkipped).toBeUndefined();
    expect(result.block).toContain('## Injected Code Context');
    expect(result.block).toContain('src/auth.ts:10-30');
  });

  test('memory and code compete in one merged, best-first list with parallel source labels', async () => {
    const memory = fakeMemory([makeRecord({ id: 'mem_auth', summary: 'auth module uses JWT rotation', tags: ['auth'], reviewState: 'reviewed', confidence: 90 })]);
    // supplied probability 0.6 → score 114
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.6)]);
    const result = await buildPerTurnKnowledgeInjection(baseInput({ memoryRegistry: memory, codeIndex: code, codeInjectionEnabled: true }));

    expect(result.record.injectedIds).toContain('mem_auth');
    expect(result.record.injectedIds).toContain('src/auth.ts:10-30');
    // parallel arrays stay aligned
    const idx = result.record.injectedIds.indexOf('src/auth.ts:10-30');
    expect(result.record.injectedSources[idx]).toBe('code-index');
    const memIdx = result.record.injectedIds.indexOf('mem_auth');
    expect(result.record.injectedSources[memIdx]).toBe('memory');
    expect(result.block).toContain('## Injected Project Knowledge');
    expect(result.block).toContain('## Injected Code Context');
  });
});

describe('code injection: supplied relevance → floor projection (scale 190)', () => {
  test('boundary: score exactly at the floor is admitted, just under is rejected', async () => {
    const floor = 95;
    const atFloor = 0.5; // 0.5 * 190 = 95 === floor
    const belowFloor = 0.49; // 93.1 < 95
    const inRange = await buildPerTurnKnowledgeInjection(baseInput({
      codeIndex: fakeCodeIndex([makeCodeHit('src/at.ts', atFloor)]),
      codeInjectionEnabled: true,
      relevanceFloor: floor,
    }));
    expect(inRange.record.injectedIds).toEqual(['src/at.ts:10-30']);

    const under = await buildPerTurnKnowledgeInjection(baseInput({
      codeIndex: fakeCodeIndex([makeCodeHit('src/under.ts', belowFloor)]),
      codeInjectionEnabled: true,
      relevanceFloor: floor,
    }));
    expect(under.block).toBeNull();
    expect(under.record.codeCandidatesConsidered).toBe(1);
    expect(under.record.codeInjectionSkipped).toBe('no code chunks cleared the relevance floor');
  });

  test('a supplied low relevance probability never clears the default floor', async () => {
    const orthogonal = fakeCodeIndex([makeCodeHit('src/unrelated.ts', 0.29)]); // 0.29*190 = 55.1 < 95
    const result = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: orthogonal, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(CODE_RELEVANCE_TO_SCORE_SCALE).toBe(190);
  });
});

describe('code injection: never injects from an unhealthy index (stats gates)', () => {
  test('empty index (indexedChunks 0) => skipped "code index empty", no search, no injection', async () => {
    let searched = false;
    const code: TurnCodeIndexSource = {
      search: async () => { searched = true; return [makeCodeHit('src/x.ts', 0.9)]; },
      stats: () => ({ ...HEALTHY_STATS, indexedChunks: 0 }),
    };
    const result = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(searched).toBe(false);
    expect(result.record.codeInjectionSkipped).toBe('code index empty');
    expect(result.record.codeCandidatesConsidered).toBe(0);
  });

  test('provider-space mismatch => skipped with the store\'s own message, never injects', async () => {
    const code = fakeCodeIndex([makeCodeHit('src/x.ts', 0.9)], { embeddingProviderMismatch: 'embeddings built with X, current provider Y, rebuild to re-embed' });
    const result = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(result.record.codeInjectionSkipped).toContain('rebuild to re-embed');
  });

  test('no semantic provider (hashed-only) => skipped "no semantic embedding provider"', async () => {
    const code = fakeCodeIndex([makeCodeHit('src/x.ts', 0.9)], { semanticRetrievalAvailable: false });
    const result = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(result.record.codeInjectionSkipped).toBe('no semantic embedding provider');
  });

  test('unavailable store => skipped "code index unavailable"', async () => {
    const code = fakeCodeIndex([makeCodeHit('src/x.ts', 0.9)], { available: false });
    const result = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(result.block).toBeNull();
    expect(result.record.codeInjectionSkipped).toBe('code index unavailable');
  });
});

describe('code injection: flag/gate off is a hard no-op', () => {
  test('codeInjectionEnabled false: index never queried, no code fields set', async () => {
    let searched = false;
    const code: TurnCodeIndexSource = {
      search: async () => { searched = true; return [makeCodeHit('src/x.ts', 0.9)]; },
      stats: () => HEALTHY_STATS,
    };
    const result = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: false }));
    expect(searched).toBe(false);
    expect(result.record.codeCandidatesConsidered).toBe(0);
    expect(result.record.codeInjectionSkipped).toBeUndefined();
  });

  test('no code source at all: memory-only record shape unchanged (codeCandidatesConsidered 0)', async () => {
    const memory = fakeMemory([makeRecord({ id: 'mem_1', summary: 'auth module JWT rotation', tags: ['auth'], reviewState: 'reviewed', confidence: 90 })]);
    const result = await buildPerTurnKnowledgeInjection(baseInput({ memoryRegistry: memory }));
    expect(result.record.injectedIds).toEqual(['mem_1']);
    expect(result.record.injectedSources).toEqual(['memory']);
    expect(result.record.codeCandidatesConsidered).toBe(0);
    expect(result.block).not.toContain('## Injected Code Context');
  });
});

describe('code injection: budget competition and dedupe', () => {
  test('a lower-scored code hit is dropped for budget before a higher-scored memory record', async () => {
    const memory = fakeMemory([makeRecord({ id: 'mem_hi', summary: 'auth module JWT rotation reviewed and trusted', tags: ['auth'], reviewState: 'reviewed', confidence: 95 })]);
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.5)]); // score 95, lower than the memory record
    // First measure the full cost, then set budget one token short.
    const full = await buildPerTurnKnowledgeInjection(baseInput({ memoryRegistry: memory, codeIndex: code, codeInjectionEnabled: true, budgetTokens: 100_000 }));
    expect(full.record.injectedIds).toContain('src/auth.ts:10-30');

    const tight = await buildPerTurnKnowledgeInjection(baseInput({ memoryRegistry: memory, codeIndex: code, codeInjectionEnabled: true, budgetTokens: full.record.tokenCost - 1 }));
    expect(tight.record.injectedIds).toEqual(['mem_hi']);
    expect(tight.record.droppedForBudget).toEqual(['src/auth.ts:10-30']);
    expect(tight.record.tokenCost).toBeLessThanOrEqual(tight.record.budgetTokens);
  });

  test('a code id already in alreadyInjectedIds is not re-listed (retry-fresh dedupe)', async () => {
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.8, { startLine: 10, endLine: 30 }), makeCodeHit('src/other.ts', 0.7, { startLine: 5, endLine: 9 })]);
    const result = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true, alreadyInjectedIds: ['src/auth.ts:10-30'] }));
    expect(result.record.injectedIds).toEqual(['src/other.ts:5-9']);
    expect(result.record.codeCandidatesConsidered).toBe(1); // the deduped one is not "considered"
  });

  test('compose-fresh: two calls recompute independently against their own alreadyInjected sets', async () => {
    const code = fakeCodeIndex([makeCodeHit('src/auth.ts', 0.8)]);
    const first = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true }));
    expect(first.record.injectedIds).toEqual(['src/auth.ts:10-30']);
    const second = await buildPerTurnKnowledgeInjection(baseInput({ codeIndex: code, codeInjectionEnabled: true, alreadyInjectedIds: first.record.injectedIds }));
    expect(second.record.injectedIds).toEqual([]); // already surfaced, none fresh
    expect(second.block).toBeNull();
  });
});
