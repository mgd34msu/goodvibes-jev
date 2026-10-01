import { asRecord, bestId, bestTitle, firstArrayAtPath, firstString, readPath } from './object';
import { deriveProviderStatus } from './provider-status';

export interface ProviderOption {
  id: string;
  label: string;
  value: unknown;
}

/**
 * Configured providers first, then unconfigured, alphabetical within each
 * group. Every provider list the operator picks from (composer picker,
 * Providers sidebar) orders this way: the provider someone can actually use
 * must not sit below a scroll of forty they cannot.
 */
export function sortProvidersConfiguredFirst(options: readonly ProviderOption[]): ProviderOption[] {
  return [...options].sort((a, b) => {
    const aConfigured = deriveProviderStatus(a.value).configured;
    const bConfigured = deriveProviderStatus(b.value).configured;
    if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}

export interface ModelOption {
  id: string;
  label: string;
  value: unknown;
  providerId: string;
  rawModelId: string;
  registryKey: string;
}

export function providerOptionsFromResponse(value: unknown): ProviderOption[] {
  return firstArrayAtPath(value, [
    ['providers'],
    ['items'],
    ['data'],
    ['result', 'providers'],
    ['result', 'items'],
    ['result', 'data'],
  ])
    .map((provider) => {
      const id = bestId(provider);
      return id ? { id, label: bestTitle(provider, id), value: provider } : null;
    })
    .filter((provider): provider is ProviderOption => provider !== null);
}

/**
 * Tolerant read of a model entry's reasoning-effort options (models.list
 * serves `reasoningOptions: { levels, source }` per model from sdk 2.0.23).
 * Null when the daemon predates the field or the model reports none, the
 * caller renders no effort control rather than a fabricated ladder.
 */
export function reasoningOptionsForModel(
  providers: readonly unknown[],
  registryKey: string,
): { levels: readonly string[]; source: string } | null {
  if (!registryKey) return null;
  for (const provider of providers) {
    const models = asRecord(provider).models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const record = asRecord(model);
      const key = firstString(record, ['registryKey', 'key']);
      if (key !== registryKey) continue;
      const options = asRecord(record.reasoningOptions);
      const levels = Array.isArray(options.levels)
        ? options.levels.filter((level): level is string => typeof level === 'string' && level.length > 0)
        : [];
      if (levels.length === 0) return null;
      return { levels, source: firstString(options, ['source']) || 'unknown' };
    }
  }
  return null;
}

function providerQualifiedKey(providerId: string, modelId: string, registryKey: string): string {
  if (registryKey.includes(':')) return registryKey;
  if (modelId.includes(':')) return modelId;
  return providerId && modelId ? `${providerId}:${modelId}` : '';
}

function normalizeModel(providerId: string, model: unknown): ModelOption | null {
  if (typeof model === 'string') {
    const rawModelId = model.trim();
    const registryKey = providerQualifiedKey(providerId, rawModelId, '');
    return registryKey ? { id: registryKey, label: rawModelId, value: model, providerId, rawModelId, registryKey } : null;
  }

  const explicitRegistryKey = firstString(model, ['registryKey', 'key']);
  const rawModelId = firstString(model, ['modelId', 'id', 'model', 'modelName', 'value', 'name'])
    || explicitRegistryKey.split(':').slice(1).join(':');
  const registryKey = providerQualifiedKey(providerId, rawModelId, explicitRegistryKey);
  if (!registryKey || !rawModelId) return null;
  return {
    id: registryKey,
    label: bestTitle(model, rawModelId),
    value: model,
    providerId,
    rawModelId,
    registryKey,
  };
}

function appendUnique(target: ModelOption[], model: ModelOption | null) {
  if (!model) return;
  if (target.some((item) => item.id === model.id)) return;
  target.push(model);
}

function appendUniqueString(target: string[], value: string) {
  if (!value || target.includes(value)) return;
  target.push(value);
}

const CATALOG_PROVIDER_ALIASES: Record<string, string> = {
  'openai-subscriber': 'openai',
  inception: 'inceptionlabs',
  copilot: 'github-copilot',
  'azure-openai': 'microsoft-foundry',
  'azure-openai-responses': 'microsoft-foundry',
  dashscope: 'qwen',
  'volcano-engine': 'volcengine',
  'x-ai': 'xai',
  'z-ai': 'zai',
  'cloudflare-gateway': 'cloudflare-ai-gateway',
  'ai-gateway': 'vercel-ai-gateway',
};

export function providerModelSourceIds(provider: unknown): string[] {
  const providerId = bestId(provider);
  const ids: string[] = [];

  appendUniqueString(ids, CATALOG_PROVIDER_ALIASES[providerId] ?? '');
  appendUniqueString(ids, firstString(provider, ['catalogProviderId', 'canonicalProviderId', 'subscriptionProviderId', 'baseProviderId', 'modelProviderId']));
  appendUniqueString(ids, firstString(readPath(provider, ['runtime']), ['catalogProviderId', 'canonicalProviderId', 'subscriptionProviderId', 'baseProviderId', 'modelProviderId']));
  appendUniqueString(ids, firstString(readPath(provider, ['runtime', 'models']), ['providerId', 'catalogProviderId', 'canonicalProviderId']));

  for (const route of firstArrayAtPath(provider, [
    ['auth', 'routes'],
    ['runtime', 'auth', 'routes'],
  ])) {
    appendUniqueString(ids, firstString(route, ['providerId', 'catalogProviderId', 'subscriptionProviderId']));
  }

  if (providerId.endsWith('-subscriber')) {
    appendUniqueString(ids, providerId.slice(0, -'-subscriber'.length));
  }

  return ids.filter((id) => id !== providerId);
}

export function modelOptionsFromProvider(provider: unknown): ModelOption[] {
  const models: ModelOption[] = [];
  const providerId = bestId(provider);
  for (const path of [
    ['models'],
    ['availableModels'],
    ['modelCatalog'],
    ['catalog', 'models'],
    ['catalog', 'items'],
    ['runtime', 'models', 'models'],
    ['runtime', 'models', 'aliases'],
  ]) {
    for (const model of firstArrayAtPath(provider, [path])) {
      appendUnique(models, normalizeModel(providerId, model));
    }
  }

  const defaultModel = readPath(provider, ['runtime', 'models', 'defaultModel']);
  appendUnique(models, normalizeModel(providerId, defaultModel));

  const record = asRecord(provider);
  appendUnique(models, normalizeModel(providerId, record.defaultModel));

  return models;
}

export function modelOptionsForProvider(provider: unknown, modelCatalogProviders: unknown[] = []): ModelOption[] {
  const aliasProviderIds = providerModelSourceIds(provider);
  const aliasModels: ModelOption[] = [];

  for (const aliasProviderId of aliasProviderIds) {
    const catalogProvider = modelCatalogProviders.find((candidate) => bestId(candidate) === aliasProviderId);
    if (!catalogProvider) continue;
    for (const model of modelOptionsFromProvider(catalogProvider)) {
      appendUnique(aliasModels, model);
    }
  }

  if (aliasModels.length) return aliasModels;
  return modelOptionsFromProvider(provider);
}
