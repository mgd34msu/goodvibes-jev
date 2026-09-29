/**
 * The provider transport and cache readings as the adapters call them
 * (batteries/provider-cache.ts). Each remembers what it read, so a model id or
 * an error text is read once per process.
 */
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { cacheMinimum, copilotClaudeModel } from './batteries/provider-cache.js';
import { ReadingMemo } from './provider-readings.js';

const holds = (reading: YesNoReading): boolean => reading.verdict === 'yes' && reading.outcome === 'act';

const claudeMemo = new ReadingMemo<boolean>(256);

/** Whether a Copilot model id names an Anthropic Claude model; false unless the reading is strong enough to act on. */
export function readsAsCopilotClaudeModel(modelId: string, site: string): Promise<boolean> {
  return claudeMemo.get(modelId, async () => {
    const run = await copilotClaudeModel.run(judgmentPort(site), { model_id: modelId }, { site });
    const claude = holds(run.readings.claude);
    run.recordAction(claude ? 'anthropic-transport' : 'openai-transport');
    return claude;
  });
}

/** Long error bodies say what they mean in their opening. */
const MAX_ERROR_CHARS = 1_500;
const cacheMinimumMemo = new ReadingMemo<boolean>(128);

/** Whether a failed cache creation says the content is below the cache minimum; false unless the reading is strong enough to act on. */
export function readsAsBelowCacheMinimum(errorText: string, site: string): Promise<boolean> {
  const state = { error: errorText.slice(0, MAX_ERROR_CHARS) };
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
