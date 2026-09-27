import { logger } from '../utils/logger.js';
import { inferFallbackContextWindow } from './context-window-fallback.js';
import type { BenchmarkEntry } from './model-benchmarks.js';
import { compositeScore } from './model-benchmarks.js';
import type { CatalogModel } from './model-catalog.js';
import type { ContextWindowProvenance } from './registry-types.js';
import { type ReasoningEffortSpec, parseReasoningOptions } from './reasoning-effort.js';
import { resolveReasoningEffortSpec } from './reasoning-effort-families.js';
import type { SyntheticBackend, CanonicalModel, SyntheticTier } from './synthetic.js';
import { mapLimit } from '@goodvibes-jev/judgment';
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

/**
 * Which catalog entries from different callable providers serve the same
 * model: routing.model-identity readings over the entries of one catalog
 * family (a catalog fact) from the other callable providers. Replaces the
 * normalized-name slug grouping. `known` answers from what has been read;
 * `readAll` reads what has not, so the next build groups it.
 */
export class SyntheticIdentities {
  readonly #resolver: ModelIdentityResolver;
  #candidatesFrom: readonly CatalogModel[] | undefined;
  #candidates: readonly IdentityCandidate[] = [];

  constructor(options: { readonly path?: string | undefined; readonly models: () => readonly CatalogModel[] }) {
    this.#resolver = new ModelIdentityResolver({
      universe: 'synthetic-backends',
      path: options.path,
      candidates: () => {
        const models = options.models();
        if (models !== this.#candidatesFrom) {
          this.#candidatesFrom = models;
          this.#candidates = models
            .filter((model) => model.family && isKeyed(model))
            .map((model) => ({ key: registryKeyOf(model), id: model.id, name: model.name, provider: model.providerId, family: model.family }));
        }
        return this.#candidates;
      },
    });
  }

  static query(model: CatalogModel): IdentityQuery {
    return { id: model.id, name: model.name, provider: model.providerId, family: model.family, otherProviderThan: model.providerId };
  }

  /** The registry key of another provider's entry read as the same model, null for none, undefined when not read. */
  known(model: CatalogModel): string | null | undefined {
    return this.#resolver.known(SyntheticIdentities.query(model));
  }

  /** Reads every callable family member that has not been read; returns how many readings were asked. */
  async readAll(models: readonly CatalogModel[], site = 'providers.synthetic.identity'): Promise<number> {
    const pending = syntheticCandidatesOf(models).filter((model) => this.known(model) === undefined);
    await mapLimit(pending, SYNTHETIC_IDENTITY_CONCURRENCY, (model) => this.#resolver.resolve(SyntheticIdentities.query(model), site));
    return pending.length;
  }
}

/** Identity readings in flight at once while grouping. */
const SYNTHETIC_IDENTITY_CONCURRENCY = 8;

/** Callable catalog models whose family has callable entries from at least two providers: the only ones a failover group can hold. */
function syntheticCandidatesOf(models: readonly CatalogModel[]): CatalogModel[] {
  const providersByFamily = new Map<string, Set<string>>();
  for (const model of models) {
    if (!model.family || !isKeyed(model)) continue;
    const providers = providersByFamily.get(model.family) ?? new Set<string>();
    providers.add(model.providerId);
    providersByFamily.set(model.family, providers);
  }
  return models.filter((model) => model.family && isKeyed(model) && (providersByFamily.get(model.family)?.size ?? 0) >= 2);
}

/**
 * Canonical failover models: callable catalog entries from different
 * providers that the identity readings say are the same model, joined into
 * one group per model. A group needs at least two providers. Entries not yet
 * read join no group until their reading lands.
 */
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
    const canonicalId = usedIds.has(slug) ? `${representative.family}-${slug}` : slug;
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
      contextWindow: hasCatalogContextWindow ? bestBackend.contextWindow! : inferFallbackContextWindow('synthetic', canonical.id),
      ...(!hasCatalogContextWindow ? { contextWindowProvenance: 'fallback' as const } : {}),
      selectable: true,
      // A metered group carries no capability label until one of its backends is read.
      ...(canonical.tier === 'free' || canonical.tier === 'subscription' ? { tier: canonical.tier } : {}),
      ...(hasReasoning
        ? {
          reasoningEffort: resolveReasoningEffortSpec({
            modelId: bestBackend?.modelId ?? canonical.id,
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
