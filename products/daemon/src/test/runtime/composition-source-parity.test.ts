/** Bounded runtime assertions restored from pinned daemon 254699bf originals. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { PairingTokenManager } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { controlPlaneStorePath } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { sharedWorkspaceRegisterPath, WorkspaceRegistrationStore } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { foldLegacyProjectMemory } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { emitOpsMemoryPressure } from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import { createDaemonBootOperations } from '../../runtime/boot-composition.js';
import { createDaemonPluginLoaderDeps } from '../../runtime/plugin-composition.js';
import { sharedWorkspaceRegistrationStorePath } from '../../runtime/trust/checkpoint-eligibility.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

let fixtures: DaemonFixture[];
let restores: Array<() => void>;
function keep<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
beforeEach(() => {
  fixtures = []; restores = [];
  keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
  keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue());
});
afterEach(async () => {
  try { for (const fx of fixtures) await fx.stop(); }
  finally { for (const restore of restores.reverse()) restore(); }
});
async function fixture() {
  const fx = await startDaemonFixture({ root: makeOwnedTempDir('daemon-composition-parity'),
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    createBootOperations(runtime) {
      keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockResolvedValue(''));
      return createDaemonBootOperations(runtime);
    },
  });
  fixtures.push(fx);
  return fx;
}

test('the canonical boot fold reports a missing project source without importing or failing, including rerun', async () => {
  const fx = await fixture();
  const runtime = fx.services;
  const report = await foldLegacyProjectMemory(runtime.memoryStore, runtime.memoryEmbeddingRegistry, fx.workingDirectory);
  expect(report.totalImported).toBe(0);
  expect(report.failedSources).toHaveLength(0);
  expect(report.missingSources.length).toBeGreaterThan(0);
  expect(report.missingSources.some((label) => label.includes(fx.workingDirectory))).toBe(true);
  const rerun = await foldLegacyProjectMemory(runtime.memoryStore, runtime.memoryEmbeddingRegistry, fx.workingDirectory);
  expect(rerun.totalImported).toBe(0);
  expect(rerun.failedSources).toHaveLength(0);
  // Also exercise the production caller, rather than inferring boot from the helper.
  await expect(createDaemonBootOperations(runtime).foldMemory()).resolves.toBeUndefined();
});

test('the composed broker and pairing writer use scoped stores, with no unscoped orphan', async () => {
  const fx = await fixture();
  const { shellPaths, pairingTokens, sessionBroker } = fx.services;
  const surface = GOODVIBES_DAEMON_SURFACE_ROOT;
  expect(surface.length).toBeGreaterThan(0);
  expect(sessionBroker.storePath).toBe(join(fx.workingDirectory, '.goodvibes', surface, 'control-plane', 'sessions.json'));
  expect(sessionBroker.storePath).not.toBe(shellPaths.resolveUserPath('control-plane', 'sessions.json'));
  const pairingPath = controlPlaneStorePath(shellPaths, surface, 'pairing-tokens.json');
  expect(pairingPath).toBe(join(fx.homeDirectory, '.goodvibes', surface, 'control-plane', 'pairing-tokens.json'));
  pairingTokens.mint({ name: 'synthetic fixture device' });
  expect(existsSync(pairingPath)).toBe(true);
  expect(new PairingTokenManager(pairingPath).list().map((entry) => entry.name)).toContain('synthetic fixture device');
  expect(existsSync(join(fx.homeDirectory, '.goodvibes', 'control-plane'))).toBe(false);
  expect(existsSync(join(fx.workingDirectory, '.goodvibes', 'control-plane'))).toBe(false);
  expect(() => controlPlaneStorePath(shellPaths, '   ', 'pairing-tokens.json')).toThrow();
});

test('the shared workspace writer and daemon reader agree without either legacy or surface-scoped copies', async () => {
  const fx = await fixture();
  const { shellPaths } = fx.services;
  const path = sharedWorkspaceRegisterPath(shellPaths);
  const store = new WorkspaceRegistrationStore({ path, homeDir: fx.homeDirectory, daemonStateDir: shellPaths.resolveUserPath() });
  await store.add(fx.workingDirectory);
  expect(path).toBe(join(fx.homeDirectory, '.goodvibes', 'shared', 'workspace-registrations.json'));
  expect(sharedWorkspaceRegistrationStorePath(shellPaths)).toBe(path);
  expect(readFileSync(path, 'utf8')).toContain(fx.workingDirectory);
  expect(existsSync(join(fx.homeDirectory, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'workspace-registrations.json'))).toBe(false);
  expect(existsSync(join(fx.homeDirectory, '.goodvibes', 'control-plane', 'workspace-registrations.json'))).toBe(false);
});

test('the real graph has no panel producer and pressure reaches its existing webhook owner', async () => {
  const fx = await fixture();
  const runtime = fx.services;
  const graph = readFileSync(new URL('../../runtime/service-graph.ts', import.meta.url), 'utf8');
  expect(graph).not.toContain('createNotificationDispatcher');
  expect(graph).not.toContain('wireRuntimeNotificationBridge');
  const configured = keep(spyOn(runtime.webhookNotifier, 'isConfigured').mockReturnValue(true));
  const send = keep(spyOn(runtime.webhookNotifier, 'send').mockResolvedValue({ attempted: 1, delivered: 1, failed: 0, results: [] }));
  const emit = () => emitOpsMemoryPressure(runtime.runtimeBus, { sessionId: 'fixture', source: 'fixture', traceId: 'fixture' }, {
    tier: 'critical', previousTier: 'high', rssMb: 3600, heapMb: 900, budgetMb: 4096, usedPct: 88,
  });
  emit(); await Promise.resolve();
  expect(configured).toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toContain('memory pressure');
  await runtime.close();
  emit(); await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
});

test('production plugin composition serves delivery and gateway alongside an unserved slash command, then unregisters both', async () => {
  const fx = await fixture();
  const runtime = fx.services;
  const directory = join(fx.workingDirectory, '.goodvibes', 'plugins', 'both-halves');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'both-halves', version: '1.0.0', description: 'owned synthetic fixture' }));
  writeFileSync(join(directory, 'index.js'), `export function init(api) {
    api.registerDeliveryStrategy({ id: 'fixture-delivery', canHandle: request => request.target.kind === 'none', deliver: async () => ({ responseId: 'fixture-delivered' }) });
    api.registerGatewayMethod({ id: 'fixture.ping', title: 'Fixture', description: 'Fixture', category: 'plugins', access: 'authenticated', transport: ['internal'], scopes: [], invokable: true }, async () => ({ ok: true }));
    api.registerCommand({ name: 'fixture', description: 'No prompt on this host', handler: () => {} });
  }`);
  const deps = createDaemonPluginLoaderDeps(runtime);
  expect(deps.channelDeliveryRouter).toBe(runtime.deliveryManager.getDeliveryRouter());
  expect(deps.gatewayMethods).toBe(runtime.gatewayMethods);
  expect(deps.channelRegistry).toBe(runtime.channelPlugins);
  expect(() => deps.commandRegistry.register({ name: 'standalone-fixture', description: 'Unserved', handler: () => {} })).not.toThrow();
  expect(() => deps.commandRegistry.unregister('standalone-fixture')).not.toThrow();
  expect((await runtime.pluginManager.enable('both-halves')).ok).toBe(true);
  expect((await runtime.bootTasks!.start()).state).toBe('ready');
  expect(runtime.pluginManager.list().find((entry) => entry.name === 'both-halves')?.active).toBe(true);
  expect(deps.channelDeliveryRouter.listStrategies().map((entry) => entry.id)).toContain('fixture-delivery');
  expect(await fx.invoke<{ ok: boolean }>('plugin.both-halves.fixture.ping')).toEqual({ ok: true });
  expect(await deps.channelDeliveryRouter.deliver({ target: { kind: 'none' }, body: 'synthetic', title: 'fixture', jobId: 'fixture', runId: 'fixture', includeLinks: false })).toBe('fixture-delivered');
  await runtime.close(); // Real loader cleanup also unregisters the unserved slash command.
  expect(deps.channelDeliveryRouter.listStrategies().map((entry) => entry.id)).not.toContain('fixture-delivery');
  expect(deps.gatewayMethods.get('plugin.both-halves.fixture.ping')).toBeNull();
  expect(runtime.pluginManager.isEnabled('both-halves')).toBe(true);
});
