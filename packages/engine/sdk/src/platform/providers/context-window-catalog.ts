/**
 * Fill missing/legacy remote windows from the catalog without inventing
 * identity. Exact provider IDs (or explicit aliases) and model IDs stay code;
 * a non-exact model ID is resolved only by routing.model-identity. Until that
 * reading settles it stays an estimate, never an authoritative window.
 *
 * An own-provider catalog entry is a stated ceiling. Other providers' most
 * common value (ties smaller, one vote per provider) is only a budget/display
 * estimate: endpoints serving the same model can impose different limits.
 * User caps and learned endpoint observations are overlaid after this step.
 */
import { knownFallbackContextWindow } from './context-window-fallback.js';
import { ModelIdentityResolver } from '../routing/model-identity.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { CatalogModel } from './model-catalog.js';
import type { ContextWindowOrigin, ModelDefinition } from './registry-types.js';

/** The number older provider files wrote for every unmeasured remote model. */
export const LEGACY_GUESSED_CONTEXT_WINDOW = 8_192;

interface CatalogListing {
  readonly providerId: string;
  readonly tokens: number;
}

/** Lookup tables and identity readings for one immutable catalog snapshot. */
export interface CatalogContextWindowIndex {
  readonly byProvider: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** One vote per provider for each exact catalog model ID. */
  readonly byModelId: ReadonlyMap<string, readonly CatalogListing[]>;
  /** Exact ID, a previously read identity, or null while unknown. */
  readonly resolveModelId: (providerId: string, modelId: string) => string | null;
}

/** A numeric budget value and its source; consensus/family values are guesses. */
export interface CatalogContextWindowResolution {
  readonly tokens: number;
  readonly provenance: 'catalog' | 'fallback';
  readonly origin: ContextWindowOrigin;
}

/** Build once per snapshot. Invalid figures do not become catalog evidence. */
export function buildCatalogContextWindowIndex(
  models: readonly CatalogModel[],
  onIdentityResolved?: () => void,
): CatalogContextWindowIndex {
  const byProvider = new Map<string, Map<string, number>>();
  for (const model of models) {
    const tokens = model.contextWindow;
    if (!model.providerId || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) continue;
    let ids = byProvider.get(model.providerId);
    if (!ids) { ids = new Map(); byProvider.set(model.providerId, ids); }
    // Duplicate entries are not extra votes. The smaller stated value is the
    // conservative deterministic choice for a contradictory duplicate row.
    ids.set(model.id, Math.min(ids.get(model.id) ?? tokens, tokens));
  }
  const byModelId = new Map<string, CatalogListing[]>();
  for (const [providerId, ids] of byProvider) {
    for (const [id, tokens] of ids) {
      const listings = byModelId.get(id) ?? [];
      listings.push({ providerId, tokens });
      byModelId.set(id, listings);
    }
  }
  const candidates = models.filter((model) => byModelId.has(model.id))
    .map((model) => ({ key: model.id, id: model.id, name: model.name, provider: model.providerId }));
  const identities = new ModelIdentityResolver({ universe: 'context-window-catalog', candidates: () => candidates });
  const pending = new Set<string>();
  return {
    byProvider,
    byModelId,
    resolveModelId(providerId, modelId) {
      if (byModelId.has(modelId)) return modelId;
      const query = { id: modelId, provider: providerId };
      const known = identities.known(query);
      if (known !== undefined) return known;
      const key = JSON.stringify([providerId, modelId]);
      if (!pending.has(key)) {
        pending.add(key);
        void identities.resolve(query, 'providers.context-window-catalog.identity')
          .then(() => { onIdentityResolved?.(); })
          .catch((error: unknown) => logger.warn('[context-window-catalog] Identity reading failed', { providerId, modelId, error: summarizeError(error) }))
          .finally(() => pending.delete(key));
      }
      return null;
    },
  };
}

/** Exact provider ID or a declared alias; spelling similarity is not identity. */
export function matchCatalogProviderId(
  providerId: string,
  index: CatalogContextWindowIndex,
  aliases: Readonly<Record<string, string>> = {},
): string | null {
  if (index.byProvider.has(providerId)) return providerId;
  const alias = aliases[providerId];
  return alias && index.byProvider.has(alias) ? alias : null;
}

function consensusOf(listings: readonly CatalogListing[]): { tokens: number; agreeing: number } | null {
  const counts = new Map<number, number>();
  for (const { tokens } of listings) counts.set(tokens, (counts.get(tokens) ?? 0) + 1);
  let best: { tokens: number; agreeing: number } | null = null;
  for (const [tokens, agreeing] of counts) {
    if (!best || agreeing > best.agreeing || (agreeing === best.agreeing && tokens < best.tokens)) best = { tokens, agreeing };
  }
  return best;
}

/** Own-provider evidence first; cross-provider consensus and family fallback are estimates. */
export function resolveCatalogContextWindow(
  providerId: string,
  modelId: string,
  index: CatalogContextWindowIndex,
  aliases: Readonly<Record<string, string>> = {},
): CatalogContextWindowResolution {
  const same = index.resolveModelId(providerId, modelId);
  const catalogProviderId = matchCatalogProviderId(providerId, index, aliases);
  if (same !== null && catalogProviderId) {
    const own = index.byProvider.get(catalogProviderId)?.get(same);
    if (own !== undefined) return { tokens: own, provenance: 'catalog', origin: { kind: 'catalog', catalogProviderId } };
  }
  const listings = same === null ? [] : index.byModelId.get(same) ?? [];
  const consensus = consensusOf(listings);
  if (consensus) return {
    tokens: consensus.tokens,
    provenance: 'catalog',
    origin: { kind: 'consensus', providers: listings.length, agreeing: consensus.agreeing },
  };
  return { tokens: knownFallbackContextWindow(providerId, modelId), provenance: 'fallback', origin: { kind: 'family_default' } };
}

