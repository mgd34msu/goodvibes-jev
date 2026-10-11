import { expect, spyOn, test } from 'bun:test';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog, prepareGatewayScopePolicyOwner, completeGatewayScopePolicyBootstrap } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import * as activation from '../../runtime/native-work-execution-activation.js';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const descriptor = { id: 'nativeFixture.scope', title: 'Synthetic native fixture scope', description: 'Local synthetic native scope owner proof', category: 'fixture',
  source: 'plugin' as const, pluginId: 'native-ci-fixture', access: 'admin' as const, transport: ['ws' as const], scopes: ['write:native-fixture'] };

test('scope bootstrap is one-use and refuses native ownership until both real host phases finish', () => {
  const methods = new GatewayMethodCatalog(); let mutations = 0;
  const owner = prepareGatewayScopePolicyOwner(methods, () => { mutations++; }, true);
  expect(() => owner.current()).toThrow();
  completeGatewayScopePolicyBootstrap(methods); expect(() => owner.current()).toThrow();
  methods.register(descriptor, async () => ({})); expect(mutations).toBe(0);
  completeGatewayScopePolicyBootstrap(methods, 'boot'); expect(owner.current().scopes).toContain('write:native-fixture');
  methods.unregister(descriptor.id); expect(mutations).toBe(1);
  owner.close(); completeGatewayScopePolicyBootstrap(methods, 'boot');
  expect(() => owner.current()).toThrow(); expect(() => prepareGatewayScopePolicyOwner(methods, () => {})).toThrow();
});

test('actual daemon facade and plugin bootstrap preserve durable policy across clean restart, while runtime ABA revokes it', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const build = activation.createDaemonNativeWorkExecutionActivation;
  let owned: Parameters<typeof build>[0] | undefined;
  const capture = spyOn(activation, 'createDaemonNativeWorkExecutionActivation').mockImplementation(options => { owned = options; return build(options); });
  const root = makeOwnedTempDir('native-ci-full-daemon-bootstrap');
  let daemon: DaemonFixture | undefined;
  const options: Parameters<typeof startDaemonFixture>[0] = { root,
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    createBootOperations: services => ({ async foldMemory() {}, startProviderWatch() {}, stopProviderWatch() {},
      createWebhooks: () => ({ attach() {}, close() {} }), createNotifier: () => ({ attach() {}, close() {} }),
      async synchronizeServices() {}, async initializePlugins() { services.gatewayMethods.register(descriptor, async () => ({})); },
      async closePlugins() { services.gatewayMethods.unregister(descriptor.id); }, reportFailure() {},
    }),
  };
  try {
    daemon = await startDaemonFixture(options);
    const first = owned!; expect(first).toBeDefined();
    expect(() => first.continuationScopeOwner!.current()).toThrow();
    expect((await daemon.services.bootTasks!.start()).state).toBe('ready');
    const policy = first.configManager.captureDurableConfigurationIncarnation(); const scopes = first.continuationScopeOwner!.current();
    expect(scopes.scopes).toContain('write:native-fixture');
    await daemon.stop(); expect(() => first.continuationScopeOwner!.current()).toThrow();
    daemon = await startDaemonFixture(options);
    const second = owned!; expect(second.configManager).toBeInstanceOf(ConfigManager);
    expect(() => second.continuationScopeOwner!.current()).toThrow();
    await daemon.services.bootTasks!.start();
    expect(second.configManager.getDurableConfigurationIncarnation()).toBe(policy);
    expect(second.continuationScopeOwner!.current()).toEqual(scopes);
    daemon.services.gatewayMethods.unregister(descriptor.id); daemon.services.gatewayMethods.register(descriptor, async () => ({}));
    expect(second.continuationScopeOwner!.current()).toEqual(scopes);
    expect(second.configManager.getDurableConfigurationIncarnation()).not.toBe(policy);
    await daemon.stop(); daemon = await startDaemonFixture(options); await daemon.services.bootTasks!.start();
    expect(owned!.configManager.getDurableConfigurationIncarnation()).not.toBe(policy);
    expect(owned!.continuationScopeOwner!.current()).toEqual(scopes);
  } finally { await daemon?.stop(); capture.mockRestore(); identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); }
}, 30000);
