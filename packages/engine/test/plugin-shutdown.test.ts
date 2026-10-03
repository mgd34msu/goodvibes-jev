import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginAPI } from '../sdk/src/platform/plugins/api.ts';
import { PluginClosedError, PluginInFlightTracker } from '../sdk/src/platform/plugins/in-flight.ts';
import type { PluginLoaderDeps } from '../sdk/src/platform/plugins/loader.ts';
import { PluginManager } from '../sdk/src/platform/plugins/manager.ts';
import type { HostSlashCommand } from '../sdk/src/platform/runtime/host-ui.ts';
import { ChannelPluginRegistry } from '../sdk/src/platform/channels/plugin-registry.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Probe {
  api?: PluginAPI;
  init: ReturnType<typeof gate>;
  activated: ReturnType<typeof gate>;
  activation: ReturnType<typeof gate>;
  deactivation: ReturnType<typeof gate>;
  deactivating: ReturnType<typeof gate>;
  call: ReturnType<typeof gate>;
  called: ReturnType<typeof gate>;
  generations: number;
  deactivated: number;
  commandCalls: number;
  eventCalls: number;
  failDeactivate: boolean;
  failInit: boolean;
}

const probeStore = new Map<string, Probe>();
(globalThis as unknown as { __jevPluginLifetime: Map<string, Probe> }).__jevPluginLifetime = probeStore;
const fixtures: Array<{ root: string; probe: Probe; manager: PluginManager }> = [];

afterEach(async () => {
  for (const { root, probe, manager } of fixtures.splice(0)) {
    probe.init.resolve();
    probe.activation.resolve();
    probe.deactivation.resolve();
    probe.call.resolve();
    await manager.close().catch(() => undefined);
    probeStore.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(options: { holdInit?: boolean; holdActivation?: boolean; enabled?: boolean; tracker?: PluginInFlightTracker } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jev-plugin-close-'));
  const pluginDir = join(root, 'project', '.goodvibes', 'plugins', 'owned');
  mkdirSync(pluginDir, { recursive: true });
  const probe: Probe = {
    init: gate(), activated: gate(), activation: gate(), deactivation: gate(), deactivating: gate(),
    call: gate(), called: gate(), generations: 0, deactivated: 0, commandCalls: 0, eventCalls: 0,
    failDeactivate: false, failInit: false,
  };
  if (!options.holdInit) probe.init.resolve();
  if (!options.holdActivation) probe.activation.resolve();
  probe.deactivation.resolve();
  probeStore.set(root, probe);
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ name: 'owned', version: '1.0.0', description: 'owned fixture' }));
  writeFileSync(join(pluginDir, 'index.js'), `
const probe = globalThis.__jevPluginLifetime.get(${JSON.stringify(root)});
export async function init(api) {
  probe.api = api;
  probe.generations++;
  api.registerCommand('ping', 'fixture', () => { probe.commandCalls++; });
  api.registerTool('slow', { description: 'controlled call' }, async () => {
    probe.called.resolve();
    await probe.call.promise;
    return { success: true, output: 'settled' };
  });
  api.onEvent('TEST_PLUGIN_LIFETIME', () => { probe.eventCalls++; });
  await probe.init.promise;
  if (probe.failInit) throw new Error('fixture init failure');
}
export async function activate() {
  probe.activated.resolve();
  await probe.activation.promise;
}
export async function deactivate() {
  probe.deactivated++;
  probe.deactivating.resolve();
  await probe.deactivation.promise;
  if (probe.failDeactivate) throw new Error('fixture deactivate failure');
}
`);
  const stateFilePath = join(root, 'plugins.json');
  writeFileSync(stateFilePath, JSON.stringify({ enabled: { owned: options.enabled ?? true }, config: { owned: { marker: 'keep' } }, trust: {}, quarantine: {} }));
  const initialState = readFileSync(stateFilePath, 'utf8');
  const commands = new Map<string, HostSlashCommand>();
  const hooks = new Set<(event: { payload: unknown }) => void>();
  let unrelatedEvents = 0;
  const unrelated = () => { unrelatedEvents++; };
  hooks.add(unrelated);
  const toolRegistry = new ToolRegistry();
  const channelRegistry = new ChannelPluginRegistry();
  const registrations: unknown[] = [];
  const removed: string[] = [];
  let failCommandCleanup = false;
  let onProviderRegister: (() => void) | undefined;
  const deps = {
    runtimeBus: { on(_type: string, handler: (event: { payload: unknown }) => void) {
      hooks.add(handler);
      return () => { hooks.delete(handler); removed.push('event'); };
    } },
    commandRegistry: {
      register(command: HostSlashCommand) { commands.set(command.name, command); },
      unregister(name: string) {
        commands.delete(name);
        removed.push('command');
        if (failCommandCleanup) throw new Error('fixture unregister failure');
      },
    },
    providerRegistry: { has() { return registrations.length > 0; }, getRegistered() { return (registrations.at(-1) as { provider: unknown } | undefined)?.provider; }, registerRuntimeProvider(value: unknown) {
      registrations.push(value);
      onProviderRegister?.();
      return () => { removed.push('provider'); };
    } },
    toolRegistry, channelRegistry,
    getPluginConfig: () => ({ marker: 'keep' }),
    isEnabled: () => true,
    ...(options.tracker ? { inFlight: options.tracker } : {}),
  } as unknown as PluginLoaderDeps;
  const manager = new PluginManager({ pathOptions: { cwd: join(root, 'project'), homeDir: join(root, 'home') }, stateFilePath });
  fixtures.push({ root, probe, manager });
  return {
    root, probe, manager, deps, commands, hooks, toolRegistry, channelRegistry, registrations, removed, initialState, stateFilePath,
    state: () => readFileSync(stateFilePath, 'utf8'),
    emit: () => { for (const callback of hooks) callback({ payload: {} }); },
    unrelatedEvents: () => unrelatedEvents,
    failCommandCleanup: () => { failCommandCleanup = true; },
    onProviderRegister: (callback: () => void) => { onProviderRegister = callback; },
  };
}

