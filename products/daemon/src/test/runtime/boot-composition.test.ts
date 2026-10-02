/** Actual product factory, graph and loopback server; only external boundaries are replaced. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import { join } from 'node:path';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { Notifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { NOTIFICATIONS_METADATA_ONLY_KEY, type NotificationDelivery } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { emitContractPassed } from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import { createDaemonBootOperations } from '../../runtime/boot-composition.js';
import type { RuntimeServices } from '../../runtime/services.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const URL = 'https://example.com/boot-notification';
const PRIVATE = 'synthetic-private-boot-content';
const turn: NotificationDelivery = { kind: 'turn', facts: { outcome: 'completed', elapsedMs: 1000, name: PRIVATE } };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let fixtures: DaemonFixture[];
let restores: Array<() => void>;
let releases: Array<() => void>;
let notifiers: Notifier[];
function keep<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  releases.push(resolve);
  return { promise, resolve };
}
function observe(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return keep(spyOn(globalThis, 'fetch').mockImplementation(Object.assign(implementation, { preconnect() {} })));
}
async function fixture(configure?: (runtime: RuntimeServices) => void, withBoot = true) {
  const fx = await startDaemonFixture({ root: makeOwnedTempDir('daemon-production-boot'),
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    ...(withBoot ? { createBootOperations(runtime: RuntimeServices) {
      // Explicit synthetic credential boundary prevents fallback to caller env.
      keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockResolvedValue(''));
      configure?.(runtime);
      return createDaemonBootOperations(runtime);
    } } : {}),
  });
  fixtures.push(fx);
  return fx;
}
beforeEach(() => {
  fixtures = []; restores = []; releases = []; notifiers = [];
  keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
  keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue());
  const original = Notifier.fromConfig;
  keep(spyOn(Notifier, 'fromConfig').mockImplementation(async (...args) => {
    const notifier = await original(...args); notifiers.push(notifier); return notifier;
  }));
});
afterEach(async () => {
  for (const release of releases) release();
  for (const fx of fixtures) await fx.stop();
  for (const restore of restores.reverse()) restore();
});

async function plugin(fx: DaemonFixture) {
  const directory = join(fx.workingDirectory, '.goodvibes', 'plugins', 'production-boot');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'production-boot', version: '1.0.0', description: 'owned fixture' }));
  fs.writeFileSync(join(directory, 'index.js'), `
    let release; export const pending = new Promise(resolve => { release = resolve; });
    export function finish() { release('finished'); }
    export function init(api) {
      api.registerGatewayMethod({ id: 'boot.fixture.held', title: 'Boot fixture', description: 'fixture', category: 'plugins', access: 'authenticated', transport: ['internal'], scopes: [], invokable: true }, () => pending);
      api.registerChannelPlugin({ id: 'production-boot', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/webhook/production-boot',
        async handleInbound() { return new Response('production boot fixture', { status: 202 }); } });
    }
  `);
  const module = await import(join(directory, 'index.js')) as { finish(): void };
  releases.push(module.finish);
  expect((await fx.services.pluginManager.enable('production-boot')).ok).toBe(true);
  return module;
}

test('production boot folds real legacy memory, synchronizes configured service facts and serves an enabled plugin', async () => {
  const fx = await fixture((runtime) => {
    keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockImplementation(async (service, field) => service === 'boot-service' && field === 'primary' ? 'synthetic-service-key' : ''));
  });
  await plugin(fx);
  fs.writeFileSync(join(fx.workingDirectory, '.goodvibes', fx.services.surfaceRoot, 'services.json'), JSON.stringify({
    'missing-service': { name: 'Missing service', authType: 'bearer', tokenKey: 'missing-fixture-key' },
    'boot-service': { name: 'Boot fixture service', authType: 'bearer', tokenKey: 'unused-synthetic-key', baseUrl: 'https://example.com/service' },
  }));
  const legacyPath = join(fx.workingDirectory, '.goodvibes', 'tui', 'memory.sqlite');
  fs.mkdirSync(join(legacyPath, '..'), { recursive: true });
  const source = new MemoryStore(legacyPath, { embeddingRegistry: fx.services.memoryEmbeddingRegistry, enableVectorIndex: false });
  await source.init();
  const record = await source.add({ scope: 'project', cls: 'fact', summary: 'synthetic boot migration fact' });
  await source.save(); source.close();
  expect(fx.services.memoryStore.get(record.id)).toBeNull();
  const boot = fx.services.bootTasks!;
  expect((await boot.start()).state).toBe('ready');
  expect(fx.services.memoryStore.get(record.id)?.summary).toBe('synthetic boot migration fact');
  expect(fs.existsSync(legacyPath)).toBe(true);
  expect(fx.services.runtimeStore.getState().integrations.integrations.get('boot-service')).toMatchObject({
    displayName: 'Boot fixture service', status: 'healthy', meta: { hasPrimaryCredential: true, hasWebhookUrl: false },
  });
  expect(fx.services.runtimeStore.getState().integrations.integrations.get('missing-service')?.status).toBe('unconfigured');
  const response = await fx.fetch('/webhook/production-boot');
  expect(response.status).toBe(202); expect(await response.text()).toBe('production boot fixture');
  await fx.services.close();
  expect(fx.services.channelPlugins.get('production-boot')).toBeNull();
  expect(fx.services.pluginManager.isEnabled('production-boot')).toBe(true);
});

test.each(['provider', 'webhook'] as const)('real graph fences all owners while plugin, provider reload and webhook body drain; release %s first', async (first) => {
  const reload = gate(); const loaded = gate(); const body = gate(); const cancelling = gate();
  const nativeWatch = fs.watch;
  let watching = false; let watchClosed = false;
  keep(spyOn(fs, 'watch').mockImplementation(((dir: fs.PathLike, options: fs.WatchOptions, callback: fs.WatchListener<string>) => {
    const watcher = nativeWatch(dir, options, callback);
    if (String(dir).endsWith('/providers')) {
      watching = true;
      const close = watcher.close.bind(watcher);
      keep(spyOn(watcher, 'close').mockImplementation(() => { watchClosed = true; close(); }));
    }
    return watcher;
  }) as typeof fs.watch));
  const fx = await fixture();
  const module = await plugin(fx);
  const runtime = fx.services;
  expect((await runtime.bootTasks!.start()).state).toBe('ready');
  const heldPlugin = fx.invoke('plugin.production-boot.boot.fixture.held');
  const changes: unknown[] = [];
  restores.push(runtime.runtimeBus.on('PROVIDERS_CHANGED', (event) => { changes.push(event.payload); }));
  const load = runtime.providerRegistry.loadCustomProviders;
  let loadCalls = 0;
  keep(spyOn(runtime.providerRegistry, 'loadCustomProviders').mockImplementation(async function (this: ProviderRegistry) {
    loadCalls++; loaded.resolve(); await reload.promise; return load.call(this);
  }));
  await until(() => watching, 'provider native watcher readiness');
  const providers = join(runtime.configManager.getControlPlaneConfigDir(), 'providers');
  fs.writeFileSync(join(providers, 'boot-provider.json'), JSON.stringify({ name: 'boot-provider', displayName: 'Boot provider', type: 'openai-compat', baseURL: 'http://127.0.0.1:1/v1',
    models: [{ id: 'owned-model', displayName: 'Owned model', contextWindow: 8192, capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false } }] }));
  await loaded.promise;
  runtime.webhookNotifier.addUrl(URL);
  // Only enable the explicit test force bit after replacing all fetch side effects.
  mockFetch(async (input) => String(input) === URL
    ? new Response(new ReadableStream({ cancel() { cancelling.resolve(); return body.promise; } }))
    : new Response('{}', { headers: { 'content-type': 'application/json' } }));
  Reflect.set(runtime.webhookNotifier, 'force', true);
  const sending = runtime.webhookNotifier.sendNotification(turn);
  await cancelling.promise;
  const calls: string[] = [];
  const notifier = notifiers[0]!;
  const closePlugin = runtime.pluginManager.close.bind(runtime.pluginManager);
  const closeNotifier = notifier.close.bind(notifier);
  const closeWebhook = runtime.webhookNotifier.close.bind(runtime.webhookNotifier);
  const closeProvider = runtime.providerRegistry.closeWatching.bind(runtime.providerRegistry);
  keep(spyOn(runtime.pluginManager, 'close').mockImplementation(() => { calls.push('plugins'); return closePlugin(); }));
  keep(spyOn(notifier, 'close').mockImplementation(() => { calls.push('notifier'); return closeNotifier(); }));
  keep(spyOn(runtime.webhookNotifier, 'close').mockImplementation(() => { calls.push('webhook'); return closeWebhook(); }));
  keep(spyOn(runtime.providerRegistry, 'closeWatching').mockImplementation(() => { calls.push('provider'); return closeProvider(); }));
  const handlers = keep(spyOn(runtime.daemonHandlers.routing, 'close'));
  const base = keep(spyOn(runtime.processManager, 'close'));
  const closing = runtime.close(); const settled = observe(closing);
  expect(runtime.close()).toBe(closing);
  await flush();
  expect(calls).toEqual(['plugins', 'notifier', 'webhook', 'provider']);
  expect(watchClosed).toBe(true);
  expect(() => runtime.providerRegistry.startWatching()).toThrow('closed');
  await expect(notifier.notifyNotification(turn)).rejects.toThrow('closed');
  expect((await runtime.webhookNotifier.sendNotification(turn)).results[0]?.error).toContain('closed');
  await flush(); expect(settled()).toBe(false); expect(handlers).not.toHaveBeenCalled(); expect(base).not.toHaveBeenCalled();
  module.finish(); await heldPlugin;
  if (first === 'provider') { reload.resolve(); await until(() => runtime.providerRegistry.has('boot-provider'), 'real admitted provider result'); }
  else { body.resolve(); await sending; }
  await flush(); expect(settled()).toBe(false); expect(handlers).not.toHaveBeenCalled(); expect(base).not.toHaveBeenCalled();
  reload.resolve(); body.resolve(); await sending; await closing;
  expect(runtime.providerRegistry.require('boot-provider').models).toContain('owned-model');
  expect(changes).toEqual([{ type: 'PROVIDERS_CHANGED', added: ['boot-provider:owned-model'], removed: [], updated: [] }]);
  expect(loadCalls).toBe(1); expect(handlers).toHaveBeenCalledTimes(1); expect(base).toHaveBeenCalledTimes(1);
});

test('held real Notifier.fromConfig acquisition closes without attachment or later steps', async () => {
  const acquired = gate(); const credential = gate(); const retiring = gate(); const retired = gate();
  const fx = await fixture((runtime) => {
    keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockImplementation(async () => { acquired.resolve(); await credential.promise; return ''; }));
  });
  const attach = keep(spyOn(Notifier.prototype, 'attachToRuntimeBus'));
  const closeReal = Notifier.prototype.close;
  const close = keep(spyOn(Notifier.prototype, 'close').mockImplementation(async function (this: Notifier) {
    retiring.resolve(); await closeReal.call(this); await retired.promise;
  }));
  const sync = keep(spyOn(fx.services.serviceRegistry, 'getAll'));
  const plugins = keep(spyOn(fx.services.pluginManager, 'init'));
  const starting = fx.services.bootTasks!.start(); await acquired.promise;
  sync.mockClear();
  const closing = fx.services.close(); const settled = observe(closing);
  credential.resolve(); await retiring.promise;
  expect(attach).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
  expect(fx.services.runtimeStore.getState().integrations.integrations.has('slack')).toBe(false);
  expect(sync).not.toHaveBeenCalled(); expect(plugins).not.toHaveBeenCalled();
  expect(settled()).toBe(false);
  await expect(notifiers[0]!.notifyNotification(turn)).rejects.toThrow('closed');
  retired.resolve(); await starting; await closing;
  expect(close).toHaveBeenCalledTimes(1);
});

test('zero-URL boot attaches the shared webhook and both real owners read live fail-closed privacy', async () => {
  let policy: unknown = false;
  const fx = await fixture((runtime) => {
    const get = runtime.configManager.get.bind(runtime.configManager);
    keep(spyOn(runtime.configManager, 'get').mockImplementation(((key: string) => {
      if (key !== NOTIFICATIONS_METADATA_ONLY_KEY) return get(key as never);
      if (policy === 'throw') throw new Error(PRIVATE);
      if (policy === 'async') return Promise.reject(new Error(PRIVATE));
      return policy;
    }) as never));
    keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockImplementation(async (service, field) => service === 'slack' && field === 'webhookUrl' ? URL : ''));
  });
  fs.writeFileSync(join(fx.workingDirectory, '.goodvibes', fx.services.surfaceRoot, 'services.json'), JSON.stringify({
    slack: { name: 'Slack webhook only', authType: 'bearer', tokenKey: '', webhookUrlKey: 'synthetic-only' },
  }));
  const runtime = fx.services;
  const attach = keep(spyOn(runtime.webhookNotifier, 'attachToRuntimeBus'));
  expect((await runtime.bootTasks!.start()).state).toBe('ready');
  expect(runtime.webhookNotifier.getUrls()).toEqual([]); expect(attach).toHaveBeenCalledTimes(1);
  expect(runtime.runtimeStore.getState().integrations.integrations.get('slack')).toMatchObject({
    category: 'communication', status: 'healthy', successCount: 0, errorCount: 0,
    meta: { attempts: 0, retrying: 0, deadLetters: 0, dlqSize: 0, hasPrimaryCredential: false, hasWebhookUrl: true },
  });
  expect(runtime.runtimeStore.getState().integrations.integrations.has('webhooks')).toBe(false);
  const sent: string[] = [];
  mockFetch(async (_input, init) => { sent.push(String(init?.body)); return new Response('ok'); });
  Reflect.set(runtime.webhookNotifier, 'force', true);
  runtime.webhookNotifier.addUrl(URL);
  emitContractPassed(runtime.runtimeBus, { sessionId: 'synthetic-session', traceId: 'synthetic-trace', source: 'boot-fixture' }, { contractId: 'synthetic-contract', criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 });
  await until(() => sent.length === 2, 'shared bus webhook and configured notifier delivery');
  await flush(); expect(sent).toHaveLength(2);
  for (const value of [false, true, undefined, 'unknown', 'throw', 'async', false]) {
    policy = value; sent.length = 0;
    await runtime.webhookNotifier.sendNotification(turn);
    await notifiers[0]!.notifyNotification(turn);
    expect(sent).toHaveLength(2);
    for (const body of sent) {
      if (value === false) expect(body).toContain(PRIVATE);
      else expect(body).not.toContain(PRIVATE);
    }
  }
});

test('a shared webhook is owned even when no boot factory is supplied', async () => {
  const fx = await fixture(undefined, false);
  fx.services.webhookNotifier.addUrl(URL);
  await fx.services.close();
  expect((await fx.services.webhookNotifier.send('unused')).results[0]?.error).toContain('closed');
});

test('configured webhook facts reflect the actual shared owner at attachment', async () => {
  const fx = await fixture((runtime) => runtime.configManager.mergeCategory('notifications', { webhookUrls: [URL] }));
  expect((await fx.services.bootTasks!.start()).state).toBe('ready');
  expect(fx.services.webhookNotifier.getUrls()).toEqual([URL]);
  expect(fx.services.runtimeStore.getState().integrations.integrations.get('webhooks')).toMatchObject({
    category: 'communication', status: 'healthy', meta: { urlCount: 1 },
  });
});

test('a failed real memory fold is degraded rather than silently ready', async () => {
  const fx = await fixture();
  const directory = join(fx.workingDirectory, '.goodvibes', 'tui');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(join(directory, 'memory.sqlite'), 'synthetic invalid sqlite fixture');
  const snapshot = await fx.services.bootTasks!.start();
  expect(snapshot.state).toBe('degraded');
  expect(snapshot.steps.find((step) => step.name === 'memory-fold')?.state).toBe('failed');
  expect(snapshot.steps.find((step) => step.name === 'plugins')?.state).toBe('ready');
});

test('failed graph boot composition closes its already-acquired shared webhook', async () => {
  let runtime: RuntimeServices | undefined;
  const failure = new Error('synthetic composition failure');
  await expect(fixture((services) => { runtime = services; throw failure; })).rejects.toBe(failure);
  if (!runtime) throw new Error('graph never reached boot composition');
  runtime.webhookNotifier.addUrl(URL);
  expect((await runtime.webhookNotifier.send('unused')).results[0]?.error).toContain('closed');
});

test.each(['notifier', 'configured-services'] as const)('a rejected %s credential read cannot hide a held sibling from graph shutdown', async (step) => {
  const entered = gate(); const held = gate();
  const failures: unknown[] = [];
  const warn = logger.warn.bind(logger);
  keep(spyOn(logger, 'warn').mockImplementation((message, meta) => {
    if (message === 'Daemon boot step failed') failures.push(meta);
    warn(message, meta);
  }));
  let released = false;
  const fx = await fixture((runtime) => {
    keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockImplementation(async (service, field) => {
      const selected = step === 'notifier' ? service === 'slack' : service === 'boot-service';
      if (!selected) return '';
      if (field === 'primary') { entered.resolve(); await held.promise; released = true; return ''; }
      throw new Error(PRIVATE);
    }));
  });
  if (step === 'configured-services') {
    fs.writeFileSync(join(fx.workingDirectory, '.goodvibes', fx.services.surfaceRoot, 'services.json'), JSON.stringify({
      'boot-service': { name: 'Boot service', authType: 'bearer', tokenKey: 'synthetic-only' },
    }));
  }
  const starting = fx.services.bootTasks!.start(); await entered.promise;
  await flush();
  expect(failures).toEqual([]);
  const base = keep(spyOn(fx.services.processManager, 'close'));
  const closing = fx.services.close(); const settled = observe(closing);
  await flush(); expect(settled()).toBe(false); expect(released).toBe(false); expect(base).not.toHaveBeenCalled();
  held.resolve(); await starting; await closing;
  expect(released).toBe(true); expect(base).toHaveBeenCalledTimes(1);
  expect(failures).toEqual([{ step }]);
  expect(fx.services.bootTasks!.snapshot().steps.find((value) => value.name === step)?.state).toBe('failed');
});
