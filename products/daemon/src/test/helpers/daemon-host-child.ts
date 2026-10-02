/** Real configured graph/host in a disposable home, driven by actual signals. */
import { spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { inboxSurface } from '@goodvibes-jev/engine/sdk/platform/cluster';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { Notifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { runDaemonProcess } from '../../daemon/process-lifecycle.js';
import { createDaemonHost } from '../../runtime/daemon-host.js';
import { createDaemonBootOperations } from '../../runtime/boot-composition.js';
import { createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus } from '../../runtime/index.js';
import { createRuntimeServices } from '../../runtime/services.js';

const mode = process.argv[2];
const root = process.argv[3];
if (!root || process.env.GOODVIBES_SDK_TEST_RUNNER !== '1') throw new Error('Owned subprocess fixture root required');
const event = (value: string) => { writeSync(1, `${value}\n`); };
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const phaseGate = gate();
const graphGate = gate();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'release-phase') phaseGate.resolve();
  if (line === 'release-graph') graphGate.resolve();
  if (line === 'check-phase') { event(`PHASE_GRAPH_CLOSES:${graphCloses}`); event('PHASE_CHECKED'); }
});
let bootStarts = 0;
let serverCreates = 0;
let notifierAttaches = 0;
let graphCloses = 0;
let closeCalls = 0;
const ownedHandlers = new Map<string, () => void>();
process.on('exit', (code) => {
  event(`COUNTS:${bootStarts}:${serverCreates}:${notifierAttaches}:${graphCloses}:${closeCalls}`);
  event(`EXIT:${code}:${process.listenerCount('SIGINT')}:${process.listenerCount('SIGTERM')}`);
  event(`OWNED_SIGNALS:${Number(process.listeners('SIGINT').includes(ownedHandlers.get('SIGINT')!))}:${Number(process.listeners('SIGTERM').includes(ownedHandlers.get('SIGTERM')!))}`);
});

spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
if (mode === 'notifier') {
  const fromConfig = Notifier.fromConfig;
  spyOn(Notifier, 'fromConfig').mockImplementation(async (...args) => {
    event('HELD');
    await phaseGate.promise;
    return fromConfig(...args);
  });
}
const attach = Notifier.prototype.attachToRuntimeBus;
spyOn(Notifier.prototype, 'attachToRuntimeBus').mockImplementation(function (this: Notifier, ...args) {
  notifierAttaches++;
  return attach.apply(this, args);
});

const homeDirectory = join(root, 'home');
const workingDir = join(root, 'workspace');
const configDir = join(homeDirectory, '.goodvibes', 'daemon');
mkdirSync(configDir, { recursive: true });
mkdirSync(workingDir, { recursive: true });
const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir, homeDir: homeDirectory });
configManager.set('cluster.enabled', false);
configManager.set('relay.enabled', false);
const featureFlags = createFeatureFlagManager();
featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });

const pluginDir = join(workingDir, '.goodvibes', 'plugins', 'signal-owned');
if (mode === 'plugin') {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ name: 'signal-owned', version: '1.0.0', description: 'signal fixture' }));
  writeFileSync(join(pluginDir, 'index.js'), `
    import { writeSync } from 'node:fs';
    let release; const held = new Promise(resolve => { release = resolve; });
    export function finish() { release('finished'); }
    export function init(api) {
      api.registerGatewayMethod({ id: 'held', title: 'Held fixture', description: 'fixture', category: 'plugins', access: 'authenticated', transport: ['internal'], scopes: [], invokable: true }, () => {
        writeSync(1, 'HELD\\n');
        return held;
      });
    }
  `);
  const preferences = join(homeDirectory, '.goodvibes', 'tui', 'plugins.json');
  mkdirSync(join(preferences, '..'), { recursive: true });
  writeFileSync(preferences, JSON.stringify({ enabled: { 'signal-owned': true }, config: {}, trust: {}, quarantine: {} }));
}

