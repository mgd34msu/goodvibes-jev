import { describe, expect, test } from 'bun:test';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { getEventListeners } from 'node:events';
import { withTestTimeout } from './_helpers/test-timeout.ts';
import {
  getTierPromptSupplement,
  readTierPromptSupplement,
  type ModelTier,
  type TierPromptAudience,
  type TierPromptSupplementOptions,
} from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelFacts, ModelTierStore, TierRecord } from '../sdk/src/platform/routing/model-tiers.js';

const facts: ModelFacts = { registryKey: 'fixture:small', id: 'small', name: 'Small fixture', provider: 'fixture' };
const economy: TierRecord = { tier: 'economy', frontier: 0, small: 1 };
const cancelled = { name: 'JudgmentError', kind: 'aborted', message: 'the judgment call was cancelled' };

function fixed(record: TierRecord): Pick<ModelTierStore, 'read'> {
  return { read: async () => record };
}

describe('tier guidance audience', () => {
  test('omitting audience preserves the existing agent text for every tier', () => {
    const tiers: ModelTier[] = ['free', 'standard', 'premium', 'subscription'];
    for (const tier of tiers) expect(getTierPromptSupplement(tier)).toBe(getTierPromptSupplement(tier, { audience: 'agent' }));
    expect(getTierPromptSupplement('free')).toContain('required JSON completion block');
    expect(getTierPromptSupplement('free')).toContain('there is no human watching');
  });

  test('conversation guidance keeps tool discipline without unattended-agent completion rules', () => {
    const audience: TierPromptAudience = 'conversation';
    const options: TierPromptSupplementOptions = { audience };
    const prompt = getTierPromptSupplement('free', options);
    expect(prompt).toContain('ALL required parameters');
    expect(prompt).toContain('parallel spawns run concurrently');
    expect(prompt).not.toContain('JSON completion block');
    expect(prompt).not.toContain('no human watching');
    expect(prompt).not.toContain('Do not stop after the first step and ask for');
    expect(getTierPromptSupplement('standard', options)).toBe(getTierPromptSupplement('standard'));
    expect(getTierPromptSupplement('premium', options)).toBe('');
    expect(getTierPromptSupplement('subscription', options)).toBe('');
  });

  test('read capability tiers and the unsettled policy both preserve the requested audience', async () => {
    for (const tier of ['economy', undefined] as const) {
      const prompt = await readTierPromptSupplement(facts, fixed({ ...economy, tier }), undefined, { audience: 'conversation' });
      expect(prompt).toBe(getTierPromptSupplement('free', { audience: 'conversation' }));
    }
    expect(await readTierPromptSupplement(facts, fixed(economy))).toBe(getTierPromptSupplement('free'));
    expect(await readTierPromptSupplement(facts, fixed({ ...economy, tier: 'premium' }), 'fixture', { audience: 'conversation' })).toBe('');
  });
});

