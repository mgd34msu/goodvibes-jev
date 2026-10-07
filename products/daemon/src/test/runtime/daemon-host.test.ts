import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer, HttpListener } from '@goodvibes-jev/engine/sdk/platform/daemon';
import type { DiscoveredServer } from '@goodvibes-jev/engine/sdk/platform/discovery';
import type { HostedWorkspaceFloor } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { Notifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus } from '../../runtime/index.js';
import { createDaemonHost, type DaemonHost, type DaemonHostFactories, type DaemonHostOptions } from '../../runtime/daemon-host.js';
import { createDaemonBootOperations } from '../../runtime/boot-composition.js';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

let hosts: DaemonHost[];
let restores: Array<() => void>;
let releases: Array<() => void>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function keep<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  releases.push(resolve);
  return { promise, resolve };
}
function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}
beforeEach(() => {
  hosts = []; restores = []; releases = [];
  keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
  keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue());
});
afterEach(async () => {
  for (const release of releases) release();
  for (const host of hosts) { try { await host.close(); } catch { /* Failure cases assert the bounded result. */ } }
  for (const restore of restores.reverse()) restore();
});

function fixture(configure?: (runtime: RuntimeServices) => void, extra: DaemonHostFactories = {}) {
  const root = makeOwnedTempDir('owned-daemon-host');
  const homeDirectory = join(root, 'home'); const workingDir = join(root, 'workspace');
  const configDir = join(homeDirectory, '.goodvibes', 'daemon');
  mkdirSync(configDir, { recursive: true }); mkdirSync(workingDir, { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir, homeDir: homeDirectory });
  configManager.set('cluster.enabled', false);
  configManager.set('relay.enabled', false);
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
  let port = 0;
  const serveFactory = ((options) => {
    const server = Bun.serve(options); port = server.port!; return server;
  }) as typeof Bun.serve;
  const options: DaemonHostOptions = {
    runtime: { configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), featureFlags,
      homeDirectory, workingDir, daemonHomeDirectory: configDir,
      inboxFactory: (context, _routing, inboxOptions) => registerInboxSurface(context, { ...inboxOptions, adapters: new Map() }),
      localUserAuthManager: new UserAuthManager({ bootstrapFilePath: join(homeDirectory, 'users.json'), bootstrapCredentialPath: join(homeDirectory, 'bootstrap.txt'),
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('fixture'), roles: ['admin'] }] }),
    },
    daemon: { host: '127.0.0.1', port: 0, token: 'synthetic-host-token', serveFactory },
  };
  const factories: DaemonHostFactories = {
    async createRuntime(runtimeOptions) {
      expect(runtimeOptions.createBootOperations).toBe(createDaemonBootOperations);
      const runtime = await createRuntimeServices(runtimeOptions);
      keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockResolvedValue(''));
      configure?.(runtime); return runtime;
    }, ...extra,
  };
  const host = createDaemonHost(options, factories); hosts.push(host);
  return { root, homeDirectory, workingDir, options, factories, host, get baseUrl() { return `http://127.0.0.1:${port}`; } };
}

function seedPlugin(fx: ReturnType<typeof fixture>) {
  const directory = join(fx.workingDir, '.goodvibes', 'plugins', 'owned-host');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'owned-host', version: '1.0.0', description: 'owned fixture' }));
  writeFileSync(join(directory, 'index.js'), `
    let release; const held = new Promise(resolve => { release = resolve; });
    export function finish() { release('finished'); }
    export function init(api) {
      api.registerGatewayMethod({ id: 'held', title: 'Held fixture', description: 'fixture', category: 'plugins', access: 'authenticated', transport: ['internal'], scopes: [], invokable: true }, () => held);
      api.registerChannelPlugin({ id: 'owned-host', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/webhook/owned-host',
        async handleInbound() { return new Response('owned configured host', { status: 202 }); } });
    }
  `);
  const preferences = join(fx.homeDirectory, '.goodvibes', 'tui', 'plugins.json');
  mkdirSync(join(preferences, '..'), { recursive: true });
  writeFileSync(preferences, JSON.stringify({ enabled: { 'owned-host': true }, config: {}, trust: {}, quarantine: {} }));
  return { directory, preferences };
}

