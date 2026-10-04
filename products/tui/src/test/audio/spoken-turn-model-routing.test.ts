// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { describe, expect, test } from 'bun:test';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ModelDefinition, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import {
  attachSpokenTurnModelRouting,
  createSpokenTurnInputOptions,
  resolveSpokenTurnModelOverride,
} from '../../audio/spoken-turn-model-routing.ts';

const chatModel: ModelDefinition = {
  id: 'chat-model',
  provider: 'openai',
  registryKey: 'openai:chat-model',
  displayName: 'Chat Model',
  description: '',
  contextWindow: 128000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
  selectable: true,
  tier: 'standard',
};

const ttsModel: ModelDefinition = {
  id: 'spoken-model',
  provider: 'anthropic',
  registryKey: 'anthropic:spoken-model',
  displayName: 'Spoken Model',
  description: '',
  contextWindow: 200000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
  selectable: true,
  tier: 'standard',
};

function makeConfig(values: Record<string, string>): Pick<ConfigManager, 'get'> {
  return {
    get(key: string) {
      return values[key] ?? '';
    },
  } as Pick<ConfigManager, 'get'>;
}

function makeRegistry(current = chatModel): ProviderRegistry {
  return {
    getCurrentModel: () => current,
    listModels: () => [chatModel, ttsModel],
  } as unknown as ProviderRegistry;
}

describe('spoken turn model routing', () => {
  test('uses the current chat model when no TTS LLM override is configured', () => {
    const override = resolveSpokenTurnModelOverride({
      providerRegistry: makeRegistry(),
      configManager: makeConfig({}),
    });

    expect(override).toBeNull();
  });

  test('resolves the configured TTS LLM override without changing current chat model', () => {
    const registry = makeRegistry();
    const override = resolveSpokenTurnModelOverride({
      providerRegistry: registry,
      configManager: makeConfig({
        'tts.llmProvider': 'anthropic',
        'tts.llmModel': 'anthropic:spoken-model',
      }),
    });

    expect(override?.registryKey).toBe('anthropic:spoken-model');
    expect(registry.getCurrentModel().registryKey).toBe('openai:chat-model');
  });

  test('applies the routed provider registry only to spoken turns', async () => {
    let activeRegistry = makeRegistry();
    const observedModels: string[] = [];
    const fakeOrchestrator = {
      setCoreServices(services: { providerRegistry?: ProviderRegistry }) {
        if (services.providerRegistry) activeRegistry = services.providerRegistry;
      },
      async runTurn(_text?: string, _content?: unknown, _options?: unknown) {
        observedModels.push(activeRegistry.getCurrentModel().registryKey ?? activeRegistry.getCurrentModel().id);
      },
    };

    const detach = attachSpokenTurnModelRouting({
      orchestrator: fakeOrchestrator as never,
      providerRegistry: activeRegistry,
      configManager: makeConfig({
        'tts.llmProvider': 'anthropic',
        'tts.llmModel': 'anthropic:spoken-model',
      }),
    });

    await fakeOrchestrator.runTurn();
    await fakeOrchestrator.runTurn('speak', undefined, createSpokenTurnInputOptions());
    detach();

    expect(observedModels).toEqual(['openai:chat-model', 'anthropic:spoken-model']);
    expect(activeRegistry.getCurrentModel().registryKey).toBe('openai:chat-model');
  });

  test('falls back to current chat model when the configured override is invalid', async () => {
    let activeRegistry = makeRegistry();
    const messages: string[] = [];
    const observedModels: string[] = [];
    const fakeOrchestrator = {
      setCoreServices(services: { providerRegistry?: ProviderRegistry }) {
        if (services.providerRegistry) activeRegistry = services.providerRegistry;
      },
      async runTurn(_text?: string, _content?: unknown, _options?: unknown) {
        observedModels.push(activeRegistry.getCurrentModel().registryKey ?? activeRegistry.getCurrentModel().id);
      },
    };

    attachSpokenTurnModelRouting({
      orchestrator: fakeOrchestrator as never,
      providerRegistry: activeRegistry,
      configManager: makeConfig({
        'tts.llmProvider': 'anthropic',
        'tts.llmModel': 'missing-model',
      }),
      notify: (message) => messages.push(message),
    });

    await fakeOrchestrator.runTurn('speak', undefined, createSpokenTurnInputOptions());

    expect(observedModels).toEqual(['openai:chat-model']);
    expect(messages.join('\n')).toContain("Configured TTS LLM 'missing-model' was not found");
  });
  for (const scenario of [
    { name: 'ordinary input', spoken: false, model: '' },
    { name: 'spoken input without an override', spoken: true, model: '' },
    { name: 'spoken input with an override', spoken: true, model: 'anthropic:spoken-model' },
  ]) {
    test(`preserves opaque execution context for ${scenario.name}`, async () => {
      const registry = makeRegistry();
      const admission = Object.freeze({ identity: Symbol('native-admission') });
      const laterContext = Object.freeze({ identity: Symbol('future-context') });
      const inputOptions = scenario.spoken ? createSpokenTurnInputOptions() : undefined;
      const content = [{ type: 'text' as const, text: 'original source' }];
      let observed: readonly unknown[] = [];
      const target = {
        setCoreServices(_services: { providerRegistry?: ProviderRegistry }) {},
        async runTurn(...args: readonly unknown[]) { observed = args; },
      };
      const detach = attachSpokenTurnModelRouting({
        orchestrator: target as never, providerRegistry: registry,
        configManager: makeConfig({ 'tts.llmModel': scenario.model }),
      });
      await target.runTurn('original source', content, inputOptions, admission, laterContext);
      expect(observed).toHaveLength(5);
      expect(observed[0]).toBe('original source');
      expect(observed[1]).toBe(content);
      expect(observed[2]).toBe(inputOptions);
      expect(observed[3]).toBe(admission);
      expect(observed[4]).toBe(laterContext);
      detach();
      await target.runTurn('after detach', content, inputOptions, admission, laterContext);
      expect(observed[3]).toBe(admission);
      expect(observed[4]).toBe(laterContext);
    });
  }

});
