/**
 * surfaces.webhook.defaultTarget is declared secret-bearing: an outbound
 * webhook URL commonly carries its own token, and its credential reading
 * could not settle, so the credential-scope gate, which now fails closed,
 * requires it declared. A declared value may be stored as a secret
 * reference, so the webhook delivery strategy resolves it before posting.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createWebhookDeliveryStrategy } from '../sdk/src/platform/channels/delivery/strategies-core.js';
import { isSecretBearingConfigKey } from '../sdk/src/platform/config/secret-bearing-config-keys.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('the webhook default target', () => {
  test('is declared secret-bearing', () => {
    expect(isSecretBearingConfigKey('surfaces.webhook.defaultTarget')).toBe(true);
  });

  test('a secret reference is resolved before the webhook is posted', async () => {
    const posted: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      posted.push(String(input instanceof Request ? input.url : input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const config = {
      get: (key: string) => ({
        'surfaces.webhook.defaultTarget': 'goodvibes://secrets/goodvibes/WEBHOOK_DEFAULT_TARGET',
        'surfaces.webhook.timeoutMs': 5_000,
      } as Record<string, unknown>)[key],
    } as unknown as ConfigManager;
    const secrets = {
      get: async (key: string): Promise<string | null> => (key === 'WEBHOOK_DEFAULT_TARGET' ? 'https://hooks.example.com/services/T0/B0/token123' : null),
      getGlobalHome: () => '/nonexistent-goodvibes-home',
    };
    const strategy = createWebhookDeliveryStrategy(config, {} as ArtifactStore, secrets);
    await strategy.deliver({ target: { kind: 'webhook' }, body: 'hello' } as never);
    expect(posted).toEqual(['https://hooks.example.com/services/T0/B0/token123']);
  });
});
