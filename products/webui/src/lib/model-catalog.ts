/**
 * model-catalog.ts, multi-target model routing over the real wire shapes.
 *
 * GROUNDED (verified against goodvibes-sdk source, not guessed):
 *   - The "current model" concept (models.current.get/models.current.set, PATCH
 *     /api/models/current) is a SINGLE global slot, there is no multi-target
 *     verb on the wire. Multi-target routing (main/helper/tool/tts/embeddings)
 *     is implemented via separate shared config keys, read/written through
 *     config.get/config.set (packages/sdk/src/platform/config/schema-domain-core.ts):
 *       main       -> models.current.set (PATCH /api/models/current), NOT config.set;
 *                     this is the only target with a dedicated wire verb, and it
 *                     validates the provider is configured server-side. Routing
 *                     the main target through config.set('provider.model', ...)
 *                     directly would skip that validation and never update the
 *                     provider registry's live current-model state, genuinely
 *                     wrong, not just inconsistent.
 *       helper     -> helper.globalProvider + helper.globalModel (+ helper.enabled)
 *       tool       -> tools.llmProvider + tools.llmModel (+ tools.llmEnabled)
 *       tts        -> tts.llmProvider + tts.llmModel (LLM route for spoken-output
 *                     turns, distinct from tts.provider/voice/speed, the AUDIO
 *                     synthesis settings VOICE-WEBUI's voice-config surface owns)
 *       embeddings -> provider.embeddingProvider (a provider id only, embeddings
 *                     have no model concept on this wire)
 *     Target labels below ("Main Chat", "Helper Model", "Tool LLM", "TTS LLM",
 *     "Embeddings") match the TUI's model-workspace.ts targetLabelFor() exactly,
 *     for cross-surface naming parity.
 *
 *   - Model catalog pricing: GET /api/providers (providers.list/providers.get)
 *     genuinely populates `tier` and `pricing` {inputPerMillionTokens,
 *     outputPerMillionTokens, currency} per model when the provider registry's
 *     pricing catalog has the data (packages/sdk/src/platform/providers/
 *     runtime-snapshot.ts toModelSnapshot()), this is real, live wire data.
 *     GET /api/models (models.list) does NOT carry tier/pricing at all
 *     (packages/sdk/src/platform/daemon/http/model-routes.ts's
 *     ProviderModelEntry projects only id/registryKey/provider/label/
 *     contextWindow), so this module reads models from the providers.list/get
 *     response, not the models.list catalog, specifically to get honest price
 *     data.
 *
 *   - Capability flags (reasoning/toolCalling/multimodal) and a "quality tier"
 *     / benchmark score exist server-side on ModelDefinition/benchmarkStore but
 *     are NOT projected onto any HTTP response this client can reach (confirmed:
 *     zero occurrences of `capabilities`/`qualityTier`/`benchmark` in the
 *     operator contract or the model/provider routes). The Capability filter
 *     and the qualityTier group-by are kept in the type vocabulary below for
 *     naming parity with the TUI's model picker, but hasAnyCapabilityData /
 *     hasAnyQualityTierData let a caller detect there is really nothing to
 *     filter/group by today and render an honest disabled state instead of a
 *     control that silently filters nothing, the same forward-compat honesty
 *     ruling provider-status.ts's FRESHNESS_RANK comment documents (a future
 *     daemon adding this data should "just work" without a code change here).
 */
import { asRecord, firstArrayAtPath, firstString, readPath } from './object';

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type ModelTarget = 'main' | 'helper' | 'tool' | 'tts' | 'embeddings';

export const MODEL_TARGETS: readonly ModelTarget[] = ['main', 'helper', 'tool', 'tts', 'embeddings'];

/** Exact labels from the TUI's model-workspace.ts targetLabelFor(), naming parity. */
export const TARGET_LABELS: Record<ModelTarget, string> = {
  main: 'Main Chat',
  helper: 'Helper Model',
  tool: 'Tool LLM',
  tts: 'TTS LLM',
  embeddings: 'Embeddings',
};

