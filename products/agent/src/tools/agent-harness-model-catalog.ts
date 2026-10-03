import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { requireProviderApi } from '../input/commands/runtime-services.ts';
import type { ArtifactListLike, ModelCandidate, ProviderApiLike } from './agent-harness-model-routing-types.ts';
import { readRecord, readString, readStringArray } from './agent-harness-model-routing-utils.ts';

export function readProviderModels(value: unknown, providerId: string): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return providerId ? `${providerId}:${entry}` : entry;
    const modelId = modelModelId(entry);
    const registryKey = modelRegistryKey(entry);
    return registryKey || (providerId && modelId ? `${providerId}:${modelId}` : modelId);
  }).filter(Boolean);
}

export function readArtifactStore(context: CommandContext): ArtifactListLike | null {
  const candidate = (context.platform as { readonly artifactStore?: unknown }).artifactStore;
  return candidate && typeof candidate === 'object' ? candidate as ArtifactListLike : null;
}

export function readConfig(context: CommandContext, key: string): unknown {
  try {
    return (context.platform.configManager as { get(settingKey: string): unknown }).get(key);
  } catch {
    return undefined;
  }
}

export function contextWindowFor(context: CommandContext, model: unknown): number | null {
  // The window a source states, or null when unknown (a guess, or disproven
  // by a larger accepted request); never the model record's stated number
  // when the registry knows that number is not real.
  const known = context.provider.providerRegistry as { getKnownContextWindowForModel?: (candidate: unknown) => number | null };
  const isModelDefinition = typeof readRecord(model).registryKey === 'string' && typeof readRecord(model).contextWindow === 'number';
  if (isModelDefinition && typeof known.getKnownContextWindowForModel === 'function') {
    try {
      const value = known.getKnownContextWindowForModel(model);
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      // A bare model reference the registry cannot resolve: fall through.
    }
  }
  const record = readRecord(model);
  const direct = record.contextWindow;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  try {
    const registry = context.provider.providerRegistry as { getContextWindowForModel(candidate: unknown): number };
    const value = registry.getContextWindowForModel(model);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function modelRegistryKey(model: unknown): string {
  const record = readRecord(model);
  return readString(record.registryKey) || readString(record.id) || readString(record.modelId);
}

export function modelProviderId(model: unknown): string {
  const record = readRecord(model);
  return readString(record.providerId) || readString(record.provider);
}

export function modelModelId(model: unknown): string {
  const record = readRecord(model);
  return readString(record.modelId) || readString(record.id) || modelRegistryKey(model);
}

export function modelDisplayName(model: unknown): string {
  const record = readRecord(model);
  return readString(record.displayName) || readString(record.name) || modelRegistryKey(model);
}

export function modelCurrent(model: unknown): boolean {
  const record = readRecord(model);
  return record.current === true;
}

export function modelReasoning(model: unknown): readonly string[] {
  const record = readRecord(model);
  return readStringArray(record.reasoningEffort);
}

export function modelCapabilities(model: unknown): unknown {
  return readRecord(model).capabilities ?? null;
}

export function modelTier(model: unknown): string | undefined {
  return readString(readRecord(model).tier) || undefined;
}

export function modelBenchmarkCompositeScore(model: unknown): number | null {
  const benchmark = readRecord(readRecord(model).benchmark);
  const value = benchmark.compositeScore;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function modelBenchmarkQualityTier(model: unknown): string | undefined {
  return readString(readRecord(readRecord(model).benchmark).qualityTier) || undefined;
}

export function readProviderApi(context: CommandContext): ProviderApiLike | null {
  try {
    return requireProviderApi(context) as ProviderApiLike;
  } catch {
    return null;
  }
}

export async function loadPinnedModelIds(context: CommandContext): Promise<ReadonlySet<string>> {
  const providerApi = readProviderApi(context);
  if (!providerApi) return new Set();
  try {
    const favorites = await providerApi.getFavorites();
    const pinned = readRecord(favorites).pinned;
    if (!Array.isArray(pinned)) return new Set();
    return new Set(pinned.flatMap((entry) => {
      const record = readRecord(entry);
      return [readString(record.registryKey), readString(record.modelId)].filter(Boolean);
    }));
  } catch {
    return new Set();
  }
}

export async function loadModels(context: CommandContext): Promise<readonly ModelCandidate[]> {
  const providerApi = readProviderApi(context);
  if (!providerApi) return [];
  const pinned = await loadPinnedModelIds(context);
  const models = await providerApi.listModels({ selectableOnly: true });
  return models.map((model) => {
    const registryKey = modelRegistryKey(model);
    const modelId = modelModelId(model);
    return {
      kind: 'model',
      id: registryKey,
      registryKey,
      modelId,
      providerId: modelProviderId(model),
      displayName: modelDisplayName(model),
      current: modelCurrent(model) || registryKey === context.session.runtime.model,
      contextWindow: contextWindowFor(context, model),
      reasoningEffort: modelReasoning(model),
      capabilities: modelCapabilities(model),
      tier: modelTier(model),
      benchmarkCompositeScore: modelBenchmarkCompositeScore(model),
      benchmarkQualityTier: modelBenchmarkQualityTier(model),
      pinned: pinned.has(registryKey) || pinned.has(modelId),
    };
  });
}

export function listProviderIds(context: CommandContext): readonly string[] {
  return readProviderApi(context)?.listProviderIds() ?? [];
}

export function listRegistryModels(context: CommandContext): readonly unknown[] {
  try {
    const registry = context.provider.providerRegistry as { listModels?: () => readonly unknown[] };
    return registry.listModels?.() ?? [];
  } catch {
    return [];
  }
}

export function listProviderRegistryProviders(context: CommandContext): readonly unknown[] {
  try {
    const registry = context.provider.providerRegistry as { listProviders?: () => readonly unknown[] };
    return registry.listProviders?.() ?? [];
  } catch {
    return [];
  }
}
