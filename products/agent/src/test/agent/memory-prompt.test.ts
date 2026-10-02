import { useMemoryReadings } from '../../../../../packages/engine/test/_helpers/memory-readings.ts';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { buildReviewedMemoryPrompt, describeMemoryPromptEligibility, isPromptActiveMemory, rankMemoryForTurn, relevanceBand } from '../../agent/memory-prompt.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function withMemoryRegistry<T>(fn: (registry: MemoryRegistry) => Promise<T>): Promise<T> {
  const root = makeProjectTempDir('goodvibes-agent-memory-prompt');
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: root,
  });
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  const registry = new MemoryRegistry(store);
  try {
    return await fn(registry);
  } finally {
    await store.save();
    store.close();
  }
}

useMemoryReadings();

describe('buildReviewedMemoryPrompt', () => {
  test('renders reviewed Agent-local memory in confidence order', async () => {
    await withMemoryRegistry(async (registry) => {
      const low = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'User likes short checklists.',
        provenance: [{ kind: 'event', ref: 'test-low' }],
      });
      const high = await registry.add({
        scope: 'project',
        cls: 'constraint',
        summary: 'Never use non-Agent knowledge routes.',
        tags: ['knowledge'],
        provenance: [{ kind: 'event', ref: 'test-high' }],
      });
      registry.review(low.id, { state: 'reviewed', confidence: 70, reviewedBy: 'test' });
      registry.review(high.id, { state: 'reviewed', confidence: 95, reviewedBy: 'test' });

      const prompt = await buildReviewedMemoryPrompt(registry);

      expect(prompt).toContain('Reviewed GoodVibes Agent Memory');
      expect(prompt).toContain('[project/constraint 95% tags=knowledge source=event:test-high] Never use non-Agent knowledge routes.');
      expect(prompt).toContain('[project/fact 70% source=event:test-low] User likes short checklists.');
      expect(prompt!.indexOf('Never use non-Agent')).toBeLessThan(prompt!.indexOf('short checklists'));
    });
  });

  test('a genuinely-stored fresh fact (store-default confidence, never reviewed) recalls in a fresh session', async () => {
    // The dogfood repro that motivated this fix: store a fact with no explicit confidence
    // (so it lands at the SDK's own default of 60, reviewState 'fresh'), then build a
    // brand-new prompt (as a fresh session would) and confirm it shows up. Before this
    // fix, a fresh record's confidence (60) could never clear a 70 floor, so a fact
    // stored in one session silently never recalled in the next.
    await withMemoryRegistry(async (registry) => {
      const fact = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'User prefers dark mode in the editor.',
        provenance: [{ kind: 'event', ref: 'fresh-session-repro' }],
      });
      expect(fact.reviewState).toBe('fresh');
      expect(fact.confidence).toBe(60);

      const prompt = await buildReviewedMemoryPrompt(registry);

      expect(prompt).not.toBeNull();
      expect(prompt).toContain('User prefers dark mode in the editor.');
      expect(isPromptActiveMemory(fact)).toBe(true);
    });
  });

  test('excludes stale and contradicted memory regardless of confidence, and explicitly low-confidence memory', async () => {
    await withMemoryRegistry(async (registry) => {
      const stale = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'Stale records should stay out no matter how confident they once were.',
        provenance: [{ kind: 'event', ref: 'stale' }],
      });
      const low = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'Explicitly low-confidence records should stay out.',
        provenance: [{ kind: 'event', ref: 'low' }],
      });
      registry.review(stale.id, { state: 'stale', staleReason: 'Outdated', confidence: 95 });
      registry.review(low.id, { state: 'reviewed', confidence: 40, reviewedBy: 'test' });

      const prompt = await buildReviewedMemoryPrompt(registry);

      expect(prompt).toBeNull();
      const staleEligibility = describeMemoryPromptEligibility({ ...stale, reviewState: 'stale', confidence: 95 });
      expect(staleEligibility.eligible).toBe(false);
      expect(staleEligibility.reason).toContain('stale');
      const lowEligibility = describeMemoryPromptEligibility({ ...low, reviewState: 'reviewed', confidence: 40 });
      expect(lowEligibility.eligible).toBe(false);
      expect(lowEligibility.reason).toContain('confidence');
    });
  });
});

describe('describeMemoryPromptEligibility', () => {
  test('never returns a blanket-boosted confidence: the reported reason always reflects the record\'s own stored confidence and reviewState', async () => {
    await withMemoryRegistry(async (registry) => {
      const record = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'Some fact.',
        provenance: [{ kind: 'session', ref: 'session-123' }],
      });
      const decision = describeMemoryPromptEligibility(record);
      expect(decision.eligible).toBe(true);
      expect(decision.reason).toContain('60%');
      expect(decision.reason).toContain('fresh');
      expect(decision.reason).toContain('session:session-123');
    });
  });

  test('surfaces "no provenance recorded" honestly instead of hiding it', () => {
    const decision = describeMemoryPromptEligibility({
      id: 'mem-no-provenance',
      scope: 'project',
      cls: 'fact',
      summary: 'No provenance.',
      tags: [],
      provenance: [],
      reviewState: 'fresh',
      confidence: 60,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toContain('no provenance recorded');
  });
});

