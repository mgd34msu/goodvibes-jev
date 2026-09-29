/**
 * provider-adapter-kind.test.ts
 *
 * The adapter a provider runs on is a registered fact: each adapter class
 * declares it, ProviderRegistry records it by provider id at registration,
 * and two lookups read it instead of words in the provider id: the
 * prompt-cache capability (cache-capability.ts) and the reasoning field the
 * /effort explainer names (describeReasoningWire in reasoning-effort.ts).
 */
import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';
import type { ProviderAdapterKind } from '../sdk/src/platform/providers/adapter-kind.js';
import { providerAdapterKind } from '../sdk/src/platform/providers/adapter-kind.js';
import { AnthropicCompatProvider } from '../sdk/src/platform/providers/anthropic-compat.js';
import { OpenAICompatProvider } from '../sdk/src/platform/providers/openai-compat.js';
import { GeminiProvider } from '../sdk/src/platform/providers/gemini.js';
import { getCacheCapability } from '../sdk/src/platform/providers/cache-capability.js';
import { describeReasoningWire, FALLBACK_REASONING_EFFORT_SPEC, type ReasoningEffortSpec } from '../sdk/src/platform/providers/reasoning-effort.js';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

function makeRegistry(): ProviderRegistry {
  return new ProviderRegistry({
    configManager: { get: () => undefined, getCategory: () => ({}), getControlPlaneConfigDir: () => '/tmp/adapter-kind-registry' } as unknown as RegistryOptions['configManager'],
    subscriptionManager: { get: () => null, getPending: () => null } as unknown as RegistryOptions['subscriptionManager'],
    capabilityRegistry: { invalidate: () => {}, setModelFactsSource: () => {} } as unknown as RegistryOptions['capabilityRegistry'],
    cacheHitTracker: {} as unknown as RegistryOptions['cacheHitTracker'],
    favoritesStore: {} as unknown as RegistryOptions['favoritesStore'],
    benchmarkStore: {} as unknown as RegistryOptions['benchmarkStore'],
    secretsManager: {} as unknown as RegistryOptions['secretsManager'],
    serviceRegistry: {} as unknown as RegistryOptions['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
  });
}

function stubProvider(name: string, adapterKind?: ProviderAdapterKind): LLMProvider {
  return {
    name,
    models: ['m'],
    ...(adapterKind ? { adapterKind } : {}),
    modelSource: { kind: 'live-discovery' },
    credentialAuthority: 'anonymous',
    chat: async () => { throw new Error('not used'); },
  } as unknown as LLMProvider;
}

const BUDGET_SPEC: ReasoningEffortSpec = { kind: 'budget_tokens', values: ['low', 'high'], source: 'family', minBudgetTokens: 1024, canDisableReasoning: true };

describe('adapter classes declare their kind', () => {
  test('compat adapters carry the kind their catalog kind or custom type builds', () => {
    const anthropicCompat = new AnthropicCompatProvider({ name: 'kind-a', baseURL: 'https://a.example.test', apiKey: 'k', defaultModel: 'm', models: ['m'] });
    const openaiCompat = new OpenAICompatProvider({ name: 'kind-o', baseURL: 'https://o.example.test/v1', apiKey: 'k', defaultModel: 'm', models: ['m'] });
    expect(anthropicCompat.adapterKind).toBe('anthropic-compat');
    expect(openaiCompat.adapterKind).toBe('openai-compat');
    expect(new GeminiProvider('k').adapterKind).toBe('gemini');
  });
});

describe('ProviderRegistry records the adapter kind by provider id', () => {
  test('register and registerRuntimeProvider record it; a provider declaring none clears it', () => {
    const registry = makeRegistry();
    registry.register(stubProvider('kind-registered', 'anthropic-compat'));
    registry.registerRuntimeProvider({ provider: stubProvider('kind-runtime', 'gemini') });
    expect(providerAdapterKind('kind-registered')).toBe('anthropic-compat');
    expect(providerAdapterKind('kind-runtime')).toBe('gemini');
    registry.register(stubProvider('kind-registered'));
    expect(providerAdapterKind('kind-registered')).toBeUndefined();
  });
});

describe('prompt-cache capability', () => {
  test('openrouter has its own row with the OpenAI terms', () => {
    expect(getCacheCapability('openrouter')).toEqual({ type: 'automatic', readDiscount: 0.5 });
  });

  test('a provider registered on the Anthropic-compatible adapter caches the way Anthropic does, whatever its name', () => {
    makeRegistry().register(stubProvider('corp-claude-proxy', 'anthropic-compat'));
    expect(getCacheCapability('corp-claude-proxy')).toBe(getCacheCapability('anthropic'));
  });

  test('a name that only contains a known provider name borrows nothing', () => {
    makeRegistry().register(stubProvider('my-openrouter-mirror', 'openai-compat'));
    makeRegistry().register(stubProvider('anthropic-compat-labelled', 'openai-compat'));
    expect(getCacheCapability('my-openrouter-mirror')).toEqual({ type: 'none' });
    expect(getCacheCapability('anthropic-compat-labelled')).toEqual({ type: 'none' });
  });
});

describe('describeReasoningWire names the field the registered adapter sends', () => {
  test('Anthropic Messages adapters, including one whose id does not say anthropic', () => {
    const registry = makeRegistry();
    registry.register(stubProvider('wire-minimax', 'anthropic-compat'));
    registry.register(stubProvider('wire-bedrock', 'anthropic-sdk'));
    expect(describeReasoningWire(FALLBACK_REASONING_EFFORT_SPEC, 'wire-minimax')).toBe('output_config.effort');
    expect(describeReasoningWire(FALLBACK_REASONING_EFFORT_SPEC, 'wire-bedrock')).toBe('output_config.effort');
    expect(describeReasoningWire(BUDGET_SPEC, 'wire-minimax')).toBe('thinking.budget_tokens');
  });

  test('the Gemini adapter', () => {
    makeRegistry().register(stubProvider('wire-gemini', 'gemini'));
    expect(describeReasoningWire(FALLBACK_REASONING_EFFORT_SPEC, 'wire-gemini')).toBe('thinking_config.thinking_level');
    expect(describeReasoningWire(BUDGET_SPEC, 'wire-gemini')).toBe('thinking_config.thinking_budget');
  });

  test('an OpenAI-compatible provider whose id says google or anthropic sends reasoning_effort', () => {
    const registry = makeRegistry();
    registry.register(stubProvider('google-vertex-openai-proxy', 'openai-compat'));
    registry.register(stubProvider('anthropic-lookalike', 'openai-compat'));
    expect(describeReasoningWire(FALLBACK_REASONING_EFFORT_SPEC, 'google-vertex-openai-proxy')).toBe('reasoning_effort');
    expect(describeReasoningWire(FALLBACK_REASONING_EFFORT_SPEC, 'anthropic-lookalike')).toBe('reasoning_effort');
    expect(describeReasoningWire(FALLBACK_REASONING_EFFORT_SPEC)).toBe('reasoning_effort');
  });
});
