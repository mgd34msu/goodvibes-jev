import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { registerDraftMethods, registerRoutingMethods } from '@goodvibes-jev/engine/sdk/platform/channels';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { registerRemoteSurface } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { ATTACHED_PAYMENTS_METHOD_IDS, PaymentReplyInboxClosedError } from '@goodvibes-jev/engine/sdk/platform/payments';
import { registerDaemonHandlers, type DaemonHandlerSurfaceProviders } from '../../daemon/handlers/index.js';
import type { HandlerContext, OwnedHandlerSurface } from '../../daemon/handlers/context.js';
import { createPaymentsServices, type PaymentsServices } from '../../runtime/payments-composition.js';
import { createShellPathService } from '../../runtime/index.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** All five providers compose their actual implementations in owned files. */
function fixture() {
  const root = makeOwnedTempDir('daemon-handlers');
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  const secrets = new Map<string, string>();
  const secretPort = {
    async get(key: string) { return secrets.get(key) ?? null; },
    async set(key: string, value: string) { secrets.set(key, value); },
    async delete(key: string) { secrets.delete(key); },
  };
  const catalog = new GatewayMethodCatalog();
  const ctx: HandlerContext = {
    catalog, workingDirectory, homeDirectory,
    configManager: new ConfigManager({ homeDir: homeDirectory, workingDir: workingDirectory, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT }),
    credentials: createDaemonCredentialStore(secretPort),
    logger: { info() {}, warn() {}, error() {} },
  };
  const acquired: string[] = [];
  const closed: string[] = [];
  let payments: PaymentsServices | undefined;
  let remote: ReturnType<typeof registerRemoteSurface> | undefined;
  let polls = 0;
  function own<T extends OwnedHandlerSurface>(label: string, surface: T): T {
    acquired.push(label);
    return { ...surface, async close() { await surface.close(); closed.push(label); } };
  }
  const providers: DaemonHandlerSurfaceProviders = {
    registerRouting: (received) => {
      expect(received).toBe(ctx);
      return own('routing', registerRoutingMethods(received));
    },
    registerInbox: (received, routing) => {
      expect(received).toBe(ctx);
      // This synchronous read must be legal because assembly awaited routing.
      expect(routing.resolveProfileId('fixture', 'route')).toBeNull();
      return own('inbox', registerInboxSurface(received, { adapters: new Map([['fixture', {
        id: 'fixture', pollIntervalMs: 3_600_000,
        async poll() {
          polls++;
          return { items: [{ id: 'fixture-item', provider: 'fixture', kind: 'dm' as const, fromDigest: 'fixture-sender', subjectPreview: 'Fixture subject', bodyPreview: 'Fixture local body', receivedAt: Date.now(), unread: true }], state: 'ready' as const, configured: true };
        },
      }]]) }));
    },
    registerDrafts: (received) => own('drafts', registerDraftMethods(received)),
    registerPayments: (received) => {
      payments = createPaymentsServices({ configManager: received.configManager,
        shellPaths: createShellPathService({ workingDirectory, homeDirectory }), secretsManager: secretPort,
        gatewayMethods: received.catalog, isPaymentsLeader: () => true, checkoutSeam: () => undefined,
        channelDeliveryRouter: { async deliver() { throw new Error('Unexpected fixture delivery'); } },
      });
      return own('payments', payments);
    },
    registerRemote: (received) => {
      remote = registerRemoteSurface(received);
      return own('remote', remote);
    },
  };
  return { ctx, providers, acquired, closed, get payments() { return payments; }, get remote() { return remote; }, get polls() { return polls; } };
}

const methodIds = ['channels.routing.list', 'channels.inbox.list', 'channels.drafts.list', ...ATTACHED_PAYMENTS_METHOD_IDS];
function invoke(ctx: HandlerContext, id: string, body: unknown = {}) {
  return ctx.catalog.invoke(id, { body, context: {} });
}

test('all real handler surfaces are ready, share their actual handles, and close in reverse order', async () => {
  const f = fixture();
  const graph = await registerDaemonHandlers(f.ctx, f.providers);
  try {
    expect(f.acquired).toEqual(['routing', 'inbox', 'drafts', 'payments', 'remote']);
    expect(graph.paymentReplies).toBe(f.payments!.paymentReplies);
    expect(graph.remoteSurface.service).toBe(f.remote!.service);
    expect(graph.remoteDispatch).toBe(f.remote!.dispatch);
    expect(f.polls).toBe(1);
    expect(await invoke(f.ctx, 'channels.routing.list')).toMatchObject({ routes: [] });
    expect(await invoke(f.ctx, 'channels.inbox.list')).toMatchObject({ items: [{ id: 'fixture-item' }], total: 1 });
    expect(await invoke(f.ctx, 'channels.drafts.list')).toMatchObject({ drafts: [] });
    expect(await invoke(f.ctx, 'payments.cards.list')).toMatchObject({ cards: [] });
    expect(await graph.remoteSurface.service.listPeers()).toEqual([]);
  } finally { await graph.close(); }
  expect(f.closed).toEqual(['remote', 'payments', 'drafts', 'inbox', 'routing']);
  for (const id of methodIds) expect(f.ctx.catalog.hasHandler(id)).toBe(false);
  expect(graph.close()).toBe(graph.close());
});

