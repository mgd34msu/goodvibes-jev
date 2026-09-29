import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  resolveMemoryConsolidationConfig,
  runMemoryConsolidation,
} from '../sdk/src/platform/state/index.js';
import type {
  MemoryConsolidationRegistry,
  MemoryConsolidationUsageSignal,
  MemoryRecord,
  ResolvedMemoryConsolidationConfig,
} from '../sdk/src/platform/state/index.js';
// MemoryReviewPatch is a real exported type (memory-store.ts) but is not
// re-exported from the state barrel (state/index.ts), pull it from source.
import type { MemoryReviewPatch } from '../sdk/src/platform/state/memory-store.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

/**
 * Idle-time memory consolidation policy (hoisted from the agent surface).
 * Asserts the reversible-only contract: merges mark losers stale (never delete),
 * decay orders never-referenced first, and new-memory/delete work is PROPOSED,
 * never silently written. Whether a pair is a duplicate, a contradiction or
 * unrelated comes from the memory-alignment and memory-agreement readings,
 * answered here by the fake port in _helpers/memory-readings.ts (equal
 * summaries are the same fact; equal or missing details restate it,
 * different details conflict).
 */
const readings = useMemoryReadings();

const DAY_MS = 24 * 60 * 60 * 1000;

function rec(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = 1_000_000_000_000;
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    scope: 'project',
    cls: 'fact',
    summary: 'a fact',
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** In-memory registry satisfying the consolidation write seam, so tests control every field. */
class FakeRegistry implements MemoryConsolidationRegistry {
  public readonly records = new Map<string, MemoryRecord>();
  public readonly reviewCalls: Array<{ id: string; patch: MemoryReviewPatch }> = [];
  public readonly updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

  constructor(records: readonly MemoryRecord[]) {
    for (const r of records) this.records.set(r.id, r);
  }

  getAll(): readonly MemoryRecord[] {
    return [...this.records.values()];
  }

  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null {
    const existing = this.records.get(id);
    if (!existing) return null;
    this.reviewCalls.push({ id, patch });
    const updated: MemoryRecord = {
      ...existing,
      reviewState: patch.state ?? existing.reviewState,
      confidence: patch.confidence ?? existing.confidence,
      ...(patch.reviewedBy !== undefined ? { reviewedBy: patch.reviewedBy } : {}),
      ...(patch.staleReason !== undefined ? { staleReason: patch.staleReason } : {}),
    };
    this.records.set(id, updated);
    return updated;
  }

  update(id: string, patch: { scope?: MemoryRecord['scope']; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null {
    const existing = this.records.get(id);
    if (!existing) return null;
    this.updateCalls.push({ id, patch });
    const updated: MemoryRecord = { ...existing, ...(patch.tags ? { tags: patch.tags } : {}) };
    this.records.set(id, updated);
    return updated;
  }
}

const NOW = 1_000_000_000_000;
const cfg = (over: Partial<ResolvedMemoryConsolidationConfig> = {}): ResolvedMemoryConsolidationConfig => ({
  ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  ...over,
});

describe('runMemoryConsolidation: merges', () => {
  test('exact-duplicate summary merges losers to stale, unions tags, never deletes', async () => {
    const survivor = rec({ id: 'survivor', reviewState: 'reviewed', confidence: 80, updatedAt: NOW, summary: 'CI deploy note', tags: ['ci'] });
    const dup = rec({ id: 'dup', reviewState: 'fresh', confidence: 60, updatedAt: NOW - 1000, summary: 'CI deploy note', tags: ['deploy'] });
    const reg = new FakeRegistry([survivor, dup]);

    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'manual', idle: true, randomSuffix: () => 'abc123' });

    expect(receipt.merged.length).toBe(1);
    expect(receipt.merged[0]!.survivorId).toBe('survivor');
    expect(receipt.merged[0]!.duplicateIds).toContain('dup');
    // Loser marked stale, NOT deleted.
    expect(reg.records.size).toBe(2);
    expect(reg.records.get('dup')!.reviewState).toBe('stale');
    // Tag union applied to survivor.
    expect(reg.records.get('survivor')!.tags.sort()).toEqual(['ci', 'deploy']);
    expect(receipt.runId).toBe(`mcon-${NOW.toString(36)}-abc123`);
  });

  test('same-summary records across scopes are PROPOSED, never merged', async () => {
    const a = rec({ id: 'a', scope: 'project', summary: 'shared', updatedAt: NOW });
    const b = rec({ id: 'b', scope: 'team', summary: 'shared', updatedAt: NOW });
    const reg = new FakeRegistry([a, b]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged.length).toBe(0);
    expect(receipt.proposed.some((p) => p.kind === 'cross-scope-duplicate')).toBe(true);
    expect(reg.records.get('a')!.reviewState).toBe('fresh');
  });
});

describe('runMemoryConsolidation: proposals reach the review machinery', () => {
  test('a contradiction proposal marks BOTH disagreeing records contradicted (review-queue entry + injection exclusion)', async () => {
    // Same summary, different detail, and the survivor is NOT clearly newer-verified.
    const a = rec({ id: 'a', reviewState: 'fresh', confidence: 60, updatedAt: NOW, summary: 'the port', detail: 'port is 8080' });
    const b = rec({ id: 'b', reviewState: 'fresh', confidence: 60, updatedAt: NOW, summary: 'the port', detail: 'port is 9090' });
    const reg = new FakeRegistry([a, b]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    const contradiction = receipt.proposed.find((p) => p.kind === 'contradiction');
    expect(contradiction).toBeDefined();
    // Both referenced records carry the contradicted flag, the existing
    // review machinery: they enter the review queue and are excluded from
    // injection until a human resolves. Nothing is deleted.
    for (const id of contradiction!.ids) {
      expect(reg.records.get(id)!.reviewState).toBe('contradicted');
      expect(reg.records.get(id)!.staleReason).toContain('disagree');
    }
    expect(reg.records.size).toBe(2);
  });

  test('a cross-scope-duplicate proposal re-enters its records into the review queue WITHOUT blocking injection', async () => {
    const a = rec({ id: 'a', scope: 'project', reviewState: 'reviewed', summary: 'shared', updatedAt: NOW });
    const b = rec({ id: 'b', scope: 'team', reviewState: 'reviewed', summary: 'shared', updatedAt: NOW });
    const reg = new FakeRegistry([a, b]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.proposed.some((p) => p.kind === 'cross-scope-duplicate')).toBe(true);
    // Reviewed records flip to fresh (queue priority), never stale/contradicted:
    // they do not disagree, so they stay injectable.
    expect(reg.records.get('a')!.reviewState).toBe('fresh');
    expect(reg.records.get('b')!.reviewState).toBe('fresh');
    // And the receipt lists them as touched.
    expect(receipt.note.length).toBeGreaterThan(0);
  });
});

describe('runMemoryConsolidation: pair readings', () => {
  test('only records of the same class are paired, and a distinct pair gets no agreement request', async () => {
    const a = rec({ id: 'a', cls: 'fact', summary: 'daemon port is 3421' });
    const b = rec({ id: 'b', cls: 'decision', summary: 'daemon port is 3421' });
    const c = rec({ id: 'c', cls: 'fact', summary: 'tests run with bun test' });
    const reg = new FakeRegistry([a, b, c]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([]);
    // One pair (a, c), read by the aligner only.
    expect(readings.requests).toHaveLength(1);
    expect(readings.requests[0]!.state).toEqual({
      entity_a: { class: 'fact', summary: expect.any(String), tags: [] },
      entity_b: { class: 'fact', summary: expect.any(String), tags: [] },
    });
  });

  test('a review-level pair is still checked for agreement, and a record read as a later correction supersedes the one it replaces', async () => {
    readings.use({ pair: () => ({ link: 1, restates: false, conflicts: true, replaces: 'a_replaces_b' }) });
    const newer = rec({ id: 'newer', reviewState: 'reviewed', summary: 'The daemon port moved from 8080 to 3421 in v2', updatedAt: NOW });
    const older = rec({ id: 'older', reviewState: 'fresh', summary: 'Daemon default port is 8080', updatedAt: NOW - DAY_MS });
    const reg = new FakeRegistry([newer, older]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([{ survivorId: 'newer', duplicateIds: ['older'], scope: 'project', cls: 'fact' }]);
    expect(reg.records.get('older')!.reviewState).toBe('stale');
    expect(reg.records.get('older')!.staleReason).toContain('Superseded by newer, a later correction or update of it');
    expect(reg.records.get('newer')!.reviewState).toBe('reviewed');
  });

  test('the agreement request carries each record\'s created and updated dates', async () => {
    readings.use({ pair: () => ({ link: 2, restates: false, conflicts: false }) });
    const a = rec({ id: 'a', summary: 'tests run with bun test', createdAt: Date.UTC(2026, 0, 5), updatedAt: Date.UTC(2026, 2, 9) });
    const b = rec({ id: 'b', summary: 'tests run with vitest', createdAt: Date.UTC(2025, 11, 1), updatedAt: Date.UTC(2025, 11, 1) });
    await runMemoryConsolidation({ memoryRegistry: new FakeRegistry([a, b]), config: cfg(), now: NOW, trigger: 'idle', idle: true });
    const agreement = readings.requests.find((request) => 'record_a' in (request.state as object))!;
    expect(agreement.state).toEqual({
      record_a: { class: 'fact', summary: 'tests run with bun test', tags: [], created: '2026-01-05', updated: '2026-03-09' },
      record_b: { class: 'fact', summary: 'tests run with vitest', tags: [], created: '2025-12-01', updated: '2025-12-01' },
    });
    expect(Object.keys(agreement.questions).sort()).toEqual(['conflicts', 'replaces', 'restates']);
  });

  test('b_replaces_a stales the replaced record even when it is the newer one by timestamp', async () => {
    readings.use({ pair: () => ({ link: 1, restates: false, conflicts: true, replaces: 'b_replaces_a' }) });
    const a = rec({ id: 'a', summary: 'The daemon listens on port 8080', updatedAt: NOW });
    const b = rec({ id: 'b', summary: 'The daemon port moved from 8080 to 3421', updatedAt: NOW - DAY_MS });
    const reg = new FakeRegistry([a, b]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([{ survivorId: 'b', duplicateIds: ['a'], scope: 'project', cls: 'fact' }]);
    expect(reg.records.get('a')!.reviewState).toBe('stale');
    expect(reg.records.get('a')!.staleReason).toContain('Superseded by b');
    expect(reg.records.get('b')!.reviewState).toBe('fresh');
  });

  test('neither: a newer, more reviewed record does not win on its date; both go to a person', async () => {
    readings.use({ pair: () => ({ link: 1, restates: false, conflicts: true, replaces: 'neither' }) });
    const newer = rec({ id: 'newer', reviewState: 'reviewed', summary: 'Tests run with vitest', updatedAt: NOW });
    const older = rec({ id: 'older', reviewState: 'fresh', summary: 'Tests run with bun test', updatedAt: NOW - DAY_MS });
    const reg = new FakeRegistry([newer, older]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([]);
    expect(receipt.proposed.map((p) => p.kind)).toEqual(['contradiction']);
    expect(reg.records.get('newer')!.reviewState).toBe('contradicted');
    expect(reg.records.get('older')!.reviewState).toBe('contradicted');
  });

  test('a replacement the reading is not sure enough of goes to a person', async () => {
    readings.use({ pair: () => ({ link: 1, restates: false, conflicts: true, replaces: 'a_replaces_b', replacesConfidence: 0.65 }) });
    const a = rec({ id: 'a', summary: 'The daemon port moved to 3421', updatedAt: NOW });
    const b = rec({ id: 'b', summary: 'The daemon listens on port 8080', updatedAt: NOW - DAY_MS });
    const reg = new FakeRegistry([a, b]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([]);
    expect(receipt.proposed.map((p) => p.kind)).toEqual(['contradiction']);
    expect(reg.records.get('a')!.reviewState).toBe('contradicted');
    expect(reg.records.get('b')!.reviewState).toBe('contradicted');
  });

  test('a correction less reviewed than the record it replaces does not overturn the review', async () => {
    readings.use({ pair: () => ({ link: 1, restates: false, conflicts: true, replaces: 'a_replaces_b' }) });
    const a = rec({ id: 'a', reviewState: 'fresh', summary: 'The daemon port moved to 3421', updatedAt: NOW });
    const b = rec({ id: 'b', reviewState: 'reviewed', summary: 'The daemon listens on port 8080', updatedAt: NOW - DAY_MS });
    const reg = new FakeRegistry([a, b]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([]);
    expect(receipt.proposed.map((p) => p.kind)).toEqual(['contradiction']);
    expect(reg.records.get('b')!.reviewState).toBe('contradicted');
  });

  test('a replacement across scopes is only proposed', async () => {
    readings.use({ pair: () => ({ link: 1, restates: false, conflicts: true, replaces: 'a_replaces_b' }) });
    const a = rec({ id: 'a', scope: 'project', summary: 'The daemon port moved to 3421', updatedAt: NOW });
    const b = rec({ id: 'b', scope: 'team', summary: 'The daemon listens on port 8080', updatedAt: NOW - DAY_MS });
    const reg = new FakeRegistry([a, b]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([]);
    expect(receipt.proposed.map((p) => p.kind)).toEqual(['contradiction']);
    expect(receipt.proposed[0]!.reason).toContain('different scopes');
  });

  test('a restatement the reading is not sure of changes nothing', async () => {
    readings.use({ pair: () => ({ link: 2, restates: 0.58, conflicts: false }) });
    const a = rec({ id: 'a', summary: 'tests run with bun test', updatedAt: NOW });
    const b = rec({ id: 'b', summary: 'Engine tests are run with bun test', updatedAt: NOW - 1 });
    const reg = new FakeRegistry([a, b]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged).toEqual([]);
    expect(receipt.proposed).toEqual([]);
    expect(reg.reviewCalls).toEqual([]);
  });

  test('pairs past the per-run budget are not read', async () => {
    readings.use({ pair: () => ({ link: 0, restates: false, conflicts: false }) });
    const records = Array.from({ length: 20 }, (_, index) => rec({ id: `r${index}`, summary: `fact ${index}`, updatedAt: NOW - index }));
    await runMemoryConsolidation({ memoryRegistry: new FakeRegistry(records), config: cfg(), now: NOW, trigger: 'idle', idle: true });
    // 190 possible pairs; the pass reads at most 60, newest pairs first.
    expect(readings.requests).toHaveLength(60);
    const first = readings.requests[0]!.state as { entity_a: { summary: string } };
    expect(first.entity_a.summary).toBe('fact 0');
  });

  test('a pass with a pair to read and no judgment port installed throws', async () => {
    const previous = installJudgmentPort(undefined);
    try {
      const reg = new FakeRegistry([rec({ id: 'a' }), rec({ id: 'b' })]);
      await expect(runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true }))
        .rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally {
      installJudgmentPort(previous);
    }
  });
});

describe('runMemoryConsolidation: decay', () => {
  test('aged never-referenced record decays by step; usage signal availability reported', async () => {
    const aged = rec({ id: 'aged', confidence: 60, updatedAt: NOW - 100 * DAY_MS });
    const reg = new FakeRegistry([aged]);
    const receipt = await runMemoryConsolidation({
      memoryRegistry: reg,
      config: cfg({ decayAgeDays: 0, decayConfidenceStep: 10, archiveConfidenceFloor: 40 }),
      now: NOW, trigger: 'idle', idle: true,
      usageLookup: () => undefined,
    });
    expect(receipt.decayed.length).toBe(1);
    expect(receipt.decayed[0]!.toConfidence).toBe(50);
    expect(reg.records.get('aged')!.confidence).toBe(50);
    expect(receipt.usageSignalAvailable).toBe(true);
  });

  test('decay to/below archive floor marks the record stale (archived)', async () => {
    const aged = rec({ id: 'aged', confidence: 60, updatedAt: NOW - 100 * DAY_MS });
    const reg = new FakeRegistry([aged]);
    const receipt = await runMemoryConsolidation({
      memoryRegistry: reg,
      config: cfg({ decayAgeDays: 0, decayConfidenceStep: 10, archiveConfidenceFloor: 55 }),
      now: NOW, trigger: 'idle', idle: true,
    });
    expect(receipt.archived.length).toBe(1);
    expect(reg.records.get('aged')!.reviewState).toBe('stale');
  });

  test('referenced records NEVER decay', async () => {
    const aged = rec({ id: 'aged', confidence: 60, updatedAt: NOW - 100 * DAY_MS });
    const reg = new FakeRegistry([aged]);
    const signal: MemoryConsolidationUsageSignal = { injectedCount: 5, referencedCount: 4, lastReferencedAt: NOW };
    const receipt = await runMemoryConsolidation({
      memoryRegistry: reg,
      config: cfg({ decayAgeDays: 0 }),
      now: NOW, trigger: 'idle', idle: true,
      usageLookup: (id) => (id === 'aged' ? signal : undefined),
    });
    expect(receipt.decayed.length).toBe(0);
    expect(receipt.archived.length).toBe(0);
    expect(reg.records.get('aged')!.confidence).toBe(60);
  });
});

describe('runMemoryConsolidation: stale-delete proposals', () => {
  test('long-stale record is proposed for deletion but not touched', async () => {
    const stale = rec({ id: 'old', reviewState: 'stale', updatedAt: NOW - 200 * DAY_MS });
    const reg = new FakeRegistry([stale]);
    const receipt = await runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    const proposal = receipt.proposed.find((p) => p.kind === 'stale-delete');
    expect(proposal).toBeDefined();
    expect(proposal!.ids).toContain('old');
    expect(proposal!.route).toContain('memory action:"delete"');
    expect(reg.records.get('old')).not.toBeUndefined();
  });
});

describe('resolveMemoryConsolidationConfig', () => {
  test('absent learning block yields defaults', async () => {
    const resolved = resolveMemoryConsolidationConfig({ getRaw: () => ({}) });
    expect(resolved).toEqual(DEFAULT_MEMORY_CONSOLIDATION_CONFIG);
  });

  test('user block overrides per key, wrong-typed values fall back', async () => {
    const resolved = resolveMemoryConsolidationConfig({
      getRaw: () => ({ learning: { consolidation: { enabled: true, maxMergesPerRun: 3, decayAgeDays: 'nope' } } }),
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.maxMergesPerRun).toBe(3);
    expect(resolved.decayAgeDays).toBe(DEFAULT_MEMORY_CONSOLIDATION_CONFIG.decayAgeDays);
  });
});

describe('MemoryRegistry satisfies the consolidation seam', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  test('runs over a real store without error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-mcon-'));
    roots.push(root);
    const configManager = new ConfigManager({ configDir: join(root, 'config') });
    const store = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      enableVectorIndex: false,
    });
    await store.init();
    const registry = new MemoryRegistry(store);
    await registry.add({ cls: 'fact', summary: 'one and only fact' });
    const receipt = await runMemoryConsolidation({ memoryRegistry: registry, config: cfg(), now: Date.now(), trigger: 'manual', idle: true });
    expect(receipt.scanned).toBe(1);
    expect(receipt.note).toContain('never written silently');
  });
});
