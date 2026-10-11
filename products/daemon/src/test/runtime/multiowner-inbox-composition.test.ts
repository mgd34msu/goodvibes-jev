import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FakeClusterClock, MemoryClusterBus, inboxSurface } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { createClusterServices, startClusterServices } from '../../runtime/cluster-group-composition.js';
import { inboxPollerGate } from '../../runtime/cluster-composition.js';
import { createShellPathService } from '../../runtime/index.js';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import type { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import { createSlackDaemonInboxSourceFactory } from '../../runtime/slack-inbox-composition.js';
import { createEmailDaemonInboxSourceFactory } from '../../runtime/email-inbox-composition.js';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createOwnedInboxSource, type OwnedInboxSource, type InboundProviderAdapter, type InboxListOutput } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import { createMultiOwnerDaemonInboxFactory, type DaemonInboxSourceFactory } from '../../runtime/multiowner-inbox-composition.js';
import type { DaemonInboxFactory } from '../../runtime/daemon-handler-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const logger = { info() {}, warn() {}, error() {} };
function context(): HandlerContext {
  const workingDirectory = makeOwnedTempDir('multiowner-inbox');
  return { catalog: new GatewayMethodCatalog(), workingDirectory, homeDirectory: workingDirectory, logger,
    configManager: new ConfigManager({ workingDir: workingDirectory, homeDir: workingDirectory, surfaceRoot: 'daemon' }),
    credentials: { resolveConfigSecret: async () => null, resolveRef: async () => null, put: async () => {}, has: async () => false },
  };
}
const routing: Parameters<DaemonInboxFactory>[1] = {
  async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null,
};
const controls = { gatePolling() {} };
function adapter(id: string): InboundProviderAdapter {
  return { id, pollIntervalMs: 3_600_000, async poll() {
    return { state: 'ready', configured: true, items: [{ id: `${id}:synthetic`, provider: id, kind: 'dm',
      fromDigest: 'cafebabedeadbeef', subjectPreview: 'Synthetic message', bodyPreview: 'Safe synthetic body',
      receivedAt: Date.now(), unread: true }] };
  } };
}
function sourceFactory(id: string, capture: (source: OwnedInboxSource) => void = () => {}): DaemonInboxSourceFactory {
  return ctx => {
    const source = createOwnedInboxSource(ctx, { storeFileName: `${id}.sqlite`, adapters: new Map([[id, adapter(id)]]) });
    capture(source); return source;
  };
}
function invoke(ctx: HandlerContext, providers?: string[]): Promise<InboxListOutput> {
  return ctx.catalog.invoke('channels.inbox.list', { body: { provider: providers?.[0] }, context: { scopes: ['read:channels'] } }) as Promise<InboxListOutput>;
}

test('explicit independent real stores share one canonical handler; source retirement leaves binding and other owner intact', async () => {
  const ctx = context(); let slack!: OwnedInboxSource;
  const surface = await createMultiOwnerDaemonInboxFactory([
    sourceFactory('slack', value => { slack = value; }), sourceFactory('email'),
  ])(ctx, routing, controls);
  try {
    await surface.ready;
    expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(true);
    expect(await invoke(ctx)).toMatchObject({ total: 2 });
    await slack.close();
    expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(true);
    expect(await invoke(ctx, ['email'])).toMatchObject({ total: 1, items: [{ provider: 'email' }] });
    await expect(invoke(ctx)).rejects.toThrow();
  } finally { await surface.close(); }
  expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
});

test('partial acquisition failure rolls back all acquired real sources without binding', async () => {
  const ctx = context(); let source!: OwnedInboxSource;
  await expect(createMultiOwnerDaemonInboxFactory([
    sourceFactory('slack', value => { source = value; }),
    async () => { throw new Error('synthetic acquisition failure'); },
  ])(ctx, routing, controls)).rejects.toThrow('synthetic acquisition failure');
  expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
  await expect(source.acquireRead()).rejects.toThrow();
});

