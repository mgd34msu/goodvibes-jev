import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import type { DaemonBootAttachment, DaemonBootOperations } from '../../runtime/boot-tasks.js';
import type { RuntimeServices } from '../../runtime/services.js';
import { createDaemonPluginLoaderDeps } from '../../runtime/plugin-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function explicitOperations(overrides: Partial<DaemonBootOperations> = {}): DaemonBootOperations {
  const attachment = (): DaemonBootAttachment => ({ attach() {}, close() {} });
  return {
    async foldMemory() {}, startProviderWatch() {}, stopProviderWatch() {},
    createWebhooks: attachment, createNotifier: attachment,
    async synchronizeServices() {}, async initializePlugins() {}, async closePlugins() {},
    reportFailure() {}, ...overrides,
  };
}

test('the actual graph owns boot before publication and drains a late attachment before base dependencies', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  const acquiring = gate(); const acquired = gate<DaemonBootAttachment>();
  const cleanupEntered = gate(); const cleanupDone = gate(); const watchStopped = gate();
  const events: string[] = [];
  let fixture: DaemonFixture | undefined;
  let captured: RuntimeServices | undefined;
  let restoreBaseClose = () => {};
  try {
    fixture = await startDaemonFixture({ root: makeOwnedTempDir('daemon-boot-owner'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      createBootOperations(runtime) {
        captured = runtime;
        return explicitOperations({
          startProviderWatch() { events.push('watch'); },
          stopProviderWatch() { events.push('stop-watch'); watchStopped.resolve(); },
          createWebhooks() { return { attach() { events.push('attach:webhooks'); }, close() { events.push('close:webhooks'); } }; },
          createNotifier() { acquiring.resolve(); return acquired.promise; },
          async initializePlugins() { events.push('plugins'); },
        });
      },
    });
    expect(captured).toBe(fixture.services);
    expect(fixture.services.bootTasks?.snapshot().state).toBe('idle');
    expect(events).toEqual([]);
    const boot = fixture.services.bootTasks;
    if (!boot) throw new Error('fixture boot controller missing');
    const starting = boot.start(); await acquiring.promise;
    const originalClose = fixture.services.processManager.close.bind(fixture.services.processManager);
    const baseClose = spyOn(fixture.services.processManager, 'close').mockImplementation(() => { events.push('close:base'); return originalClose(); });
    restoreBaseClose = () => baseClose.mockRestore();
    let closed = false;
    const closing = fixture.services.close().then(() => { closed = true; });
    expect(await Promise.race([watchStopped.promise.then(() => true), closing.then(() => false)])).toBe(true);
    expect(events).toContain('close:webhooks');
    expect(events).not.toContain('close:base');
    expect(closed).toBe(false);
    acquired.resolve({ attach() { events.push('attach:late'); }, close() { cleanupEntered.resolve(); return cleanupDone.promise; } });
    await cleanupEntered.promise;
    expect(closed).toBe(false);
    expect(events).not.toContain('attach:late');
    cleanupDone.resolve();
    await starting; await closing;
    expect(events).toContain('close:base');
    expect(events).not.toContain('plugins');
    expect(boot.snapshot().state).toBe('closed');
    await expect(boot.start()).rejects.toThrow('closed');
  } finally {
    acquired.resolve({ attach() {}, close() {} }); cleanupDone.resolve();
    try { await fixture?.stop(); await fixture?.services.bootTasks?.close(); }
    finally { restoreBaseClose(); benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);

test('explicit boot loads an enabled plugin into the daemon registry that actually serves HTTP', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  let fixture: DaemonFixture | undefined;
  try {
    fixture = await startDaemonFixture({ root: makeOwnedTempDir('daemon-boot-live-registry'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      createBootOperations(runtime) {
        return explicitOperations({
          initializePlugins: () => runtime.pluginManager.init(createDaemonPluginLoaderDeps(runtime)),
          closePlugins: () => runtime.pluginManager.close(),
        });
      },
    });
    const directory = join(fixture.workingDirectory, '.goodvibes', 'plugins', 'boot-fixture');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'boot-fixture', version: '1.0.0', description: 'owned boot fixture' }));
    writeFileSync(join(directory, 'index.js'), `export function init(api) {
      api.registerChannelPlugin({ id: 'boot-fixture', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/webhook/boot-fixture',
        async handleInbound() { return new Response('boot fixture', { status: 202, headers: { 'x-boot-fixture': 'yes' } }); } });
    }`);
    expect((await fixture.services.pluginManager.enable('boot-fixture')).ok).toBe(true);
    expect(fixture.services.channelPlugins.get('boot-fixture')).toBeNull();
    const boot = fixture.services.bootTasks;
    if (!boot) throw new Error('fixture boot controller missing');
    expect((await boot.start()).state).toBe('ready');
    const response = await fixture.fetch('/webhook/boot-fixture');
    expect(response.status).toBe(202);
    expect(response.headers.get('x-boot-fixture')).toBe('yes');
    expect(await response.text()).toBe('boot fixture');
    await fixture.services.close();
    expect(fixture.services.channelPlugins.get('boot-fixture')).toBeNull();
    expect(fixture.services.pluginManager.isEnabled('boot-fixture')).toBe(true);
    expect(boot.snapshot().state).toBe('closed');
  } finally {
    try { await fixture?.stop(); }
    finally { benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);

test.each(['throw', 'close'] as const)('boot factory %s cannot publish a partially retired graph', async (mode) => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  let captured: RuntimeServices | undefined;
  let closing: Promise<void> | undefined;
  const failure = new Error('fixture boot construction failed');
  try {
    const creating = startDaemonFixture({ root: makeOwnedTempDir('daemon-boot-factory-failure'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      createBootOperations(runtime) {
        captured = runtime;
        if (mode === 'throw') throw failure;
        closing = runtime.close();
        void closing.catch(() => {});
        return explicitOperations();
      },
    });
    if (mode === 'throw') await expect(creating).rejects.toBe(failure);
    else await expect(creating).rejects.toThrow('closed during boot composition');
    const runtime = captured as RuntimeServices | undefined;
    if (!runtime) throw new Error('fixture never reached boot construction');
    await closing;
    expect(runtime.pluginManager.shutdownStatus().state).toBe('closed');
    if (mode === 'close') expect(runtime.bootTasks?.snapshot().state).toBe('closed');
  } finally {
    try { await captured?.close(); await captured?.bootTasks?.close(); }
    finally { benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);
