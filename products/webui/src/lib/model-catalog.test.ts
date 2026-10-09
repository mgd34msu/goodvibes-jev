import { describe, expect, test } from 'bun:test';
import {
  buildTargetEnableEntry,
  buildTargetWriteEntries,
  configuredProviderIdsFromProvidersResponse,
  detectFamily,
  filterModels,
  groupModels,
  hasAnyCapabilityData,
  hasAnyQualityTierData,
  hasAnyTierData,
  modelsFromProvidersResponse,
  providerIdsFromProvidersResponse,
  readTargetRouting,
  tierToCategoryFilter,
  type CatalogModel,
} from './model-catalog';

const PROVIDERS_RESPONSE = {
  providers: [
    {
      providerId: 'anthropic',
      active: true,
      configured: true,
      models: [
        { id: 'claude-opus-4', registryKey: 'anthropic:claude-opus-4', displayName: 'Claude Opus 4', contextWindow: 200000, tier: 'premium', pricing: { inputPerMillionTokens: 15, outputPerMillionTokens: 75, currency: 'USD' } },
        { id: 'claude-haiku', registryKey: 'anthropic:claude-haiku', displayName: 'Claude Haiku', contextWindow: 200000, tier: 'free' },
      ],
    },
    {
      providerId: 'openai',
      active: true,
      runtime: { auth: { configured: true } },
      models: [
        { id: 'gpt-5', registryKey: 'openai:gpt-5', displayName: 'GPT-5', contextWindow: 400000, tier: 'subscription' },
      ],
    },
    {
      providerId: 'mistral',
      active: false,
      configured: false,
      models: [
        { id: 'mistral-large', registryKey: 'mistral:mistral-large', displayName: 'Mistral Large', contextWindow: 128000 },
      ],
    },
  ],
};

describe('modelsFromProvidersResponse: reads tier/pricing from providers.list, not models.list', () => {
  test('flattens every provider\'s models with real tier/pricing when present', () => {
    const models = modelsFromProvidersResponse(PROVIDERS_RESPONSE);
    expect(models).toHaveLength(4);
    const opus = models.find((m) => m.id === 'claude-opus-4');
    expect(opus?.tier).toBe('premium');
    expect(opus?.pricing).toEqual({ inputPerMillionTokens: 15, outputPerMillionTokens: 75, currency: 'USD' });
    const mistral = models.find((m) => m.id === 'mistral-large');
    expect(mistral?.tier).toBeUndefined();
    expect(mistral?.pricing).toBeUndefined();
  });

  test('dedupes by registryKey', () => {
    const dup = { providers: [PROVIDERS_RESPONSE.providers[0], PROVIDERS_RESPONSE.providers[0]] };
    expect(modelsFromProvidersResponse(dup)).toHaveLength(2);
  });

  test('empty/malformed input yields an empty array, never throws', () => {
    expect(modelsFromProvidersResponse(undefined)).toEqual([]);
    expect(modelsFromProvidersResponse({})).toEqual([]);
    expect(modelsFromProvidersResponse(null)).toEqual([]);
  });
});

describe('providerIdsFromProvidersResponse / configuredProviderIdsFromProvidersResponse', () => {
  test('lists distinct provider ids in order', () => {
    expect(providerIdsFromProvidersResponse(PROVIDERS_RESPONSE)).toEqual(['anthropic', 'openai', 'mistral']);
  });

  test('configured set reads both top-level `configured` and nested runtime.auth.configured', () => {
    const configured = configuredProviderIdsFromProvidersResponse(PROVIDERS_RESPONSE);
    expect(configured.has('anthropic')).toBe(true);
    expect(configured.has('openai')).toBe(true); // via runtime.auth.configured
    expect(configured.has('mistral')).toBe(false);
  });
});