test('actual configured host initializes memory, starts real boot, serves persisted plugin and retains preference on close', async () => {
  let memoryReady = false; let bootStarted = false;
  const fx = fixture((runtime) => {
    const init = runtime.memoryStore.init.bind(runtime.memoryStore);
    keep(spyOn(runtime.memoryStore, 'init').mockImplementation(async () => { await init(); memoryReady = true; }));
    const start = runtime.bootTasks!.start;
    keep(spyOn(runtime.bootTasks!, 'start').mockImplementation(() => {
      expect(memoryReady).toBe(true); expect(fx.host.daemon?.isRunning).toBe(true); bootStarted = true; return start();
    }));
  });
  const plugin = seedPlugin(fx);
  expect(fx.host.services).toBeUndefined();
  const start = fx.host.start(); expect(fx.host.start()).toBe(start);
  expect((await start).state).toBe('ready'); expect(bootStarted).toBe(true);
  expect(fx.host.services?.pluginManager.isEnabled('owned-host')).toBe(true);
  const response = await fetch(`${fx.baseUrl}/webhook/owned-host`);
  expect(response.status).toBe(202); expect(await response.text()).toBe('owned configured host');
  const closing = fx.host.close(); expect(fx.host.close()).toBe(closing); await closing;
  expect(fx.host.snapshot().state).toBe('closed'); expect(fx.host.daemon?.isRunning).toBe(false);
  expect(fx.host.services?.channelPlugins.get('owned-host')).toBeNull();
  expect(JSON.parse(readFileSync(plugin.preferences, 'utf8')).enabled['owned-host']).toBe(true);
  await expect(fx.host.start()).rejects.toThrow('closed');
});

test('late runtime acquisition is owned and drained without starting any later phase', async () => {
  const acquired = gate(); const release = gate(); const graphClosing = gate(); const graphReleased = gate();
  let runtime: RuntimeServices | undefined; let boot = 0; let server = 0; let closed = 0;
  const fx = fixture(undefined, { async createRuntime(options) {
    runtime = await createRuntimeServices(options);
    keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockResolvedValue(''));
    keep(spyOn(runtime.bootTasks!, 'start').mockImplementation(async () => { boot++; return runtime!.bootTasks!.snapshot(); }));
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { closed++; graphClosing.resolve(); await graphReleased.promise; await close(); }));
    acquired.resolve(); await release.promise; return runtime;
  }, createServer(config) { server++; return new DaemonServer(config); } });
  const starting = fx.host.start(); await acquired.promise;
  const closing = fx.host.close(); const done = settled(closing);
  await tick(); expect(done()).toBe(false); expect(closed).toBe(0);
  release.resolve(); await graphClosing.promise; await tick();
  expect(server).toBe(0); expect(boot).toBe(0); expect(done()).toBe(false);
  graphReleased.resolve(); await starting; await closing;
  expect(closed).toBe(1); expect(runtime!.bootTasks!.snapshot().state).toBe('closed');
});

test('held server initialization must settle before stop and can never start boot after shutdown', async () => {
  const entered = gate(); const release = gate(); let boot = 0; let stopped = 0;
  const fx = fixture((runtime) => { keep(spyOn(runtime.bootTasks!, 'start').mockImplementation(async () => { boot++; return runtime.bootTasks!.snapshot(); })); }, {
    createServer(config) {
      const server = new DaemonServer(config); const stop = server.stop.bind(server);
      keep(spyOn(server, 'start').mockImplementation(async () => { entered.resolve(); await release.promise; }));
      keep(spyOn(server, 'stop').mockImplementation(async () => { stopped++; await stop(); }));
      return server;
    },
  });
  const starting = fx.host.start(); await entered.promise;
  const closing = fx.host.close(); const done = settled(closing); await tick();
  expect(done()).toBe(false); expect(stopped).toBe(0); expect(boot).toBe(0);
  release.resolve(); await starting; await closing;
  expect(stopped).toBe(1); expect(boot).toBe(0);
});

