import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { FavoritesStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ToolLLM } from '@goodvibes-jev/engine/sdk/platform/config';
import { ProviderCapabilityRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { CacheHitTracker } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { LLMProvider, ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createLaunchTolerantProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { makeProjectTempDir } from './project-temp.ts';

export interface TestManagers {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  readonly bookmarkManager: BookmarkManager;
  readonly toolLLM: ToolLLM;
}

export function buildTestModelDefinition(provider: string, modelId: string): ModelDefinition {
  return {
    id: modelId,
    provider,
    registryKey: `${provider}:${modelId}`,
    displayName: modelId,
    description: 'Test model',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 4096,
    selectable: true,
    tier: 'standard',
  };
}

export function patchTestProviderRegistry(providerRegistry: ProviderRegistry): void {
  const originalRegister = providerRegistry.register.bind(providerRegistry);
  providerRegistry.register = ((provider: LLMProvider): void => {
    originalRegister(provider);
    if (provider.models.length === 0) return;
    providerRegistry.registerRuntimeProvider({
      provider,
      replace: true,
      models: provider.models.map((modelId) => buildTestModelDefinition(provider.name, modelId)),
    });
  }) as ProviderRegistry['register'];
}

export function createTestManagers(): TestManagers {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const rootDir = makeProjectTempDir(`gv-test-managers-${suffix}`);
  const workingDir = join(rootDir, 'workspace');
  const homeDir = join(rootDir, 'home');
  const configDir = join(homeDir, '.goodvibes', 'tui');
  const subscriptionsPath = join(rootDir, 'subscriptions.json');
  const servicesPath = join(rootDir, 'services.json');
  const bookmarksDir = join(rootDir, 'bookmarks');
  const providerDataDir = join(rootDir, 'provider-data');

  const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir, homeDir });
  // Enable tools.llmEnabled by default in tests so resolveToolLLM tests can exercise
  // the resolution logic without each test individually opting in. Production code
  // keeps the gate off by default; tests opt in so the gate is not the thing under test.
  configManager.set('tools.llmEnabled', true);
  const subscriptionManager = new SubscriptionManager(subscriptionsPath);
  const secretsManager = new SecretsManager({ projectRoot: workingDir, globalHome: homeDir });
  const serviceRegistry = new ServiceRegistry(servicesPath, {
    secretsManager,
    subscriptionManager,
  });
  const favoritesStore = new FavoritesStore({ dir: providerDataDir });
  const benchmarkStore = new BenchmarkStore({ dir: providerDataDir });
  mkdirSync(dirname(benchmarkStore.getCachePath()), { recursive: true });
  writeFileSync(benchmarkStore.getCachePath(), JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
  // Construct through the same launch-tolerant path production uses: the SDK's
  // ProviderRegistry eagerly instantiates each builtin provider's OpenAI client
  // at construction, and that client throws on an empty apiKey. The tolerant
  // wrapper injects placeholder keys for unconfigured providers so a
  // no-credentials test environment can still build the registry.
  const providerRegistry = createLaunchTolerantProviderRegistry({
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: new ProviderCapabilityRegistry(),
    cacheHitTracker: new CacheHitTracker(),
    favoritesStore,
    benchmarkStore,
  });
  patchTestProviderRegistry(providerRegistry);
  const bookmarkManager = new BookmarkManager(bookmarksDir);
  const toolLLM = new ToolLLM({ configManager, providerRegistry });

  return {
    configManager,
    secretsManager,
    subscriptionManager,
    serviceRegistry,
    favoritesStore,
    benchmarkStore,
    providerRegistry,
    bookmarkManager,
    toolLLM,
  };
}

export function createTestConfigManager(): ConfigManager {
  return createTestManagers().configManager;
}

export function createTestProviderRegistry(): ProviderRegistry {
  return createTestManagers().providerRegistry;
}

export function createTestBookmarkManager(): BookmarkManager {
  return createTestManagers().bookmarkManager;
}