test('pending readiness does not return a half-ready graph or construct later providers', async () => {
  const f = fixture(); const entered = deferred(); const release = deferred();
  const original = f.providers.registerInbox;
  const providers = { ...f.providers, async registerInbox(...args: Parameters<typeof original>) {
    const surface = await original(...args);
    return { ...surface, ready: Promise.resolve(surface.ready).then(async () => { entered.resolve(); await release.promise; }) };
  } };
  let returned = false;
  const pending = registerDaemonHandlers(f.ctx, providers).then((graph) => { returned = true; return graph; });
  try {
    await entered.promise;
    expect(returned).toBe(false);
    expect(f.acquired).toEqual(['routing', 'inbox']);
    expect(f.ctx.catalog.hasHandler('payments.cards.list')).toBe(false);
  } finally { release.resolve(); const graph = await pending; await graph.close(); }
});

test('failed last readiness drains every real surface and retry reuses the same catalog', async () => {
  const f = fixture(); const failure = new Error('fixture remote readiness failed');
  const original = f.providers.registerRemote;
  let pendingReply: Promise<unknown> | undefined;
  const providers = { ...f.providers, async registerRemote(ctx: HandlerContext) {
    const surface = await original(ctx);
    pendingReply = f.payments!.paymentReplies.waitForAnswer({ kind: 'veto', channels: ['telegram'], notice: 'fixture', deadlineMs: Date.now() + 60_000 });
    void pendingReply.catch(() => {});
    return { ...surface, ready: Promise.resolve(surface.ready).then(() => { throw failure; }) };
  } };
  await expect(registerDaemonHandlers(f.ctx, providers)).rejects.toBe(failure);
  await expect(pendingReply!).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  expect(f.closed).toEqual(['remote', 'payments', 'drafts', 'inbox', 'routing']);
  for (const id of methodIds) expect(f.ctx.catalog.hasHandler(id)).toBe(false);
  const replacement = await registerDaemonHandlers(f.ctx, f.providers);
  try {
    for (const id of methodIds) expect(f.ctx.catalog.hasHandler(id)).toBe(true);
    expect(await invoke(f.ctx, 'channels.inbox.list')).toMatchObject({ total: 1 });
  } finally { await replacement.close(); }
});

test('a construction failure rolls back earlier real owners before rejecting', async () => {
  const f = fixture(); const failure = new Error('fixture construction failure');
  await expect(registerDaemonHandlers(f.ctx, { ...f.providers, registerDrafts() { throw failure; } })).rejects.toBe(failure);
  expect(f.acquired).toEqual(['routing', 'inbox']);
  expect(f.closed).toEqual(['inbox', 'routing']);
  for (const id of methodIds) expect(f.ctx.catalog.hasHandler(id)).toBe(false);
});

test('routing initialization failure releases routing before any dependent is constructed', async () => {
  const f = fixture(); const failure = new Error('fixture routing readiness failure');
  const original = f.providers.registerRouting;
  await expect(registerDaemonHandlers(f.ctx, { ...f.providers, async registerRouting(ctx: HandlerContext) {
    const surface = await original(ctx);
    return { ...surface, async initialize() { await surface.initialize(); throw failure; } };
  } })).rejects.toBe(failure);
  expect(f.acquired).toEqual(['routing']); expect(f.closed).toEqual(['routing']);
});

test('rollback cleanup failure preserves startup failure and still releases older owners', async () => {
  const f = fixture(); const startup = new Error('fixture startup failed'); const cleanup = new Error('fixture cleanup failed');
  const original = f.providers.registerRemote;
  let failure: unknown;
  try {
    await registerDaemonHandlers(f.ctx, { ...f.providers, async registerRemote(ctx: HandlerContext) {
      const surface = await original(ctx);
      return { ...surface, ready: Promise.resolve(surface.ready).then(() => { throw startup; }), async close() { await surface.close(); throw cleanup; } };
    } });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(startup);
  expect((failure as AggregateError).errors[1]).toMatchObject({ failures: [{ label: 'remote', error: cleanup }] });
  expect(f.closed).toEqual(['remote', 'payments', 'drafts', 'inbox', 'routing']);
});

test('legacy unregister starts the same awaited reverse cleanup and rejects owned reply windows', async () => {
  const f = fixture(); const graph = await registerDaemonHandlers(f.ctx, f.providers);
  const waiting = graph.paymentReplies.waitForAnswer({ kind: 'veto', channels: ['telegram'], notice: 'fixture', deadlineMs: Date.now() + 60_000 });
  void waiting.catch(() => {});
  graph.unregister();
  const closing = graph.close(); expect(graph.close()).toBe(closing);
  await closing; await expect(waiting).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  expect(f.closed).toEqual(['remote', 'payments', 'drafts', 'inbox', 'routing']);
});