describe('tier prompt cancellation', () => {
  test('forwards the exact model facts, site and AbortSignal to the existing tier reader', async () => {
    const signal = new AbortController().signal;
    let received: { model: ModelFacts; site?: string; signal?: AbortSignal } | undefined;
    const tiers: Pick<ModelTierStore, 'read'> = {
      read: async (model, options) => {
        received = { model, ...options };
        return economy;
      },
    };
    const prompt = await readTierPromptSupplement(facts, tiers, 'conversation.fixture', { audience: 'conversation', signal });
    expect(received?.model).toBe(facts);
    expect(received?.site).toBe('conversation.fixture');
    expect(received?.signal).toBe(signal);
    expect(prompt).toBe(getTierPromptSupplement('free', { audience: 'conversation' }));
  });

  test('an already aborted prompt does not request a reading, even from a cached reader', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before prompt');
    controller.abort(reason);
    let reads = 0;
    await expect(readTierPromptSupplement(facts, { read: async () => { reads++; return economy; } }, undefined, {
      signal: controller.signal,
    })).rejects.toMatchObject(cancelled);
    expect(reads).toBe(0);
  });

  test('aborting after a cached promise is returned cannot expose its prompt', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled after cache lookup');
    const pending = readTierPromptSupplement(facts, fixed(economy), undefined, { signal: controller.signal, audience: 'conversation' });
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject(cancelled);
  });

  test('a late reader that ignores cancellation cannot return a stale prompt', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled while reading');
    let finish: ((record: TierRecord) => void) | undefined;
    const tiers: Pick<ModelTierStore, 'read'> = { read: () => new Promise((resolve) => { finish = resolve; }) };
    const pending = readTierPromptSupplement(facts, tiers, 'late.fixture', { signal: controller.signal });
    if (!finish) throw new Error('The tier reading was not started');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort(reason);
    try {
      await expect(withTestTimeout(pending, 1_000, 'Cancelled prompt waited for the tier reader')).rejects.toMatchObject(cancelled);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      finish(economy);
    }
  });

  test('late rejection is handled and normal settlement removes the owned listener', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before reader rejection');
    let fail: ((error: Error) => void) | undefined;
    const pending = readTierPromptSupplement(facts, { read: () => new Promise((_resolve, reject) => { fail = reject; }) }, undefined, { signal: controller.signal });
    if (!fail) throw new Error('The tier reading was not started');
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject(cancelled);
    fail(new Error('late fixture failure'));
    await Promise.resolve();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

    const settled = new AbortController();
    await readTierPromptSupplement(facts, fixed(economy), undefined, { signal: settled.signal });
    expect(getEventListeners(settled.signal, 'abort')).toHaveLength(0);
    const failed = new AbortController();
    const failure = new Error('reader failure with signal');
    await expect(readTierPromptSupplement(facts, { read: async () => { throw failure; } }, undefined, { signal: failed.signal })).rejects.toBe(failure);
    expect(getEventListeners(failed.signal, 'abort')).toHaveLength(0);
  });

  test('a later caller can cancel a shared reading without cancelling the first prompt', async () => {
    const first = new AbortController();
    const later = new AbortController();
    let finish: ((record: TierRecord) => void) | undefined;
    const held = new Promise<TierRecord>((resolve) => { finish = resolve; });
    const tiers: Pick<ModelTierStore, 'read'> = { read: () => held };
    const firstPrompt = readTierPromptSupplement(facts, tiers, 'first.fixture', { signal: first.signal });
    const laterPrompt = readTierPromptSupplement(facts, tiers, 'later.fixture', { audience: 'conversation', signal: later.signal });
    later.abort(new Error('private later-caller abort detail'));
    try {
      await expect(withTestTimeout(laterPrompt, 1_000, 'Later caller waited for shared tier reading')).rejects.toMatchObject(cancelled);
      expect(first.signal.aborted).toBe(false);
      expect(getEventListeners(later.signal, 'abort')).toHaveLength(0);
      expect(getEventListeners(first.signal, 'abort')).toHaveLength(1);
    } finally {
      finish?.(economy);
    }
    expect(await firstPrompt).toBe(getTierPromptSupplement('free'));
    expect(getEventListeners(first.signal, 'abort')).toHaveLength(0);
  });

  test('private abort reasons never appear in the cancellation error or its cause', async () => {
    const controller = new AbortController();
    const privateReason = new Error('private prompt snapshot detail');
    const tiers: Pick<ModelTierStore, 'read'> = { read: () => {
      controller.abort(privateReason);
      throw privateReason;
    } };
    const failure = await readTierPromptSupplement(facts, tiers, undefined, { signal: controller.signal }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JudgmentError);
    expect(failure).toMatchObject(cancelled);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain(privateReason.message);
  });

  test('reader failure propagates without inventing a tier or prompt', async () => {
    const failure = new Error('fixture tier read unavailable');
    await expect(readTierPromptSupplement(facts, { read: async () => { throw failure; } }, undefined, {
      audience: 'conversation',
    })).rejects.toBe(failure);
  });
});