describe('rankMemoryForTurn (per-turn semantic scoring)', () => {
  test('ranks the eligible set by relevance to the current turn, not by stored confidence alone', async () => {
    await withMemoryRegistry(async (registry) => {
      const lowerConfidenceButOnTopic = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'The deploy pipeline requires a green typecheck before merge.',
        provenance: [{ kind: 'event', ref: 'on-topic' }],
      });
      const higherConfidenceOffTopic = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'User prefers herbal tea over coffee in the afternoon.',
        provenance: [{ kind: 'event', ref: 'off-topic' }],
      });
      registry.review(lowerConfidenceButOnTopic.id, { state: 'reviewed', confidence: 61, reviewedBy: 'test' });
      registry.review(higherConfidenceOffTopic.id, { state: 'reviewed', confidence: 95, reviewedBy: 'test' });

      const eligible = registry.getAll().filter((record) => isPromptActiveMemory(record));
      const ranking = await rankMemoryForTurn(registry, eligible, 'what does the deploy pipeline require before merge');

      expect(ranking.scored).toBe(true);
      expect(ranking.degradedReason).toBeNull();
      expect(ranking.records[0]?.id).toBe(lowerConfidenceButOnTopic.id);
      const onTopicRelevance = ranking.relevanceById.get(lowerConfidenceButOnTopic.id) ?? 0;
      const offTopicRelevance = ranking.relevanceById.get(higherConfidenceOffTopic.id) ?? 0;
      expect(onTopicRelevance).toBeGreaterThan(offTopicRelevance);
    });
  });

  test('degrades honestly (stated reason, prior confidence/recency order) when there is no current-turn text', async () => {
    await withMemoryRegistry(async (registry) => {
      const fact = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'A fact with no active turn to rank against.',
        provenance: [{ kind: 'event', ref: 'no-turn-text' }],
      });
      const eligible = registry.getAll().filter((record) => isPromptActiveMemory(record));

      const noTurnText = await rankMemoryForTurn(registry, eligible, undefined);
      expect(noTurnText.scored).toBe(false);
      expect(noTurnText.degradedReason).toContain('no current-turn text');
      expect(noTurnText.records.map((record) => record.id)).toEqual([fact.id]);

      const blankTurnText = await rankMemoryForTurn(registry, eligible, '   ');
      expect(blankTurnText.scored).toBe(false);
      expect(blankTurnText.degradedReason).toContain('no current-turn text');
    });
  });

  test('degrades honestly when the semantic index is disabled, stating why', async () => {
    const root = makeProjectTempDir('goodvibes-agent-memory-prompt-disabled-index');
    const configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
      workingDir: root,
    });
    const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry, enableVectorIndex: false });
    await store.init();
    const registry = new MemoryRegistry(store);
    try {
      const fact = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'Recorded while the semantic index is disabled.',
        provenance: [{ kind: 'event', ref: 'disabled-index' }],
      });
      const eligible = registry.getAll().filter((record) => isPromptActiveMemory(record));

      const ranking = await rankMemoryForTurn(registry, eligible, 'a real query about something');

      expect(ranking.scored).toBe(false);
      expect(ranking.degradedReason).toContain('semantic index unavailable');
      expect(ranking.degradedReason).toContain('disabled');
      expect(ranking.records.map((record) => record.id)).toEqual([fact.id]);
    } finally {
      await store.save();
      store.close();
    }
  });

  test('buildReviewedMemoryPrompt with turnText: a budget-limited cut keeps the most relevant record, not an arbitrary one', async () => {
    await withMemoryRegistry(async (registry) => {
      const onTopic = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'The deploy pipeline requires a green typecheck before merge.',
        provenance: [{ kind: 'event', ref: 'on-topic' }],
      });
      const offTopic = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'User prefers herbal tea over coffee in the afternoon.',
        provenance: [{ kind: 'event', ref: 'off-topic' }],
      });
      registry.review(onTopic.id, { state: 'reviewed', confidence: 61, reviewedBy: 'test' });
      registry.review(offTopic.id, { state: 'reviewed', confidence: 95, reviewedBy: 'test' });

      const prompt = await buildReviewedMemoryPrompt(registry, {
        limit: 1,
        turnText: 'what does the deploy pipeline require before merge',
      });

      expect(prompt).toContain('deploy pipeline');
      expect(prompt).not.toContain('herbal tea');
    });
  });

  test('buildReviewedMemoryPrompt with turnText never admits a record the confidence/reviewState gate already excluded', async () => {
    await withMemoryRegistry(async (registry) => {
      const relevantButLowConfidence = await registry.add({
        scope: 'project',
        cls: 'fact',
        summary: 'The deploy pipeline requires a green typecheck before merge.',
        provenance: [{ kind: 'event', ref: 'low-confidence-on-topic' }],
      });
      registry.review(relevantButLowConfidence.id, { state: 'reviewed', confidence: 40, reviewedBy: 'test' });

      const prompt = await buildReviewedMemoryPrompt(registry, {
        turnText: 'what does the deploy pipeline require before merge',
      });

      expect(prompt).toBeNull();
    });
  });
});

describe('relevanceBand (F7a)', () => {
  test('bands a raw relevance percent so a genuinely-lower-but-real score does not read as noise', () => {
    expect(relevanceBand(0)).toBe('low match');
    expect(relevanceBand(28)).toBe('low match');
    expect(relevanceBand(34)).toBe('low match');
    expect(relevanceBand(35)).toBe('moderate match');
    expect(relevanceBand(50)).toBe('moderate match');
    expect(relevanceBand(59)).toBe('moderate match');
    expect(relevanceBand(60)).toBe('high match');
    expect(relevanceBand(100)).toBe('high match');
  });
});