describe('detectFamily: consumes the exact server projection without guessing', () => {
  test('old servers and invalid family values stay ungrouped, even for familiar names', () => {
    for (const family of [undefined, null, 'claude', 'Invented', 42]) {
      const models = modelsFromProvidersResponse({ providerId: 'anthropic', models: [
        { id: 'claude-opus-4', displayName: 'Claude Opus 4', family },
      ] });
      expect(detectFamily(models[0]!)).toBeUndefined();
      expect(groupModels(models, 'family')[0]?.key).toBe('Ungrouped');
    }
  });

  test('settled Other is distinct from absent readings and refreshed catalogs do not retain old families', () => {
    const response = (family?: string) => ({ providerId: 'local', models: [
      { id: 'commandline-helper', displayName: 'Commandline Helper', family },
    ] });
    const settled = modelsFromProvidersResponse(response('Other'));
    expect(detectFamily(settled[0]!)).toBe('Other');
    expect(groupModels(settled, 'family')[0]?.key).toBe('Other');
    const replaced = modelsFromProvidersResponse(response());
    expect(detectFamily(replaced[0]!)).toBeUndefined();
    expect(groupModels(replaced, 'family')[0]?.key).toBe('Ungrouped');
  });

  test('groups by authoritative values even when model names suggest a different family', () => {
    const models = modelsFromProvidersResponse({ providerId: 'gateway', models: [
      { id: 'gpt-alias', displayName: 'Alias', family: 'Llama' },
      { id: 'opaque', displayName: 'Opaque', family: 'Claude' },
    ] });
    expect(groupModels(models, 'family').map((group) => group.key)).toEqual(['Llama', 'Claude']);
  });
});

describe('tierToCategoryFilter: matches the TUI\'s tierToCategoryFilter mapping', () => {
  test('free and subscription pass through; standard/premium/anything else configured is paid', () => {
    expect(tierToCategoryFilter('free')).toBe('free');
    expect(tierToCategoryFilter('subscription')).toBe('subscription');
    expect(tierToCategoryFilter('premium')).toBe('paid');
    expect(tierToCategoryFilter('standard')).toBe('paid');
  });

  test('an absent tier is undefined, never guessed as a category', () => {
    expect(tierToCategoryFilter(undefined)).toBeUndefined();
  });
});

describe('hasAnyTierData / hasAnyCapabilityData / hasAnyQualityTierData, honest forward-compat detection', () => {
  const models = modelsFromProvidersResponse(PROVIDERS_RESPONSE);

  test('tier data is genuinely present in this fixture', () => {
    expect(hasAnyTierData(models)).toBe(true);
  });

  test('capability and quality-tier data are never fabricated, always false today (no wire source exists)', () => {
    expect(hasAnyCapabilityData(models)).toBe(false);
    expect(hasAnyQualityTierData(models)).toBe(false);
  });

  test('tier data is absent when no model carries one', () => {
    const noTier = modelsFromProvidersResponse({ providers: [PROVIDERS_RESPONSE.providers[2]] });
    expect(hasAnyTierData(noTier)).toBe(false);
  });
});