/** True for the one target with no per-model concept, only a provider id. */
export function targetHasNoModelConcept(target: ModelTarget): boolean {
  return target === 'embeddings';
}

// ---------------------------------------------------------------------------
// Catalog model shape
// ---------------------------------------------------------------------------

export interface ModelPricing {
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
  readonly currency: string;
}

export interface CatalogModel {
  readonly id: string;
  readonly registryKey: string;
  readonly provider: string;
  readonly label: string;
  readonly contextWindow?: number;
  readonly family?: ModelFamily;
  readonly tier?: string;
  readonly pricing?: ModelPricing;
}

function readPricing(raw: unknown): ModelPricing | undefined {
  const record = asRecord(raw);
  const input = record.inputPerMillionTokens;
  const output = record.outputPerMillionTokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  return {
    inputPerMillionTokens: input,
    outputPerMillionTokens: output,
    currency: firstString(record, ['currency']) || 'USD',
  };
}

function normalizeCatalogModel(providerId: string, raw: unknown): CatalogModel | null {
  const record = asRecord(raw);
  const id = firstString(record, ['id', 'modelId']) || firstString(record, ['registryKey']).split(':').slice(1).join(':');
  const registryKey = firstString(record, ['registryKey']) || (id && providerId ? `${providerId}:${id}` : '');
  if (!registryKey || !id) return null;
  const contextWindowRaw = record.contextWindow;
  return {
    id,
    registryKey,
    provider: providerId,
    label: firstString(record, ['displayName', 'label', 'name']) || id,
    contextWindow: typeof contextWindowRaw === 'number' ? contextWindowRaw : undefined,
    family: readModelFamily(record.family),
    tier: firstString(record, ['tier']) || undefined,
    pricing: readPricing(record.pricing),
  };
}

/**
 * Read models from a providers.list()/providers.get() response, the source
 * that genuinely carries tier/pricing. Tolerant of both the list envelope
 * ({ providers: [...] }) and a single provider record.
 */
export function modelsFromProvidersResponse(value: unknown): CatalogModel[] {
  const providers = firstArrayAtPath(value, [['providers']]);
  const providerRecords = providers.length > 0 ? providers : [value];
  const models: CatalogModel[] = [];
  for (const providerRaw of providerRecords) {
    const providerId = firstString(providerRaw, ['providerId', 'id']);
    if (!providerId) continue;
    const modelList = firstArrayAtPath(providerRaw, [['models']]);
    for (const modelRaw of modelList) {
      const model = normalizeCatalogModel(providerId, modelRaw);
      if (model && !models.some((existing) => existing.registryKey === model.registryKey)) {
        models.push(model);
      }
    }
  }
  return models;
}

