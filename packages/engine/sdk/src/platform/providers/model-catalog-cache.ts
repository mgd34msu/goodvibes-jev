import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { CatalogModel } from './model-catalog.js';
import { summarizeError } from '../utils/error-display.js';
import { isTtlCacheStale, validateTtlCacheEnvelope } from './json-ttl-cache.js';
import { fetchModelCatalogRepository } from './model-catalog-repository.js';
import type { ModelsDevReasoningOption } from './reasoning-effort.js';
import { ProviderAccessReadings, type ProviderAccess, type ProviderFacts } from '../routing/catalog-access.js';

interface CatalogProviderShape {
  id: string;
  name: string;
  env?: string[] | undefined;
  api?: string | undefined;
  doc?: string | undefined;
  models?: Record<string, ModelsDevModel> | undefined;
}

interface CatalogCacheFile {
  version: typeof CATALOG_CACHE_VERSION;
  fetchedAt: number;
  ttlMs: number;
  models: CatalogModel[];
}

interface ModelsDevModelCost {
  input?: number | undefined;
  output?: number | undefined;
  cache_read?: number | undefined;
  cache_write?: number | undefined;
}

interface ModelsDevModelLimit {
  context?: number | undefined;
  output?: number | undefined;
}

interface ModelsDevModel {
  id?: string | undefined;
  canonical_model_id?: string | undefined;
  type?: string | undefined;
  name?: string | undefined;
  family?: string | undefined;
  cost?: ModelsDevModelCost | undefined;
  limit?: ModelsDevModelLimit | undefined;
  reasoning?: boolean | undefined;
  reasoning_options?: ModelsDevReasoningOption[] | undefined;
  tool_call?: boolean | undefined;
  structured_output?: boolean | undefined;
  open_weights?: boolean | undefined;
  modalities?: { input?: string[] | undefined; output?: string[] | undefined } | undefined;
}

type ModelsDevResponse = Record<string, CatalogProviderShape>;

const CATALOG_TTL_MS = 60 * 60 * 1000;
/** Repository-backed cache with canonical identities, model types and capability facts. */
const CATALOG_CACHE_VERSION = 6;

export function getCatalogCachePath(cacheDir: string): string {
  return join(cacheDir, 'model-catalog.json');
}

/** Where the provider access readings are remembered, beside the catalog cache. */
export function getProviderAccessPath(cacheDir: string): string {
  return join(cacheDir, 'provider-access.json');
}

export function getCatalogTmpPath(cacheDir: string): string {
  return `${getCatalogCachePath(cacheDir)}.tmp`;
}

/**
 * The catalog tier of one model from its provider's access reading
 * (routing.catalog-provider-access) and its listed cost: a plan or a local
 * server is not metered ('subscription': the listed per-token price is not
 * what the user pays), a metered model listed at zero input and output cost
 * is free, and everything else, including a provider whose access reading
 * did not settle, is paid. The zero test is arithmetic; the access is judged.
 */
function catalogTier(access: ProviderAccess | undefined, cost: ModelsDevModelCost | undefined): 'free' | 'paid' | 'subscription' {
  if (access === 'subscription' || access === 'local') return 'subscription';
  if (access === 'metered' && cost?.input === 0 && cost?.output === 0) return 'free';
  return 'paid';
}

/** How many model names a provider's access reading sees for context. */
const ACCESS_SAMPLE_MODELS = 5;

