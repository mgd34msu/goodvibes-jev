import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, SecretsManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createProductionDaemonInboxFactory } from '../../runtime/production-inbox-composition.js';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { DaemonInboxFactory } from '../../runtime/daemon-handler-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { SecretsManager as NativeSecretsManager } from '../../config/secrets.js';
import { registerOwnedMailInbox } from '../../runtime/owned-inbox-mail.js';
import { createDiscordInboxOwner, createSlackInboxOwner, createEmailInboxOwner } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { OwnedInboxSource } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { HostedInboxScreeningAcquisition } from '../../runtime/hosted-source-screening-composition.js';

async function initialReady(created: ReturnType<DaemonInboxFactory>): Promise<void> {
  const surface = await created;
  try {
    if (!surface.ready) throw new Error('Expected owned inbox source readiness');
    await surface.ready;
  } finally { await surface.close(); }
}

function fixture() {
  const root = makeOwnedTempDir('production-inbox');
  const values = new Map<string, string>();
  const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'daemon' });
  const listeners = new Set<() => void>(); let polling = 0;
  const ctx: HandlerContext = { catalog: new GatewayMethodCatalog(), workingDirectory: root, homeDirectory: root,
    logger: { info() {}, warn() {}, error() {} },
    configManager,
    credentials: { inspectConfigSecret(key) { return values.has(key) ? 'present' : 'absent'; },
      async resolveConfigSecret() { throw new Error('Absence admission must not resolve credentials'); }, async resolveRef() { return null; },
      async put() { throw new Error('No credential writes'); }, async has() { return false; } },
  };
  const controls = { gatePolling() { polling++; }, onAccountInvalidation(listener: () => void) {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } };
  const invoke = () => ctx.catalog.invoke('channels.inbox.list', { body: {}, context: { scopes: ['read:channels'] } });
  return { root, ctx, configManager, values, listeners, controls, invoke, get polling() { return polling; } };
}
const routing = {} as Parameters<DaemonInboxFactory>[1];
const syntheticScreening = {
  authority: { ownerId: 'synthetic-bootstrap-screening', revision: 'v1', retention: 'ephemeral-no-log' as const,
    signal: new AbortController().signal, assertCurrent() {} },
  proposal: { endpoint: 'http://127.0.0.1:1', model: 'synthetic-proposer' },
  judgment: { endpoint: 'http://127.0.0.1:1', model: 'jev-1.13.0' as const },
};

