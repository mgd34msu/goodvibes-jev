/** Provider output-cap readings and deterministic chat-capability lookup. */
import { knownCatalogChatCapability } from '../providers/model-catalog-facts.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import {
  anthropicOutputCap,
  type AnthropicOutputCapRow,
} from './batteries/model-limits.js';
import { ReadingMemo } from './provider-readings.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { requireActingReading } from '../types/judgment-held.js';

const outputCapRows = new Map<string, AnthropicOutputCapRow | null>();
const outputCapMemo = new ReadingMemo<AnthropicOutputCapRow | null>(256);

/** The remembered output-cap row of an Anthropic model id: a row, null for none, undefined when not read. */
export function knownAnthropicOutputCapRow(modelId: string): AnthropicOutputCapRow | null | undefined {
  return outputCapRows.get(modelId);
}

/** Reads which documented output-cap row an Anthropic model id belongs to; null only for a settled none; uncertainty remains held. */
export function readAnthropicOutputCapRow(modelId: string, site: string): Promise<AnthropicOutputCapRow | null> {
  assertJudgmentInput({ modelId });
  const known = outputCapRows.get(modelId);
  if (known !== undefined) return Promise.resolve(known);
  return outputCapMemo.get(modelId, async () => {
    const dispatched = await anthropicOutputCap.route(judgmentPort(site), { model_id: modelId }, { site });
    requireActingReading(dispatched.reading);
    const row = dispatched.route !== 'none' ? dispatched.route : null;
    dispatched.recordAction(`cap:${row ?? 'none'}`);
    outputCapRows.set(modelId, row);
    return row;
  });
}

/** Retain only chat models established by repository metadata; report unknown entries. */
export async function readChatModelIds(provider: string, modelIds: readonly string[], _site: string,
  onUnclassified?: (modelId: string) => void): Promise<string[]> {
  return modelIds.filter(modelId => {
    const chat = knownCatalogChatCapability(provider, modelId);
    if (chat === undefined) onUnclassified?.(modelId);
    return chat === true;
  });
}

/** Forgets every remembered model-fact reading; for tests that swap the judgment port. */
export function forgetModelLimitReadings(): void {
  outputCapRows.clear();
  outputCapMemo.clear();
}
