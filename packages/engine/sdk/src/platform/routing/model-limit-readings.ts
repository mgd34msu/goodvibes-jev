/**
 * The provider model-fact readings as their callers use them
 * (batteries/model-limits.ts). Each remembers what it read, so a model id is
 * read once per process; the `known...` lookups give synchronous callers the
 * remembered reading, or undefined when it has not been read.
 */
import { mapLimit } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import {
  anthropicOutputCap,
  chatModel,
  contextWindowFamily,
  type AnthropicOutputCapRow,
  type ContextWindowFamily,
} from './batteries/model-limits.js';
import { ReadingMemo } from './provider-readings.js';

const windowKey = (provider: string, modelId: string): string => `${provider}\u0000${modelId}`;
const windowFamilies = new Map<string, ContextWindowFamily | null>();
const windowFamilyMemo = new ReadingMemo<ContextWindowFamily | null>(2048);

/** The remembered context-window family of a model: a family, null for none, undefined when not read. */
export function knownContextWindowFamily(provider: string, modelId: string): ContextWindowFamily | null | undefined {
  return windowFamilies.get(windowKey(provider, modelId));
}

/** Reads which documented context-window row a model belongs to; null when none, or when the reading is too weak to act on. */
export function readContextWindowFamily(provider: string, modelId: string, site: string): Promise<ContextWindowFamily | null> {
  const key = windowKey(provider, modelId);
  const known = windowFamilies.get(key);
  if (known !== undefined) return Promise.resolve(known);
  return windowFamilyMemo.get(key, async () => {
    const dispatched = await contextWindowFamily.route(judgmentPort(site), { provider, model_id: modelId }, { site });
    const family = dispatched.reading.outcome === 'act' && dispatched.route !== 'none' ? dispatched.route : null;
    dispatched.recordAction(`window:${family ?? 'none'}`);
    windowFamilies.set(key, family);
    return family;
  });
}

const outputCapRows = new Map<string, AnthropicOutputCapRow | null>();
const outputCapMemo = new ReadingMemo<AnthropicOutputCapRow | null>(256);

/** The remembered output-cap row of an Anthropic model id: a row, null for none, undefined when not read. */
export function knownAnthropicOutputCapRow(modelId: string): AnthropicOutputCapRow | null | undefined {
  return outputCapRows.get(modelId);
}

/** Reads which documented output-cap row an Anthropic model id belongs to; null when none, or when the reading is too weak to act on. */
export function readAnthropicOutputCapRow(modelId: string, site: string): Promise<AnthropicOutputCapRow | null> {
  const known = outputCapRows.get(modelId);
  if (known !== undefined) return Promise.resolve(known);
  return outputCapMemo.get(modelId, async () => {
    const dispatched = await anthropicOutputCap.route(judgmentPort(site), { model_id: modelId }, { site });
    const row = dispatched.reading.outcome === 'act' && dispatched.route !== 'none' ? dispatched.route : null;
    dispatched.recordAction(`cap:${row ?? 'none'}`);
    outputCapRows.set(modelId, row);
    return row;
  });
}

/** How many listed models are read at once. */
const CHAT_MODEL_CONCURRENCY = 8;
const chatModelMemo = new ReadingMemo<boolean>(4096);

/**
 * Whether a listed model stays listed as a chat model. Only a no strong
 * enough to act on drops it: a model whose reading does not settle stays
 * listed, which leaves it pickable rather than hiding it.
 */
function readKeepsChatModel(provider: string, modelId: string, site: string): Promise<boolean> {
  return chatModelMemo.get(windowKey(provider, modelId), async () => {
    const run = await chatModel.run(judgmentPort(site), { provider, model_id: modelId }, { site });
    const reading = run.readings.chat;
    const keep = !(reading.verdict === 'no' && reading.outcome === 'act');
    run.recordAction(keep ? 'keep-listed' : 'drop-non-chat');
    return keep;
  });
}

/** The listed model ids that read as chat models, in listing order; each id is its own request. */
export async function readChatModelIds(provider: string, modelIds: readonly string[], site: string): Promise<string[]> {
  const keep = await mapLimit(modelIds, CHAT_MODEL_CONCURRENCY, (modelId) => readKeepsChatModel(provider, modelId, site));
  return modelIds.filter((_, index) => keep[index]);
}

/** Forgets every remembered model-fact reading; for tests that swap the judgment port. */
export function forgetModelLimitReadings(): void {
  windowFamilies.clear();
  windowFamilyMemo.clear();
  outputCapRows.clear();
  outputCapMemo.clear();
  chatModelMemo.clear();
}
