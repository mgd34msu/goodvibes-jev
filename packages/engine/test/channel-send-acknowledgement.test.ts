import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import type { ChannelDeliveryRequest } from '../sdk/src/platform/channels/delivery/types.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ServiceRegistry } from '../sdk/src/platform/config/service-registry.js';
import type { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { SlackIntegration } from '../sdk/src/platform/integrations/slack.js';

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
function transport(reply: () => Response | Promise<Response>) {
  const mock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => await reply(), { preconnect() {} }));
  restores.push(() => mock.mockRestore());
  return mock;
}
function router(): ChannelDeliveryRouter {
  return new ChannelDeliveryRouter({
    configManager: { get: () => undefined } as unknown as ConfigManager,
    serviceRegistry: { get: () => undefined, resolveSecret: async () => 'synthetic-owned-secret' } as unknown as ServiceRegistry,
    secretsManager: { get: async () => null, getGlobalHome: () => '/owned-synthetic-home' },
    artifactStore: {} as ArtifactStore,
  });
}
function request(surfaceKind: 'slack' | 'telegram'): ChannelDeliveryRequest {
  return { target: { kind: 'surface', surfaceKind, address: 'owned-destination' },
    body: 'owned body', title: 'owned', jobId: 'owned-job', runId: 'owned-run', includeLinks: false };
}

describe('protocol acknowledgement is required for a successful send', () => {
  for (const payload of [{ ok: false, description: 'synthetic private provider rejection' }, { ok: 'true' }, {}, null]) {
    test(`Telegram refuses a non-acknowledgement: ${JSON.stringify(payload)}`, async () => {
      const fetch = transport(() => Response.json(payload));
      await expect(router().deliver(request('telegram'))).rejects.toThrow('did not acknowledge');
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }
  test('Telegram refuses malformed JSON without substituting the destination as a receipt', async () => {
    transport(() => new Response('{ incomplete', { headers: { 'content-type': 'application/json' } }));
    await expect(router().deliver(request('telegram'))).rejects.toThrow('did not acknowledge');
  });
  test('Telegram preserves a real provider message ID after literal acknowledgement', async () => {
    transport(() => Response.json({ ok: true, result: { message_id: 42 } }));
    expect(await router().deliver(request('telegram'))).toBe('42');
  });
  test('a held Telegram response body cannot produce premature acknowledgement', async () => {
    let release!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      release = () => { controller.enqueue(new TextEncoder().encode('{"ok":true,"result":{"message_id":43}}')); controller.close(); };
    } });
    transport(() => new Response(body, { headers: { 'content-type': 'application/json' } }));
    let settled = false;
    const delivery = router().deliver(request('telegram')).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release();
    expect(await delivery).toBe('43');
  });
  for (const payload of [{ ok: false }, { ok: 'true' }, { ok: 1 }, {}, null]) {
    test(`Slack requires literal application acknowledgement: ${JSON.stringify(payload)}`, async () => {
      transport(() => Response.json(payload));
      await expect(new SlackIntegration(undefined, 'synthetic-owned-token').postMessage('owned-channel', 'owned body')).rejects.toThrow();
    });
  }
  test('Slack response URL HTTP failure remains a failure and retires its body', async () => {
    let retired = false;
    transport(() => new Response(new ReadableStream({ cancel() { retired = true; } }), { status: 503 }));
    const input = request('slack');
    const promise = router().deliver({ ...input, binding: { id: 'owned-binding', surfaceKind: 'slack', surfaceId: 'owned', externalId: 'owned',
      metadata: { responseUrl: 'https://hooks.slack.com/actions/owned-synthetic-capability' } } });
    await expect(promise).rejects.toMatchObject({ status: 503 });
    expect(retired).toBe(true);
  });
  test('Slack webhook success awaits owned body retirement', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    transport(() => new Response(new ReadableStream({ cancel() { return held; } })));
    let settled = false;
    const delivery = new SlackIntegration('https://hooks.slack.com/services/owned-synthetic-capability').postWebhook('owned body')
      .finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release(); await delivery;
    expect(settled).toBe(true);
  });
});