test('held real notifier acquisition drains its late owner without attachment or graph close', async () => {
  const entered = gate(); const release = gate(); let graphClosed = 0; let plugins = 0;
  const original = Notifier.fromConfig;
  keep(spyOn(Notifier, 'fromConfig').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); }));
  const attach = keep(spyOn(Notifier.prototype, 'attachToRuntimeBus'));
  const fx = fixture((runtime) => {
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { graphClosed++; await close(); }));
    const init = runtime.pluginManager.init.bind(runtime.pluginManager);
    keep(spyOn(runtime.pluginManager, 'init').mockImplementation(async (...args) => { plugins++; return init(...args); }));
  });
  const starting = fx.host.start(); await entered.promise;
  const closing = fx.host.close(); const done = settled(closing); await tick();
  expect(done()).toBe(false); expect(graphClosed).toBe(0);
  release.resolve(); await starting; await closing;
  expect(attach).not.toHaveBeenCalled(); expect(plugins).toBe(0); expect(graphClosed).toBe(1);
});

test('held real plugin call keeps graph dependencies alive until its owner drains', async () => {
  const fx = fixture(); const plugin = seedPlugin(fx);
  await fx.host.start();
  const module = await import(join(plugin.directory, 'index.js')) as { finish(): void }; releases.push(module.finish);
  const runtime = fx.host.services!;
  const call = runtime.gatewayMethods.invoke('plugin.owned-host.held', { methodId: 'plugin.owned-host.held', body: {} } as never);
  await tick();
  const close = keep(spyOn(runtime, 'close'));
  const closing = fx.host.close(); const done = settled(closing); await tick();
  expect(runtime.bootTasks!.snapshot().state).toBe('closing');
  expect(done()).toBe(false); expect(close).not.toHaveBeenCalled();
  module.finish(); await call; await closing;
  expect(close).toHaveBeenCalledTimes(1);
});

test('not-running refusal closes partial owners, skips boot and permits a fresh host retry', async () => {
  let closed = 0; let boot = 0;
  const fx = fixture((runtime) => {
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { closed++; await close(); }));
    keep(spyOn(runtime.bootTasks!, 'start').mockImplementation(async () => { boot++; return runtime.bootTasks!.snapshot(); }));
  }, { createServer(config) {
    const server = new DaemonServer(config); keep(spyOn(server, 'start').mockResolvedValue()); return server;
  } });
  await expect(fx.host.start()).rejects.toThrow('server startup failed'); await fx.host.close();
  expect(closed).toBe(1); expect(boot).toBe(0); expect(fx.host.snapshot().state).toBe('failed');
  const retry = fixture(); expect((await retry.host.start()).state).toBe('ready'); await retry.host.close();
});

test('independent server and listener stop failures still await graph close and expose no rejected values', async () => {
  const graphEntered = gate(); const graphRelease = gate(); const calls: string[] = [];
  const raw = { get message(): never { throw new Error('secret getter invoked'); }, toString() { throw new Error('secret string invoked'); } };
  const fx = fixture((runtime) => {
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { calls.push('graph'); graphEntered.resolve(); await graphRelease.promise; await close(); }));
  }, {
    createServer(config) {
      const server = new DaemonServer(config); const stop = server.stop.bind(server);
      keep(spyOn(server, 'stop').mockImplementation(async () => { calls.push('server'); await stop(); throw raw; })); return server;
    },
    createListener(config) {
      const listener = new HttpListener(config); const stop = listener.stop.bind(listener);
      keep(spyOn(listener, 'stop').mockImplementation(async () => { calls.push('listener'); await stop(); throw raw; })); return listener;
    },
  });
  const host = createDaemonHost({ ...fx.options, httpListener: { host: '127.0.0.1', port: 0 } }, fx.factories); hosts.push(host);
  await host.start(); const closing = host.close(); const done = settled(closing); await graphEntered.promise;
  expect(calls).toEqual(['listener', 'server', 'graph']); expect(done()).toBe(false);
  graphRelease.resolve(); await expect(closing).rejects.toThrow('Daemon host cleanup failed');
  const failure = await closing.catch((error: unknown) => error) as AggregateError;
  expect(failure.errors.map((error: Error) => error.message)).toEqual(['Daemon host HTTP listener stop failed', 'Daemon host daemon server stop failed']);
  expect(host.snapshot().state).toBe('failed');
});