async function turns(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function apiOf(probe: Probe): PluginAPI {
  if (!probe.api) throw new Error('fixture API was not acquired');
  return probe.api;
}

describe('PluginManager owned shutdown', () => {
  test('releases registrations, preserves operator state and unrelated subscribers, and is idempotent', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    fx.emit();
    expect(fx.probe.eventCalls).toBe(1);
    const closing = fx.manager.close();
    expect(fx.manager.close()).toBe(closing);
    await closing;
    expect(fx.probe.deactivated).toBe(1);
    expect(fx.commands.size).toBe(0);
    expect(fx.toolRegistry.has('plugin_owned_slow')).toBe(false);
    expect(fx.hooks.size).toBe(1);
    fx.emit();
    expect(fx.probe.eventCalls).toBe(1);
    expect(fx.unrelatedEvents()).toBe(2);
    expect(fx.manager.isEnabled('owned')).toBe(true);
    expect(fx.manager.getPluginConfig('owned')).toEqual({ marker: 'keep' });
    expect(fx.state()).toBe(fx.initialState);
    expect(fx.manager.list()[0]?.active).toBe(false);
    expect(fx.manager.shutdownStatus()).toEqual({ state: 'closed', lifecycleOperations: 0, pendingInstances: 0, activeCalls: [], cleanupFailures: 0 });
  });

  test('refuses new calls immediately but does not unload under an admitted call', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    const running = fx.toolRegistry.execute('running', 'plugin_owned_slow', {});
    await fx.probe.called.promise;
    let closed = false;
    const closing = fx.manager.close().then(() => { closed = true; });
    const refused = await fx.toolRegistry.execute('late', 'plugin_owned_slow', {});
    await fx.commands.get('plugin-owned-ping')?.handler([]);
    fx.emit();
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('closed');
    expect(fx.probe.commandCalls).toBe(0);
    expect(fx.probe.eventCalls).toBe(0);
    expect(fx.probe.deactivated).toBe(0);
    expect(closed).toBe(false);
    expect(fx.manager.shutdownStatus()).toEqual({ state: 'closing', lifecycleOperations: 0, pendingInstances: 1, activeCalls: [{ pluginName: 'owned', count: 1 }], cleanupFailures: 0 });
    fx.probe.call.resolve();
    expect((await running).output).toBe('settled');
    await closing;
    expect(fx.probe.deactivated).toBe(1);
  });

  test('waits for a late activation acquisition and releases it before close returns', async () => {
    const fx = fixture({ holdActivation: true });
    const init = fx.manager.init(fx.deps);
    await fx.probe.activated.promise;
    let closed = false;
    const closing = fx.manager.close().then(() => { closed = true; });
    await turns();
    expect(closed).toBe(false);
    fx.probe.activation.resolve();
    await init;
    await closing;
    expect(fx.probe.deactivated).toBe(1);
    expect(fx.commands.size).toBe(0);
    expect(fx.toolRegistry.has('plugin_owned_slow')).toBe(false);
    expect(fx.state()).toBe(fx.initialState);
  });

  test('an admitted reload cannot resume admission or acquire a replacement after close', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    fx.probe.deactivation = gate();
    const reload = fx.manager.reload();
    await fx.probe.deactivating.promise;
    const closing = fx.manager.close();
    fx.probe.deactivation.resolve();
    await reload;
    await closing;
    expect(fx.probe.generations).toBe(1);
    expect(fx.probe.deactivated).toBe(1);
    expect(fx.commands.size).toBe(0);
    expect(() => apiOf(fx.probe).registerTool('late', {}, async () => ({ success: true }))).toThrow(PluginClosedError);
  });

  test('close during enable drains the acquired instance and does not claim it remains available', async () => {
    const fx = fixture({ enabled: false, holdActivation: true });
    await fx.manager.init(fx.deps);
    const enable = fx.manager.enable('owned');
    await fx.probe.activated.promise;
    const requestedState = fx.state();
    const closing = fx.manager.close();
    fx.probe.activation.resolve();
    expect((await enable).ok).toBe(false);
    await closing;
    expect(fx.probe.deactivated).toBe(1);
    expect(fx.state()).toBe(requestedState);
    expect(fx.manager.isEnabled('owned')).toBe(true);
  });

  test('attempts every cleanup and returns failure after deactivation and unregister errors', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    fx.probe.failDeactivate = true;
    fx.failCommandCleanup();
    const closing = fx.manager.close();
    await expect(closing).rejects.toThrow('shutdown cleanup did not complete');
    expect(fx.manager.close()).toBe(closing);
    expect(fx.manager.shutdownStatus()).toMatchObject({ state: 'failed', cleanupFailures: 1 });
    expect(fx.removed).toEqual(['command', 'event']);
    expect(fx.toolRegistry.has('plugin_owned_slow')).toBe(false);
    expect(fx.state()).toBe(fx.initialState);
  });

  test('one failed plugin cleanup does not prevent cleanup of another owned instance', async () => {
    const fx = fixture();
    const first = join(fx.root, 'project', '.goodvibes', 'plugins', 'owned');
    const second = join(fx.root, 'project', '.goodvibes', 'plugins', 'second');
    mkdirSync(second);
    writeFileSync(join(second, 'manifest.json'), JSON.stringify({ name: 'second', version: '1.0.0', description: 'second fixture' }));
    writeFileSync(join(second, 'index.js'), readFileSync(join(first, 'index.js')));
    writeFileSync(fx.stateFilePath, JSON.stringify({ enabled: { owned: true, second: true }, config: {}, trust: {}, quarantine: {} }));
    const before = fx.state();
    await fx.manager.init(fx.deps);
    fx.probe.failDeactivate = true;
    await expect(fx.manager.close()).rejects.toThrow('shutdown cleanup did not complete');
    expect(fx.probe.deactivated).toBe(2);
    expect(fx.commands.size).toBe(0);
    expect(fx.toolRegistry.list()).toEqual([]);
    expect(fx.hooks.size).toBe(1);
    expect(fx.state()).toBe(before);
  });

  test('a failed initialization cleans registrations and permits an ordinary reload retry before shutdown', async () => {
    const fx = fixture();
    fx.probe.failInit = true;
    await fx.manager.init(fx.deps);
    const stale = apiOf(fx.probe);
    expect(fx.commands.size).toBe(0);
    expect(() => stale.registerCommand('late', '', () => undefined)).toThrow(PluginClosedError);
    fx.probe.failInit = false;
    expect((await fx.manager.reload()).reloaded).toBe(1);
    await fx.manager.close();
    expect(fx.probe.generations).toBe(2);
    expect(fx.probe.deactivated).toBe(1);
    expect(fx.commands.size).toBe(0);
  });

  test('failed-load cleanup errors are reported again by the lifetime owner', async () => {
    const fx = fixture();
    fx.probe.failInit = true;
    fx.failCommandCleanup();
    await expect(fx.manager.init(fx.deps)).rejects.toThrow('cleanup did not complete');
    await expect(fx.manager.close()).rejects.toThrow('shutdown cleanup did not complete');
    expect(fx.hooks.size).toBe(1);
  });

  test('post-close lifecycle and preference mutations refuse without changing disk', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    await fx.manager.close();
    for (const action of [() => fx.manager.init(fx.deps), () => fx.manager.enable('owned'), () => fx.manager.disable('owned'), () => fx.manager.reload()]) {
      await expect(action()).rejects.toThrow('closed');
    }
    expect(fx.manager.trust('owned', 'trusted').ok).toBe(false);
    expect(fx.manager.trustSigned('owned').ok).toBe(false);
    expect(fx.manager.quarantine('owned', 'fixture').ok).toBe(false);
    expect(fx.manager.liftQuarantine('owned').ok).toBe(false);
    expect(fx.state()).toBe(fx.initialState);
  });

  test('a shared tracker keeps unrelated owners open while closing this plugin permanently', async () => {
    const tracker = new PluginInFlightTracker();
    const fx = fixture({ tracker });
    await fx.manager.init(fx.deps);
    await fx.manager.close();
    tracker.resume('owned');
    expect(() => tracker.track('owned', () => 1)).toThrow(PluginClosedError);
    expect(tracker.track('unrelated', () => 2)).toBe(2);
  });

  test('an admitted async provider registration settles before shutdown and cannot publish late', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    const pending = apiOf(fx.probe).registerProvider('fixture', { baseURL: 'http://127.0.0.1:1', models: ['fixture'] }).catch((error: unknown) => error);
    await fx.manager.close();
    expect(await pending).toBeInstanceOf(PluginClosedError);
    expect(fx.registrations).toEqual([]);
    expect(fx.removed).toEqual(['command', 'event']);
  });

  test('reentrant close from an acquired registration waits until its cleanup is owned', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    let closing: Promise<void> | undefined;
    fx.onProviderRegister(() => { closing = fx.manager.close(); });
    await apiOf(fx.probe).registerProvider('fixture', { baseURL: 'http://127.0.0.1:1', models: ['fixture'] });
    if (!closing) throw new Error('fixture registry did not request close');
    await closing;
    expect(fx.registrations).toHaveLength(1);
    expect(fx.removed).toEqual(['command', 'event', 'provider']);
  });

  test('a stale instance cannot serve captured callbacks after a successful reload', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    const command = fx.commands.get('plugin-owned-ping');
    const tool = fx.toolRegistry.list()[0];
    const events = [...fx.hooks];
    if (!command || !tool) throw new Error('fixture registrations missing');
    await fx.manager.reload();
    await command.handler([]);
    fx.probe.call.resolve();
    const result = await tool.execute({});
    for (const callback of events) callback({ payload: {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('closed');
    expect(fx.probe.commandCalls).toBe(0);
    expect(fx.probe.eventCalls).toBe(0);
    await fx.commands.get('plugin-owned-ping')?.handler([]);
    fx.emit();
    expect(fx.probe.commandCalls).toBe(1);
    expect(fx.probe.eventCalls).toBe(1);
  });

  test('concurrent retirement requests share one deactivation and shutdown drain', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    fx.probe.deactivation = gate();
    const disabling = fx.manager.disable('owned');
    await fx.probe.deactivating.promise;
    const reloading = fx.manager.reload().catch((error: unknown) => error);
    await turns();
    const closing = fx.manager.close();
    fx.probe.deactivation.resolve();
    await disabling;
    await reloading;
    await closing;
    expect(fx.probe.deactivated).toBe(1);
    expect(fx.removed.filter((name) => name === 'command')).toHaveLength(1);
  });

  test('the real channel registry drains active callbacks and retained channel objects refuse after close', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    let calls = 0;
    const hold = gate();
    apiOf(fx.probe).registerChannelPlugin({
      id: 'owned-channel', surface: 'webhook', displayName: 'Fixture', capabilities: [],
      async runTool() { calls++; await hold.promise; return 'done'; },
    });
    const retained = fx.channelRegistry.get('owned-channel');
    if (!retained?.runTool) throw new Error('fixture channel not registered');
    const running = fx.channelRegistry.runTool('webhook', 'fixture');
    let closed = false;
    const closing = fx.manager.close().then(() => { closed = true; });
    try {
      await turns();
      expect(closed).toBe(false);
      expect(fx.probe.deactivated).toBe(0);
      await expect(retained.runTool('late')).rejects.toThrow(PluginClosedError);
      expect(calls).toBe(1);
    } finally { hold.resolve(); await running; await closing; }
    expect(fx.probe.deactivated).toBe(1);
    expect(fx.channelRegistry.get('owned-channel')).toBeNull();
  });

  test('retained APIs reject every registration family after close', async () => {
    const fx = fixture();
    await fx.manager.init(fx.deps);
    const api = apiOf(fx.probe);
    await fx.manager.close();
    const synchronous = ['registerCommand', 'registerProviderInstance', 'registerTool', 'registerGatewayMethod', 'registerChannelPlugin', 'registerDeliveryStrategy', 'registerMemoryEmbeddingProvider', 'registerVoiceProvider', 'registerMediaProvider', 'registerWebSearchProvider', 'onEvent'] as const;
    for (const method of synchronous) {
      expect(() => (api[method] as (...args: unknown[]) => unknown)()).toThrow(PluginClosedError);
    }
    await expect(api.registerProvider('late', { baseURL: 'http://127.0.0.1:1', models: [] })).rejects.toThrow(PluginClosedError);
    expect(fx.commands.size).toBe(0);
    expect(fx.hooks.size).toBe(1);
    expect(fx.registrations).toEqual([]);
  });
});


test('tracker close owns synchronous reentrancy and rejected calls without closing another tracker', async () => {
  const tracker = new PluginInFlightTracker();
  const unrelated = new PluginInFlightTracker();
  const held = gate();
  let closing: Promise<void> | undefined;
  let settled = false;
  const call = tracker.track('first', async () => {
    closing = tracker.close();
    void closing.then(() => { settled = true; });
    await held.promise;
    throw new Error('original call error');
  }).catch((error: unknown) => error);
  await turns();
  expect(settled).toBe(false);
  if (!closing) throw new Error('The tracked callback did not begin reentrant close');
  expect(tracker.close()).toBe(closing);
  tracker.resume('first');
  expect(() => tracker.track('new-name', () => 1)).toThrow(PluginClosedError);
  expect(unrelated.track('first', () => 2)).toBe(2);
  held.resolve();
  expect(await call).toMatchObject({ message: 'original call error' });
  await closing;
  expect(tracker.inFlight('first')).toBe(0);
});