describe('filterModels', () => {
  const models = modelsFromProvidersResponse(PROVIDERS_RESPONSE);

  test('query filters by label/registryKey substring, case-insensitively', () => {
    const filtered = filterModels(models, { query: 'opus' });
    expect(filtered.map((m) => m.id)).toEqual(['claude-opus-4']);
  });

  test('provider filter narrows to one provider', () => {
    const filtered = filterModels(models, { provider: 'anthropic' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  test('category filter uses the real tier data, excluding models with no tier at all', () => {
    const free = filterModels(models, { categoryFilter: 'free' });
    expect(free.map((m) => m.id)).toEqual(['claude-haiku']);
    const paid = filterModels(models, { categoryFilter: 'paid' });
    expect(paid.map((m) => m.id)).toEqual(['claude-opus-4']);
  });

  test('availableOnly excludes models whose provider is not configured', () => {
    const configuredIds = configuredProviderIdsFromProvidersResponse(PROVIDERS_RESPONSE);
    const filtered = filterModels(models, { availableOnly: true, configuredProviderIds: configuredIds });
    expect(filtered.some((m) => m.provider === 'mistral')).toBe(false);
  });
});

describe('groupModels', () => {
  const models = modelsFromProvidersResponse(PROVIDERS_RESPONSE);

  test('groups by provider', () => {
    const groups = groupModels(models, 'provider');
    expect(groups.map((g) => g.key)).toEqual(['anthropic', 'openai', 'mistral']);
  });

  test('groups by real pricing tier, with an honest "unreported" bucket for models with no tier', () => {
    const groups = groupModels(models, 'pricingTier');
    const unreported = groups.find((g) => g.key === 'unreported');
    expect(unreported?.models.map((m) => m.id)).toEqual(['mistral-large']);
  });
});

describe('readTargetRouting / buildTargetWriteEntries / buildTargetEnableEntry, target routing mirrors the TUI\'s model-picker-types.ts mapping exactly', () => {
  test('main reads from currentModel, not config, and has no enable entry (it is not a config key)', () => {
    const routing = readTargetRouting('main', {}, { provider: 'anthropic', id: 'claude-opus-4', registryKey: 'anthropic:claude-opus-4' });
    expect(routing.provider).toBe('anthropic');
    expect(routing.model).toBe('claude-opus-4');
    expect(routing.unset).toBe(false);
    expect(buildTargetWriteEntries('main', 'anthropic', 'claude-opus-4')).toBeNull();
    expect(buildTargetEnableEntry('main', true)).toBeNull();
  });

  test('helper reads helper.globalProvider/globalModel/enabled and writes all three on select', () => {
    const config = { helper: { enabled: true, globalProvider: 'openai', globalModel: 'gpt-5' } };
    const routing = readTargetRouting('helper', config, null);
    expect(routing).toMatchObject({ provider: 'openai', model: 'gpt-5', enabled: true, unset: false });
    expect(buildTargetWriteEntries('helper', 'anthropic', 'claude-haiku')).toEqual([
      ['helper.globalProvider', 'anthropic'],
      ['helper.globalModel', 'claude-haiku'],
      ['helper.enabled', true],
    ]);
    expect(buildTargetEnableEntry('helper', false)).toEqual(['helper.enabled', false]);
  });

  test('tool reads tools.llmProvider/llmModel/llmEnabled and writes all three, with a configuredNote when enabled but no model', () => {
    const routing = readTargetRouting('tool', { tools: { llmEnabled: true, llmProvider: '', llmModel: '' } }, null);
    expect(routing.enabled).toBe(true);
    expect(routing.unset).toBe(true);
    expect(routing.configuredNote).toBeTruthy();
    expect(buildTargetWriteEntries('tool', 'openai', 'gpt-5')).toEqual([
      ['tools.llmProvider', 'openai'],
      ['tools.llmModel', 'gpt-5'],
      ['tools.llmEnabled', true],
    ]);
  });

  test('tts reads tts.llmProvider/llmModel (not tts.provider/voice/speed; VOICE-WEBUI\'s domain) and has no enable flag', () => {
    const routing = readTargetRouting('tts', { tts: { provider: 'elevenlabs', voice: 'x', llmProvider: '', llmModel: '' } }, null);
    expect(routing.unset).toBe(true);
    expect(routing.configuredNote).toBeTruthy();
    expect(buildTargetEnableEntry('tts', true)).toBeNull();
    expect(buildTargetWriteEntries('tts', 'anthropic', 'claude-haiku')).toEqual([
      ['tts.llmProvider', 'anthropic'],
      ['tts.llmModel', 'claude-haiku'],
    ]);
  });

  test('embeddings has no model concept: reads provider.embeddingProvider only, writes one key, never unset', () => {
    const routing = readTargetRouting('embeddings', { provider: { embeddingProvider: 'hashed-local' } }, null);
    expect(routing.provider).toBe('hashed-local');
    expect(routing.model).toBe('');
    expect(routing.unset).toBe(false);
    expect(routing.configuredNote).toBeTruthy();
    expect(buildTargetWriteEntries('embeddings', 'openai-embeddings', '')).toEqual([
      ['provider.embeddingProvider', 'openai-embeddings'],
    ]);
    expect(buildTargetEnableEntry('embeddings', true)).toBeNull();
  });

  test('embeddings falls back to the schema default when config has no embeddingProvider key', () => {
    const routing = readTargetRouting('embeddings', {}, null);
    expect(routing.provider).toBe('hashed-local');
  });
});
