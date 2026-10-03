import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { FavoritesStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { CacheHitTracker } from '@goodvibes-jev/engine/sdk/platform/providers';
import { OpenAIProvider } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderCapabilityRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createLaunchTolerantProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { getProviderRuntimeSnapshot, getProviderUsageSnapshot } from '@goodvibes-jev/engine/sdk/platform/providers';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function goodVibesRef(source: string, id: string): string {
  return `goodvibes://secrets/${source}/${encodeURIComponent(id)}`;
}

describe('provider runtime snapshots', () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  let root = '';
  let secrets: SecretsManager;
  let subscriptions: SubscriptionManager;
  let providerRegistry: ProviderRegistry;

  beforeEach(() => {
    root = makeProjectTempDir('gv-provider-runtime');
    process.env.HOME = root;
    process.chdir(root);
    secrets = new SecretsManager({ projectRoot: root, globalHome: root });
    subscriptions = new SubscriptionManager(join(root, '.goodvibes', 'tui', 'subscriptions.json'));
    const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: secrets,
      subscriptionManager: subscriptions,
    });
    const favoritesStore = new FavoritesStore({ dir: join(root, '.goodvibes', 'tui') });
    const benchmarkStore = new BenchmarkStore({ dir: join(root, '.goodvibes', 'tui') });
    const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(root, '.goodvibes', 'tui') });
    configManager.setDynamic('provider.model', 'openai:gpt-5-test');
    providerRegistry = createLaunchTolerantProviderRegistry({
      configManager,
      subscriptionManager: subscriptions,
      secretsManager: secrets,
      serviceRegistry,
      capabilityRegistry: new ProviderCapabilityRegistry(),
      cacheHitTracker: new CacheHitTracker(),
      favoritesStore,
      benchmarkStore,
    });
    providerRegistry.registerRuntimeProvider({
      provider: new OpenAIProvider(''),
      replace: true,
      models: [{
        id: 'gpt-5-test',
        provider: 'openai',
        registryKey: 'openai:gpt-5-test',
        displayName: 'GPT-5 Test',
        description: 'GPT-5 test model',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
        contextWindow: 128_000,
        selectable: true,
      }],
    });
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  test('surfaces provider-owned secret-ref and subscription OAuth routes', async () => {
    await secrets.set('OPENAI_API_KEY', goodVibesRef('goodvibes', 'OPENAI_REAL_KEY'), {
      scope: 'project',
      medium: 'secure',
    });
    await secrets.set('OPENAI_REAL_KEY', 'sk-linked', {
      scope: 'project',
      medium: 'secure',
    });
    subscriptions.saveSubscription({
      provider: 'openai',
      accessToken: 'header.payload.signature',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 60_000,
      authMode: 'oauth',
      overrideAmbientApiKeys: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const snapshot = await getProviderRuntimeSnapshot(providerRegistry, 'openai');
    expect(snapshot).toEqual(expect.objectContaining({ providerId: 'openai' }));
    expect(snapshot?.runtime.auth?.routes).toContainEqual(expect.objectContaining({
      route: 'secret-ref',
      configured: true,
    }));
    expect(snapshot?.runtime.auth?.routes).toContainEqual(expect.objectContaining({
      route: 'subscription-oauth',
      configured: true,
    }));

    const usage = await getProviderUsageSnapshot(providerRegistry, 'openai');
    expect(usage).toEqual(expect.objectContaining({ providerId: 'openai' }));
    expect(usage?.usage.streaming).toBe(true);
  });
});
