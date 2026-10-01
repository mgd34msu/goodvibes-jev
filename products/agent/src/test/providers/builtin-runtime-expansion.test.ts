import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { FavoritesStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { BenchmarkStore } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderCapabilityRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { CacheHitTracker } from '@goodvibes-jev/engine/sdk/platform/providers';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createLaunchTolerantProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const CLEAN_ENV_KEYS = [
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
];

function expectPresent<T>(value: T | null | undefined, description: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${description}`);
  }
  return value;
}

describe('provider runtime expansion', () => {
  const originalHome = process.env.HOME;
  const originalEnv = new Map<string, string | undefined>();
  let tempHome = '';
  let providerRegistry: ProviderRegistry;

  beforeEach(() => {
    tempHome = makeProjectTempDir('gv-provider-expansion');
    process.env.HOME = tempHome;
    for (const key of CLEAN_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(tempHome, '.goodvibes', 'tui') });
    const subscriptionManager = new SubscriptionManager(join(tempHome, '.goodvibes', 'tui', 'subscriptions.json'));
    const secretsManager = new SecretsManager({ projectRoot: tempHome, globalHome: tempHome });
    const serviceRegistry = new ServiceRegistry(join(tempHome, '.goodvibes', 'tui', 'services.json'), {
      secretsManager,
      subscriptionManager,
    });
    const favoritesStore = new FavoritesStore({ dir: join(tempHome, '.goodvibes', 'tui') });
    const benchmarkStore = new BenchmarkStore({ dir: join(tempHome, '.goodvibes', 'tui') });
    providerRegistry = createLaunchTolerantProviderRegistry({
      configManager,
      subscriptionManager,
      secretsManager,
      serviceRegistry,
      capabilityRegistry: new ProviderCapabilityRegistry(),
      cacheHitTracker: new CacheHitTracker(),
      favoritesStore,
      benchmarkStore,
    });
  });

  afterEach(() => {
    for (const key of CLEAN_ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test('registers all approved builtin provider and gateway integrations', () => {
    const providerIds = new Set(providerRegistry.listProviders().map((provider) => provider.name));
    for (const providerId of [
      'amazon-bedrock',
      'amazon-bedrock-mantle',
      'anthropic-vertex',
      'deepseek',
      'fireworks',
      'github-copilot',
      'microsoft-foundry',
      'minimax',
      'moonshot',
      'qianfan',
      'qwen',
      'sglang',
      'stepfun',
      'together',
      'venice',
      'volcengine',
      'xai',
      'xiaomi',
      'zai',
      'vercel-ai-gateway',
      'litellm',
      'copilot-proxy',
    ]) {
      expect(providerIds.has(providerId)).toBe(true);
    }
  });

  test('resolves builtin provider aliases through the registry', () => {
    expect(providerRegistry.getRegistered('copilot').name).toBe('github-copilot');
    expect(providerRegistry.getRegistered('azure-openai').name).toBe('microsoft-foundry');
    expect(providerRegistry.getRegistered('dashscope').name).toBe('qwen');
    expect(providerRegistry.getRegistered('volcano-engine').name).toBe('volcengine');
    expect(providerRegistry.getRegistered('x-ai').name).toBe('xai');
    expect(providerRegistry.getRegistered('z-ai').name).toBe('zai');
    expect(providerRegistry.getRegistered('ai-gateway').name).toBe('vercel-ai-gateway');
  });

  test('surfaces runtime auth and policy metadata for new custom and gateway providers', async () => {
    const bedrockProvider = providerRegistry.getRegistered('amazon-bedrock');
    expect(typeof bedrockProvider.describeRuntime).toBe('function');
    const bedrockRuntime = await providerRegistry.describeRuntime('amazon-bedrock');
    const bedrock = expectPresent(bedrockRuntime, 'amazon-bedrock runtime metadata');
    expect(bedrock.auth?.routes?.map((route) => route.route)).toContain('anonymous');
    expect(bedrock.policy?.streamProtocol).toBe('anthropic-sdk-stream');

    const vertexProvider = providerRegistry.getRegistered('anthropic-vertex');
    expect(typeof vertexProvider.describeRuntime).toBe('function');
    const vertexRuntime = await providerRegistry.describeRuntime('anthropic-vertex');
    const vertex = expectPresent(vertexRuntime, 'anthropic-vertex runtime metadata');
    expect(vertex.auth?.routes?.map((route) => route.route)).toContain('anonymous');
    expect(vertex.policy?.streamProtocol).toBe('anthropic-sdk-stream');

    const copilotProvider = providerRegistry.getRegistered('github-copilot');
    expect(typeof copilotProvider.describeRuntime).toBe('function');
    const copilotRuntime = await providerRegistry.describeRuntime('github-copilot');
    const copilot = expectPresent(copilotRuntime, 'github-copilot runtime metadata');
    expect(copilot.auth?.envVars).toContain('GH_TOKEN');
    expect(copilot.models?.aliases).toContain('copilot');

    const litellmProvider = providerRegistry.getRegistered('litellm');
    expect(typeof litellmProvider.describeRuntime).toBe('function');
    const litellmRuntime = await providerRegistry.describeRuntime('litellm');
    const litellm = expectPresent(litellmRuntime, 'litellm runtime metadata');
    expect(litellm.auth?.mode).toBe('anonymous');
    expect(litellm.auth?.configured).toBe(true);
    expect(litellm.auth?.routes?.map((route) => route.route)).toContain('anonymous');

    const xaiProvider = providerRegistry.getRegistered('xai');
    expect(typeof xaiProvider.describeRuntime).toBe('function');
    const xaiRuntime = await providerRegistry.describeRuntime('xai');
    const xai = expectPresent(xaiRuntime, 'xai runtime metadata');
    expect(xai.models?.defaultModel).toBe('grok-4');
    expect(xai.models?.aliases).toContain('x-ai');
  });
});