test('close before start admits no graph and required inbox cannot silently default', async () => {
  const fx = fixture(); await fx.host.close(); expect(fx.host.services).toBeUndefined();
  await expect(fx.host.start()).rejects.toThrow('closed');
  const host = createDaemonHost({ ...fx.options, runtime: { ...fx.options.runtime, inboxFactory: undefined as never } }); hosts.push(host);
  await expect(host.start()).rejects.toThrow('runtime acquisition failed'); expect(host.services).toBeUndefined();
});

test('actual server fail-fast startup retains held sibling acquisition until graph close', async () => {
  const stopping = keep(spyOn(DaemonServer.prototype, 'stop'));
  const entered = gate(); const release = gate();
  let graphClosed = false; let siblingFinished = false;
  const fx = fixture((runtime) => {
    const start = runtime.sessionBroker.start.bind(runtime.sessionBroker);
    keep(spyOn(runtime.sessionBroker, 'start').mockImplementation(async () => {
      entered.resolve(); await release.promise; await start(); siblingFinished = true;
    }));
    keep(spyOn(runtime.approvalBroker, 'start').mockRejectedValue(new Error('synthetic sibling failure')));
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { graphClosed = true; await close(); }));
  });
  const starting = fx.host.start(); await entered.promise;
  await expect(starting).rejects.toThrow('server startup failed');
  const closing = fx.host.close(); const done = settled(closing); await tick();
  expect(graphClosed).toBe(false); expect(done()).toBe(false); expect(siblingFinished).toBe(false);
  expect(stopping).not.toHaveBeenCalled();
  release.resolve(); await expect(closing).rejects.toThrow('Daemon host cleanup failed');
  expect(siblingFinished).toBe(true); expect(graphClosed).toBe(true);
  expect(Reflect.get(fx.host.services!.sessionBroker, '_gcInterval')).toBeNull();
});

test('actual server failed-start cluster rollback is owned even when subsequent stops are no-ops', async () => {
  const stopping = keep(spyOn(DaemonServer.prototype, 'stop'));
  const entered = gate(); const release = gate(); let graphClosed = false; let consumerStopped = false;
  const { inboxSurface } = await import('@goodvibes-jev/engine/sdk/platform/cluster');
  const fx = fixture((runtime) => {
    runtime.clusterCoordinator.register({ id: 'held-startup-gate', surface: inboxSurface('owned-fixture'), async start() {},
      async stop() { entered.resolve(); await release.promise; consumerStopped = true; } });
    keep(spyOn(runtime.approvalBroker, 'start').mockRejectedValue(new Error('synthetic startup failure')));
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { graphClosed = true; await close(); }));
  });
  const starting = fx.host.start(); await entered.promise;
  await expect(starting).rejects.toThrow('server startup failed');
  const closing = fx.host.close(); const done = settled(closing); await tick();
  expect(graphClosed).toBe(false); expect(done()).toBe(false); expect(consumerStopped).toBe(false);
  expect(stopping).not.toHaveBeenCalled();
  release.resolve(); await expect(closing).rejects.toThrow('Daemon host cleanup failed');
  expect(consumerStopped).toBe(true); expect(graphClosed).toBe(true);
});

test('real startup drains remain isolated between concurrent facade instances', async () => {
  const entered = gate(); const release = gate();
  const failing = fixture((runtime) => {
    const start = runtime.sessionBroker.start;
    keep(spyOn(runtime.sessionBroker, 'start').mockImplementation(async function (this: RuntimeServices['sessionBroker']) {
      entered.resolve(); await release.promise; return start.call(this);
    }));
    keep(spyOn(runtime.approvalBroker, 'start').mockRejectedValue(new Error('synthetic instance failure')));
  });
  const failedStart = failing.host.start(); await entered.promise;
  await expect(failedStart).rejects.toThrow('server startup failed');
  const failedClose = failing.host.close(); const failedDone = settled(failedClose);
  const healthy = fixture();
  expect((await healthy.host.start()).state).toBe('ready');
  await healthy.host.daemon!.waitForRestart();
  await healthy.host.close();
  expect(failedDone()).toBe(false);
  release.resolve(); await expect(failedClose).rejects.toThrow('cleanup failed');
  expect(Reflect.get(failing.host.services!.sessionBroker, '_gcInterval')).toBeNull();
});

