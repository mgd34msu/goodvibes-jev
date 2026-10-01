import { describe, expect, test } from 'bun:test';
import {
  reasoningOptionsForModel,
  sortProvidersConfiguredFirst,
  modelOptionsForProvider,
  modelOptionsFromProvider,
  providerModelSourceIds,
  providerOptionsFromResponse,
} from './provider-models';

describe('provider model extraction', () => {
  test('extracts providers from daemon list response', () => {
    const options = providerOptionsFromResponse({
      providers: [
        { providerId: 'openai', label: 'OpenAI' },
        { providerId: 'anthropic' },
      ],
    });

    expect(options.map((option) => option.id)).toEqual(['openai', 'anthropic']);
    expect(options[0].label).toBe('OpenAI');
  });

  test('extracts runtime model strings from provider snapshots', () => {
    const models = modelOptionsFromProvider({
      providerId: 'openai',
      runtime: {
        models: {
          defaultModel: 'gpt-5.2',
          models: ['gpt-5.2', 'gpt-5.2-mini'],
          aliases: ['fast'],
        },
      },
    });

    expect(models.map((model) => model.id)).toEqual(['openai:gpt-5.2', 'openai:gpt-5.2-mini', 'openai:fast']);
    expect(models.map((model) => model.rawModelId)).toEqual(['gpt-5.2', 'gpt-5.2-mini', 'fast']);
  });

  test('deduplicates object and string model ids', () => {
    const models = modelOptionsFromProvider({
      providerId: 'anthropic',
      models: ['claude-sonnet-5', { modelId: 'claude-sonnet-5', label: 'Sonnet' }],
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('anthropic:claude-sonnet-5');
  });

  test('uses daemon priced model metadata for labels and ids', () => {
    const models = modelOptionsFromProvider({
      providerId: 'openai',
      models: [
        {
          id: 'gpt-5.2',
          registryKey: 'openai:gpt-5.2',
          displayName: 'GPT-5.2',
          selectable: true,
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('openai:gpt-5.2');
    expect(models[0].registryKey).toBe('openai:gpt-5.2');
    expect(models[0].label).toBe('GPT-5.2');
  });

  test('preserves nested provider catalog model ids under the selected provider', () => {
    const models = modelOptionsFromProvider({
      providerId: 'openrouter',
      runtime: {
        models: {
          models: ['openai/chatgpt5.5', 'free'],
        },
      },
    });

    expect(models.map((model) => model.registryKey)).toEqual(['openrouter:openai/chatgpt5.5', 'openrouter:free']);
  });

  test('maps subscription runtime providers to catalog provider models', () => {
    const runtimeProvider = {
      providerId: 'openai-subscriber',
      runtime: {
        auth: {
          routes: [
            { route: 'subscription-oauth', providerId: 'openai' },
          ],
        },
        models: {
          models: ['gpt-5.5'],
        },
      },
    };
    const catalogProviders = [
      {
        providerId: 'openai',
        models: [
          { id: 'gpt-5.5', registryKey: 'openai:gpt-5.5', displayName: 'GPT-5.5' },
          { id: 'gpt-5.4', registryKey: 'openai:gpt-5.4', displayName: 'GPT-5.4' },
        ],
      },
    ];

    expect(providerModelSourceIds(runtimeProvider)).toContain('openai');
    expect(modelOptionsForProvider(runtimeProvider, catalogProviders).map((model) => model.registryKey))
      .toEqual(['openai:gpt-5.5', 'openai:gpt-5.4']);
  });
});

describe('sortProvidersConfiguredFirst', () => {
  const provider = (id: string, configured: boolean) => ({
    id,
    label: id,
    value: { id, runtime: { auth: { configured, routes: [{ route: 'api-key', configured, usable: configured, freshness: configured ? 'healthy' : 'unconfigured' }] } } },
  });

  test('configured providers lead, alphabetical within each group', () => {
    const sorted = sortProvidersConfiguredFirst([
      provider('abacusai', false),
      provider('openai', true),
      provider('anthropic', false),
      provider('groq', true),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(['groq', 'openai', 'abacusai', 'anthropic']);
  });

  test('a provider configured only via a usable route sorts as configured', () => {
    const routeOnly = {
      id: 'openai',
      label: 'openai',
      value: {
        id: 'openai',
        runtime: {
          auth: {
            configured: false,
            routes: [{ route: 'subscription-oauth', configured: true, usable: true, freshness: 'healthy' }],
          },
        },
      },
    };
    const sorted = sortProvidersConfiguredFirst([provider('abacusai', false), routeOnly]);
    expect(sorted[0]?.id).toBe('openai');
  });
});

describe('reasoningOptionsForModel', () => {
  const providers = [
    {
      id: 'openai',
      models: [
        { registryKey: 'openai:gpt-5.6', id: 'gpt-5.6', reasoningOptions: { levels: ['low', 'medium', 'high', 'xhigh'], source: 'catalog' } },
        { registryKey: 'openai:gpt-5.4-mini', id: 'gpt-5.4-mini' },
      ],
    },
  ];

  test('returns the declared ladder for the matching model', () => {
    expect(reasoningOptionsForModel(providers, 'openai:gpt-5.6')).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh'],
      source: 'catalog',
    });
  });

  test('null for a model without the field (older daemon), never a fabricated ladder', () => {
    expect(reasoningOptionsForModel(providers, 'openai:gpt-5.4-mini')).toBeNull();
    expect(reasoningOptionsForModel(providers, 'openai:absent')).toBeNull();
    expect(reasoningOptionsForModel(providers, '')).toBeNull();
  });

  test('non-string and empty levels are dropped; an all-junk ladder reads as none', () => {
    const junk = [{ id: 'p', models: [{ registryKey: 'p:m', reasoningOptions: { levels: [1, '', null], source: 'catalog' } }] }];
    expect(reasoningOptionsForModel(junk, 'p:m')).toBeNull();
  });
});