test('fresh production membership reports all three unconfigured sources with no polling or storage', async () => {
  const f = fixture(); const surface = await createProductionDaemonInboxFactory()(f.ctx, routing, f.controls);
  try {
    await surface.ready;
    expect(await f.invoke()).toMatchObject({ items: [], total: 0, partial: false,
      providers: ['slack', 'discord', 'email'].map(provider => ({ provider, state: 'unconfigured', configured: false, syncing: false })) });
    expect(f.polling).toBe(0);
    expect(existsSync(join(f.root, '.goodvibes', 'tui', 'operator'))).toBe(false);
  } finally { await surface.close(); }
  expect(f.listeners.size).toBe(0); expect(f.ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
});

for (const key of ['surfaces.slack.botToken', 'surfaces.discord.botToken', 'surfaces.email.imapPassword']) {
  test(`configured ${key} without trusted account authority refuses and rolls back all owners`, async () => {
    const f = fixture(); f.values.set(key, 'synthetic-configured-secret');
    await expect(initialReady(createProductionDaemonInboxFactory()(f.ctx, routing, f.controls))).rejects.toThrow('requires an admitted account');
    expect(f.listeners.size).toBe(0); expect(f.polling).toBe(0);
    expect(f.ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
  });
}

test('native account and DM settings cannot create screening authority', async () => {
  const f = fixture(); f.configManager.set('surfaces.discord.enabled', true);
  f.configManager.set('surfaces.discord.inboxBotUserId', '100000000000000001');
  f.configManager.set('surfaces.discord.inboxChannelIds', '100000000000000002');
  await expect(initialReady(createProductionDaemonInboxFactory()(f.ctx, routing, f.controls))).rejects.toThrow('requires an admitted account');
  expect(f.listeners.size).toBe(0); expect(f.polling).toBe(0);
});

for (const [userId, channels] of [
  ['', '100000000000000002'], ['01', '100000000000000002'], ['18446744073709551616', '100000000000000002'],
  ['100000000000000001', ''], ['100000000000000001', '100000000000000002,100000000000000002'],
  ['100000000000000001', '0'], ['100000000000000001', '18446744073709551616'],
  ['100000000000000001', Array.from({ length: 201 }, (_, i) => String(i + 1)).join(',')],
] as const) {
  test(`native registry refuses inadmissible identity/membership ${userId}/${channels.slice(0, 45)} before provider acquisition`, async () => {
    const f = fixture(); f.configManager.set('surfaces.discord.enabled', true);
    f.configManager.set('surfaces.discord.inboxBotUserId', userId!);
    f.configManager.set('surfaces.discord.inboxChannelIds', channels!);
    let owners = 0;
    await expect(initialReady(createProductionDaemonInboxFactory({}, { discord: { async createOwner() {
      owners++; throw new Error('Invalid registry must not acquire a provider');
    } } }, syntheticScreening)(f.ctx, routing, f.controls))).rejects.toThrow('Discord inbox');
    expect(owners).toBe(0); expect(f.listeners.size).toBe(0); expect(f.polling).toBe(0);
  });
}

test('injected screening does not activate an explicitly disabled source', async () => {
  const f = fixture(); const surface = await createProductionDaemonInboxFactory({}, {}, syntheticScreening)(f.ctx, routing, f.controls);
  try {
    expect(await f.invoke()).toMatchObject({ providers: expect.arrayContaining([
      expect.objectContaining({ provider: 'discord', state: 'unconfigured' }),
    ]) });
    expect(f.polling).toBe(0);
  } finally { await surface.close(); }
  expect(f.listeners.size).toBe(0);
});

test('credential/config invalidation withdraws unconfigured snapshots instead of silently omitting a new source', async () => {
  const f = fixture(); const surface = await createProductionDaemonInboxFactory()(f.ctx, routing, f.controls);
  try {
    await f.invoke();
    f.values.set('surfaces.slack.botToken', 'synthetic-new-account');
    for (const listener of f.listeners) listener();
    await expect(f.invoke()).rejects.toThrow();
    expect(f.polling).toBe(0);
  } finally { await surface.close(); }
});

test('an independently changed credential fails read validation even without a local write notification', async () => {
  const f = fixture(); const surface = await createProductionDaemonInboxFactory()(f.ctx, routing, f.controls);
  try {
    f.values.set('surfaces.discord.botToken', 'synthetic-external-change');
    await expect(f.invoke()).rejects.toThrow();
  } finally { await surface.close(); }
});

test('unrelated invalidation rechecks absent sources without disabling fresh-install inbox', async () => {
  const f = fixture(); const surface = await createProductionDaemonInboxFactory()(f.ctx, routing, f.controls);
  try {
    await surface.ready;
    for (const listener of f.listeners) listener();
    // The real absence replacements have no I/O; observe their completed turn.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(await f.invoke()).toMatchObject({ partial: false });
  } finally { await surface.close(); }
});

test('unknown local credential state cannot masquerade as an unconfigured provider', async () => {
  const f = fixture(); f.ctx.credentials.inspectConfigSecret = () => 'unavailable';
  await expect(initialReady(createProductionDaemonInboxFactory()(f.ctx, routing, f.controls))).rejects.toThrow('credential admission is unavailable');
  expect(f.listeners.size).toBe(0); expect(f.polling).toBe(0);
});

test('quarantined source settings cannot masquerade as default unconfigured intent', async () => {
  const f = fixture(); const path = join(f.root, 'selected-settings.json');
  writeFileSync(path, JSON.stringify({ surfaces: { slack: { botToken: 123 } } }));
  const configManager = new ConfigManager({ workingDir: f.root, homeDir: f.root, surfaceRoot: 'daemon',
    daemonTierPath: path, diagnosticMode: 'structural' });
  await expect(initialReady(createProductionDaemonInboxFactory()({ ...f.ctx, configManager }, routing, f.controls)))
    .rejects.toThrow('configuration admission is unavailable');
  expect(f.listeners.size).toBe(0);
});

test('unreadable real credential storage cannot masquerade as a fresh install', async () => {
  const f = fixture(); const daemonHome = join(f.root, 'selected-daemon');
  mkdirSync(daemonHome, { recursive: true }); writeFileSync(join(daemonHome, 'secrets.json'), '{invalid synthetic file');
  const secrets = new SecretsManager({ globalHome: f.root, projectRoot: f.root, daemonHome, surfaceRoot: 'daemon' });
  const credentials = createDaemonCredentialStore(secrets);
  expect(await credentials.resolveConfigSecret('surfaces.slack.botToken')).toBeNull();
  expect(credentials.inspectConfigSecret!('surfaces.slack.botToken')).toBe('unavailable');
  await expect(initialReady(createProductionDaemonInboxFactory()({ ...f.ctx, credentials }, routing, f.controls)))
    .rejects.toThrow('credential admission is unavailable');
  expect(f.listeners.size).toBe(0);
});

test('external credentials appearing between source reads withhold the entire earlier absence snapshot', async () => {
  const f = fixture(); const surface = await createProductionDaemonInboxFactory()(f.ctx, routing, f.controls);
  const inspect = f.ctx.credentials.inspectConfigSecret!;
  f.ctx.credentials.inspectConfigSecret = key => {
    if (key === 'surfaces.email.imapHost') f.values.set('surfaces.slack.botToken', 'synthetic-concurrent-account');
    return inspect(key);
  };
  try { await expect(f.invoke()).rejects.toThrow(); }
  finally { await surface.close(); }
});

test('shutdown retires admitted absence reads before releasing subscriptions and canonical registration', async () => {
  const f = fixture(); const surface = await createProductionDaemonInboxFactory()(f.ctx, routing, f.controls);
  const reads = Array.from({ length: 20 }, () => f.invoke());
  const settled = Promise.allSettled(reads);
  await surface.close();
  expect((await settled).every(row => row.status === 'rejected')).toBe(true);
  expect(f.listeners.size).toBe(0); expect(f.ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
});

for (const provider of ['slack', 'discord', 'email'] as const) {
  test(`default production ${provider} reaches its actual account owner through native hosted consent without injected screening`, async () => {
    const f = fixture();
    const originalEnvironment = { abacus: process.env.ABACUSAI_API_KEY, typesafe: process.env.TYPESAFE_API_KEY };
    delete process.env.ABACUSAI_API_KEY; delete process.env.TYPESAFE_API_KEY;
    const owners: Array<{ close(): Promise<void> }> = [];
    const secretsManager = new NativeSecretsManager({ globalHome: f.root, projectRoot: f.root });
    try {
      await secretsManager.set('ABACUSAI_API_KEY', 'synthetic-native-abacus-key');
      await secretsManager.set('TYPESAFE_API_KEY', 'synthetic-native-typesafe-key');
      f.configManager.set('surfaces.hostedInboxScreening', 'abacus-typesafe-provider-managed');
      if (provider === 'slack') {
        f.configManager.set('surfaces.slack.enabled', true); f.configManager.set('surfaces.slack.workspaceId', 'T-SYNTHETIC');
        f.configManager.set('surfaces.slack.inboxUserId', 'U-SYNTHETIC');
      } else if (provider === 'discord') {
        f.configManager.set('surfaces.discord.enabled', true); f.configManager.set('surfaces.discord.inboxBotUserId', '100000000000000001');
        f.configManager.set('surfaces.discord.inboxChannelIds', '100000000000000002');
      } else {
        f.configManager.set('surfaces.email.imapHost', 'imap.synthetic.test'); f.configManager.set('surfaces.email.imapUser', 'mailbox@synthetic.test');
      }
      let admitted = 0;
      const observe = (screening: Parameters<typeof createDiscordInboxOwner>[1]['screening']) => {
        admitted++; expect('kind' in screening && screening.kind).toBe('hosted');
        expect(screening.authority.retention).toBe('provider-managed-zero-retention-unverified');
        screening.authority.assertCurrent();
      };
      const factory = createProductionDaemonInboxFactory({}, {
        slack: { async createOwner(context, options) {
          observe(options.screening); expect(options.account).toEqual({ workspaceId: 'T-SYNTHETIC', userId: 'U-SYNTHETIC' });
          const owner = await createSlackInboxOwner(context, options); owners.push(owner);
          throw new Error('Synthetic fixture stops after actual Slack owner construction');
        } },
        discord: { async createOwner(context, options) {
          observe(options.screening); expect(options.account.userId).toBe('100000000000000001');
          expect(options.channels.channelIds).toEqual(['100000000000000002']);
          const owner = await createDiscordInboxOwner(context, options); owners.push(owner);
          throw new Error('Synthetic fixture stops after actual Discord owner construction');
        } },
        email: { createOwner(options) {
          observe(options.screening); expect(options.account).toMatchObject({ host: 'imap.synthetic.test', username: 'mailbox@synthetic.test', security: 'tls' });
          const owner = createEmailInboxOwner(options); owners.push(owner);
          throw new Error('Synthetic fixture stops after actual email owner construction');
        } },
      });
      const nativeRouting: Parameters<DaemonInboxFactory>[1] = {
        async initialize() {}, async close() {}, unregister() {}, resolveProfileId() { return 'synthetic-profile'; },
      };
      await expect(initialReady(registerOwnedMailInbox(factory, { ...f.ctx, credentials: createDaemonCredentialStore(secretsManager) }, nativeRouting, f.controls,
        { configManager: f.configManager, secretsManager }))).rejects.toThrow();
      expect(admitted).toBe(1); expect(owners).toHaveLength(1);
      expect(f.polling).toBe(0); expect(f.listeners.size).toBe(0);
      expect(f.ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
    } finally {
      await Promise.all(owners.map(owner => owner.close()));
      if (originalEnvironment.abacus === undefined) delete process.env.ABACUSAI_API_KEY; else process.env.ABACUSAI_API_KEY = originalEnvironment.abacus;
      if (originalEnvironment.typesafe === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalEnvironment.typesafe;
    }
  });
}

test('native root shutdown aborts screening immediately and drains the owned source before closing acquisition', async () => {
  const f = fixture(); const env = { abacus: process.env.ABACUSAI_API_KEY, typesafe: process.env.TYPESAFE_API_KEY };
  delete process.env.ABACUSAI_API_KEY; delete process.env.TYPESAFE_API_KEY;
  const sourceDraining = Promise.withResolvers<void>(), releaseSource = Promise.withResolvers<void>();
  const events: string[] = [];
  const secretsManager = new NativeSecretsManager({ globalHome: f.root, projectRoot: f.root });
  let acquisition: HostedInboxScreeningAcquisition | undefined;
  let registration: Awaited<ReturnType<typeof registerOwnedMailInbox>> | undefined;
  try {
    await secretsManager.set('ABACUSAI_API_KEY', 'synthetic-root-abacus'); await secretsManager.set('TYPESAFE_API_KEY', 'synthetic-root-typesafe');
    f.configManager.set('surfaces.hostedInboxScreening', 'abacus-typesafe-provider-managed');
    f.configManager.set('surfaces.slack.enabled', true); f.configManager.set('surfaces.slack.workspaceId', 'T-SYNTHETIC');
    f.configManager.set('surfaces.slack.inboxUserId', 'U-SYNTHETIC');
    const production = createProductionDaemonInboxFactory({}, { slack: {
      // The provider owner is real. This explicit storage seam performs no poll.
      createOwner: createSlackInboxOwner,
      createSource(): OwnedInboxSource { return { providerIds: ['slack'], ready: Promise.resolve(), unregister() {},
        async acquireRead() { throw new Error('Synthetic close fixture does not read inboxes'); },
        async close() { events.push('source draining'); sourceDraining.resolve(); await releaseSource.promise; events.push('source drained'); },
      }; },
    } });
    const nativeRouting: Parameters<DaemonInboxFactory>[1] = {
      async initialize() {}, async close() {}, unregister() {}, resolveProfileId() { return 'synthetic-profile'; },
    };
    registration = await registerOwnedMailInbox((context, routing, controls) => production(context, routing, { ...controls,
      async acquireHostedScreening(source, operation) {
        if (!controls.acquireHostedScreening) throw new Error('Expected native hosted acquisition');
        acquisition = await controls.acquireHostedScreening(source, operation);
        const captured = acquisition;
        return { options: captured.options, async close() { events.push('acquisition closed'); await captured.close(); } };
      },
    }), { ...f.ctx, credentials: createDaemonCredentialStore(secretsManager) }, nativeRouting, f.controls,
    { configManager: f.configManager, secretsManager });
    await registration.ready;
    if (!acquisition) throw new Error('Expected actual native acquisition');
    const captured = acquisition;
    const closing = registration.close(); expect(registration.close()).toBe(closing);
    expect(captured.options.authority.signal.aborted).toBe(true);
    expect(() => captured.options.authority.assertCurrent()).toThrow();
    await sourceDraining.promise; expect(events).toEqual(['source draining']);
    releaseSource.resolve(); await closing;
    expect(events).toEqual(['source draining', 'source drained', 'acquisition closed']);
    expect(f.ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
  } finally {
    releaseSource.resolve(); await registration?.close();
    if (env.abacus === undefined) delete process.env.ABACUSAI_API_KEY; else process.env.ABACUSAI_API_KEY = env.abacus;
    if (env.typesafe === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = env.typesafe;
  }
});