/** The published facts the access reading needs, for every well-formed provider in the feed. */
function providerFactsOf(json: ModelsDevResponse): ProviderFacts[] {
  const facts: ProviderFacts[] = [];
  for (const [providerId, providerData] of Object.entries(json)) {
    if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) continue;
    const models = providerData.models && typeof providerData.models === 'object' && !Array.isArray(providerData.models) ? Object.entries(providerData.models) : [];
    facts.push({
      id: providerId,
      name: typeof providerData.name === 'string' && providerData.name.trim() ? providerData.name : providerId,
      ...(typeof providerData.api === 'string' ? { api: providerData.api } : {}),
      ...(typeof providerData.doc === 'string' ? { doc: providerData.doc } : {}),
      envVars: getStringArray(providerData.env),
      sampleModels: models.slice(0, ACCESS_SAMPLE_MODELS).map(([key, model]) => (typeof model?.name === 'string' ? model.name : key)),
    });
  }
  return facts;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Sanitize the feed's `reasoning_options` array.
 *
 * Returns undefined when the field is absent, "the catalog says nothing",
 * which falls through to the curated family table. An empty array is kept as
 * an empty array, because the feed uses it to say something different and
 * specific: this model reasons but exposes no configurable levels.
 */
function getReasoningOptions(value: unknown): ModelsDevReasoningOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: ModelsDevReasoningOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = record['type'];
    if (typeof type !== 'string' || !type) continue;
    const values = record['values'];
    const min = record['min'];
    const max = record['max'];
    options.push({
      type,
      ...(Array.isArray(values) ? { values: getStringArray(values) } : {}),
      ...(typeof min === 'number' ? { min } : {}),
      ...(typeof max === 'number' ? { max } : {}),
    });
  }
  return options;
}

function transformModelsDevResponse(input: unknown, access: ReadonlyMap<string, ProviderAccess | undefined>): CatalogModel[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Model catalog root is not a provider map');
  const json = input as ModelsDevResponse;
  const models: CatalogModel[] = [];
  let skippedProviders = 0;
  let skippedProviderModelLists = 0;
  let skippedModels = 0;

  for (const [providerId, providerData] of Object.entries(json)) {
    if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) {
      skippedProviders++;
      continue;
    }

    const providerAccess = access.get(providerId);
    const providerName = typeof providerData.name === 'string' && providerData.name.trim()
      ? providerData.name
      : providerId;
    const providerModels = providerData.models;
    if (!providerModels || typeof providerModels !== 'object' || Array.isArray(providerModels)) {
      skippedProviderModelLists++;
      continue;
    }

    for (const [modelKey, modelData] of Object.entries(providerModels)) {
      if (!modelData || typeof modelData !== 'object' || Array.isArray(modelData)) {
        skippedModels++;
        continue;
      }

      const modelId = typeof modelData.id === 'string' && modelData.id.trim() ? modelData.id : modelKey;
      const modelName = typeof modelData.name === 'string' && modelData.name.trim() ? modelData.name : modelId;
      const modelFamily = typeof modelData.family === 'string' ? modelData.family : undefined;
      const cost = modelData.cost;
      const limit = modelData.limit;
      const reasoningOptions = getReasoningOptions(modelData.reasoning_options);
      // The feed's own answer to what this model accepts as input. Undefined
      // when the entry carried no modality block, which is distinct from an
      // entry that carried one listing text only.
      const inputModalities = Array.isArray(modelData.modalities?.input)
        ? getStringArray(modelData.modalities.input)
        : undefined;

      // Honest pricing: a missing cost stays null (unpriced). Coercing to $0
      // made absent-from-catalog models look free downstream.
      const pricing = typeof cost?.input === 'number' && typeof cost?.output === 'number'
        ? {
          input: cost.input,
          output: cost.output,
          ...(typeof cost.cache_read === 'number' ? { cacheRead: cost.cache_read } : {}),
          ...(typeof cost.cache_write === 'number' ? { cacheWrite: cost.cache_write } : {}),
        }
        : null;
      const contextWindow = typeof limit?.context === 'number' && limit.context > 0 ? limit.context : undefined;

      const tier = catalogTier(providerAccess, cost);

      const maxOutputTokens = typeof limit?.output === 'number' ? limit.output : undefined;

      models.push({
        id: modelId,
        modelType: typeof modelData.type === 'string' ? modelData.type : 'chat',
        ...(typeof modelData.tool_call === 'boolean' ? { toolCalling: modelData.tool_call } : {}),
        ...(Array.isArray(modelData.modalities?.output) ? { outputModalities: getStringArray(modelData.modalities.output) } : {}),
        ...(typeof modelData.canonical_model_id === 'string' && modelData.canonical_model_id.trim()
          ? { canonicalModelId: modelData.canonical_model_id } : {}),
        name: modelName,
        ...(modelFamily ? { family: modelFamily } : {}),
        provider: providerName,
        providerId,
        providerEnvVars: getStringArray(providerData.env),
        pricing,
        tier,
        contextWindow,
        maxOutputTokens,
        ...(typeof modelData.reasoning === 'boolean' ? { reasoning: modelData.reasoning } : {}),
        ...(reasoningOptions !== undefined ? { reasoningOptions } : {}),
        ...(inputModalities !== undefined ? { inputModalities } : {}),
      });
    }
  }

  if (skippedProviders > 0 || skippedProviderModelLists > 0 || skippedModels > 0) {
    logger.warn('[model-catalog] Ignored malformed catalog entries', {
      skippedProviders,
      skippedProviderModelLists,
      skippedModels,
    });
  }

  return models;
}

