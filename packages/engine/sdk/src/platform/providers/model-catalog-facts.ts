import type { CatalogModel } from './model-catalog.js';
import { CATALOG_PROVIDER_NAME_ALIASES } from './provider-aliases.js';

/** Public repository facts shared by provider discovery and benchmark matching. */
let catalog: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map();
let byProvider: ReadonlyMap<string, ReadonlyMap<string, CatalogModel>> = new Map();
let byReference: ReadonlyMap<string, readonly CatalogModel[]> = new Map();
let identities: ReadonlyMap<string, ReadonlySet<string>> = new Map();

export function installCatalogModelFacts(models: readonly CatalogModel[]): void {
  const next = new Map<string, Map<string, string>>();
  const aliases = new Map<string, Set<string>>();
  const providers = new Map<string, Map<string, CatalogModel>>();
  const references = new Map<string, CatalogModel[]>();
  for (const model of models) {
    let records = providers.get(model.providerId);
    if (!records) { records = new Map(); providers.set(model.providerId, records); }
    records.set(model.id, model);
    for (const reference of new Set([model.id, `${model.providerId}:${model.id}`, ...(model.canonicalModelId ? [model.canonicalModelId] : [])])) {
      const matches = references.get(reference) ?? [];
      matches.push(model); references.set(reference, matches);
    }
    if (model.modelType) {
      let provider = next.get(model.providerId);
      if (!provider) { provider = new Map(); next.set(model.providerId, provider); }
      provider.set(model.id, model.modelType);
    }
    if (!model.canonicalModelId) continue;
    for (const reference of [model.id, model.name, `${model.providerId}:${model.id}`, model.canonicalModelId]) {
      const key = reference.toLowerCase();
      let matches = aliases.get(key);
      if (!matches) { matches = new Set(); aliases.set(key, matches); }
      matches.add(model.canonicalModelId);
    }
  }
  catalog = next;
  byProvider = providers;
  byReference = references;
  identities = aliases;
}

/** Only unambiguous, explicitly published names and IDs establish identity. */
export function knownCatalogModelIdentity(reference: string): string | undefined {
  const matches = identities.get(reference.toLowerCase());
  return matches?.size === 1 ? matches.values().next().value : undefined;
}

export function knownCatalogChatCapability(provider: string, modelId: string): boolean | undefined {
  const type = catalog.get(CATALOG_PROVIDER_NAME_ALIASES[provider] ?? provider)?.get(modelId);
  if (type === undefined) return undefined;
  if (type === 'chat') return true;
  return ['embedding', 'reranking', 'image', 'video', 'speech', 'transcription', 'decision', 'realtime'].includes(type) ? false : undefined;
}

/** Exact endpoint facts. A canonical ID can join only this provider's offerings. */
export function catalogModelsForReference(modelId: string, provider?: string): readonly CatalogModel[] {
  if (provider === undefined) return byReference.get(modelId) ?? [];
  const records = byProvider.get(CATALOG_PROVIDER_NAME_ALIASES[provider] ?? provider);
  const direct = records?.get(modelId);
  if (direct) return [direct];
  return (byReference.get(modelId) ?? []).filter(model =>
    model.providerId === (CATALOG_PROVIDER_NAME_ALIASES[provider] ?? provider));
}

/** Unknown or conflicting endpoint limits remain unknown. */
export function knownCatalogMaxOutput(provider: string, modelId: string): number | undefined {
  const models = catalogModelsForReference(modelId, provider);
  const limits = new Set(models.map(model => model.maxOutputTokens));
  const limit = limits.values().next().value;
  return limits.size === 1 && typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}
