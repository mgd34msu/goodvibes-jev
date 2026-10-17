import { expect, test } from 'bun:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { handleNtfySurfacePayload } from '../sdk/src/platform/adapters/ntfy/index.js';
import { handleDiscordSurfaceWebhook } from '../sdk/src/platform/adapters/discord/index.js';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/types.js';

test('ntfy releases failed deliveries for retry and retains completed ones', async () => {
  let available = false;
  let sends = 0;
  const context = {
    configManager: { get: (key: string) => key === 'surfaces.ntfy.remoteTopic' ? 'remote' : '' },
    authorizeSurfaceIngress: async () => ({ allowed: true }),
    postNtfyRemoteChatMessage: async () => { sends++; if (!available) throw new Error('offline'); return {}; },
  } as unknown as SurfaceAdapterContext;
  const message = { id: randomUUID(), topic: 'remote', message: 'hello' };
  await expect(handleNtfySurfacePayload(message, context)).rejects.toThrow('offline');
  available = true;
  expect((await handleNtfySurfacePayload(message, context)).status).toBe(202);
  expect(await (await handleNtfySurfacePayload(message, context)).json()).toMatchObject({ reason: 'duplicate-delivery' });
  expect(sends).toBe(2);
});

test('Discord rejects stale signatures and replays but allows a failed command to retry', async () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  let calls = 0;
  let available = false;
  const context = {
    serviceRegistry: { resolveSecret: async (_service: string, field: string) => field === 'publicKey' ? publicKey : undefined },
    authorizeSurfaceIngress: async () => ({ allowed: true }),
    routeBindings: { upsertBinding: async () => ({ id: 'route' }) },
    parseSurfaceControlCommand: async () => ({ command: 'status' }),
    performSurfaceControlCommand: async () => { calls++; if (!available) throw new Error('offline'); return 'done'; },
  } as unknown as SurfaceAdapterContext;
  const body = JSON.stringify({ id: randomUUID(), application_id: 'app', type: 2, token: 'synthetic', data: { name: 'ask', options: [{ name: 'prompt', value: 'status' }] }, user: { id: 'owner' } });
  const request = (age = 0) => {
    const timestamp = String(Math.floor(Date.now() / 1000) - age);
    return new Request('http://localhost/webhook/discord', { method: 'POST', body, headers: {
      'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex'),
    } });
  };
  expect((await handleDiscordSurfaceWebhook(request(600), context)).status).toBe(401);
  expect(calls).toBe(0);
  await expect(handleDiscordSurfaceWebhook(request(), context)).rejects.toThrow('offline');
  available = true;
  expect((await handleDiscordSurfaceWebhook(request(), context)).status).toBe(200);
  expect((await handleDiscordSurfaceWebhook(request(), context)).status).toBe(200);
  expect(calls).toBe(2);
});
