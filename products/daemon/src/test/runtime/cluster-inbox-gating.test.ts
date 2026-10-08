/**
 * Registration proof restored from daemon254699b's cluster-inbox-gating suite.
 * The shipping handler composition supplies the gate to the real registrar.
 * Only providers and transport are synthetic; no production cluster inbox is enabled.
 */
import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { FakeClusterClock, MemoryClusterBus, inboxSurface, surfaceIdFor } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { registerInboxSurface, type InboundProviderAdapter, type InboxListOutput, type InboxSurfaceRegistration } from '@goodvibes-jev/engine/sdk/platform/intake';
import { createDaemonHandlerComposition } from '../../runtime/daemon-handler-composition.js';
import { createClusterComposition, inboxPollerGate } from '../../runtime/cluster-composition.js';
import { createClusterServices, startClusterServices } from '../../runtime/cluster-group-composition.js';
import { createShellPathService, DistributedRuntimeManager } from '../../runtime/index.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const logger = { info() {}, warn() {}, error() {} };
const account = 'private-inbox@example.test';
const other = 'separate-account@example.test';
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function turns() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function result(id: string, item = `${id}-current`) {
  return { state: 'ready' as const, configured: true, items: [{ id: item, provider: id, kind: 'dm' as const,
    fromDigest: 'cafebabedeadbeef', subjectPreview: 'Synthetic message', bodyPreview: 'Synthetic local body', receivedAt: Date.now(), unread: true }] };
}
function adapter(id: string, poll: InboundProviderAdapter['poll'] = async () => result(id)): InboundProviderAdapter {
  return { id, pollIntervalMs: 3_600_000, poll };
}
function invoke(catalog: GatewayMethodCatalog): Promise<InboxListOutput> {
  return catalog.invoke('channels.inbox.list', { body: {}, context: { scopes: ['read:channels'] } }) as Promise<InboxListOutput>;
}

async function node(bus: MemoryClusterBus, clock: FakeClusterClock, label: string, adapters: InboundProviderAdapter[], seed = false) {
  const root = makeOwnedTempDir('daemon-inbox-gate');
  const workingDirectory = join(root, 'workspace'); const homeDirectory = join(root, 'home');
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const configManager = new ConfigManager({ workingDir: workingDirectory, homeDir: homeDirectory, surfaceRoot: 'daemon' });
  configManager.set('cluster.enabled', true);
  configManager.set('cluster.bootProbeSeconds', 1);
  configManager.set('cluster.heartbeatSeconds', 1);
  configManager.set('cluster.masterTimeoutSeconds', 3);
  const values = new Map<string, string>();
  const secretsManager = { async get(key: string) { return values.get(key) ?? null; }, async set(key: string, value: string) { values.set(key, value); }, async delete(key: string) { values.delete(key); } };
  const cluster = createClusterServices({ configManager, shellPaths, secretsManager, transport: bus.createTransport(label), clock });
  const gatewayMethods = new GatewayMethodCatalog();
  if (seed) {
    const previous = registerInboxSurface({ catalog: gatewayMethods, workingDirectory, logger }, { adapters: new Map([[account, adapter(account, async () => result(account, 'persisted-before-election'))]]) });
    await previous.ready; await previous.close();
  }
  const manager = new DistributedRuntimeManager(join(root, 'remote.json'));
  const ready = manager.start();
  let inbox!: InboxSurfaceRegistration;
  const graph = await createDaemonHandlerComposition({ gatewayMethods,
    // This graph only needs the in-memory credential port, never an OS keyring.
    secretsManager: secretsManager as Parameters<typeof createDaemonHandlerComposition>[0]['secretsManager'], configManager,
    workingDirectory, homeDirectory, shellPaths, distributedRuntime: manager, distributedRuntimeReady: ready,
    clusterCoordinator: cluster.clusterCoordinator, checkoutSeam: () => undefined,
    channelDeliveryRouter: { async deliver() { throw new Error('Unexpected fixture delivery'); } },
    inboxFactory: (context, _routing, controls) => {
      inbox = registerInboxSurface(context, { ...controls, adapters: new Map(adapters.map((value) => [value.id, value])) });
      return inbox;
    },
  });
  return { ...cluster, graph, inbox, gatewayMethods, workingDirectory,
    async close() { await graph.close(); await cluster.clusterCoordinator.stop('fixture cleanup'); await cluster.clusterGroup.stop(); await manager.writes.drain(); } };
}
async function advance(clock: FakeClusterClock, nodes: Awaited<ReturnType<typeof node>>[], ms = 2000) {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    clock.advance(100); await turns();
    await Promise.all(nodes.map((n) => n.clusterCoordinator.settled()));
  }
}
async function enroll(first: Awaited<ReturnType<typeof node>>, second?: Awaited<ReturnType<typeof node>>) {
  await first.clusterGroup.start();
  const created = await first.clusterGroup.verbs.create({ name: 'Synthetic registration group', passphrase: 'synthetic in-memory fixture material' });
  if (!created.ok) throw new Error(created.error);
  if (second) {
    await second.clusterGroup.start();
    const joined = await second.clusterGroup.verbs.join({ groupId: created.data.groupId, joinKey: created.data.joinKey });
    expect(joined.ok).toBe(true);
  }
}

