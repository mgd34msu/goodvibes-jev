import { modelFamilyReadings, type ModelFamily } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
export { POPULAR_PROVIDERS } from '@goodvibes-jev/engine/terminal-shell';

export type PickerMode = 'model' | 'provider' | 'effort' | 'contextCap';

/**
 * Which config keys the model picker writes to on commit.
 * 'main'   -> provider.provider + provider.model (default)
 * 'helper' -> helper.globalProvider + helper.globalModel (+ helper.enabled: true)
 * 'tool'   -> tools.llmProvider + tools.llmModel (+ tools.llmEnabled: true)
 * 'tts'    -> tts.llmProvider + tts.llmModel
 */
export type ModelPickerTarget = 'main' | 'helper' | 'tool' | 'tts';

export type ModelPickerFocusPane = 'targets' | 'items';

export interface ModelPickerTargetInfo {
  readonly target: ModelPickerTarget;
  readonly label: string;
  readonly description: string;
  readonly provider: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly inherited: boolean;
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
