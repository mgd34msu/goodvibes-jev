import { logger } from '../utils/logger.js';
import { knownFallbackContextWindow } from './context-window-fallback.js';
import type { BenchmarkEntry } from './model-benchmarks.js';
import { compositeScore } from './model-benchmarks.js';
import type { CatalogModel } from './model-catalog.js';
import type { ContextWindowProvenance } from './registry-types.js';
import { type ReasoningEffortSpec, parseReasoningOptions } from './reasoning-effort.js';
import { resolveReasoningEffortSpec } from './reasoning-effort-families.js';
import type { SyntheticBackend, CanonicalModel, SyntheticTier } from './synthetic.js';
import { ModelIdentityResolver, type IdentityCandidate, type IdentityQuery } from '../routing/model-identity.js';

export interface MinimalModelDefinition {
  id: string;
  provider: string;
  registryKey: string;
  displayName: string;
  description: string;
  capabilities: {
    toolCalling: boolean;
    codeEditing: boolean;
    reasoning: boolean;
    multimodal: boolean;
  };
  contextWindow: number;
  contextWindowProvenance?: ContextWindowProvenance | undefined;
  selectable: boolean;
  tier?: 'free' | 'standard' | 'premium' | 'subscription' | undefined;
  reasoningEffort?: ReasoningEffortSpec | undefined;
}

export interface SyntheticModelInfo {
  backendCount: number;
  keyedBackendCount: number;
  tier: SyntheticTier;
  bestCompositeScore: number | null;
}

export function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasConfiguredEnvVar(envVars: readonly string[]): boolean {
  return envVars.some((envVar) => {
    const value = process.env[envVar]!;
    return typeof value === 'string' && value.length > 0;
  });
}

/** Whether a catalog model's provider can be called: it needs no key, or one of its key variables is set. */
function isKeyed(model: CatalogModel): boolean {
  return model.providerEnvVars.length === 0 || hasConfiguredEnvVar(model.providerEnvVars);
}

const registryKeyOf = (model: CatalogModel): string => `${model.providerId}:${model.id}`;

/** Join callable provider offerings only through their published canonical model IDs. */
export class SyntheticIdentities {
  readonly #resolver: ModelIdentityResolver;
  #candidatesFrom: readonly CatalogModel[] | undefined;
  #candidates: readonly IdentityCandidate[] = [];

  constructor(options: { readonly models: () => readonly CatalogModel[] }) {
    this.#resolver = new ModelIdentityResolver({
      candidates: () => {
        const models = options.models();
        if (models !== this.#candidatesFrom) {
          this.#candidatesFrom = models;
          this.#candidates = models
            .filter((model) => model.canonicalModelId && isKeyed(model))
            .map((model) => ({ key: registryKeyOf(model), id: model.id, name: model.name, provider: model.providerId,
              canonicalModelId: model.canonicalModelId }));
        }
        return this.#candidates;
      },
    });
  }

  static query(model: CatalogModel): IdentityQuery {
    return { id: model.id, name: model.name, provider: model.providerId, canonicalModelId: model.canonicalModelId, otherProviderThan: model.providerId };
  }

  /** The registry key of another offering of the published model, or null. */
  known(model: CatalogModel): string | null {
    if (!model.canonicalModelId) return null;
    return this.#resolver.known(SyntheticIdentities.query(model));
  }

  /** Compatibility entrypoint: canonical joins require no asynchronous readings. */
  async readAll(_models: readonly CatalogModel[], _site = 'providers.synthetic.identity'): Promise<number> {
    return 0;
  }
}

/** Published models available from at least two callable providers. */
function syntheticCandidatesOf(models: readonly CatalogModel[]): CatalogModel[] {
  const providersByIdentity = new Map<string, Set<string>>();
  for (const model of models) {
    if (!model.canonicalModelId || !isKeyed(model)) continue;
    const providers = providersByIdentity.get(model.canonicalModelId) ?? new Set<string>();
    providers.add(model.providerId);
    providersByIdentity.set(model.canonicalModelId, providers);
  }
  return models.filter((model) => model.canonicalModelId && isKeyed(model) && (providersByIdentity.get(model.canonicalModelId)?.size ?? 0) >= 2);
}

