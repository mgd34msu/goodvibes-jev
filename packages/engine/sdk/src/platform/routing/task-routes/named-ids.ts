/**
 * `routing.task-route.named-id`: which known id, if any, a request names
 * (a model provider, an external memory provider, a channel target). The ids
 * are open lists of data offered as candidates, never matched by substring;
 * each candidate carries the names it goes by, so an alias such as
 * "llamacpp" lands on the fixed route id "llama.cpp". The ids are the values
 * the agent's route strings carried.
 *
 * Context: `{ request, kind }`, the task and what the candidates are.
 *
 * Bands: low stakes. A named id only fills a read-only route string; a weak
 * reading leaves the generic route string in place (slots.ts).
 */
import { defineSelector, NONE, STAKES_BANDS, type Candidate } from '@goodvibes-jev/judgment';

const LOW = STAKES_BANDS.low;

/** A known id and the names a request may use for it. */
export interface NamedId {
  readonly id: string;
  readonly names: readonly string[];
}

/** Model provider ids the agent's model routes name. */
export const MODEL_PROVIDER_IDS: readonly NamedId[] = [
  { id: 'openrouter', names: ['OpenRouter'] },
  { id: 'openai', names: ['OpenAI'] },
  { id: 'anthropic', names: ['Anthropic'] },
  { id: 'claude', names: ['Claude'] },
  { id: 'ollama', names: ['Ollama'] },
  { id: 'llama.cpp', names: ['llama.cpp', 'llamacpp'] },
  { id: 'vllm', names: ['vLLM'] },
  { id: 'lm-studio', names: ['LM Studio'] },
];

/** External memory provider ids (the agent's EXTERNAL_MEMORY_PROVIDER_IDS). */
export const EXTERNAL_MEMORY_PROVIDER_IDS: readonly NamedId[] = [
  { id: 'honcho', names: ['Honcho'] },
  { id: 'openviking', names: ['OpenViking'] },
  { id: 'mem0', names: ['Mem0'] },
  { id: 'hindsight', names: ['Hindsight'] },
  { id: 'holographic', names: ['Holographic'] },
  { id: 'retaindb', names: ['RetainDB'] },
  { id: 'byterover', names: ['ByteRover'] },
  { id: 'supermemory', names: ['Supermemory'] },
];

/** Channel target ids the agent's channel routes name. */
export const CHANNEL_TARGET_IDS: readonly NamedId[] = [
  { id: 'slack', names: ['Slack'] },
  { id: 'discord', names: ['Discord'] },
  { id: 'telegram', names: ['Telegram'] },
  { id: 'whatsapp', names: ['WhatsApp'] },
  { id: 'signal', names: ['Signal'] },
  { id: 'matrix', names: ['Matrix'] },
  { id: 'teams', names: ['Microsoft Teams', 'Teams'] },
  { id: 'ntfy', names: ['ntfy'] },
  { id: 'webhook', names: ['webhook'] },
];

/** What each list holds, as the selector's context names it. */
export const NAMED_ID_KINDS = {
  modelProvider: { kind: 'model provider', ids: MODEL_PROVIDER_IDS },
  memoryProvider: { kind: 'external memory provider', ids: EXTERNAL_MEMORY_PROVIDER_IDS },
  channelTarget: { kind: 'messaging channel or notification target', ids: CHANNEL_TARGET_IDS },
} as const;

export type NamedIdKind = keyof typeof NAMED_ID_KINDS;

export const namedIdCandidates = (ids: readonly NamedId[]): readonly Candidate[] =>
  ids.map(({ id, names }) => ({ id, content: { names: [...names] } }));

const fixture = (kind: NamedIdKind, request: string, expect: string) => ({
  name: `${kind}: ${request}`,
  context: { request, kind: NAMED_ID_KINDS[kind].kind },
  candidates: namedIdCandidates(NAMED_ID_KINDS[kind].ids),
  expect,
});

export const taskRouteNamedId = defineSelector({
  name: 'routing.task-route.named-id',
  version: 1,
  description: 'Which known model provider, external memory provider or channel target a request names, or none.',
  accuracyFloor: 0.9,
  instructions: 'Each candidate is a known `context.kind`, with the names it goes by. Which candidate does `context.request` name? Choose none when the request names none of them, even if it is about that kind of thing.',
  fitInstructions: 'Does `context.request` name this candidate, by one of the names it lists?',
  band: LOW.confidence,
  fitBand: LOW.yesNo,
  fixtures: [
    fixture('modelProvider', 'connect OpenRouter subscription', 'openrouter'),
    fixture('modelProvider', 'is my OpenAI API key still valid?', 'openai'),
    fixture('modelProvider', 'check the Anthropic provider account', 'anthropic'),
    fixture('modelProvider', 'log in to my Claude subscription', 'claude'),
    fixture('modelProvider', 'recommend an Ollama model for this laptop', 'ollama'),
    fixture('modelProvider', 'serve a model with llamacpp on port 8080', 'llama.cpp'),
    fixture('modelProvider', 'is the vLLM endpoint reachable?', 'vllm'),
    fixture('modelProvider', 'connect the LM Studio server', 'lm-studio'),
    fixture('modelProvider', 'show my model provider subscriptions', NONE),
    fixture('memoryProvider', 'set up Honcho for cross-session memory', 'honcho'),
    fixture('memoryProvider', 'sync memory to OpenViking', 'openviking'),
    fixture('memoryProvider', 'connect Mem0 as my memory backend', 'mem0'),
    fixture('memoryProvider', 'is the Hindsight memory provider ready?', 'hindsight'),
    fixture('memoryProvider', 'export memory to Holographic', 'holographic'),
    fixture('memoryProvider', 'import my memories from RetainDB', 'retaindb'),
    fixture('memoryProvider', 'enable the ByteRover memory provider', 'byterover'),
    fixture('memoryProvider', 'connect Supermemory as an external memory provider', 'supermemory'),
    fixture('memoryProvider', 'set up cross-session memory sync', NONE),
    fixture('channelTarget', 'set up Slack notifications', 'slack'),
    fixture('channelTarget', 'triage failed Discord delivery retries', 'discord'),
    fixture('channelTarget', 'send message to Telegram', 'telegram'),
    fixture('channelTarget', 'notify me on WhatsApp when the build finishes', 'whatsapp'),
    fixture('channelTarget', 'connect my Signal account for alerts', 'signal'),
    fixture('channelTarget', 'post the summary to the Matrix room', 'matrix'),
    fixture('channelTarget', 'send a test message to Microsoft Teams', 'teams'),
    fixture('channelTarget', 'push a ntfy notification to my phone', 'ntfy'),
    fixture('channelTarget', 'deliver the report to the webhook', 'webhook'),
    fixture('channelTarget', 'show recent delivery receipts', NONE),
  ],
});