/** Distinct provider ids from a providers.list() response, in listed order. */
export function providerIdsFromProvidersResponse(value: unknown): string[] {
  const providers = firstArrayAtPath(value, [['providers']]);
  const ids: string[] = [];
  for (const providerRaw of providers) {
    const id = firstString(providerRaw, ['providerId', 'id']);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Provider ids whose `configured` (top-level or runtime.auth.configured) is true. */
export function configuredProviderIdsFromProvidersResponse(value: unknown): Set<string> {
  const providers = firstArrayAtPath(value, [['providers']]);
  const ids = new Set<string>();
  for (const providerRaw of providers) {
    const id = firstString(providerRaw, ['providerId', 'id']);
    if (!id) continue;
    const configured =
      asRecord(providerRaw).configured === true ||
      readPath(providerRaw, ['runtime', 'auth', 'configured']) === true;
    if (configured) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Family is a server-owned settled judgment. Old servers may omit it.
// ---------------------------------------------------------------------------

export type ModelFamily =
  | 'Claude'
  | 'GPT'
  | 'Gemini'
  | 'Llama'
  | 'Qwen'
  | 'GLM'
  | 'MiniMax'
  | 'DeepSeek'
  | 'Mistral'
  | 'Command'
  | 'Grok'
  | 'Kimi'
  | 'Other';

const MODEL_FAMILIES: ReadonlySet<string> = new Set<ModelFamily>([
  'Claude', 'GPT', 'Gemini', 'Llama', 'Qwen', 'GLM', 'MiniMax', 'DeepSeek',
  'Mistral', 'Command', 'Grok', 'Kimi', 'Other',
]);

function readModelFamily(value: unknown): ModelFamily | undefined {
  return typeof value === 'string' && MODEL_FAMILIES.has(value) ? value as ModelFamily : undefined;
}

export function detectFamily(model: CatalogModel): ModelFamily | undefined {
  return readModelFamily(model.family);
}

// ---------------------------------------------------------------------------
// Filters, TUI vocabulary (model-picker-types.ts). 'all'/'none' are always
// honest no-ops; the rest are backed by real per-model tier data (see the
// module doc comment for what is/isn't wire-served today).
// ---------------------------------------------------------------------------

export type CategoryFilter = 'all' | 'free' | 'paid' | 'subscription';
export type CapabilityFilter = 'reasoning' | 'toolUse' | 'multimodal' | 'none';
export type GroupByMode = 'provider' | 'family' | 'pricingTier' | 'qualityTier';

/** Matches the TUI's tierToCategoryFilter: 'free'/'subscription' pass through, anything else configured is 'paid'. */
export function tierToCategoryFilter(tier: string | undefined): CategoryFilter | undefined {
  if (!tier) return undefined;
  if (tier === 'free') return 'free';
  if (tier === 'subscription') return 'subscription';
  return 'paid';
}

/** True once the current dataset carries real tier data on at least one model. */
export function hasAnyTierData(models: readonly CatalogModel[]): boolean {
  return models.some((model) => Boolean(model.tier));
}

/** Always false today (see module doc comment), kept as a function, not a constant,
 *  so a future daemon that starts projecting capability flags is picked up without
 *  a code change at every call site once this is wired to real data. */
export function hasAnyCapabilityData(_models: readonly CatalogModel[]): boolean {
  return false;
}

/** Always false today, see hasAnyCapabilityData. */
export function hasAnyQualityTierData(_models: readonly CatalogModel[]): boolean {
  return false;
}

export interface ModelFilterOptions {
  readonly query?: string;
  readonly provider?: string;
  readonly categoryFilter?: CategoryFilter;
  readonly availableOnly?: boolean;
  readonly configuredProviderIds?: ReadonlySet<string>;
}

export function filterModels(models: readonly CatalogModel[], options: ModelFilterOptions): CatalogModel[] {
  const query = (options.query ?? '').trim().toLowerCase();
  const categoryFilter = options.categoryFilter ?? 'all';
  return models.filter((model) => {
    if (options.provider && model.provider !== options.provider) return false;
    if (query && !`${model.label} ${model.registryKey}`.toLowerCase().includes(query)) return false;
    if (categoryFilter !== 'all' && tierToCategoryFilter(model.tier) !== categoryFilter) return false;
    if (options.availableOnly && options.configuredProviderIds && !options.configuredProviderIds.has(model.provider)) {
      return false;
    }
    return true;
  });
}

export interface ModelGroup {
  readonly key: string;
  readonly label: string;
  readonly models: readonly CatalogModel[];
}

/** Groups honest for 'provider'/'family'/'pricingTier'; 'qualityTier' has no wire
 *  data (see hasAnyQualityTierData) so callers should disable that mode rather than
 *  call this with it, passed through here as a single "Ungrouped" bucket if it is. */
export function groupModels(models: readonly CatalogModel[], groupBy: GroupByMode): ModelGroup[] {
  const buckets = new Map<string, CatalogModel[]>();
  const order: string[] = [];
  const keyFor = (model: CatalogModel): string => {
    if (groupBy === 'provider') return model.provider;
    if (groupBy === 'family') return detectFamily(model) ?? 'Ungrouped';
    if (groupBy === 'pricingTier') return model.tier ?? 'unreported';
    return 'Ungrouped';
  };
  for (const model of models) {
    const key = keyFor(model);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)?.push(model);
  }
  return order.map((key) => ({
    key,
    label: key === 'unreported' ? 'Pricing tier unreported' : key,
    models: buckets.get(key) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Target routing, read the current selection for a target, and build the
// config.set entries a "Use" action should write.
// ---------------------------------------------------------------------------

export interface TargetRouting {
  readonly target: ModelTarget;
  readonly label: string;
  readonly enabled: boolean;
  /** True when this target has genuinely never been routed (empty provider+model). */
  readonly unset: boolean;
  readonly provider: string;
  readonly model: string;
  /** Honest note for targets with no model concept, or an empty-means-inherit key. */
  readonly configuredNote?: string;
}

/**
 * config, the flat config.get() object (config manager's getAll()). currentModel,
 * models.current.get()'s `model` field ({ registryKey, provider, id } | null), only used
 * for the 'main' target since it is not itself a config key.
 */
export function readTargetRouting(
  target: ModelTarget,
  config: unknown,
  currentModel: { registryKey?: string; provider?: string; id?: string } | null,
): TargetRouting {
  const label = TARGET_LABELS[target];
  if (target === 'main') {
    const provider = currentModel?.provider ?? '';
    const model = currentModel?.id ?? '';
    return { target, label, enabled: true, unset: !provider || !model, provider, model };
  }
  if (target === 'helper') {
    const provider = firstString(config, ['helper', 'globalProvider']) || firstString(readPath(config, ['helper']), ['globalProvider']);
    const model = firstString(readPath(config, ['helper']), ['globalModel']);
    const enabled = readPath(config, ['helper', 'enabled']) === true;
    return { target, label, enabled, unset: !provider || !model, provider, model };
  }
  if (target === 'tool') {
    const provider = firstString(readPath(config, ['tools']), ['llmProvider']);
    const model = firstString(readPath(config, ['tools']), ['llmModel']);
    const enabled = readPath(config, ['tools', 'llmEnabled']) === true;
    return {
      target,
      label,
      enabled,
      unset: !provider || !model,
      provider,
      model,
      configuredNote: !model && enabled ? 'Empty model uses the fastest available for the provider.' : undefined,
    };
  }
  if (target === 'tts') {
    const provider = firstString(readPath(config, ['tts']), ['llmProvider']);
    const model = firstString(readPath(config, ['tts']), ['llmModel']);
    return {
      target,
      label,
      enabled: true,
      unset: !provider || !model,
      provider,
      model,
      configuredNote: !provider || !model ? 'Empty uses the active chat provider/model for spoken-output turns.' : undefined,
    };
  }
  // embeddings, no model concept.
  const provider = firstString(readPath(config, ['provider']), ['embeddingProvider']) || 'hashed-local';
  return {
    target,
    label,
    enabled: true,
    unset: false,
    provider,
    model: '',
    configuredNote: 'Embedding provider only; this target has no model selection.',
  };
}

/** The config.set entries a "Use <model> for <target>" action should write. Returns
 *  null for 'main', which routes through models.current.set instead (see module doc). */
export function buildTargetWriteEntries(
  target: ModelTarget,
  providerId: string,
  modelId: string,
): readonly (readonly [string, unknown])[] | null {
  if (target === 'main') return null;
  if (target === 'helper') {
    return [
      ['helper.globalProvider', providerId],
      ['helper.globalModel', modelId],
      ['helper.enabled', true],
    ];
  }
  if (target === 'tool') {
    return [
      ['tools.llmProvider', providerId],
      ['tools.llmModel', modelId],
      ['tools.llmEnabled', true],
    ];
  }
  if (target === 'tts') {
    return [
      ['tts.llmProvider', providerId],
      ['tts.llmModel', modelId],
    ];
  }
  // embeddings, provider id only, no model.
  return [['provider.embeddingProvider', providerId]];
}

/** The single config.set entry that flips a target's enable flag, or null for
 *  targets with no enable flag ('main', 'tts', 'embeddings' are always-on). */
export function buildTargetEnableEntry(target: ModelTarget, enabled: boolean): readonly [string, unknown] | null {
  if (target === 'helper') return ['helper.enabled', enabled];
  if (target === 'tool') return ['tools.llmEnabled', enabled];
  return null;
}