/** Group provider offerings with the same published model identity. */
export function buildSyntheticCanonicalModels(models: readonly CatalogModel[], identities: Pick<SyntheticIdentities, 'known'>): CanonicalModel[] {
  const candidates = syntheticCandidatesOf(models);
  const byKey = new Map(candidates.map((model) => [registryKeyOf(model), model]));
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    let node = key;
    while (parent.has(node) && parent.get(node) !== node) node = parent.get(node)!;
    return node;
  };
  for (const model of candidates) {
    const same = identities.known(model);
    if (!same || !byKey.has(same)) continue;
    const a = root(registryKeyOf(model));
    const b = root(same);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const groups = new Map<string, CatalogModel[]>();
  for (const model of candidates) {
    const key = root(registryKeyOf(model));
    const group = groups.get(key) ?? [];
    group.push(model);
    groups.set(key, group);
  }

  const canonical: CanonicalModel[] = [];
  const usedIds = new Set<string>();
  const tierPriority: Record<SyntheticTier, number> = { free: 2, subscription: 1, paid: 0 };
  for (const group of groups.values()) {
    const distinctProviders = new Set(group.map((model) => model.providerId)).size;
    if (distinctProviders < 2) continue;
    const ordered = [...group].sort((a, b) => registryKeyOf(a).localeCompare(registryKeyOf(b)));
    const representative = ordered[0]!;
    const slug = nameToSlug(representative.name) || nameToSlug(representative.id);
    const canonicalId = usedIds.has(slug) ? `${nameToSlug(representative.canonicalModelId ?? representative.id)}-${slug}` : slug;
    usedIds.add(canonicalId);
    const backends: SyntheticBackend[] = ordered.map((model) => ({
      providerName: model.providerId,
      modelId: model.id,
      registryKey: registryKeyOf(model),
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      envVars: model.providerEnvVars.length > 0 ? model.providerEnvVars : undefined,
    }));
    const tier = ordered.reduce<SyntheticTier>((best, model) => ((tierPriority[model.tier] ?? 0) > (tierPriority[best] ?? 0) ? model.tier : best), ordered[0]!.tier);
    canonical.push({ id: canonicalId, tier, backends, backendCount: backends.length, keyedBackendCount: distinctProviders });
  }
  return canonical;
}

export function getSyntheticModelInfo(
  modelId: string,
  canonicalModels: readonly CanonicalModel[],
  getBenchmarks: (modelName: string) => BenchmarkEntry | undefined,
): SyntheticModelInfo | null {
  const canonical = canonicalModels.find((model) => model.id === modelId);
  if (!canonical) return null;

  let bestCompositeScore: number | null = null;
  for (const backend of canonical.backends) {
    const benchmark = getBenchmarks(backend.modelId);
    if (!benchmark) continue;
    const score = compositeScore(benchmark.benchmarks);
    if (score != null && (bestCompositeScore == null || score > bestCompositeScore)) {
      bestCompositeScore = score;
    }
  }

  return {
    backendCount: canonical.backendCount,
    keyedBackendCount: canonical.keyedBackendCount,
    tier: canonical.tier,
    bestCompositeScore,
  };
}

export function getSyntheticBackendModelIds(canonicalModels: readonly CanonicalModel[]): Set<string> {
  return new Set(canonicalModels.flatMap((canonical) => canonical.backends.map((backend) => backend.modelId)));
}

export function getSyntheticModelDefinitions(
  models: readonly CatalogModel[],
  canonicalModels: readonly CanonicalModel[],
): MinimalModelDefinition[] {
  const definitions = canonicalModels.map((canonical): MinimalModelDefinition => {
    const bestBackend = canonical.backends.reduce(
      (best, backend) => ((backend.contextWindow ?? 0) > (best.contextWindow ?? 0) ? backend : best),
      canonical.backends[0]!,
    );
    const catalogMatch = models.find((model) => canonical.backends.some((backend) => backend.modelId === model.id));
    const displayName = catalogMatch?.name ?? canonical.id;
    const catalogSpec = parseReasoningOptions(catalogMatch?.reasoningOptions);
    const hasReasoning = catalogMatch?.reasoning === true
      || (catalogSpec !== undefined && catalogSpec.kind !== 'unavailable');

    const hasCatalogContextWindow = bestBackend?.contextWindow != null && bestBackend.contextWindow > 0;
    return {
      id: canonical.id,
      provider: 'synthetic',
      registryKey: `synthetic:${canonical.id}`,
      displayName,
      description: `Synthetic failover model, ${canonical.backendCount} provider${canonical.backendCount !== 1 ? 's' : ''} available`,
      capabilities: {
        toolCalling: true,
        codeEditing: true,
        reasoning: hasReasoning,
        multimodal: false,
      },
      contextWindow: hasCatalogContextWindow ? bestBackend.contextWindow! : knownFallbackContextWindow('synthetic', canonical.id),
      ...(!hasCatalogContextWindow ? { contextWindowProvenance: 'fallback' as const } : {}),
      selectable: true,
      // A metered group carries no capability label until one of its backends is read.
      ...(canonical.tier === 'free' || canonical.tier === 'subscription' ? { tier: canonical.tier } : {}),
      ...(hasReasoning
        ? {
          reasoningEffort: resolveReasoningEffortSpec({
            provider: bestBackend?.providerName, modelId: bestBackend?.modelId ?? canonical.id,
            ...(catalogSpec ? { spec: catalogSpec } : {}),
          }),
        }
        : {}),
    };
  });

  logger.debug('[model-catalog] getSyntheticModelDefinitions', {
    count: definitions.length,
    sampleIds: definitions.slice(0, 20).map((definition) => definition.id),
  });
  return definitions;
}