test('synchronous borrowed startup throw retains all admitted children without raw inspection', async () => {
  const entered = gate(); const release = gate(); let rawTouched = false; let graphClosed = false;
  const raw = { get message() { rawTouched = true; throw new Error('forbidden'); }, toString() { rawTouched = true; throw new Error('forbidden'); } };
  const fx = fixture((runtime) => {
    const start = runtime.sessionBroker.start.bind(runtime.sessionBroker);
    keep(spyOn(runtime.sessionBroker, 'start').mockImplementation(async () => { entered.resolve(); await release.promise; await start(); }));
    keep(spyOn(runtime.approvalBroker, 'start').mockImplementation(() => { throw raw; }));
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { graphClosed = true; await close(); }));
  });
  const starting = fx.host.start(); await entered.promise;
  await expect(starting).rejects.toThrow('server startup failed');
  const closing = fx.host.close(); const done = settled(closing);
  await tick();
  expect(done()).toBe(false); expect(graphClosed).toBe(false); expect(rawTouched).toBe(false);
  release.resolve(); await expect(closing).rejects.toThrow('cleanup failed');
  expect(Reflect.get(fx.host.services!.sessionBroker, '_gcInterval')).toBeNull();
  expect(rawTouched).toBe(false);
});

test('settled first rollback rejection remains visible to the barrier without raw inspection', async () => {
  let touched = false;
  const raw = { get message() { touched = true; throw new Error('forbidden'); }, toString() { touched = true; throw new Error('forbidden'); } };
  const fx = fixture((runtime) => {
    keep(spyOn(runtime.approvalBroker, 'start').mockRejectedValue(new Error('synthetic startup failure')));
    const stop = runtime.clusterCoordinator.stop.bind(runtime.clusterCoordinator);
    keep(spyOn(runtime.clusterCoordinator, 'stop').mockImplementation(async (reason) => {
      if (reason === 'daemon start failed') throw raw;
      await stop(reason);
    }));
  });
  await expect(fx.host.start()).rejects.toThrow('server startup failed');
  await expect(fx.host.close()).rejects.toThrow('cleanup failed');
  const result = await fx.host.daemon!.waitForRestart().catch((error: unknown) => error) as AggregateError;
  expect(result.errors.map((error: Error) => error.message)).toEqual([
    'Daemon approval broker startup operation failed', 'Daemon cluster rollback startup operation failed',
  ]);
  expect(touched).toBe(false);
});


test('close immediately fences both real config restart watchers while an admitted plugin call drains', async () => {
  const fx = fixture(); const plugin = seedPlugin(fx);
  const host = createDaemonHost({ ...fx.options, httpListener: { host: '127.0.0.1', port: 0 } }, fx.factories); hosts.push(host);
  await host.start();
  const module = await import(join(plugin.directory, 'index.js')) as { finish(): void }; releases.push(module.finish);
  const runtime = host.services!;
  const call = runtime.gatewayMethods.invoke('plugin.owned-host.held', { methodId: 'plugin.owned-host.held', body: {} } as never);
  await tick();
  const serverStart = keep(spyOn(host.daemon!, 'start'));
  const listenerStart = keep(spyOn(host.httpListener!, 'start'));
  const graphClose = keep(spyOn(runtime, 'close'));
  const closing = host.close(); const done = settled(closing);
  expect(host.close()).toBe(closing);
  runtime.configManager.set('controlPlane.port', 43187);
  runtime.configManager.set('httpListener.port', 43188);
  await host.daemon!.waitForRestart(); await host.httpListener!.waitForRestart();
  expect(serverStart).not.toHaveBeenCalled(); expect(listenerStart).not.toHaveBeenCalled();
  expect(done()).toBe(false); expect(graphClose).not.toHaveBeenCalled();
  module.finish(); await call; await closing;
  expect(graphClose).toHaveBeenCalledTimes(1);
});

