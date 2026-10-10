import { modelFamilyReadings, type ModelFamily } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';

export type PickerMode = 'model' | 'provider' | 'effort' | 'contextCap' | 'embeddingProvider';

/**
 * Which config keys the model picker writes to on commit.
 * 'main'       -> provider.provider + provider.model (default)
 * 'helper'     -> helper.globalProvider + helper.globalModel (+ helper.enabled: true)
 * 'tool'       -> tools.llmProvider + tools.llmModel (+ tools.llmEnabled: true)
 * 'tts'        -> tts.llmProvider + tts.llmModel
 * 'embeddings' -> provider.embeddingProvider, via MemoryEmbeddingProviderRegistry.setDefaultProvider()
 *                 (not an LLM route, no model concept, see ModelPickerTargetInfo.configuredNote)
 */
export type ModelPickerTarget = 'main' | 'helper' | 'tool' | 'tts' | 'embeddings';

export type ModelPickerFocusRegion = 'targets' | 'items';

export interface ModelPickerTargetInfo {
  readonly target: ModelPickerTarget;
  readonly label: string;
  readonly description: string;
  readonly provider: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly inherited: boolean;
  /**
   * Honest override for the "Current:" summary line. Used by the 'embeddings'
   * target (which has no model concept, only a provider id + dimensions +
   * configured state) so the renderer never prints a phantom "model:" value.
   * When set, this replaces the computed provider:model route text.
   */
  readonly configuredNote?: string;
}

/** One entry in the embedding-provider picker list (PickerMode 'embeddingProvider'). */
export interface EmbeddingProviderPickerEntry {
  readonly id: string;
  readonly label: string;
  readonly dimensions: number;
  readonly configured: boolean;
  readonly detail?: string;
}

/**
 * Pricing tier filter.
 * 'paid' matches ModelDefinition tiers 'standard' and 'premium' for forward-compat
 * with future CatalogModel tiers ('free' | 'paid' | 'subscription').
 */
export type CategoryFilter = 'all' | 'free' | 'paid' | 'subscription';

export type { ModelFamily };

export type CapabilityFilter = 'reasoning' | 'toolUse' | 'multimodal' | 'none';
export type BenchmarkSort = 'none' | 'composite' | 'swe' | 'gpqa';
export type GroupByMode = 'provider' | 'family' | 'pricingTier' | 'qualityTier';

/** Render only the canonical settled family for this exact catalog evidence. */
export function detectFamily(model: ModelDefinition): ModelFamily | undefined {
  return modelFamilyReadings.known(model);
}

export function tierToCategoryFilter(tier: string | undefined): CategoryFilter {
  if (tier === 'free') return 'free';
  if (tier === 'subscription') return 'subscription';
  return 'paid';
}

export interface PickerItem {
  id: string;
  label: string;
  detail?: string;
  isGroupHeader?: boolean;
  qualityTier?: string;
  isPinned?: boolean;
  isFree?: boolean;
  isConfigured?: boolean;
  configuredVia?: 'env' | 'secrets' | 'subscription' | 'anonymous';
}

export const POPULAR_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'google',
  'groq',
  'mistral',
  'nvidia',
  'ollama',
  'openai',
  'openrouter',
  'synthetic',
]);

export interface FilteredModelsCache {
  readonly modelsRef: ModelDefinition[];
  readonly configuredProvidersKey: string;
  readonly pinnedIdsKey: string;
  readonly recentIdsKey: string;
  readonly query: string;
  readonly categoryFilter: CategoryFilter;
  readonly capabilityFilter: CapabilityFilter;
  readonly availableOnly: boolean;
  readonly benchmarkSort: BenchmarkSort;
  readonly groupBy: GroupByMode;
  readonly result: ModelDefinition[];
}

export interface FilteredProvidersCache {
  readonly providersRef: string[];
  readonly query: string;
  readonly result: string[];
}

export interface ModelItemsCache {
  readonly filteredModelsRef: ModelDefinition[];
  readonly pinnedIdsKey: string;
  readonly groupBy: GroupByMode;
  readonly result: PickerItem[];
}

export interface ProviderItemsCache {
  readonly filteredProvidersRef: string[];
  readonly configuredProvidersKey: string;
  readonly configuredViaKey: string;
  readonly result: PickerItem[];
}