const host = createDaemonHost({
  runtime: {
    configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), featureFlags,
    homeDirectory, workingDir, daemonHomeDirectory: configDir,
    inboxFactory: (context, _routing, inboxOptions) => registerInboxSurface(context, { ...inboxOptions, adapters: new Map() }),
    localUserAuthManager: new UserAuthManager({
      bootstrapFilePath: join(homeDirectory, 'users.json'), bootstrapCredentialPath: join(homeDirectory, 'bootstrap.txt'),
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('fixture'), roles: ['admin'] }],
    }),
  },
  daemon: { host: '127.0.0.1', port: 0, token: 'synthetic-signal-fixture-token' },
}, {
  async createRuntime(options) {
    if (options.createBootOperations !== createDaemonBootOperations) throw new Error('Fixture requires real boot composition');
    const runtime = await createRuntimeServices(options);
    spyOn(runtime.serviceRegistry, 'resolveSecret').mockResolvedValue('');
    const start = runtime.bootTasks!.start;
    spyOn(runtime.bootTasks!, 'start').mockImplementation(() => { bootStarts++; return start(); });
    const close = runtime.close;
    spyOn(runtime, 'close').mockImplementation(async () => {
      graphCloses++;
      event('GRAPH_CLOSING');
      await graphGate.promise;
      await close();
      event('GRAPH_CLOSED');
    });
    if (mode === 'sibling-timeout') {
      const startSession = runtime.sessionBroker.start.bind(runtime.sessionBroker);
      spyOn(runtime.sessionBroker, 'start').mockImplementation(async () => { event('HELD'); await phaseGate.promise; await startSession(); });
      spyOn(runtime.approvalBroker, 'start').mockRejectedValue(new Error('PRIVATE_STARTUP_SIBLING_SENTINEL'));
    }
    if (mode === 'rollback-timeout') {
      runtime.clusterCoordinator.register({ id: 'held-rollback', surface: inboxSurface('fixture-rollback'), async start() {},
        async stop() { event('HELD'); await phaseGate.promise; } });
      spyOn(runtime.approvalBroker, 'start').mockRejectedValue(new Error('PRIVATE_STARTUP_ROLLBACK_SENTINEL'));
    }
    if (mode === 'runtime') { event('HELD'); await phaseGate.promise; }
    return runtime;
  },
  createServer(options) {
    serverCreates++;
    const server = new DaemonServer(options);
    const start = server.start.bind(server);
    if (mode === 'server' || mode === 'startup-timeout') {
      spyOn(server, 'start').mockImplementation(async () => {
        if (mode === 'startup-timeout') throw new Error('PRIVATE_HOST_STARTUP_SENTINEL');
        event('HELD');
        await phaseGate.promise;
        await start();
      });
    }
    return server;
  },
});

const handle = runDaemonProcess(() => ({
  start: host.start,
  close() {
    closeCalls++;
    event('CLOSING');
    const closing = host.close();
    if (mode === 'plugin') {
      const runtime = host.services!;
      event(`PLUGIN_STATE:${runtime.pluginManager.shutdownStatus().state}`);
      void runtime.gatewayMethods.invoke('plugin.signal-owned.held', { methodId: 'plugin.signal-owned.held', body: {} } as never).then(
        () => event('PLUGIN_ADMITTED_AFTER_CLOSE'),
        () => event('PLUGIN_REFUSED'),
      );
    }
    return closing;
  },
}), {
  shutdownTimeoutMs: mode?.endsWith('-timeout') ? 300 : 10_000,
  process: {
    on(signal, listener) { ownedHandlers.set(signal, listener); process.on(signal, listener); },
    off(signal, listener) { process.off(signal, listener); },
    exit(code) { process.exit(code); },
  },
});

void handle.ready.then(async () => {
  if (mode !== 'plugin') return;
  const plugin = await import(join(pluginDir, 'index.js')) as { finish(): void };
  void phaseGate.promise.then(() => { plugin.finish(); });
  await host.services!.gatewayMethods.invoke('plugin.signal-owned.held', { methodId: 'plugin.signal-owned.held', body: {} } as never);
  event('PLUGIN_SETTLED');
}, () => {}).catch(() => { event('FIXTURE_FAILURE'); });