test('close fences the start and dirty cycle of a config restart already waiting in stop', async () => {
  const fx = fixture(); await fx.host.start();
  const daemon = fx.host.daemon!;
  const entered = gate(); const release = gate();
  const originalStop = daemon.stop.bind(daemon);
  let first = true;
  keep(spyOn(daemon, 'stop').mockImplementation(async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    await originalStop();
  }));
  const start = keep(spyOn(daemon, 'start'));
  const close = keep(spyOn(fx.host.services!, 'close'));
  const config = fx.host.services!.configManager;
  config.set('controlPlane.port', 43187); await entered.promise;
  config.set('controlPlane.host', 'localhost'); // admitted dirty cycle
  const closing = fx.host.close(); const done = settled(closing);
  config.set('controlPlane.host', '127.0.0.1');
  await tick(); expect(done()).toBe(false); expect(close).not.toHaveBeenCalled();
  release.resolve(); await closing;
  expect(start).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
});

test('one borrowed restart fence failure cannot skip the other fence or accepted owner drainage', async () => {
  const fx = fixture();
  const host = createDaemonHost({ ...fx.options, httpListener: { host: '127.0.0.1', port: 0 } }, fx.factories); hosts.push(host);
  await host.start();
  const raw = { get message(): never { throw new Error('untrusted rejection inspected'); } };
  keep(spyOn(host.daemon!, 'fenceRestartAdmission').mockImplementation(() => { throw raw; }));
  const listenerFence = keep(spyOn(host.httpListener!, 'fenceRestartAdmission'));
  const bootClose = keep(spyOn(host.services!.bootTasks!, 'close'));
  const graphClose = keep(spyOn(host.services!, 'close'));
  const closing = host.close();
  expect(host.close()).toBe(closing);
  expect(listenerFence).toHaveBeenCalledTimes(1);
  expect(bootClose).toHaveBeenCalledTimes(1);
  await expect(closing).rejects.toThrow('Daemon host cleanup failed');
  expect(graphClose).toHaveBeenCalledTimes(1);
});

function cachedServer(model = 'cached-model', name = 'cached-fixture'): DiscoveredServer {
  return { name, host: '127.0.0.1', port: 9, baseURL: 'http://127.0.0.1:9/v1', models: [model], serverType: 'vllm' };
}
function seedCache(homeDirectory: string, servers: unknown, surfaceRoot = 'tui') {
  const directory = join(homeDirectory, '.goodvibes', surfaceRoot);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'discovered-providers.json'), JSON.stringify(servers));
}
function seedCustom(fx: ReturnType<typeof fixture>, name = 'cached-fixture') {
  const directory = join(fx.options.runtime.configManager.getControlPlaneConfigDir(), 'providers');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify({
    name, displayName: 'Custom fixture', type: 'openai-compat', baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'custom-model', displayName: 'Custom model', contextWindow: 8192,
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false } }],
  }));
}
function holdInitialCustomLoad() {
  const entered = gate(); const release = gate();
  const real = ProviderRegistry.prototype.loadCustomProviders;
  let registry: ProviderRegistry | undefined;
  keep(spyOn(ProviderRegistry.prototype, 'loadCustomProviders').mockImplementation(async function (this: ProviderRegistry) {
    registry = this; entered.resolve(); await release.promise; return real.call(this);
  }));
  return { entered, release, get registry() { return registry; } };
}

