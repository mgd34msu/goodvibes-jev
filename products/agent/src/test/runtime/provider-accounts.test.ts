import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProviderAccountSnapshot } from '../../runtime/provider-account-snapshot.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('provider account snapshot', () => {
  const originalHome = process.env.HOME;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalCwd = process.cwd();
  let root = '';
  let testManagers = createTestManagers();

  beforeEach(() => {
    testManagers = createTestManagers();
    testManagers.providerRegistry.register({
      name: 'openai',
      models: ['gpt-5'],
      // Hand-maintained fixture list; the SDK's registration-time model-source
      // contract requires every register()-ed provider to declare its source.
      modelSource: { kind: 'dated-static', asOf: '2026-07-13' },
      credentialAuthority: 'resolver',
      async chat() {
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'completed',
        };
      },
    });
    testManagers.providerRegistry.setCurrentModel('openai:gpt-5');
    root = makeProjectTempDir('gv-provider-accounts');
    process.env.HOME = root;
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  test('marks expired subscription fallback to API key explicitly', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    testManagers.subscriptionManager.saveSubscription({
      provider: 'openai',
      accessToken: 'header.payload.signature',
      tokenType: 'Bearer',
      expiresAt: Date.now() - 5_000,
      authMode: 'oauth',
      overrideAmbientApiKeys: true,
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 10_000,
    });

    const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager: testManagers.subscriptionManager,
    });
    const snapshot = await buildProviderAccountSnapshot({
      providerModels: testManagers.providerRegistry,
      services: serviceRegistry,
      subscriptions: testManagers.subscriptionManager,
      environment: {
        hasEnvironmentVariable: (name: string) => Boolean(process.env[name]),
      },
    });
    const openai = snapshot.providers.find((entry) => entry.providerId === 'openai');
    expect(openai).toEqual(expect.objectContaining({
      preferredRoute: 'subscription',
      activeRoute: 'api-key',
      fallbackRoute: 'api-key',
      fallbackRisk: expect.stringContaining('preferred subscription path'),
      issues: expect.arrayContaining([
        expect.stringContaining('expired'),
      ]),
    }));
  });

  test('no fallbackRisk when activeRoute equals preferredRoute (healthy subscription)', async () => {
    testManagers.subscriptionManager.saveSubscription({
      provider: 'openai',
      accessToken: 'header.payload.signature',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      authMode: 'oauth',
      overrideAmbientApiKeys: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // No API key present, only subscription, so activeRoute === preferredRoute === 'subscription'.
    const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager: testManagers.subscriptionManager,
    });
    const snapshot = await buildProviderAccountSnapshot({
      providerModels: testManagers.providerRegistry,
      services: serviceRegistry,
      subscriptions: testManagers.subscriptionManager,
      environment: {
        hasEnvironmentVariable: (_name: string) => false,
      },
    });
    const openai = snapshot.providers.find((p) => p.providerId === 'openai');
    expect(openai).toBeDefined();
    // preferredRoute and activeRoute must both be subscription.
    expect(openai!.preferredRoute).toBe('subscription');
    expect(openai!.activeRoute).toBe('subscription');
    // No fallbackRoute when routes are equal.
    expect(openai!.fallbackRoute).toBeUndefined();
    // No fallbackRisk when there is no fallback, operator should not see a spurious risk advisory.
    expect(openai!.fallbackRisk).toBeUndefined();
  });

  test('surfaces unusable provider OAuth posture as a repair issue', async () => {
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'tui', 'services.json'), JSON.stringify({
      testsvc: {
        name: 'testsvc',
        providerId: 'test-provider',
        baseUrl: 'https://example.invalid',
        authType: 'oauth',
        tokenKey: 'TEST_PROVIDER_TOKEN',
        oauth: {
          authUrl: 'https://example.invalid/auth',
          tokenUrl: 'https://example.invalid/token',
          clientId: 'client-id',
          redirectUri: 'http://localhost:1455/callback',
        },
      },
    }, null, 2));

    const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
      subscriptionManager: testManagers.subscriptionManager,
    });
    const snapshot = await buildProviderAccountSnapshot({
      providerModels: testManagers.providerRegistry,
      services: serviceRegistry,
      subscriptions: testManagers.subscriptionManager,
      environment: {
        hasEnvironmentVariable: (name: string) => Boolean(process.env[name]),
      },
    });
    const provider = snapshot.providers.find((entry) => entry.providerId === 'test-provider');
    expect(provider).toEqual(expect.objectContaining({
      oauthReady: true,
      activeRoute: 'unconfigured',
      issues: expect.arrayContaining([
        expect.stringContaining('missing a usable credential'),
      ]),
      recommendedActions: expect.arrayContaining([
        expect.stringContaining('provider OAuth credentials'),
      ]),
    }));
    expect(provider?.recommendedActions.join('\n')).not.toContain('/services');
  });
});
