/** Owned synthetic transports only: a revoked check-in must not send after preparation settles. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ArtifactAttachment, ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import { createWebhookDeliveryStrategy } from '../sdk/src/platform/channels/delivery/strategies-core.js';
import type { ChannelDeliveryRequest, ChannelDeliverySurfaceKind, ChannelDeliveryStrategy } from '../sdk/src/platform/channels/delivery/types.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ServiceRegistry } from '../sdk/src/platform/config/service-registry.js';
import type { ControlPlaneGateway } from '../sdk/src/platform/control-plane/gateway.js';
import { pinnedFetch } from '../sdk/src/platform/tools/fetch/pinned-request.js';
import { assertDeliveryCurrent } from '../sdk/src/platform/utils/delivery-lifetime.js';
import { logger } from '../sdk/src/platform/utils/logger.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const revoked = new Error('Owned delivery authority revoked');
function lifetime() {
  const controller = new AbortController();
  let current = true;
  return {
    signal: controller.signal,
    assertCurrent() { if (!current) throw revoked; },
    revoke() { current = false; },
    abort() { controller.abort(revoked); },
  };
}

type WireCall = { url: string; init: RequestInit | undefined };
let calls: WireCall[];
let restore: Array<() => void>;
let transport: (call: WireCall) => Promise<Response>;
let fixtureNumber = 0;

beforeEach(() => {
  calls = [];
  restore = [];
  transport = async ({ url }) => new URL(url).hostname === 'login.microsoftonline.com'
    ? Response.json({ access_token: 'owned-access-token', expires_in: 3600 })
    : Response.json({ ok: true, id: 'owned-message', result: { message_id: 7 } });
  const mock = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: input instanceof Request ? input.url : String(input), init };
    calls.push(call);
    return transport(call);
  }, { preconnect() { throw new Error('Unexpected preconnect in synthetic delivery test'); } }));
  restore.push(() => mock.mockRestore());
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const log = spyOn(logger, level).mockImplementation(() => {});
    restore.push(() => log.mockRestore());
  }
});
afterEach(() => { for (const undo of restore.reverse()) undo(); });

interface Provider {
  name: string;
  surface: ChannelDeliverySurfaceKind;
  config?: Record<string, unknown>;
  address?: string;
  metadata?: Record<string, unknown>;
}
const providers: Provider[] = [
  { name: 'Slack API', surface: 'slack' },
  { name: 'Discord API', surface: 'discord', address: '123456789012345678' },
  { name: 'ntfy', surface: 'ntfy' },
  { name: 'Home Assistant', surface: 'homeassistant', config: { 'surfaces.homeassistant.instanceUrl': 'https://ha.example.invalid' } },
  { name: 'Telegram', surface: 'telegram' },
  { name: 'Google Chat', surface: 'google-chat', address: '' },
  { name: 'Signal', surface: 'signal', config: { 'surfaces.signal.bridgeUrl': 'https://signal.example.invalid' } },
  { name: 'WhatsApp Meta', surface: 'whatsapp', config: { 'surfaces.whatsapp.provider': 'meta-cloud', 'surfaces.whatsapp.phoneNumberId': 'owned-phone' } },
  { name: 'WhatsApp bridge', surface: 'whatsapp', config: { 'surfaces.whatsapp.provider': 'bridge' } },
  { name: 'Telephony SMS', surface: 'telephony', config: { 'surfaces.telephony.provider': 'twilio', 'surfaces.telephony.accountSid': 'owned-sid', 'surfaces.telephony.fromNumber': '+15555550100' } },
  { name: 'Telephony voice', surface: 'telephony', config: { 'surfaces.telephony.provider': 'twilio', 'surfaces.telephony.mode': 'voice', 'surfaces.telephony.accountSid': 'owned-sid', 'surfaces.telephony.fromNumber': '+15555550100' } },
  { name: 'Telephony bridge', surface: 'telephony', config: { 'surfaces.telephony.provider': 'bridge', 'surfaces.telephony.bridgeUrl': 'https://telephony.example.invalid' } },
  { name: 'iMessage', surface: 'imessage', config: { 'surfaces.imessage.bridgeUrl': 'https://imessage.example.invalid' } },
  { name: 'Teams', surface: 'msteams', config: { 'surfaces.msteams.serviceUrl': 'https://teams.example.invalid' } },
  { name: 'BlueBubbles', surface: 'bluebubbles', config: { 'surfaces.bluebubbles.serverUrl': 'https://bluebubbles.example.invalid' } },
  { name: 'Mattermost', surface: 'mattermost', config: { 'surfaces.mattermost.baseUrl': 'https://mattermost.example.invalid' } },
  { name: 'Matrix', surface: 'matrix', config: { 'surfaces.matrix.homeserverUrl': 'https://matrix.example.invalid' } },
];
const attachment = { artifactId: 'owned-artifact', filename: 'owned.txt', mimeType: 'text/plain', sizeBytes: 5, contentPath: '/owned/artifact' } as ArtifactAttachment;
const secrets = { get: async () => null, getGlobalHome: () => '/owned/no-secrets' };
function fixture(provider: Provider, options: {
  resolveSecret?: (service: string) => Promise<string>;
  toAttachment?: () => Promise<ArtifactAttachment>;
  gateway?: ControlPlaneGateway;
} = {}) {
  const values = { ...provider.config, 'surfaces.msteams.appId': `owned-app-${++fixtureNumber}` };
  const config = { get: (key: string) => values[key as keyof typeof values] } as unknown as ConfigManager;
  const registry = {
    resolveSecret: options.resolveSecret ?? (async (service: string) => service === 'google-chat' ? 'https://google-chat.example.invalid' : 'owned-token'),
    get: () => ({ baseUrl: 'https://bridge.example.invalid' }),
  } as unknown as ServiceRegistry;
  const artifacts = { toAttachment: options.toAttachment ?? (async () => attachment) } as unknown as ArtifactStore;
  const request: ChannelDeliveryRequest = {
    target: { kind: 'surface', surfaceKind: provider.surface, ...(provider.address === '' ? {} : { address: provider.address ?? 'owned-recipient' }) },
    body: 'Owned delivery body', title: 'Owned check-in', jobId: 'owned-job', runId: 'owned-run', includeLinks: false, allowDuplicate: true,
    ...(provider.metadata ? { binding: { id: 'owned-route', surfaceKind: 'slack', surfaceId: 'owned-surface', externalId: 'owned-external', metadata: provider.metadata } } : {}),
  };
  return {
    config, registry, artifacts, request,
    router: new ChannelDeliveryRouter({ configManager: config, serviceRegistry: registry, artifactStore: artifacts, secretsManager: secrets, controlPlaneGateway: options.gateway }),
  };
}

describe('built-in guarded delivery', () => {
  for (const provider of providers) {
    test(`${provider.name}: revocation during credential resolution produces zero outbound calls`, async () => {
      const entered = deferred<void>();
      const credentials = deferred<string>();
      const owner = lifetime();
      const f = fixture(provider, { resolveSecret: async () => { entered.resolve(); return credentials.promise; } });
      const pending = f.router.deliver({ ...f.request, signal: owner.signal, assertCurrent: owner.assertCurrent });
      await entered.promise;
      owner.revoke();
      credentials.resolve(provider.surface === 'google-chat' ? 'https://google-chat.example.invalid' : 'owned-token');
      await expect(pending).rejects.toBe(revoked);
      expect(calls).toHaveLength(0);
    });

    test(`${provider.name}: current delivery reaches synthetic transport and propagates abort`, async () => {
      const owner = lifetime();
      const f = fixture(provider);
      await f.router.deliver({ ...f.request, signal: owner.signal, assertCurrent: owner.assertCurrent });
      expect(calls.length).toBe(provider.surface === 'msteams' ? 2 : 1);
      for (const call of calls) {
        expect(call.init?.signal).toBeDefined();
        expect(call.init?.signal?.aborted).toBe(false);
        const body = String(call.init?.body);
        expect(body).not.toContain('assertCurrent');
        expect(body).not.toContain('"signal":');
      }
      owner.abort();
      for (const call of calls) expect(call.init?.signal?.aborted).toBe(true);
      // A successful delivery stays successful. Abort cannot undo a send already accepted.
    });
  }

  for (const provider of [
    { name: 'Slack explicit webhook', surface: 'slack', address: 'https://slack.example.invalid/hook' },
    { name: 'Slack response URL', surface: 'slack', metadata: { responseUrl: 'https://hooks.slack.com/owned' } },
    { name: 'Discord explicit webhook', surface: 'discord', address: 'https://discord.example.invalid/hook' },
    { name: 'Discord original response', surface: 'discord', metadata: { applicationId: '123456789012345678', interactionToken: 'owned-interaction' } },
  ] satisfies Provider[]) {
    test(`${provider.name}: attachment wait is guarded before SDK transport`, async () => {
      const entered = deferred<void>();
      const attachments = deferred<ArtifactAttachment>();
      const owner = lifetime();
      const f = fixture(provider, { toAttachment: async () => { entered.resolve(); return attachments.promise; } });
      const pending = f.router.deliver({ ...f.request, attachments: [{ artifactId: 'owned-artifact' }], signal: owner.signal, assertCurrent: owner.assertCurrent });
      await entered.promise;
      owner.revoke();
      attachments.resolve(attachment);
      await expect(pending).rejects.toBe(revoked);
      expect(calls).toHaveLength(0);
    });
  }

  test('revocation during nested local-secret resolution prevents Slack SDK send', async () => {
    const entered = deferred<void>();
    const secret = deferred<string>();
    const owner = lifetime();
    const f = fixture({ name: 'Slack local secret', surface: 'slack', config: {
      'surfaces.slack.botToken': 'goodvibes://secrets/goodvibes/owned-token',
    } });
    const router = new ChannelDeliveryRouter({
      configManager: f.config,
      serviceRegistry: { resolveSecret: async () => undefined, get: () => undefined } as unknown as ServiceRegistry,
      artifactStore: f.artifacts,
      secretsManager: { get: async () => { entered.resolve(); return secret.promise; }, getGlobalHome: () => '/owned/no-secrets' },
    });
    const pending = router.deliver({ ...f.request, assertCurrent: owner.assertCurrent });
    await entered.promise;
    owner.revoke();
    secret.resolve('owned-local-token');
    await expect(pending).rejects.toBe(revoked);
    expect(calls).toHaveLength(0);
  });

  test('abort alone during credential preparation is enforced', async () => {
    const entered = deferred<void>();
    const credentials = deferred<string>();
    const owner = lifetime();
    const f = fixture(providers[0]!, { resolveSecret: async () => { entered.resolve(); return credentials.promise; } });
    const pending = f.router.deliver({ ...f.request, signal: owner.signal });
    await entered.promise;
    owner.abort();
    credentials.resolve('owned-token');
    await expect(pending).rejects.toBe(revoked);
    expect(calls).toHaveLength(0);
  });

  test('revocation while Teams token response is pending prevents the message POST', async () => {
    const entered = deferred<void>();
    const token = deferred<Response>();
    const owner = lifetime();
    transport = async () => { entered.resolve(); return token.promise; };
    const f = fixture(providers.find((p) => p.surface === 'msteams')!);
    const pending = f.router.deliver({ ...f.request, assertCurrent: owner.assertCurrent });
    await entered.promise;
    owner.revoke();
    token.resolve(Response.json({ access_token: 'owned-late-token', expires_in: 3600 }));
    await expect(pending).rejects.toBe(revoked);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('login.microsoftonline.com');
  });

  test('web control-plane publication is guarded after attachment preparation', async () => {
    const entered = deferred<void>();
    const attachments = deferred<ArtifactAttachment>();
    let published = 0;
    const owner = lifetime();
    const gateway = { publishSurfaceMessage() { published++; return { id: 'owned-publication' }; } } as unknown as ControlPlaneGateway;
    const f = fixture({ name: 'Web', surface: 'web' }, { gateway, toAttachment: async () => { entered.resolve(); return attachments.promise; } });
    const pending = f.router.deliver({ ...f.request, attachments: [{ artifactId: 'owned-artifact' }], assertCurrent: owner.assertCurrent });
    await entered.promise;
    owner.revoke();
    attachments.resolve(attachment);
    await expect(pending).rejects.toBe(revoked);
    expect(published).toBe(0);
    await expect(f.router.deliver({ ...f.request, assertCurrent() {} })).resolves.toBe('owned-publication');
    expect(published).toBe(1);
  });
});

describe('DNS and pinned webhook transport lifetime', () => {
  for (const mode of ['guard', 'signal'] as const) {
    test(`${mode}: revocation while DNS is pending prevents the first actual fetch`, async () => {
      const entered = deferred<void>();
      const dns = deferred<readonly { address: string; family: number }[]>();
      const f = fixture({ name: 'Webhook', surface: 'webhook', address: 'https://owned.example.invalid/hook' });
      const strategy = createWebhookDeliveryStrategy(f.config, f.artifacts, secrets, { resolveHost: async () => { entered.resolve(); return dns.promise; } });
      const router = new ChannelDeliveryRouter({ strategies: [strategy] });
      const owner = lifetime();
      const pending = router.deliver({ ...f.request, ...(mode === 'guard' ? { assertCurrent: owner.assertCurrent } : { signal: owner.signal }) });
      await entered.promise;
      mode === 'guard' ? owner.revoke() : owner.abort();
      dns.resolve([{ address: '203.0.113.31', family: 4 }]);
      await expect(pending).rejects.toBe(revoked);
      expect(calls).toHaveLength(0);
    });
  }

  test('current webhook sends to the checked address with its lifetime signal', async () => {
    const f = fixture({ name: 'Webhook', surface: 'webhook', address: 'https://owned.example.invalid/hook' });
    const strategy = createWebhookDeliveryStrategy(f.config, f.artifacts, secrets, { resolveHost: async () => [{ address: '203.0.113.31', family: 4 }] });
    const owner = lifetime();
    await new ChannelDeliveryRouter({ strategies: [strategy] }).deliver({ ...f.request, signal: owner.signal, assertCurrent: owner.assertCurrent });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://203.0.113.31/hook');
    expect(new Headers(calls[0]!.init?.headers).get('host')).toBe('owned.example.invalid');
    owner.abort();
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
  });

  test('existing address fallback rechecks authority before another outbound attempt', async () => {
    const owner = lifetime();
    transport = async () => { owner.revoke(); throw new Error('Owned connection failure'); };
    await expect(pinnedFetch('https://owned.example.invalid/hook', { method: 'POST' }, [
      { address: '203.0.113.31', family: 4 }, { address: '203.0.113.32', family: 4 },
    ], 'opaque-url', owner.assertCurrent)).rejects.toBe(revoked);
    expect(calls).toHaveLength(1);
  });
});

describe('custom strategy and agent capability contracts', () => {
  for (const mutation of ['remove', 'replace', 'remove-readd', 'replace-same'] as const) {
    test(`${mutation} selected strategy during credential preparation revokes guarded send`, async () => {
      const entered = deferred<void>();
      const credentials = deferred<string>();
      const owner = lifetime();
      const f = fixture(providers[0]!, { resolveSecret: async () => { entered.resolve(); return credentials.promise; } });
      const strategy = f.router.listStrategies().find((entry) => entry.id === 'channel-delivery:slack')!;
      const pending = f.router.deliver({ ...f.request, signal: owner.signal, assertCurrent: owner.assertCurrent });
      await entered.promise;
      if (mutation === 'replace' || mutation === 'replace-same') {
        f.router.registerStrategy(mutation === 'replace-same' ? strategy : { ...strategy }, { replace: true });
      } else {
        expect(f.router.unregisterStrategy(strategy.id)).toBe(true);
        if (mutation === 'remove-readd') f.router.registerStrategy(strategy);
      }
      credentials.resolve('owned-token');
      await expect(pending).rejects.toThrow('registration is no longer current');
      expect(calls).toHaveLength(0);
    });
  }

  test('removing and re-adding a strategy during DNS preparation cannot revive a guarded webhook', async () => {
    const entered = deferred<void>();
    const dns = deferred<readonly { address: string; family: number }[]>();
    const f = fixture({ name: 'Webhook', surface: 'webhook', address: 'https://owned.example.invalid/hook' });
    const strategy = createWebhookDeliveryStrategy(f.config, f.artifacts, secrets, { resolveHost: async () => { entered.resolve(); return dns.promise; } });
    const router = new ChannelDeliveryRouter({ strategies: [strategy] });
    const pending = router.deliver({ ...f.request, assertCurrent() {} });
    await entered.promise;
    router.unregisterStrategy(strategy.id);
    router.registerStrategy(strategy);
    dns.resolve([{ address: '203.0.113.31', family: 4 }]);
    await expect(pending).rejects.toThrow('registration is no longer current');
    expect(calls).toHaveLength(0);
  });

  test('an unrelated strategy mutation does not revoke a current guarded send', async () => {
    const entered = deferred<void>();
    const credentials = deferred<string>();
    const f = fixture(providers[0]!, { resolveSecret: async () => { entered.resolve(); return credentials.promise; } });
    const pending = f.router.deliver({ ...f.request, assertCurrent() {} });
    await entered.promise;
    f.router.unregisterStrategy('channel-delivery:telegram');
    credentials.resolve('owned-token');
    await expect(pending).resolves.toBe('owned-recipient');
    expect(calls).toHaveLength(1);
  });

  test('unguarded delivery preserves prior behavior when its strategy is removed during preparation', async () => {
    const entered = deferred<void>();
    const credentials = deferred<string>();
    const f = fixture(providers[0]!, { resolveSecret: async () => { entered.resolve(); return credentials.promise; } });
    const pending = f.router.deliver(f.request);
    await entered.promise;
    f.router.unregisterStrategy('channel-delivery:slack');
    credentials.resolve('owned-token');
    await expect(pending).resolves.toBe('owned-recipient');
    expect(calls).toHaveLength(1);
  });

  test('custom strategy without capability fails closed only for guarded requests', async () => {
    let delivered = 0;
    const router = new ChannelDeliveryRouter({ strategies: [{ id: 'owned-custom', canHandle: () => true, async deliver() { delivered++; return { responseId: 'owned-custom-message' }; } }] });
    const { request } = fixture(providers[0]!);
    await expect(router.deliver({ ...request, assertCurrent() {} })).rejects.toThrow('does not support guarded delivery');
    await expect(router.deliver({ ...request, signal: new AbortController().signal })).rejects.toThrow('does not support guarded delivery');
    expect(delivered).toBe(0);
    await expect(router.deliver(request)).resolves.toBe('owned-custom-message');
    expect(delivered).toBe(1);
  });

  test('capability-advertising custom strategy receives the lifetime', async () => {
    const owner = lifetime();
    const router = new ChannelDeliveryRouter({ strategies: [{ id: 'owned-capable', supportsGuardedDelivery: true, canHandle: () => true, async deliver(request) {
      expect(request.signal).toBe(owner.signal);
      expect(request.assertCurrent).toBeDefined();
      assertDeliveryCurrent(request);
      return { responseId: 'owned-custom-message' };
    } }] });
    const { request } = fixture(providers[0]!);
    await expect(router.deliver({ ...request, signal: owner.signal, assertCurrent: owner.assertCurrent })).resolves.toBe('owned-custom-message');
  });

  test('agent refuses unsupported sender without calling it; ordinary sends still work', async () => {
    const router = new ChannelDeliveryRouter({ strategies: [] });
    let delivered = 0;
    router.agentDelivery.register({ id: 'owned-legacy-sender', async send() { delivered++; return 'owned-agent-message'; } });
    const { request } = fixture({ name: 'Agent', surface: 'agent' });
    await expect(router.deliver({ ...request, assertCurrent() {} })).rejects.toThrow('sender does not support guarded delivery');
    expect(delivered).toBe(0);
    await expect(router.deliver(request)).resolves.toBe('owned-agent-message');
    expect(delivered).toBe(1);
  });

  test('current capable agent sender lands a guarded message', async () => {
    const owner = lifetime();
    const router = new ChannelDeliveryRouter({ strategies: [] });
    let delivered = 0;
    router.agentDelivery.register({ id: 'owned-capable-sender', supportsGuardedDelivery: true, async send(message, lifetime) {
      assertDeliveryCurrent(lifetime!);
      expect(message.body).toBe('Owned delivery body');
      expect(lifetime?.signal).toBe(owner.signal);
      delivered++;
      return 'owned-agent-message';
    } });
    const { request } = fixture({ name: 'Agent', surface: 'agent' });
    await expect(router.deliver({ ...request, signal: owner.signal, assertCurrent: owner.assertCurrent })).resolves.toBe('owned-agent-message');
    expect(delivered).toBe(1);
  });

  test('capable agent sender can enforce the guard after its own asynchronous preparation', async () => {
    const owner = lifetime();
    const entered = deferred<void>();
    const ready = deferred<void>();
    const router = new ChannelDeliveryRouter({ strategies: [] });
    let delivered = 0;
    router.agentDelivery.register({ id: 'owned-capable-sender', supportsGuardedDelivery: true, async send(message, lifetime) {
      expect(message).not.toHaveProperty('signal');
      expect(lifetime?.signal).toBe(owner.signal);
      entered.resolve();
      await ready.promise;
      assertDeliveryCurrent(lifetime!);
      delivered++;
      return 'owned-agent-message';
    } });
    const { request } = fixture({ name: 'Agent', surface: 'agent' });
    const pending = router.deliver({ ...request, signal: owner.signal, assertCurrent: owner.assertCurrent });
    await entered.promise;
    owner.revoke();
    ready.resolve();
    await expect(pending).rejects.toBe(revoked);
    expect(delivered).toBe(0);
  });
});

for (const kind of ['inherited', 'accessor'] as const) {
  test(`direct custom strategy ${kind} capability cannot opt in or run getters`, async () => {
    let delivered = 0, getterCalls = 0;
    const strategy: ChannelDeliveryStrategy = { id: 'direct-untrusted', canHandle: () => true, async deliver() { delivered++; return {}; } };
    if (kind === 'inherited') Object.setPrototypeOf(strategy, { supportsGuardedDelivery: true });
    else Object.defineProperty(strategy, 'supportsGuardedDelivery', { get() { getterCalls++; return true; } });
    const router = new ChannelDeliveryRouter({ strategies: [strategy] });
    const { request } = fixture(providers[0]!);
    await expect(router.deliver({ ...request, assertCurrent() {} })).rejects.toThrow('does not support guarded delivery');
    expect(delivered).toBe(0); expect(getterCalls).toBe(0);
  });
  test(`agent sender ${kind} capability cannot opt in or run getters`, async () => {
    let delivered = 0, getterCalls = 0;
    const sender = { id: 'untrusted-sender', async send() { delivered++; return undefined; } };
    if (kind === 'inherited') Object.setPrototypeOf(sender, { supportsGuardedDelivery: true });
    else Object.defineProperty(sender, 'supportsGuardedDelivery', { get() { getterCalls++; return true; } });
    const router = new ChannelDeliveryRouter({ strategies: [] }); router.agentDelivery.register(sender);
    const { request } = fixture({ name: 'Agent', surface: 'agent' });
    await expect(router.deliver({ ...request, assertCurrent() {} })).rejects.toThrow('does not support guarded delivery');
    expect(delivered).toBe(0); expect(getterCalls).toBe(0);
  });
}
for (const change of ['remove', 'replace', 'remove-readd'] as const) {
  test(`agent sender ${change} during preparation fences its old registration`, async () => {
    const entered = deferred<void>(), ready = deferred<void>(); let delivered = 0;
    const router = new ChannelDeliveryRouter({ strategies: [] });
    const sender = { id: 'captured-sender', supportsGuardedDelivery: true,
      async send(_message: unknown, lifetime?: import('../sdk/src/platform/utils/delivery-lifetime.js').DeliveryLifetime) {
        entered.resolve(); await ready.promise; assertDeliveryCurrent(lifetime!); delivered++; return 'sent';
      } };
    const unregister = router.agentDelivery.register(sender);
    const { request } = fixture({ name: 'Agent', surface: 'agent' });
    const pending = router.deliver({ ...request, assertCurrent() {} }); await entered.promise;
    if (change === 'replace') router.agentDelivery.register({ ...sender, id: 'replacement' }, { replace: true });
    else { unregister(); if (change === 'remove-readd') router.agentDelivery.register(sender); }
    ready.resolve(); await expect(pending).rejects.toThrow('registration is no longer current'); expect(delivered).toBe(0);
  });
}
test('direct capability mutation cannot upgrade registration without explicit replacement', async () => {
  let delivered = 0;
  const strategy = { id: 'captured-opt-in', supportsGuardedDelivery: false, canHandle: () => true, async deliver(request: ChannelDeliveryRequest) { assertDeliveryCurrent(request); delivered++; return {}; } };
  const router = new ChannelDeliveryRouter({ strategies: [strategy] }); strategy.supportsGuardedDelivery = true;
  const { request } = fixture(providers[0]!);
  await expect(router.deliver({ ...request, assertCurrent() {} })).rejects.toThrow('does not support guarded delivery'); expect(delivered).toBe(0);
  router.registerStrategy(strategy, { replace: true }); await router.deliver({ ...request, assertCurrent() {} }); expect(delivered).toBe(1);
});