test('duplicate provider membership is rejected before canonical binding and both sources retire', async () => {
  const ctx = context(); const sources: OwnedInboxSource[] = [];
  const factory: DaemonInboxSourceFactory = ctx => {
    const source = createOwnedInboxSource(ctx, { storeFileName: `duplicate-${sources.length}.sqlite`, adapters: new Map([['slack', adapter('slack')]]) });
    sources.push(source); return source;
  };
  await expect(createMultiOwnerDaemonInboxFactory([factory, factory])(ctx, routing, controls)).rejects.toThrow('Duplicate inbox provider');
  expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
  for (const source of sources) await expect(source.acquireRead()).rejects.toThrow();
});

test('source readiness failure retires every source and the canonical binding', async () => {
  const ctx = context(); let source!: OwnedInboxSource; let closed = false;
  const failed: DaemonInboxSourceFactory = () => ({ providerIds: ['email'],
    ready: Promise.reject(new Error('synthetic readiness failure')),
    acquireRead: async () => { throw new Error('unreachable'); },
    close: async () => { closed = true; }, unregister() {},
  });
  const surface = await createMultiOwnerDaemonInboxFactory([sourceFactory('slack', value => { source = value; }), failed])(ctx, routing, controls);
  await expect(surface.ready!).rejects.toThrow('synthetic readiness failure');
  expect(closed).toBe(true);
  expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
  await expect(source.acquireRead()).rejects.toThrow();
});

test('shutdown initiates all owner retirements before awaiting any and awaits their drains', async () => {
  const ctx = context(); const started: string[] = []; const release = Promise.withResolvers<void>();
  const factory = (id: string): DaemonInboxSourceFactory => () => ({ providerIds: [id], ready: Promise.resolve(),
    acquireRead: async () => { throw new Error('unused'); }, unregister() {},
    async close() { started.push(id); if (id === 'slack') await release.promise; else release.resolve(); },
  });
  const surface = await createMultiOwnerDaemonInboxFactory([factory('slack'), factory('email')])(ctx, routing, controls);
  await surface.ready;
  const first = surface.close(); expect(surface.close()).toBe(first);
  await first; expect(started).toEqual(['slack', 'email']);
  expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
});

