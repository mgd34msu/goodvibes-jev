/**
 * `routing.task-route.named-id`: which known id, if any, a request names
 * (a model provider, an external memory provider, a channel target). The
 * candidates are the live listings the host holds, never a copied list, and
 * never matched by substring; each candidate carries the names it goes by.
 *
 * Where each listing comes from:
 * - Model providers: the provider registry (every registered provider plus
 *   every configured catalog provider), named by the catalog's provider name
 *   or the builtin definition's label (`modelProviderNamedIds`).
 * - Channel targets: the channel plugin registry's adapter descriptors, one
 *   per surface, named by the adapter's display name (`channelTargetNamedIds`).
 * - External memory providers: the engine defines none (no engine module
 *   lists or serves one), so the product passes the providers it recognizes;
 *   a host that passes none gets no memory-provider reading and the generic
 *   memory route string.
 *
 * Context: `{ request, kind }`, the task and what the candidates are.
 *
 * Bands: low stakes. A named id only fills a read-only route string; a weak
 * reading leaves the generic route string in place (slots.ts).
 */
import { defineSelector, NONE, STAKES_BANDS, type Candidate } from '@goodvibes-jev/judgment';
import type { CatalogModel } from '../../providers/model-catalog.js';
import type { LLMProvider } from '../../providers/interface.js';
import { BUILTIN_COMPAT_PROVIDERS } from '../../providers/builtin-catalog.js';
import type { ChannelAdapterDescriptor } from '../../channels/types.js';

const LOW = STAKES_BANDS.low;

/** A known id and the names a request may use for it. */
export interface NamedId {
  readonly id: string;
  readonly names: readonly string[];
}

/** What each listing holds, as the selector's context names it. */
export const NAMED_ID_KINDS = {
  modelProvider: 'model provider',
  memoryProvider: 'external memory provider',
  channelTarget: 'messaging channel or notification target',
} as const;

export type NamedIdKind = keyof typeof NAMED_ID_KINDS;

/** The live listings a planning pass offers as candidates; a missing or empty listing asks nothing. */
export type NamedIdSources = { readonly [K in NamedIdKind]?: (() => readonly NamedId[]) | undefined };

/** The provider-registry view the model provider listing reads. */
export interface ProviderListing {
  listProviders(): readonly Pick<LLMProvider, 'name'>[];
  getConfiguredProviderIds(): readonly string[];
  getRawCatalogModels(): readonly Pick<CatalogModel, 'providerId' | 'provider'>[];
}

/**
 * Every provider the registry can address: the registered providers and the
 * configured catalog providers, each named by its id and by the catalog's
 * provider name or the builtin label where one exists.
 */
export function modelProviderNamedIds(registry: ProviderListing): NamedId[] {
  const catalogNames = new Map<string, string>();
  for (const model of registry.getRawCatalogModels()) if (!catalogNames.has(model.providerId)) catalogNames.set(model.providerId, model.provider);
  const labels = new Map(BUILTIN_COMPAT_PROVIDERS.map((definition) => [definition.id, definition.label]));
  const ids = new Set<string>([...registry.listProviders().map((provider) => provider.name), ...registry.getConfiguredProviderIds()]);
  return [...ids].sort().map((id) => {
    const names = new Set<string>([catalogNames.get(id) ?? labels.get(id) ?? id, id]);
    return { id, names: [...names] };
  });
}

/** Every channel surface an adapter is registered for, named by the adapter's display name. */
export function channelTargetNamedIds(plugins: { listDescriptors(): readonly Pick<ChannelAdapterDescriptor, 'surface' | 'displayName'>[] }): NamedId[] {
  return plugins.listDescriptors().map((descriptor) => ({ id: descriptor.surface, names: [...new Set([descriptor.displayName, descriptor.surface])] }));
}

export const namedIdCandidates = (ids: readonly NamedId[]): readonly Candidate[] =>
  ids.map(({ id, names }) => ({ id, content: { names: [...names] } }));

/**
 * Example listings for the fixtures, shaped as the live sources produce them
 * (a provider registry with a few builtin and catalog providers, the channel
 * adapters the engine registers, a product's memory providers). They are
 * labelled examples, not the candidate sets planning uses.
 */