test('host preloads only its selected home/surface cache before real server and hosted-floor admission', async () => {
  let requests = 0;
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
    const body = await request.json() as { model: string };
    expect(body.model).toBe('cached-model'); requests++;
    const chunk = { id: 'cached-response', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'owned cached route' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  releases.push(() => { model.stop(true); });
  const cached = { ...cachedServer(), port: model.port!, baseURL: `http://127.0.0.1:${model.port}/v1` };
  const floors: HostedWorkspaceFloor[] = [];
  let constructed = false;
  const fx = fixture(undefined, { createServer(config) {
    expect(fx.host.services!.providerRegistry.listDiscoveredServers()).toEqual([cached]);
    constructed = true;
    const hosted = config!.hostedSessions!;
    return new DaemonServer({ ...config, hostedSessions: { ...hosted, async floorFactory(input) {
      const floor = await hosted.floorFactory(input); floors.push(floor); return floor;
    } } });
  } });
  seedCache(fx.homeDirectory, [cached]);
  seedCache(fx.homeDirectory, [cachedServer('wrong-surface')], 'daemon');
  seedCache(fx.workingDir, [cachedServer('wrong-workspace')]);
  seedCache(fx.options.runtime.daemonHomeDirectory!, [cachedServer('wrong-daemon-home')]);
  expect((await fx.host.start()).state).toBe('ready'); expect(constructed).toBe(true);
  expect(requests).toBe(0);
  const response = await fetch(`${fx.baseUrl}/api/control-plane/methods/sessions.hosted.create/invoke`, {
    method: 'POST', headers: { Authorization: 'Bearer synthetic-host-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { workspaceRoot: fx.workingDir, clientId: 'cache-fixture', modelId: 'cached-fixture:cached-model', detachPolicy: 'survive' } }),
  });
  expect(response.status).toBe(200);
  expect(floors).toHaveLength(1);
  const floor = floors[0]!;
  expect(floor.services.providerRegistry.listDiscoveredServers()).toEqual([cached]);
  await floor.services.providerRegistry.ready();
  const reply = await floor.services.providerRegistry.require(cached.name).chat({ model: 'cached-model', messages: [{ role: 'user', content: 'owned synthetic request' }] });
  expect(reply.content).toBe('owned cached route'); expect(requests).toBe(1);
  seedCache(fx.homeDirectory, [cachedServer('later-cache')]);
  expect(floor.services.providerRegistry.listDiscoveredServers()).toEqual([cached]);
  expect(fx.host.services!.providerRegistry.listDiscoveredServers()).toEqual([cached]);
  await fx.host.close();
});

test.each(['absent', 'empty', 'invalid'] as const)('%s discovery cache preserves an already registered snapshot', async (cache) => {
  const existing = cachedServer('already-registered');
  let registrations = 0;
  const fx = fixture((runtime) => {
    runtime.providerRegistry.registerDiscoveredProviders([existing]);
    const register = runtime.providerRegistry.registerDiscoveredProviders.bind(runtime.providerRegistry);
    keep(spyOn(runtime.providerRegistry, 'registerDiscoveredProviders').mockImplementation((servers) => { registrations++; register(servers); }));
  });
  if (cache !== 'absent') seedCache(fx.homeDirectory, cache === 'empty' ? [] : { invalid: true });
  await fx.host.start();
  expect(registrations).toBe(0);
  expect(fx.host.services!.providerRegistry.listDiscoveredServers()).toEqual([existing]);
});

test('host awaits real custom-provider initialization before cached name collisions are admitted', async () => {
  const held = holdInitialCustomLoad(); const acquired = gate();
  const fx = fixture(() => { acquired.resolve(); });
  seedCustom(fx); seedCache(fx.homeDirectory, [cachedServer()]);
  const starting = fx.host.start(); await held.entered.promise; await acquired.promise; await tick();
  expect(fx.host.daemon).toBeUndefined();
  expect(fx.host.services!.providerRegistry.listDiscoveredServers()).toEqual([]);
  held.release.resolve(); await starting;
  const registry = fx.host.services!.providerRegistry;
  expect(registry.listDiscoveredServers()).toEqual([cachedServer()]);
  expect(registry.require('cached-fixture').models).toEqual(['custom-model']);
  expect(registry.listModels().some((model) => model.registryKey === 'cached-fixture:custom-model')).toBe(true);
  expect(registry.listModels().some((model) => model.registryKey === 'cached-fixture:cached-model')).toBe(false);
});

test('same provider names in distinct runtime homes keep independent cached models', async () => {
  const first = fixture(); const second = fixture();
  seedCache(first.homeDirectory, [cachedServer('first-model')]);
  seedCache(second.homeDirectory, [cachedServer('second-model')]);
  await Promise.all([first.host.start(), second.host.start()]);
  expect(first.host.services!.providerRegistry.require('cached-fixture').models).toEqual(['first-model']);
  expect(second.host.services!.providerRegistry.require('cached-fixture').models).toEqual(['second-model']);
  await first.host.close();
  expect(second.host.services!.providerRegistry.require('cached-fixture').models).toEqual(['second-model']);
  expect(second.host.daemon!.isRunning).toBe(true);
});

test('shutdown during initial readiness awaits real loading and prevents registration or server construction', async () => {
  const held = holdInitialCustomLoad(); const readyEntered = gate();
  let registrations = 0; let graphClosed = 0; let servers = 0;
  const fx = fixture((runtime) => {
    const register = runtime.providerRegistry.registerDiscoveredProviders.bind(runtime.providerRegistry);
    keep(spyOn(runtime.providerRegistry, 'registerDiscoveredProviders').mockImplementation((servers) => { registrations++; register(servers); }));
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { graphClosed++; await close(); }));
    const ready = runtime.providerRegistry.ready.bind(runtime.providerRegistry);
    keep(spyOn(runtime.providerRegistry, 'ready').mockImplementation(() => { readyEntered.resolve(); return ready(); }));
  }, { createServer(config) { servers++; return new DaemonServer(config); } });
  seedCustom(fx); seedCache(fx.homeDirectory, [cachedServer()]);
  const starting = fx.host.start(); await held.entered.promise; await readyEntered.promise;
  const closing = fx.host.close(); const done = settled(closing); await tick();
  expect(done()).toBe(false); expect(graphClosed).toBe(0);
  expect(registrations).toBe(0); expect(servers).toBe(0);
  held.release.resolve(); await starting; await closing;
  expect(held.registry!.require('cached-fixture').models).toEqual(['custom-model']);
  expect(registrations).toBe(0); expect(servers).toBe(0); expect(graphClosed).toBe(1);
});