test('Slack and email source factories preserve independent locks, read proofs, checkpoints and invalidation', async () => {
  const ctx = context();
  const configManager = new ConfigManager({ workingDir: ctx.workingDirectory, homeDir: ctx.workingDirectory, surfaceRoot: 'daemon' });
  configManager.set('cluster.enabled', false);
  configManager.set('surfaces.slack.enabled', true); configManager.set('surfaces.slack.workspaceId', 'T-SYNTHETIC');
  configManager.set('surfaces.email.imapHost', 'mail.synthetic.invalid'); configManager.set('surfaces.email.username', 'synthetic@example.invalid');
  const configured = { ...ctx, configManager };
  const screening = {} as ProtectedSourceOwnerOptions;
  const slackAccount = { workspaceId: 'T-SYNTHETIC', userId: 'U-SYNTHETIC' };
  const emailAccount = { host: 'mail.synthetic.invalid', port: 993, username: 'synthetic@example.invalid', mailbox: 'INBOX', security: 'tls' as const };
  let slackSource!: OwnedInboxSource, emailSource!: OwnedInboxSource;
  const wrappedSources: OwnedInboxSource[] = [];
  let proofChecks = 0, invalidations = 0, unsubscribed = false, mailClosed = false;
  let invalidation: (() => void) | undefined;
  let checkpoint: (() => unknown) | undefined;
  const starts: Promise<void>[] = [];
  const proof = async () => Object.assign(async () => { proofChecks++; }, { assertCurrent() { proofChecks++; } });
  const surface = await createMultiOwnerDaemonInboxFactory([
    createSlackDaemonInboxSourceFactory({ account: slackAccount, screening }, {
      createOwner: async () => ({ account: slackAccount, scopeId: 'synthetic-slack', adapter: adapter('slack'),
        assertReadCurrent: async () => {}, acquireReadLease: proof, invalidateCredential() { invalidations++; }, close: async () => {} }),
      createSource(context, options) { return slackSource = createOwnedInboxSource(context, options); },
    }),
    createEmailDaemonInboxSourceFactory({ account: emailAccount, screening }, {
      createOwner(options) { checkpoint = options.getCheckpoint; return { account: emailAccount, scopeId: 'synthetic-email',
        adapter: adapter('email'), assertReadCurrent: async () => {}, acquireReadLease: proof, close: async () => {} }; },
      createSource(context, options) { return emailSource = createOwnedInboxSource(context, options); },
    }),
  ].map(factory => async (...args: Parameters<DaemonInboxFactory>) => {
    const source = await factory(...args); wrappedSources.push(source); return source;
  }))(configured, routing, {
    gatePolling(_provider, control) { starts.push(control.start()); return () => control.stop(); },
    onAccountInvalidation(listener) { invalidation = listener; return () => { unsubscribed = true; }; },
    createEmailService() { return { service: {} as EmailService, close() { mailClosed = true; } }; },
  });
  const lock = (provider: string) => join(ctx.workingDirectory, '.goodvibes', 'tui', 'operator', `inbox-${provider}-synthetic-${provider}.sqlite.owner.lock`);
  try {
    await surface.ready; await Promise.all(starts);
    expect(await invoke(ctx)).toMatchObject({ total: 2 });
    expect(proofChecks).toBeGreaterThanOrEqual(4);
    expect(checkpoint!()).toBeNull();
    expect(slackSource.providerIds).toEqual(['slack']); expect(emailSource.providerIds).toEqual(['email']);
    expect(existsSync(lock('slack'))).toBe(true); expect(existsSync(lock('email'))).toBe(true);
    invalidation!(); expect(invalidations).toBe(1);
    // Legacy teardown is a detached callback, never dependent on `this`.
    for (const source of wrappedSources) {
      const unregister = source.unregister; unregister(); await source.close();
      expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(true);
    }
  } finally { await surface.close(); }
  expect(existsSync(lock('slack'))).toBe(false); expect(existsSync(lock('email'))).toBe(false);
  expect(unsubscribed).toBe(true); expect(mailClosed).toBe(true);
});