test('ungated canonical registration still seeds immediately and awaits its owned close', async () => {
  let polls = 0;
  const catalog = new GatewayMethodCatalog();
  const registration = registerInboxSurface({ catalog, workingDirectory: makeOwnedTempDir('ungated-inbox'), logger }, {
    adapters: new Map([[account, adapter(account, async () => { polls++; return result(account); })]]),
  });
  try { expect(await invoke(catalog)).toMatchObject({ total: 1 }); expect(polls).toBe(1); }
  finally { await registration.close(); }
  expect(catalog.hasHandler('channels.inbox.list')).toBe(false);
});

test('coordinator construction and account registration are inert; account identity is digested', () => {
  const root = makeOwnedTempDir('inert-inbox-gate'); let started = 0;
  const coordinator = createClusterComposition({ configManager: { getCategory: () => ({ enabled: true }) } as Pick<ConfigManager, 'getCategory'>,
    shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) });
  const gate = inboxPollerGate(account, { async start() { started++; }, async stop() {} });
  const unregister = coordinator.register(gate);
  expect(started).toBe(0); expect(coordinator.isMaster).toBe(false); expect(readdirSync(root)).toEqual([]);
  expect(gate.id).toBe(`inbox-poller:${account}`); expect(gate.surface).toEqual(inboxSurface(account));
  expect(surfaceIdFor(gate.surface)).toMatch(/^[0-9a-f]{32}$/);
  expect(surfaceIdFor(gate.surface)).not.toBe(surfaceIdFor(inboxSurface(other)));
  unregister();
});

test('actual handler registration elects each account independently while standby serves persisted rows', async () => {
  const clock = new FakeClusterClock(); const bus = new MemoryClusterBus();
  const polls = { first: 0, second: 0, other: 0 };
  const unaffectedPoll = deferred(); let awaitingUnaffectedPoll = false;
  const first = await node(bus, clock, 'first', [adapter(account, async () => { polls.first++; return result(account); }), { ...adapter(other, async () => { polls.other++; if (awaitingUnaffectedPoll) unaffectedPoll.resolve(); return result(other); }), pollIntervalMs: 20 }]);
  const second = await node(bus, clock, 'second', [adapter(account, async () => { polls.second++; return result(account); })], true);
  try {
    expect(polls).toEqual({ first: 0, second: 0, other: 0 });
    expect(await invoke(first.gatewayMethods)).toMatchObject({ total: 0 });
    expect(await invoke(second.gatewayMethods)).toMatchObject({ items: [{ id: 'persisted-before-election' }], total: 1 });
    await enroll(first, second);
    await startClusterServices(first); await advance(clock, [first]);
    expect(polls.first).toBe(1); expect(polls.second).toBe(0); expect(polls.other).toBeGreaterThan(0);
    // The real spread election moves the common account to the otherwise idle
    // second node, leaving the first node's exclusive account running.
    await startClusterServices(second); await advance(clock, [first, second], 6000);
    expect(polls.first).toBe(1); expect(polls.second).toBe(1);
    expect(first.clusterCoordinator.holdsSurface(inboxSurface(account))).toBe(false);
    expect(second.clusterCoordinator.holdsSurface(inboxSurface(account))).toBe(true);
    expect(first.clusterCoordinator.holdsSurface(inboxSurface(other))).toBe(true);
    expect(await invoke(first.gatewayMethods)).toMatchObject({ total: 2 });
    const holdings = [...first.clusterGroup.runtime.surfaceHoldings()!, ...second.clusterGroup.runtime.surfaceHoldings()!];
    expect(holdings.map((h) => h.surfaceId).sort()).toEqual([surfaceIdFor(inboxSurface(account)), surfaceIdFor(inboxSurface(other))].sort());
    await second.inbox.close(); await advance(clock, [first, second], 6000);
    const countAfterTransfer = polls.other; awaitingUnaffectedPoll = true;
    await unaffectedPoll.promise;
    expect(polls.other).toBeGreaterThan(countAfterTransfer);
    expect(polls.first).toBe(2); expect(polls.second).toBe(1);
    expect(first.clusterCoordinator.holdsSurface(inboxSurface(account))).toBe(true);
    expect(first.clusterCoordinator.holdsSurface(inboxSurface(other))).toBe(true);
    expect(second.clusterCoordinator.holdsSurface(inboxSurface(account))).toBe(false);
    expect((await invoke(first.gatewayMethods)).providers.find((p) => p.provider === other)?.syncing).toBe(true);
    expect(bus.sent.length).toBeGreaterThan(0);
    for (const name of [account, other]) {
      expect(JSON.stringify(bus.sent)).not.toContain(name);
      expect(JSON.stringify(holdings)).not.toContain(name);
    }
  } finally { await second.close(); await first.close(); }
  expect(clock.pendingTimers).toBe(0);
});