test('partial preload registration failure cannot serve and waits for owned graph cleanup without inspecting rejection', async () => {
  const graphEntered = gate(); const graphRelease = gate(); let touched = false; let servers = 0;
  const raw = { get message() { touched = true; throw new Error('private'); }, toString() { touched = true; throw new Error('private'); } };
  const fx = fixture((runtime) => {
    const register = runtime.providerRegistry.registerDiscoveredProviders.bind(runtime.providerRegistry);
    keep(spyOn(runtime.providerRegistry, 'registerDiscoveredProviders').mockImplementation((servers) => { register(servers.slice(0, 1)); throw raw; }));
    const close = runtime.close;
    keep(spyOn(runtime, 'close').mockImplementation(async () => { graphEntered.resolve(); await graphRelease.promise; await close(); }));
  }, { createServer(config) { servers++; return new DaemonServer(config); } });
  seedCache(fx.homeDirectory, [cachedServer(), cachedServer('second-model', 'second-provider')]);
  await expect(fx.host.start()).rejects.toThrow('Daemon host provider preload failed');
  const closing = fx.host.close(); const done = settled(closing); await graphEntered.promise;
  expect(fx.host.services!.providerRegistry.has('cached-fixture')).toBe(true);
  expect(fx.host.services!.providerRegistry.has('second-provider')).toBe(false);
  expect(done()).toBe(false); expect(servers).toBe(0); expect(touched).toBe(false);
  graphRelease.resolve(); await closing;
  expect(fx.host.snapshot().state).toBe('failed'); expect(touched).toBe(false);
});

test('base graph acquisition failure drains initial real custom loading before the host can receive a runtime', async () => {
  const held = holdInitialCustomLoad(); const failed = gate();
  const fx = fixture(); seedCustom(fx);
  keep(spyOn(fx.options.runtime.configManager, 'attachHookDispatcher').mockImplementation(() => { failed.resolve(); throw new Error('synthetic graph failure'); }));
  const starting = fx.host.start(); const startDone = settled(starting);
  await held.entered.promise; await failed.promise; await tick();
  const closing = fx.host.close(); const closeDone = settled(closing); await tick();
  expect(startDone()).toBe(false); expect(closeDone()).toBe(false);
  expect(fx.host.services).toBeUndefined(); expect(fx.host.daemon).toBeUndefined();
  held.release.resolve();
  await expect(starting).rejects.toThrow('Daemon host runtime acquisition failed'); await closing;
  expect(held.registry!.require('cached-fixture').models).toEqual(['custom-model']);
  expect(fx.host.services).toBeUndefined();
});
