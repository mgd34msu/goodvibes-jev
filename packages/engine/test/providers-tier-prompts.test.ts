import { describe, test, expect } from 'bun:test';
import { getTierPromptSupplement, readTierPromptSupplement } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelTier } from '@goodvibes-jev/engine/sdk/platform/providers';

describe('getTierPromptSupplement', () => {
  test('premium tier returns empty string', () => {
    expect(getTierPromptSupplement('premium')).toBe('');
  });

  test('standard tier returns non-empty string', () => {
    const result = getTierPromptSupplement('standard');
    expect(result.length).toBeGreaterThan(0);
  });

  test('free tier returns non-empty string', () => {
    const result = getTierPromptSupplement('free');
    expect(result.length).toBeGreaterThan(0);
  });

  test('free tier supplement is longer than standard tier', () => {
    const free = getTierPromptSupplement('free');
    const standard = getTierPromptSupplement('standard');
    expect(free.length).toBeGreaterThan(standard.length);
  });

  test('free tier mentions tool call format', () => {
    const result = getTierPromptSupplement('free');
    expect(result).toContain('tool call');
  });

  test('free tier mentions multi-agent workflows', () => {
    const result = getTierPromptSupplement('free');
    expect(result.toLowerCase()).toContain('agent');
  });

  test('standard tier mentions required parameters', () => {
    const result = getTierPromptSupplement('standard');
    expect(result.toLowerCase()).toContain('parameter');
  });

  test('free tier is under 400 tokens (~1600 chars) to keep it concise', () => {
    // Rough heuristic: 1 token ≈ 4 chars. 400 tokens = ~1600 chars.
    const result = getTierPromptSupplement('free');
    expect(result.length).toBeLessThan(1600);
  });

  test('all three tiers return strings (no undefined/null)', () => {
    const tiers: ModelTier[] = ['free', 'standard', 'premium'];
    for (const tier of tiers) {
      const result = getTierPromptSupplement(tier);
      expect(typeof result).toBe('string');
    }
  });
});

describe('readTierPromptSupplement', () => {
  const facts = { registryKey: 'p:m', id: 'm', name: 'M', provider: 'p' };
  const store = (tier: 'economy' | 'standard' | 'premium' | undefined) => ({ read: async () => ({ tier, frontier: 0, small: 0 }) });

  test('the read tier picks the supplement: economy gets the fullest guidance, premium none', async () => {
    expect(await readTierPromptSupplement(facts, store('economy'))).toBe(getTierPromptSupplement('free'));
    expect(await readTierPromptSupplement(facts, store('standard'))).toBe(getTierPromptSupplement('standard'));
    expect(await readTierPromptSupplement(facts, store('premium'))).toBe('');
  });

  test('an unsettled tier gets the fullest guidance', async () => {
    expect(await readTierPromptSupplement(facts, store(undefined))).toBe(getTierPromptSupplement('free'));
  });
});
