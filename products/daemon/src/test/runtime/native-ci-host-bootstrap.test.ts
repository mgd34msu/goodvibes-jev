import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as nativeActivation from '../../runtime/native-work-execution-activation.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
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
function keep<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  releases.push(resolve);
  return { promise, resolve };
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
    providerDiscovery: { scan: async () => ({ servers: [], scannedHosts: 0, scannedPorts: 0, durationMs: 0 }) },
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


test('actual host clean shutdown preserves captured durable policy with enabled plugin', async () => {
  const fx = fixture(); seedPlugin(fx);
  expect((await fx.host.start()).state).toBe('ready');
  const runtime = fx.host.services!;
  expect(runtime.pluginManager.isEnabled('owned-host')).toBe(true);
  const before = runtime.configManager.captureDurableConfigurationIncarnation();
  const configPath = runtime.configManager.getConfigPath();
  const epochBefore = JSON.parse(readFileSync(`${configPath}.policy-epoch.json`, 'utf8')).incarnation;
  await fx.host.close();
  const epochAfter = JSON.parse(readFileSync(`${configPath}.policy-epoch.json`, 'utf8')).incarnation;
  expect(epochAfter).toBe(epochBefore);
  expect(runtime.configManager.getDurableConfigurationIncarnation()).toBe(before);
  const successorConfig = new ConfigManager({ surfaceRoot: 'tui', configDir: join(fx.homeDirectory, '.goodvibes', 'daemon'), workingDir: fx.workingDir, homeDir: fx.homeDirectory });
  const featureFlags = createFeatureFlagManager(); featureFlags.loadFromConfig({ flags: deriveFeatureStates(successorConfig) });
  const successor = createDaemonHost({ ...fx.options, runtime: { ...fx.options.runtime, configManager: successorConfig, featureFlags, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() } }, fx.factories);
  hosts.push(successor);
  expect((await successor.start()).state).toBe('ready');
  expect(successor.services!.pluginManager.isEnabled('owned-host')).toBe(true);
  expect(successor.services!.configManager.getDurableConfigurationIncarnation()).toBe(before);
}, 30000);

test('composed boot controller refuses repeated start after close', async () => {
  const fx = fixture();
  expect((await fx.host.start()).state).toBe('ready');
  const boot = fx.host.services!.bootTasks!;
  await fx.host.close();
  expect(boot.snapshot().state).toBe('closed');
  await expect(boot.start()).rejects.toThrow('closed');
}, 30000);

function captureScope() {
  const build = nativeActivation.createDaemonNativeWorkExecutionActivation;
  let options: Parameters<typeof build>[0] | undefined;
  keep(spyOn(nativeActivation, 'createDaemonNativeWorkExecutionActivation').mockImplementation(value => { options = value; return build(value); }));
  return () => options!.continuationScopeOwner!;
}

test('repeated successful boot is idempotent and retirement is synchronous before held plugin teardown', async () => {
  const scope = captureScope(); const held = gate(); let init = 0; let stop = 0;
  const fx = fixture(runtime => {
    keep(spyOn(runtime.pluginManager, 'init').mockImplementation(async () => { init++; }));
    keep(spyOn(runtime.pluginManager, 'close').mockImplementation(async () => { stop++; await held.promise; }));
  });
  expect((await fx.host.start()).state).toBe('ready');
  const boot = fx.host.services!.bootTasks!;
  const first = boot.start(); expect(boot.start()).toBe(first); expect((await first).state).toBe('ready');
  expect(init).toBe(1); expect(() => scope().current()).not.toThrow();
  const closing = fx.host.close();
  expect(stop).toBe(1); expect(boot.snapshot().state).toBe('closing');
  expect(() => scope().current()).toThrow();
  await expect(boot.start()).rejects.toThrow('closed');
  held.resolve(); await closing;
});

test('settled degraded boot exposes only surviving catalog and cannot reopen after close', async () => {
  const scope = captureScope(); let init = 0;
  const fx = fixture(runtime => {
    keep(spyOn(runtime.pluginManager, 'init').mockImplementation(async () => { init++; throw new Error('synthetic plugin init failure'); }));
  });
  const result = await fx.host.start();
  expect(result.state).toBe('degraded'); expect(result.boot!.steps.find(x => x.name === 'plugins')!.state).toBe('failed');
  expect(() => scope().current()).not.toThrow();
  const boot = fx.host.services!.bootTasks!;
  expect((await boot.start()).state).toBe('degraded'); expect(init).toBe(1);
  await fx.host.close(); expect(() => scope().current()).toThrow();
  await expect(boot.start()).rejects.toThrow('closed');
});

test('boot interrupted during plugin acquisition never activates policy when admitted work settles', async () => {
  const scope = captureScope(); const entered = gate(); const held = gate(); let stop = 0;
  const fx = fixture(runtime => {
    keep(spyOn(runtime.pluginManager, 'init').mockImplementation(async () => { entered.resolve(); await held.promise; }));
    keep(spyOn(runtime.pluginManager, 'close').mockImplementation(async () => { stop++; await held.promise; }));
  });
  const starting = fx.host.start(); await entered.promise;
  expect(() => scope().current()).toThrow();
  const closing = fx.host.close(); expect(stop).toBe(1);
  expect(() => scope().current()).toThrow();
  held.resolve(); await starting; await closing;
  expect(() => scope().current()).toThrow();
  expect(fx.host.services!.bootTasks!.snapshot().state).toBe('closed');
  await expect(fx.host.services!.bootTasks!.start()).rejects.toThrow('closed');
});

test('server startup failure before product boot never completes native scope bootstrap', async () => {
  const scope = captureScope();
  const fx = fixture(undefined, { createServer(config) {
    const server = new DaemonServer(config); keep(spyOn(server, 'start').mockRejectedValue(new Error('synthetic server startup failure'))); return server;
  } });
  await expect(fx.host.start()).rejects.toThrow('server startup failed');
  await fx.host.close();
  expect(() => scope().current()).toThrow();
  expect(fx.host.services!.bootTasks!.snapshot().state).toBe('closed');
  await expect(fx.host.services!.bootTasks!.start()).rejects.toThrow('closed');
});