test('registration close aborts and drains accepted polling before resignation and successor consumption', async () => {
  const clock = new FakeClusterClock(); const bus = new MemoryClusterBus();
  const entered = deferred(); const release = deferred(); const aborted = deferred();
  const events: string[] = []; let firstPolls = 0; let secondPolls = 0;
  const first = await node(bus, clock, 'draining-owner', [{ ...adapter(account, async ({ signal }) => {
    firstPolls++;
    if (firstPolls === 1) return { state: 'empty', items: [] };
    signal!.addEventListener('abort', () => { events.push('abort'); aborted.resolve(); }, { once: true });
    entered.resolve(); await release.promise; events.push('provider-drained');
    // Deliberately ignore cancellation and return stale work. The registrar's
    // generation fence, not adapter cooperation, must prevent its commit.
    return result(account, 'late-cancelled-row');
  }), pollIntervalMs: 20 }]);
  const second = await node(bus, clock, 'successor', [adapter(account, async () => {
    secondPolls++; events.push('successor-poll');
    expect(bus.sent.some((m) => m.from === 'draining-owner' && JSON.parse(m.raw).type === 'RESIGN')).toBe(true);
    expect(events).toContain('provider-drained');
    return result(account, 'successor-row');
  })]);
  let closing: Promise<void> | undefined;
  try {
    await enroll(first, second); await startClusterServices(first);
    await advance(clock, [first]);
    expect(first.clusterCoordinator.holdsSurface(inboxSurface(account))).toBe(true);
    // Hold a cadence poll AFTER the seed and consumer start have completed.
    await entered.promise;
    await startClusterServices(second); await turns();
    expect(firstPolls).toBe(2); expect(secondPolls).toBe(0);
    expect(await invoke(second.gatewayMethods)).toMatchObject({ total: 0 });
    let closed = false;
    closing = first.inbox.close().then(() => { closed = true; });
    await aborted.promise; await turns();
    expect(closed).toBe(false); expect(secondPolls).toBe(0);
    expect(bus.sent.filter((m) => m.from === 'draining-owner' && JSON.parse(m.raw).type === 'RESIGN')).toEqual([]);
    release.resolve(); await closing; await advance(clock, [first, second], 6000);
    expect(events).toEqual(['abort', 'provider-drained', 'successor-poll']);
    expect(firstPolls).toBe(2); expect(secondPolls).toBe(1);
    expect(await invoke(second.gatewayMethods)).toMatchObject({ total: 1, items: [{ id: 'successor-row' }] });

    // Reopen the exact owned store and ask the real registrar to seed again:
    // neither a cancelled row nor its timestamp cursor may have been committed.
    let since: number | undefined = -1;
    const catalog = new GatewayMethodCatalog();
    const reopened = registerInboxSurface({ catalog, workingDirectory: first.workingDirectory, logger }, {
      adapters: new Map([[account, adapter(account, async (options) => { since = options.since; return { state: 'empty', items: [] }; })]]),
    });
    try { await reopened.ready; expect(since).toBeUndefined(); expect(await invoke(catalog)).toMatchObject({ total: 0 }); }
    finally { await reopened.close(); }
    expect(JSON.stringify(bus.sent)).not.toContain(account);
  } finally {
    release.resolve(); await closing;
    await second.close(); await first.close();
  }
  expect(clock.pendingTimers).toBe(0);
}, 15_000);

test('an elected registration cannot commit UID ownership evidence after the account fence expires', async () => {
  const clock = new FakeClusterClock(); const bus = new MemoryClusterBus();
  const entered = deferred(); const release = deferred(); let current = true; let fences = 0;
  const owned: InboundProviderAdapter = {
    id: account, pollIntervalMs: 3_600_000, checkpointKind: 'imap-uid',
    assertCurrent() { fences++; if (!current) throw new Error('Synthetic account generation expired'); },
    async poll() {
      entered.resolve(); await release.promise;
      return { state: 'pending', items: [], checkpointAdvance: {
        kind: 'imap-uid', transition: 'seed', previous: null,
        next: { kind: 'imap-uid', uidValidity: 7, lastTerminalUid: null,
          history: { kind: 'bounded-seed', lowerBoundUid: 101, skippedOlderMessages: 100 } },
        coveredUids: [], terminal: [],
      } };
    },
  };
  const owner = await node(bus, clock, 'expired-owner', [owned]);
  try {
    await enroll(owner); await startClusterServices(owner); clock.advance(2000); await entered.promise;
    current = false; release.resolve(); await owner.clusterCoordinator.settled();
    expect(fences).toBeGreaterThan(0);
    expect(owner.inbox.getImapCheckpoint!(account)).toBeNull();
    expect(await invoke(owner.gatewayMethods)).toMatchObject({ total: 0, partial: true, providers: [{ state: 'error' }] });
  } finally { release.resolve(); await owner.close(); }
  expect(clock.pendingTimers).toBe(0);
});