function validateCatalogCache(value: unknown): { cache: CatalogCacheFile | null; reason?: string } {
  const current = validateTtlCacheEnvelope<CatalogCacheFile>(value, 'models', 'array', CATALOG_CACHE_VERSION);
  if (current.cache) return current;
  const legacy = validateTtlCacheEnvelope<CatalogCacheFile>(value, 'models', 'array', 5);
  // Keep the previous catalog usable offline, while requesting repository metadata now.
  return legacy.cache ? { cache: { ...legacy.cache, version: CATALOG_CACHE_VERSION, ttlMs: 0 } } : current;
}

function loadCatalogCache(cachePath: string): CatalogCacheFile | null {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const { cache, reason } = validateCatalogCache(parsed);
    if (!cache) {
      logger.warn('[model-catalog] Ignoring malformed cache', { cachePath, reason: reason ?? 'unknown' });
      return null;
    }
    return cache;
  } catch (err) {
    const msg = summarizeError(err);
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      logger.debug('[model-catalog] No cache file (first run)');
    } else {
      logger.warn('[model-catalog] Cache load failed', { error: msg });
    }
    return null;
  }
}

function saveCatalogCache(models: CatalogModel[], cachePath: string, tmpPath: string): void {
  try {
    fs.mkdirSync(dirname(cachePath), { recursive: true });
    const payload: CatalogCacheFile = {
      version: CATALOG_CACHE_VERSION,
      fetchedAt: Date.now(),
      ttlMs: CATALOG_TTL_MS,
      models,
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, cachePath);
  } catch (err) {
    logger.warn('[model-catalog] Cache write failed', { error: summarizeError(err) });
  }
}

function isCatalogCacheStale(cache: CatalogCacheFile): boolean {
  return cache.ttlMs <= 0 || isTtlCacheStale(cache);
}

/**
 * Read the models.dev GitHub repository and normalize its records, reading each
 * provider's access (remembered in `accessPath` when given) before the tiers
 * are set. Uses a 30-second timeout for the fetch.
 */
export async function fetchCatalog(options: { readonly accessPath?: string | undefined } = {}): Promise<CatalogModel[]> {
  const json = await fetchModelCatalogRepository() as unknown as ModelsDevResponse;
  const access = await new ProviderAccessReadings({ path: options.accessPath }).readAll(providerFactsOf(json));
  const models = transformModelsDevResponse(json, access);
  logger.debug('[model-catalog] Loaded models from the models.dev GitHub repository', { count: models.length });
  return models;
}

export {
  transformModelsDevResponse,
  loadCatalogCache,
  saveCatalogCache,
  isCatalogCacheStale,
};