test('shutdown drains an admitted read holding multiple real source leases and rejects its stale result', async () => {
  const ctx = context(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let closed = false;
  const factory = (id: string): DaemonInboxSourceFactory => ctx => createOwnedInboxSource(ctx, {
    storeFileName: `${id}.sqlite`, adapters: new Map([[id, adapter(id)]]),
    acquireReadLease: async () => Object.assign(async () => {
      if (id === 'email') { entered.resolve(); await release.promise; }
    }, { assertCurrent() {} }),
  });
  const surface = await createMultiOwnerDaemonInboxFactory([factory('slack'), factory('email')])(ctx, routing, controls);
  try {
    await surface.ready;
    const read = invoke(ctx); void read.catch(() => {});
    await entered.promise;
    const closing = surface.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(closed).toBe(false); expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(false);
    release.resolve(); await expect(read).rejects.toThrow(); await closing; expect(closed).toBe(true);
  } finally { release.resolve(); await surface.close(); }
});

test('MemoryClusterBus elects independent composite sources and source retirement preserves the other provider', async () => {
  const ctx = context(); const clock = new FakeClusterClock(); const bus = new MemoryClusterBus();
  const configManager = new ConfigManager({ workingDir: ctx.workingDirectory, homeDir: ctx.workingDirectory, surfaceRoot: 'daemon' });
  configManager.set('cluster.enabled', true); configManager.set('cluster.bootProbeSeconds', 1);
  configManager.set('cluster.heartbeatSeconds', 1); configManager.set('cluster.masterTimeoutSeconds', 3);
  const values = new Map<string, string>();
  const secretsManager = { async get(key: string) { return values.get(key) ?? null; }, async set(key: string, value: string) { values.set(key, value); }, async delete(key: string) { values.delete(key); } };
  const cluster = createClusterServices({ configManager,
    shellPaths: createShellPathService({ workingDirectory: ctx.workingDirectory, homeDirectory: ctx.workingDirectory }),
    secretsManager, transport: bus.createTransport('composite-node'), clock });
  const sources: OwnedInboxSource[] = []; const polls = new Map<string, number>();
  const factory = (id: string): DaemonInboxSourceFactory => (context, _routing, controls) => {
    const selected = adapter(id);
    const source = createOwnedInboxSource(context, { storeFileName: `${id}.sqlite`, awaitInitialPoll: false,
      adapters: new Map([[id, { ...selected, async poll(options) { polls.set(id, (polls.get(id) ?? 0) + 1); return selected.poll(options); } }]]),
      gatePolling: (_provider, control) => controls.gatePollingOwned!(`${id}:synthetic-account`, control),
    }); sources.push(source); return source;
  };
  const surface = await createMultiOwnerDaemonInboxFactory([factory('slack'), factory('email')])(ctx, routing, {
    gatePolling() {}, gatePollingOwned: (id, control) => cluster.clusterCoordinator.registerOwned(inboxPollerGate(id, control)),
  });
  const advance = async () => {
    for (let n = 0; n < 40; n++) {
      clock.advance(100); for (let turn = 0; turn < 40; turn++) await Promise.resolve();
      await cluster.clusterCoordinator.settled();
    }
  };
  try {
    await surface.ready; expect(await invoke(ctx)).toMatchObject({ total: 0 }); expect(polls.size).toBe(0);
    await cluster.clusterGroup.start();
    const created = await cluster.clusterGroup.verbs.create({ name: 'Synthetic composite group', passphrase: 'synthetic-fixture-material' });
    expect(created.ok).toBe(true); await startClusterServices(cluster); await advance();
    expect(cluster.clusterCoordinator.holdsSurface(inboxSurface('slack:synthetic-account'))).toBe(true);
    expect(cluster.clusterCoordinator.holdsSurface(inboxSurface('email:synthetic-account'))).toBe(true);
    // Election readiness intentionally precedes the asynchronous SQLite seed.
    const deadline = Date.now() + 5_000;
    while ((await invoke(ctx)).total !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await invoke(ctx)).toMatchObject({ total: 2 });
    await sources[0]!.close(); await advance();
    expect(cluster.clusterCoordinator.holdsSurface(inboxSurface('slack:synthetic-account'))).toBe(false);
    expect(cluster.clusterCoordinator.holdsSurface(inboxSurface('email:synthetic-account'))).toBe(true);
    expect(await invoke(ctx, ['email'])).toMatchObject({ total: 1 });
    expect(ctx.catalog.hasHandler('channels.inbox.list')).toBe(true);
  } finally {
    await surface.close(); await cluster.clusterCoordinator.stop('fixture cleanup'); await cluster.clusterGroup.stop();
  }
  expect(clock.pendingTimers).toBe(0);
});

test('multi-owner protected sources reject legacy asynchronous-only read authority', async () => {
  const ctx = context();
  const legacy: DaemonInboxSourceFactory = context => createOwnedInboxSource(context, {
    storeFileName: 'legacy-protected.sqlite', adapters: new Map([['slack', adapter('slack')]]),
    assertReadCurrent: async () => {},
  });
  const surface = await createMultiOwnerDaemonInboxFactory([legacy, sourceFactory('email')])(ctx, routing, controls);
  try {
    await surface.ready; await expect(invoke(ctx)).rejects.toThrow('Inbox account scope is unavailable');
    expect(await invoke(ctx, ['email'])).toMatchObject({ total: 1 });
  } finally { await surface.close(); }
});
