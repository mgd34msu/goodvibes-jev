import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ControlPlaneGateway } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function createDefaultRouter(root?: string, overrides: {
  readonly configManager?: ConfigManager;
  readonly artifactStore?: ArtifactStore;
  readonly controlPlaneGateway?: ControlPlaneGateway | null;
  readonly secretsManager?: SecretsManager;
} = {}): ChannelDeliveryRouter {
  const configRoot = root ?? makeProjectTempDir('gv-delivery-router');
  const configManager = overrides.configManager ?? new ConfigManager({ surfaceRoot: 'tui',  configDir: configRoot });
  const secretsManager = overrides.secretsManager ?? new SecretsManager({ projectRoot: configRoot, globalHome: configRoot });
  const serviceRegistry = new ServiceRegistry(join(configRoot, 'services.json'), {
    secretsManager,
    subscriptionManager: new SubscriptionManager(join(configRoot, 'subscriptions.json')),
  });
  const artifactStore = overrides.artifactStore ?? new ArtifactStore({ rootDir: join(configRoot, 'artifacts') });
  return new ChannelDeliveryRouter({
    configManager,
    secretsManager,
    serviceRegistry,
    artifactStore,
    ...(overrides.controlPlaneGateway ? { controlPlaneGateway: overrides.controlPlaneGateway } : {}),
  });
}
describe('ChannelDeliveryRouter', () => {
  test('resolves Slack bot token through GoodVibes config secret refs', async () => {
    const root = makeProjectTempDir('gv-delivery-router-slack');
    const config = new ConfigManager({ surfaceRoot: 'tui', configDir: root });
    const secretsManager = new SecretsManager({ projectRoot: root, globalHome: root, configManager: config });
    const originalFetch = globalThis.fetch;
    let authorizationHeader = '';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://slack.com/api/chat.postMessage');
      authorizationHeader = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      config.set('surfaces.slack.botToken', 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN');
      await secretsManager.set('SLACK_BOT_TOKEN', 'xoxb-from-goodvibes');
      const router = createDefaultRouter(root, { configManager: config, secretsManager });

      await router.deliver({
        target: { kind: 'surface', surfaceKind: 'slack', address: 'C123' },
        body: 'slack hello',
        title: 'Slack delivery',
        jobId: 'job-slack',
        runId: 'run-slack',
        includeLinks: false,
      });

      expect(authorizationHeader).toBe('Bearer xoxb-from-goodvibes');
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