const EXAMPLE_LISTINGS: Readonly<Record<NamedIdKind, readonly NamedId[]>> = {
  modelProvider: [
    { id: 'openrouter', names: ['OpenRouter', 'openrouter'] },
    { id: 'openai', names: ['OpenAI', 'openai'] },
    { id: 'anthropic', names: ['Anthropic', 'anthropic'] },
    { id: 'ollama', names: ['Ollama', 'ollama'] },
    { id: 'llama-cpp', names: ['llama.cpp', 'llama-cpp'] },
    { id: 'vllm', names: ['vLLM', 'vllm'] },
    { id: 'lm-studio', names: ['LM Studio', 'lm-studio'] },
    { id: 'groq', names: ['Groq', 'groq'] },
    { id: 'deepseek', names: ['DeepSeek', 'deepseek'] },
    { id: 'zenmux', names: ['ZenMux', 'zenmux'] },
  ],
  memoryProvider: [
    { id: 'honcho', names: ['Honcho'] },
    { id: 'openviking', names: ['OpenViking'] },
    { id: 'mem0', names: ['Mem0'] },
    { id: 'hindsight', names: ['Hindsight'] },
    { id: 'holographic', names: ['Holographic'] },
    { id: 'retaindb', names: ['RetainDB'] },
    { id: 'byterover', names: ['ByteRover'] },
    { id: 'supermemory', names: ['Supermemory'] },
  ],
  channelTarget: [
    { id: 'slack', names: ['Slack', 'slack'] },
    { id: 'discord', names: ['Discord', 'discord'] },
    { id: 'telegram', names: ['Telegram', 'telegram'] },
    { id: 'whatsapp', names: ['WhatsApp', 'whatsapp'] },
    { id: 'signal', names: ['Signal', 'signal'] },
    { id: 'matrix', names: ['Matrix', 'matrix'] },
    { id: 'msteams', names: ['Microsoft Teams', 'msteams'] },
    { id: 'ntfy', names: ['ntfy'] },
    { id: 'webhook', names: ['Generic webhook', 'webhook'] },
    { id: 'mattermost', names: ['Mattermost', 'mattermost'] },
  ],
};

const fixture = (kind: NamedIdKind, request: string, expect: string) => ({
  name: `${kind}: ${request}`,
  context: { request, kind: NAMED_ID_KINDS[kind] },
  candidates: namedIdCandidates(EXAMPLE_LISTINGS[kind]),
  expect,
});

export const taskRouteNamedId = defineSelector({
  name: 'routing.task-route.named-id',
  version: 2,
  description: 'Which model provider, external memory provider or channel target from the host\'s live listings a request names, or none.',
  accuracyFloor: 0.9,
  instructions: 'Each candidate is a known `context.kind`, with the names it goes by. Which candidate does `context.request` name? Choose none when the request names none of them, even if it is about that kind of thing.',
  fitInstructions: 'Does `context.request` name this candidate, by one of the names it lists?',
  band: LOW.confidence,
  fitBand: LOW.yesNo,
  fixtures: [
    fixture('modelProvider', 'connect OpenRouter subscription', 'openrouter'),
    fixture('modelProvider', 'is my OpenAI API key still valid?', 'openai'),
    fixture('modelProvider', 'check the Anthropic provider account', 'anthropic'),
    fixture('modelProvider', 'check my Groq rate limits', 'groq'),
    fixture('modelProvider', 'add my ZenMux key', 'zenmux'),
    fixture('modelProvider', 'recommend an Ollama model for this laptop', 'ollama'),
    fixture('modelProvider', 'serve a model with llamacpp on port 8080', 'llama-cpp'),
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
    fixture('channelTarget', 'send a test message to Microsoft Teams', 'msteams'),
    fixture('channelTarget', 'post the release notes to our Mattermost channel', 'mattermost'),
    fixture('channelTarget', 'push a ntfy notification to my phone', 'ntfy'),
    fixture('channelTarget', 'deliver the report to the webhook', 'webhook'),
    fixture('channelTarget', 'show recent delivery receipts', NONE),
  ],
});
