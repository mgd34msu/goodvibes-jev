import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface, type InboundProviderAdapter } from '@goodvibes-jev/engine/sdk/platform/intake';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import { trackIntervals } from '../helpers/intervals.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { contractPath } from '@goodvibes-jev/engine/sdk/platform/contract';

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

test('runtime shutdown cancels contract work, flushes its pending store and detaches new admission', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const signals: AbortSignal[] = [];
  let markReadingStarted!: () => void;
  const readingStarted = new Promise<void>((resolve) => { markReadingStarted = resolve; });
  const events: string[] = [];
  const heldReading: JudgmentPort = {
    model: 'fixture-held-reading',
    ask(request) {
      if (request.context?.site !== 'contract.request-shape' || !request.signal) {
        return Promise.reject(new Error('Unexpected contract disposal fixture reading'));
      }
      const signal = request.signal;
      signals.push(signal);
      markReadingStarted();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Fixture reading cancelled', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
  let fixture: DaemonFixture | undefined;
  let previous: ReturnType<typeof installJudgmentPort>;
  let readingInstalled = false;
  const schedule = globalThis.setTimeout;
  const delayedWrites: ReturnType<typeof setTimeout>[] = [];
  try {
    fixture = await startDaemonFixture({ root: rootWithBenchmarks('daemon-contract-disposal'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    previous = installJudgmentPort(heldReading); readingInstalled = true;
    const runner = fixture.services.contractRunner;
    runner.on((event) => events.push(event.type));
    // Hold the store's debounce beyond the test ceiling: the file below must
    // be written by owned shutdown, not by winning a race with its timer.
    globalThis.setTimeout = ((callback: never, delay?: number, ...args: never[]) => {
      const timer = schedule(callback, delay === 250 ? 60_000 : delay, ...args);
      if (delay === 250) delayedWrites.push(timer);
      return timer;
    }) as typeof setTimeout;
    const started = runner.start({ ask: 'Fixture held contract', sessionId: 'fixture-session', origin: 'cli',
      projectRoot: fixture.workingDirectory, isolation: 'shared' });
    globalThis.setTimeout = schedule;
    expect(events).toContain('CONTRACT_CREATED');
    // Admission may await input preparation before requesting its first reading.
    // Observe that owned request rather than assuming start() runs it synchronously.
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([readingStarted, new Promise<never>((_, reject) => {
        readinessTimeout = schedule(() => reject(new Error('contract request-shape never became ready')), 5_000);
      })]);
    } finally { if (readinessTimeout) clearTimeout(readinessTimeout); }
    expect(signals).toHaveLength(1);
    expect(delayedWrites.length).toBeGreaterThan(0);
    expect(signals[0]!.aborted).toBe(false);
    installJudgmentPort(previous); readingInstalled = false;
    await fixture.stop();
    expect(signals[0]!.aborted).toBe(true);
    const saved = JSON.parse(readFileSync(contractPath(fixture.workingDirectory, started.contract.id), 'utf8'));
    expect(saved.contract.id).toBe(started.contract.id);
    expect(saved.contract.ask).toBe('Fixture held contract');
    expect(() => fixture!.services.agentManager.spawn({ mode: 'spawn', task: 'Late fixture admission' })).toThrow('No contract runner is composed');
  } finally {
    globalThis.setTimeout = schedule;
    if (readingInstalled) installJudgmentPort(previous);
    try { await fixture?.stop(); } finally { for (const timer of delayedWrites) clearTimeout(timer); discovery.mockRestore(); }
  }
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

test('successive owned graphs rebuild after shutdown and repeated shutdown stays inert', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const intervals = trackIntervals();
  const root = rootWithBenchmarks('daemon-helper-reset');
  let first: DaemonFixture | undefined;
  let second: DaemonFixture | undefined;
  const inboxFactory: Parameters<typeof startDaemonFixture>[0]['inboxFactory'] = (context, _routing, options) =>
    registerInboxSurface(context, { ...options, adapters: new Map() });
  try {
    first = await startDaemonFixture({ root, inboxFactory });
    const oldGraph = first.services;
    expect(first.services).toBe(oldGraph);
    expect(intervals.count).toBeGreaterThan(3);
    await first.stop();
    expect(intervals.remaining()).toEqual([]);
    await expect(first.stop()).resolves.toBeUndefined();
    expect(intervals.remaining()).toEqual([]);
    second = await startDaemonFixture({ root, inboxFactory });
    expect(second.services).not.toBe(oldGraph);
    expect(intervals.count).toBeGreaterThan(3);
    await second.stop();
    expect(intervals.remaining()).toEqual([]);
    await expect(second.stop()).resolves.toBeUndefined();
    expect(intervals.remaining()).toEqual([]);
  } finally {
    try { await second?.stop(); await first?.stop(); }
    finally { intervals.restore(); discovery.mockRestore(); }
  }
}, 30_000);


test('owned graph profile cannot follow an inherited daemon-home override', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const foreign = makeOwnedTempDir('daemon-foreign-profile');
  const foreignPath = join(foreign, 'owner-profile.md');
  const foreignText = '# Owner profile\n\n- name: foreign-fixture-owner\n';
  writeFileSync(foreignPath, foreignText);
  const previous = process.env.GOODVIBES_DAEMON_HOME;
  process.env.GOODVIBES_DAEMON_HOME = foreign;
  let fixture: DaemonFixture | undefined;
  try {
    fixture = await startDaemonFixture({ root: rootWithBenchmarks('daemon-profile-isolation'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    const profile = await fixture.invoke<{ path: string }>('profile.status');
    expect(profile.path).toBe(join(fixture.homeDirectory, '.goodvibes', 'daemon', 'owner-profile.md'));
    expect(profile.path).not.toBe(foreignPath);
    expect(readFileSync(foreignPath, 'utf8')).toBe(foreignText);
    expect(process.env.GOODVIBES_DAEMON_HOME).toBe(foreign);
  } finally {
    try { await fixture?.stop(); } finally {
      discovery.mockRestore();
      if (previous === undefined) delete process.env.GOODVIBES_DAEMON_HOME;
      else process.env.GOODVIBES_DAEMON_HOME = previous;
    }
  }
}, 30_000);
