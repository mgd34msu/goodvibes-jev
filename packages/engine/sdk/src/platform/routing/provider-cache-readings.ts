/**
 * The provider transport and cache readings as the adapters call them
 * (batteries/provider-cache.ts). Each remembers what it read, so a model id or
 * an error text is read once per process.
 */
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { cacheMinimum, copilotClaudeModel } from './batteries/provider-cache.js';
import { ReadingMemo } from './provider-readings.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { requireActingReading } from '../types/judgment-held.js';

const holds = (reading: YesNoReading): boolean => requireActingReading(reading).verdict === 'yes';

const claudeMemo = new ReadingMemo<boolean>(256);

/** Whether a Copilot model id names an Anthropic Claude model; only settled readings choose a transport. */
export function readsAsCopilotClaudeModel(modelId: string, site: string): Promise<boolean> {
  assertJudgmentInput({ model_id: modelId });
  return claudeMemo.get(modelId, async () => {
    const run = await copilotClaudeModel.run(judgmentPort(site), { model_id: modelId }, { site });
    const claude = holds(run.readings.claude);
    run.recordAction(claude ? 'anthropic-transport' : 'openai-transport');
    return claude;
  });
}

const cacheMinimumMemo = new ReadingMemo<boolean>(128);

/** Whether a failed cache creation says the content is below the cache minimum; uncertainty is not cached as false. */
export function readsAsBelowCacheMinimum(errorText: string, site: string): Promise<boolean> {
  const state = { error: errorText };
  assertJudgmentInput(state);
  return cacheMinimumMemo.get(state.error, async () => {
    const run = await cacheMinimum.run(judgmentPort(site), state, { site });
    const below = holds(run.readings.belowMinimum);
    run.recordAction(below ? 'mark-uncacheable' : 'try-again-later');
    return below;
  });
}

/** Forgets every remembered reading here; for tests that swap the judgment port. */
export function forgetProviderCacheReadings(): void {
  claudeMemo.clear();
  cacheMinimumMemo.clear();
}