/**
 * True when a base URL points at this machine or a private network: such an
 * endpoint is a local server whose own figure is kept.
 */
export function isLocalBaseUrl(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1' || host === '::') return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:127.');
  }
  return false;
}

/**
 * True when a model's window is not a real figure and it is not local: the
 * window is missing, is the old 8192 guess, or is itself only a guess. A
 * window the provider reported, a learned limit, and any local model keep
 * their own figure.
 */
export function needsCatalogContextWindow(model: ModelDefinition, isLocalProvider: boolean): boolean {
  if (isLocalProvider) return false;
  const provenance = model.contextWindowProvenance;
  if (provenance === 'provider_api' || provenance === 'observed_limit' || provenance === 'accepted_floor' || provenance === 'catalog' || model.contextWindowOrigin?.kind === 'user_override') return false;
  const window = model.contextWindow;
  if (!Number.isFinite(window) || window <= 0) return true;
  if (provenance === 'fallback') return true;
  // A catalog model (no provenance) states its catalog figure; only a
  // configured value equal to the old guess is replaced.
  return provenance === 'configured_cap' && window === LEGACY_GUESSED_CONTEXT_WINDOW;
}

/**
 * Apply the catalog resolution to one model when it needs it; returns the
 * model unchanged otherwise.
 */
export function applyCatalogContextWindow(
  model: ModelDefinition,
  isLocalProvider: boolean,
  index: CatalogContextWindowIndex,
  aliases: Readonly<Record<string, string>> = {},
): ModelDefinition {
  if (!needsCatalogContextWindow(model, isLocalProvider)) return model;
  const resolved = resolveCatalogContextWindow(model.provider, model.id, index, aliases);
  return {
    ...model,
    contextWindow: resolved.tokens,
    contextWindowProvenance: resolved.provenance,
    contextWindowOrigin: resolved.origin,
  };
}

/**
 * A short label naming where a model's window came from, for /context window
 * and /status: 'catalog: abacus', 'consensus of 4 providers', 'family
 * default', 'user override', and so on.
 */
export function describeContextWindowSource(model: ModelDefinition): string {
  const origin = model.contextWindowOrigin;
  switch (model.contextWindowProvenance) {
    case 'configured_cap':
      if (origin?.kind === 'user_override') return 'user override';
      if (origin?.kind === 'provider_file') return 'provider file';
      return 'configured';
    case 'provider_api':
      return 'reported by the provider';
    case 'observed_limit':
      return 'learned from a provider rejection';
    case 'accepted_floor':
      return 'the provider accepted a larger request than the stated window';
    case 'catalog':
      if (origin?.kind === 'catalog') return `catalog: ${origin.catalogProviderId}`;
      if (origin?.kind === 'consensus') {
        const noun = origin.providers === 1 ? 'provider' : 'providers';
        return origin.agreeing === origin.providers
          ? `estimate from ${origin.providers} ${noun}`
          : `estimate from ${origin.providers} ${noun} (${origin.agreeing} agree)`;
      }
      return 'model catalog';
    case 'fallback':
      return origin?.kind === 'family_default' ? 'family default (estimate)' : 'default (nothing states it)';
    default:
      return 'model catalog';
  }
}

/**
 * The registry's holder for the catalog step: keeps the lookup tables for
 * the current catalog snapshot and the names of local custom providers, and
 * applies the resolution to each model the registry lists.
 */
export class CatalogContextWindowResolver {
  private indexed: { models: readonly CatalogModel[]; index: CatalogContextWindowIndex } | null = null;
  private localCustomProviders: ReadonlySet<string> = new Set();

  constructor(
    private readonly catalogModels: () => readonly CatalogModel[],
    /** True for a discovered local server. */
    private readonly isDiscovered: (providerName: string) => boolean,
    /** The registered provider, read for a `baseURL` field when it has one. */
    private readonly getProvider: (providerName: string) => object | undefined,
    private readonly aliases: Readonly<Record<string, string>> = {},
    private readonly onIdentityResolved?: (() => void) | undefined,
  ) {}

  /** Record which custom providers sit at a local or private address. */
  setCustomProviders(configs: ReadonlyArray<{ readonly name: string; readonly baseURL: string }>): void {
    this.localCustomProviders = new Set(configs.filter((config) => isLocalBaseUrl(config.baseURL)).map((config) => config.name));
  }

  /** A discovered server, a custom provider at a local address, or any provider registered with a local base URL. */
  isLocalProvider(providerName: string): boolean {
    if (this.localCustomProviders.has(providerName) || this.isDiscovered(providerName)) return true;
    const provider = this.getProvider(providerName);
    const baseURL = provider && 'baseURL' in provider ? provider.baseURL : undefined;
    return typeof baseURL === 'string' && isLocalBaseUrl(baseURL);
  }

  private index(): CatalogContextWindowIndex {
    const models = this.catalogModels();
    if (this.indexed?.models !== models) this.indexed = { models, index: buildCatalogContextWindowIndex(models, this.onIdentityResolved) };
    return this.indexed.index;
  }

  apply(model: ModelDefinition): ModelDefinition {
    if (!needsCatalogContextWindow(model, this.isLocalProvider(model.provider))) return model;
    return applyCatalogContextWindow(model, false, this.index(), this.aliases);
  }
}
