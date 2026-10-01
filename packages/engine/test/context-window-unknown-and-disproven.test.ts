/**
 * An unknown context window is reported as unknown, never as a guessed number.
 *
 * Live incident (abacusai route-llm, a router): the provider file written by
 * `/provider add` stated `contextWindow: 8192` for every model because the
 * endpoint said nothing. The meter then read `29.9k / 8.2k`, the model was
 * given small-model guidance, and small-window auto-compaction fired every
 * turn on a six-message conversation (`6 -> 6 messages, saved ~0`), because
 * the 29.9k of real input was the system prompt and tool schemas.
 *
 * Pins:
 * 1. a provider file model with no contextWindow loads, with an unknown window;
 * 2. a successful request larger than the stated window disproves it
 *    (provenance accepted_floor), persisted, and a user override is exempt;
 * 3. getKnownContextWindowForModel returns null for a guessed or disproven window;
 * 4. neither compaction trigger acts on an unknown window;
 * 5. small-window compaction never runs when it has nothing past the kept messages;
 * Tier selection stays with the separate Jev model-tier reading.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import { loadCustomProviders } from '../sdk/src/platform/providers/custom-loader.js';
import { ContextWindowOverrideStore, getContextWindowOverridesPath } from '../sdk/src/platform/providers/context-window-overrides.js';
import { ModelLimitsService } from '../sdk/src/platform/providers/model-limits.js';
import type { DiscoveredServer } from '../sdk/src/platform/discovery/scanner.js';
import {
  checkContextWindowPreflight,
  handlePostTurnContextMaintenance,
  type PreflightDeps,
  type PostTurnContextDeps,
} from '../sdk/src/platform/core/orchestrator-context-runtime.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import type { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

function makeRegistry(root: string, modelLimitsService?: ModelLimitsService): ProviderRegistry {
  return new ProviderRegistry({
    configManager: { get: () => undefined, getCategory: () => ({}), getControlPlaneConfigDir: () => root } as unknown as RegistryOptions['configManager'],
    subscriptionManager: { get: () => null, getPending: () => null, saveSubscription: async () => {}, resolveAccessToken: async () => null } as unknown as RegistryOptions['subscriptionManager'],
    capabilityRegistry: { getCapability: () => ({}), getRouteExplanation: () => ({ accepted: true }), invalidate: () => {} } as unknown as RegistryOptions['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as RegistryOptions['cacheHitTracker'],
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) } as unknown as RegistryOptions['favoritesStore'],
    benchmarkStore: { getBenchmarks: () => undefined, getTopBenchmarkModelIds: () => [] } as unknown as RegistryOptions['benchmarkStore'],
    secretsManager: {} as unknown as RegistryOptions['secretsManager'],
    serviceRegistry: {} as unknown as RegistryOptions['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
    modelLimitsService,
  });
}

const SERVER: DiscoveredServer = {
  name: 'ollama',
  host: '127.0.0.1',
  port: 11434,
  baseURL: 'http://127.0.0.1:11434/v1',
  models: ['qwen3-local'],
  serverType: 'ollama',
  modelContextWindows: { 'qwen3-local': 8192 },
};
const KEY = 'ollama:qwen3-local';

function withTempRoot(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gv-ctxwin-unknown-'));
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('custom provider files: a model with no stated window', () => {
  test('loads with an unknown (fallback) window instead of failing validation', async () => {
    await withTempRoot(async (root) => {
      writeFileSync(join(root, 'router.json'), JSON.stringify({
        name: 'router',
        displayName: 'router',
        type: 'openai-compat',
        baseURL: 'https://router.example/v1',
        models: [{ id: 'route-llm', displayName: 'route-llm', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }],
      }));
      const result = await loadCustomProviders({ providersDir: root });
      expect(result.warnings.filter((w) => w.includes('contextWindow'))).toEqual([]);
      const model = result.models.find((m) => m.id === 'route-llm');
      expect(model?.contextWindowProvenance).toBe('fallback');
    });
  });

  test('a stated window that is not a positive number is still rejected', async () => {
    await withTempRoot(async (root) => {
      writeFileSync(join(root, 'bad.json'), JSON.stringify({
        name: 'bad',
        displayName: 'bad',
        type: 'openai-compat',
        baseURL: 'https://bad.example/v1',
        models: [{ id: 'm', displayName: 'm', contextWindow: 0, capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }],
      }));
      const result = await loadCustomProviders({ providersDir: root });
      expect(result.models).toHaveLength(0);
      expect(result.warnings.some((w) => w.includes('"contextWindow", when given, must be a positive number'))).toBe(true);
    });
  });
});

describe('a larger accepted request disproves the stated window', () => {
  test('the window becomes unknown with the accepted input as its floor', async () => {
    await withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([SERVER]); // states 8192
      registry.reconcileObservedContextWindow(KEY, 29_871);

      const model = registry.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindowProvenance).toBe('accepted_floor');
      expect(model.contextWindow).toBe(29_871);
      expect(registry.getKnownContextWindowForModel(model)).toBeNull();
      // Budget math still gets a number, and never the disproven 8192.
      expect(registry.getContextWindowForModel(model)).toBe(29_871);
    });
  });

  test('the floor persists across a restart and only rises', async () => {
    await withTempRoot((root) => {
      const first = makeRegistry(root);
      first.registerDiscoveredProviders([SERVER]);
      first.reconcileObservedContextWindow(KEY, 20_000);
      first.reconcileObservedContextWindow(KEY, 15_000); // smaller, ignored
      const file = JSON.parse(readFileSync(getContextWindowOverridesPath(root), 'utf-8')) as { version: number; accepted?: Record<string, number> };
      expect(file.version).toBe(2);
      expect(file.accepted).toEqual({ [KEY]: 20_000 });

      const second = makeRegistry(root);
      second.registerDiscoveredProviders([SERVER]);
      const model = second.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindowProvenance).toBe('accepted_floor');
      expect(model.contextWindow).toBe(20_000);
    });
  });

  test('input within the stated window changes nothing', async () => {
    await withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([SERVER]);
      registry.reconcileObservedContextWindow(KEY, 6_000);
      const model = registry.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindowProvenance).toBe('provider_api');
      expect(registry.getKnownContextWindowForModel(model)).toBe(8192);
    });
  });

  test('a user override is a deliberate budget and is never disproven', async () => {
    await withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([SERVER]);
      registry.setModelContextCap(KEY, 8_000);
      registry.reconcileObservedContextWindow(KEY, 29_871);
      const model = registry.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindowProvenance).toBe('configured_cap');
      expect(registry.getKnownContextWindowForModel(model)).toBe(8_000);
    });
  });

  test('clearing the model returns it to its stated window', async () => {
    await withTempRoot((root) => {
      const registry = makeRegistry(root);
      registry.registerDiscoveredProviders([SERVER]);
      registry.reconcileObservedContextWindow(KEY, 29_871);
      expect(registry.clearModelContextCap(KEY)).toBe(true);
      const model = registry.listModels().find((m) => m.registryKey === KEY)!;
      expect(model.contextWindow).toBe(8192);
      expect(model.contextWindowProvenance).toBe('provider_api');
    });
  });
});

// ---------------------------------------------------------------------------
// Compaction triggers
// ---------------------------------------------------------------------------

function routerModel(): ModelDefinition {
  return {
    id: 'route-llm',
    provider: 'abacusai',
    registryKey: 'abacusai:route-llm',
    displayName: 'route-llm',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
  };
}

function makeHarness(opts: { known: number | null; messageCount: number }) {
  const model = routerModel();
  const systemMessages: string[] = [];
  const state = { compactCalls: 0, replaced: 0 };
  const messages = Array.from({ length: opts.messageCount }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` }));
  const conversation = {
    getMessagesForLLM: () => messages,
    addSystemMessage: (msg: string) => { systemMessages.push(msg); },
    replaceMessagesForLLM: () => { state.replaced += 1; },
    compact: async () => { state.compactCalls += 1; },
  } as unknown as ConversationManager;
  // The registry as it stood in the incident: budget math returns the stated
  // 8192; the known window is what this round adds.
  const providerRegistry = {
    getCurrentModel: () => model,
    getContextWindowForModel: () => 8192,
    getKnownContextWindowForModel: () => opts.known,
    listModels: () => [model],
  } as unknown as PreflightDeps['providerRegistry'];
  const config: Record<string, unknown> = { 'behavior.autoCompactThreshold': 80, 'behavior.staleContextWarnings': true };
  const shared = {
    conversation,
    requestRender: () => {},
    hookDispatcher: null,
    configManager: { get: (key: string) => config[key] } as unknown as Pick<ConfigManager, 'get'>,
    providerRegistry,
    sessionLineageTracker: { getEntries: () => [], getCompactionCount: () => 0, getOriginalTask: () => null },
    sessionId: 'test-session',
    agentManager: { list: () => [] },
    contractRunner: { list: () => [] },
    planManager: null,
    sessionMemoryStore: null,
    runtimeBus: null,
    emitterContext: () => ({ sessionId: 'test-session', turnId: 'turn-1' }) as unknown as ReturnType<PreflightDeps['emitterContext']>,
    isCompacting: false,
    setIsCompacting: () => {},
  };
  const postTurn: PostTurnContextDeps = { ...shared, lastWarningBracket: 0, setLastWarningBracket: () => {} };
  const preflight: PreflightDeps = shared;
  return { model, systemMessages, state, postTurn, preflight };
}

describe('compaction on an unknown window', () => {
  test('post-turn: 29.9k of real input on an unknown window neither warns nor compacts', async () => {
    const h = makeHarness({ known: null, messageCount: 30 });
    await handlePostTurnContextMaintenance(h.postTurn, 'turn-1', 29_871);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.systemMessages).toEqual([]);
    expect(h.state.replaced).toBe(0);
    expect(h.state.compactCalls).toBe(0);
  });

  test('preflight: an unknown window is never an overflow', async () => {
    const h = makeHarness({ known: null, messageCount: 30 });
    expect(await checkContextWindowPreflight(h.preflight, 'turn-1', h.model)).toBe('ok');
    expect(h.systemMessages).toEqual([]);
  });
});

describe('small-window compaction with nothing to remove', () => {
  test('a known 8k window over threshold with six messages announces and commits nothing', async () => {
    const h = makeHarness({ known: 8192, messageCount: 6 });
    await handlePostTurnContextMaintenance(h.postTurn, 'turn-1', 29_871);
    expect(h.systemMessages).toEqual([]);
    expect(h.state.replaced).toBe(0);
  });

  test('control: with more than the kept messages it still compacts', async () => {
    const h = makeHarness({ known: 8192, messageCount: 14 });
    await handlePostTurnContextMaintenance(h.postTurn, 'turn-1', 29_871);
    expect(h.state.replaced).toBe(1);
    expect(h.systemMessages.some((m) => m.includes('Kept last 10 messages'))).toBe(true);
  });
});


describe('nullable observations do not manufacture authority', () => {
  test('fallbacks and invalid windows stay unknown while numeric budget math stays finite', () => {
    const service = new ModelLimitsService({ cachePath: '/unused/context-window-test.json' });
    for (const contextWindow of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(service.getKnownContextWindowForModel({ ...routerModel(), contextWindow })).toBeNull();
      expect(Number.isFinite(service.getContextWindowForModel({ ...routerModel(), contextWindow }))).toBe(true);
    }
    expect(service.getKnownContextWindowForModel({ ...routerModel(), contextWindow: 400000, contextWindowProvenance: 'fallback' })).toBeNull();
    expect(service.getKnownContextWindowForModel({ ...routerModel(), contextWindow: 20000, contextWindowProvenance: 'accepted_floor' })).toBeNull();
  });

  test.each([16000, 32000])('OpenRouter window %i must meet an accepted floor before it is known', async (ceiling) => {
    await withTempRoot((root) => {
      const cachePath = join(root, 'limits.json');
      writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86400000,
        models: { 'route-llm': { contextLength: ceiling, maxOutputTokens: 4096, supportedParameters: [] } } }));
      const service = new ModelLimitsService({ cachePath });
      service.init();
      const model = { ...routerModel(), contextWindow: 24000, contextWindowProvenance: 'accepted_floor' as const };
      expect(service.getKnownContextWindowForModel(model)).toBe(ceiling < 24000 ? null : ceiling);
      expect(service.getContextWindowForModel(model)).toBe(Math.max(24000, ceiling));
    });
  });

  test('rejection, larger success, restart, contradicted rejection, genuine later rejection', async () => {
    await withTempRoot((root) => {
      const first = makeRegistry(root);
      first.registerDiscoveredProviders([SERVER]);
      first.recordContextWindowRejection(KEY, 6000);
      expect(first.getObservedContextWindow(KEY)).toBe(6000);
      first.reconcileObservedContextWindow(KEY, 24000);
      expect(first.getObservedContextWindow(KEY)).toBeNull();
      expect(first.getKnownContextWindowForModel(first.listModels().find((m) => m.registryKey === KEY)!)).toBeNull();
      const file = JSON.parse(readFileSync(getContextWindowOverridesPath(root), 'utf-8')) as { version: number; observed: Record<string, number>; accepted: Record<string, number> };
      expect(file.version).toBe(2);
      expect(file.observed).toEqual({});
      expect(file.accepted).toEqual({ [KEY]: 24000 });
      const second = makeRegistry(root);
      second.registerDiscoveredProviders([SERVER]);
      second.recordContextWindowRejection(KEY, 12000); // contradicts the accepted floor
      expect(second.getObservedContextWindow(KEY)).toBeNull();
      expect(second.getKnownContextWindowForModel(second.listModels().find((m) => m.registryKey === KEY)!)).toBeNull();
      second.recordContextWindowRejection(KEY, 30000);
      const observed = second.listModels().find((m) => m.registryKey === KEY)!;
      expect(second.getKnownContextWindowForModel(observed)).toBe(30000);
      expect(observed.contextWindowProvenance).toBe('observed_limit');
      second.reconcileObservedContextWindow(KEY, 40000);
      expect(second.getObservedContextWindow(KEY)).toBeNull();
      expect(second.getKnownContextWindowForModel(second.listModels().find((m) => m.registryKey === KEY)!)).toBeNull();
      second.setModelContextCap(KEY, 8192);
      second.reconcileObservedContextWindow(KEY, 50000);
      const capped = second.listModels().find((m) => m.registryKey === KEY)!;
      expect(second.getKnownContextWindowForModel(capped)).toBe(8192);
      expect(capped.contextWindowOrigin).toEqual({ kind: 'user_override' });
    });
  });

  test('invalid successes do not invalidate a ceiling or persist false floors', async () => {
    await withTempRoot((root) => {
      const store = new ContextWindowOverrideStore(join(root, 'overrides.json'));
      store.recordRejection(KEY, 4000);
      for (const input of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 10000001]) {
        expect(store.reconcileSuccessfulInput(KEY, input, () => routerModel())).toBe(false);
      }
      expect(store.getObserved(KEY)).toBe(4000);
    });
  });

  test('provider warning still compacts an unknown window without invented percentage text', async () => {
    const h = makeHarness({ known: null, messageCount: 30 });
    h.preflight.modelContextWarning = { provider: 'abacusai', model: 'route-llm' };
    expect(await checkContextWindowPreflight(h.preflight, 'turn-1', h.model)).toBe('compacted');
    expect(h.state.compactCalls).toBe(1);
    expect(h.systemMessages.join(' ')).toContain('unknown context window');
    expect(h.systemMessages.join(' ')).not.toContain('0%');
  });
});


test('an accepted floor survives a larger raw estimate and blocks a smaller resolved ceiling after restart', async () => {
  await withTempRoot((root) => {
    const cachePath = join(root, 'limits.json');
    const writeLimits = (ceiling: number) => writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86400000,
      models: { 'route-llm': { contextLength: ceiling, maxOutputTokens: 4096, supportedParameters: [] } } }));
    const boot = () => {
      const service = new ModelLimitsService({ cachePath }); service.init();
      const registry = makeRegistry(root, service);
      const definition: ModelDefinition = { ...routerModel(), contextWindow: 128000, contextWindowProvenance: 'fallback' };
      registry.registerRuntimeProvider({
        provider: { name: definition.provider, models: [definition.id], credentialAuthority: 'anonymous',
          chat: async () => ({ content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }) },
        models: [definition],
      });
      return registry;
    };
    const key = 'abacusai:route-llm';
    writeLimits(8192);
    const first = boot();
    const raw = first.listModels().find((m) => m.registryKey === key)!;
    expect(raw.contextWindow).toBe(128000);
    expect(first.getKnownContextWindowForModel(raw)).toBe(8192);
    first.reconcileObservedContextWindow(key, 24000);
    const persisted = JSON.parse(readFileSync(getContextWindowOverridesPath(root), 'utf-8')) as { accepted: Record<string, number> };
    expect(persisted.accepted[key]).toBe(24000);
    for (const registry of [first, boot()]) {
      const definition = registry.listModels().find((m) => m.registryKey === key)!;
      expect(definition.contextWindow).toBe(128000);
      expect(definition.contextWindowAcceptedFloor).toBe(24000);
      expect(registry.getKnownContextWindowForModel(definition)).toBeNull();
      expect(registry.getContextWindowForModel(definition)).toBe(128000);
    }
    writeLimits(32000);
    const supported = boot();
    const definition = supported.listModels().find((m) => m.registryKey === key)!;
    expect(definition.contextWindowAcceptedFloor).toBe(24000);
    expect(supported.getKnownContextWindowForModel(definition)).toBe(32000);
  });
});


test('a real provider warning on a short known-small-window history still performs structured recovery', async () => {
  const h = makeHarness({ known: 8192, messageCount: 6 });
  let cleared = 0;
  h.postTurn.modelContextWarning = { provider: 'abacusai', model: 'route-llm', providerStopReason: 'context_length_exceeded' };
  h.postTurn.clearModelContextWarning = () => { cleared++; };
  await handlePostTurnContextMaintenance(h.postTurn, 'turn-1', 29871);
  expect(h.state.compactCalls).toBe(1);
  expect(h.state.replaced).toBe(0);
  expect(cleared).toBe(1);
  expect(h.systemMessages.some((message) => message.includes('reported its context window is full'))).toBe(true);
  expect(h.systemMessages.some((message) => message.includes('Context auto-compacted.'))).toBe(true);
});


test('an existing floor rises below a still-supported ceiling and survives restart', async () => {
  await withTempRoot((root) => {
    const first = makeRegistry(root);
    first.registerDiscoveredProviders([SERVER]);
    first.reconcileObservedContextWindow(KEY, 24000);
    first.recordContextWindowRejection(KEY, 30000);
    first.reconcileObservedContextWindow(KEY, 28000);
    expect(first.getObservedContextWindow(KEY)).toBe(30000);
    const file = JSON.parse(readFileSync(getContextWindowOverridesPath(root), 'utf-8')) as { accepted: Record<string, number>; observed: Record<string, number> };
    expect(file.accepted[KEY]).toBe(28000);
    expect(file.observed[KEY]).toBe(30000);
    const second = makeRegistry(root);
    second.registerDiscoveredProviders([SERVER]);
    second.recordContextWindowRejection(KEY, 26000);
    expect(second.getObservedContextWindow(KEY)).toBe(30000);
    const model = second.listModels().find((entry) => entry.registryKey === KEY)!;
    expect(model.contextWindowAcceptedFloor).toBe(28000);
    expect(second.getKnownContextWindowForModel(model)).toBe(30000);
    second.recordContextWindowRejection(KEY, 29000);
    expect(second.getKnownContextWindowForModel(second.listModels().find((entry) => entry.registryKey === KEY)!)).toBe(29000);
  });
});
