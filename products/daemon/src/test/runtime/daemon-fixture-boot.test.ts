import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface, type InboundProviderAdapter } from '@goodvibes-jev/engine/sdk/platform/intake';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { trackIntervals } from '../helpers/intervals.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';

function rootWithBenchmarks(label: string): string {
  const root = makeOwnedTempDir(label);
  const directory = join(root, 'home', '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'benchmarks.json'), JSON.stringify({
    version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000,
    entries: [{ modelId: 'fixture-model', name: 'Fixture model', organization: 'Fixture', benchmarks: { gpqa: 0.7 } }],
  }));
  return root;
}

test('the actual product graph serves its configured inbox over loopback and awaits shutdown', async () => {
  // Provider metadata is explicitly fixture-backed. This case does not claim
  // live catalog discovery or inference; every gateway/store/server is real.
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const intervals = trackIntervals();
  let polls = 0;
  const adapter: InboundProviderAdapter = {
    id: 'fixture', pollIntervalMs: 3_600_000,
    async poll() {
      polls++;
      return {
        state: 'ready', configured: true,
        items: [{ id: 'fixture-item', provider: 'fixture', kind: 'dm', fromDigest: 'fixture-sender', subjectPreview: 'Fixture subject', bodyPreview: 'Fixture body', receivedAt: Date.now(), unread: true }],
      };
    },
  };
  let fixture: DaemonFixture | undefined;
  try {
    fixture = await startDaemonFixture({ root: rootWithBenchmarks('daemon-boot'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map([['fixture', adapter]]) }),
    });
    expect(fixture.daemon.isRunning).toBe(true);
    expect(fixture.services.benchmarkStore.getKnownBenchmarks('fixture-model')?.benchmarks.gpqa).toBe(0.7);
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(polls).toBe(1);
    expect(intervals.count).toBeGreaterThan(3);
    const response = await fixture.fetch('/api/channels/inbox');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: 'fixture-item' }], total: 1 });
    expect(await fixture.invoke('channels.drafts.list')).toMatchObject({ drafts: [] });
    expect(await fixture.invoke('payments.cards.list')).toMatchObject({ cards: [] });
    expect(fixture.services.sessionSnapshot('fixture-session', { messages: [] })).toMatchObject({ messages: [], contracts: [] });
    const stopping = fixture.stop(); expect(fixture.stop()).toBe(stopping);
    await stopping;
    expect(fixture.daemon.isRunning).toBe(false);
    expect(fixture.services.gatewayMethods.hasHandler('channels.inbox.list')).toBe(false);
    expect(intervals.remaining()).toEqual([]);
  } finally { try { await fixture?.stop(); } finally { intervals.restore(); discovery.mockRestore(); } }
}, 30_000);

test('failed inbox acquisition releases the real base graph and the same owned root can boot again', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const intervals = trackIntervals(); const root = rootWithBenchmarks('daemon-startup-rollback');
  const failure = new Error('fixture inbox initialization failed');
  let fixture: DaemonFixture | undefined;
  try {
    await expect(startDaemonFixture({ root, inboxFactory() {
      expect(intervals.count).toBeGreaterThan(3);
      throw failure;
    } })).rejects.toBe(failure);
    expect(intervals.remaining()).toEqual([]);
    fixture = await startDaemonFixture({ root,
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    expect(fixture.daemon.isRunning).toBe(true);
    expect(await fixture.invoke('channels.inbox.list')).toMatchObject({ items: [], total: 0 });
    await fixture.stop(); expect(intervals.remaining()).toEqual([]);
  } finally { try { await fixture?.stop(); } finally { intervals.restore(); discovery.mockRestore(); } }
}, 30_000);

test.each(['benchmarks', 'providers'])('shutdown awaits accepted %s metadata before releasing its owned graph', async (kind) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockImplementation(() => kind === 'providers' ? waiting.then(() => []) : Promise.resolve([]));
  const refresh = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockImplementation(() => waiting);
  let fixture: DaemonFixture | undefined;
  try {
    const root = kind === 'benchmarks' ? makeOwnedTempDir('daemon-benchmark-drain') : rootWithBenchmarks('daemon-discovery-drain');
    fixture = await startDaemonFixture({ root,
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(kind === 'benchmarks' ? 1 : 0);
    let closed = false;
    const closing = fixture.stop().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    expect(fixture.daemon.isRunning).toBe(false);
  } finally {
    release();
    try { await fixture?.stop(); }
    finally { refresh.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);
