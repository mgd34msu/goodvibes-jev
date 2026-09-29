/**
 * plugin-hot-reload-drain.test.ts, the quiesce phase of a plugin reload.
 *
 * Phase 1 of runHotReload used to set record.reloading and nothing else: a
 * tool call still running in the plugin had its instance unloaded under it,
 * and new calls kept arriving. Now every call into plugin code (commands,
 * tools, gateway methods, event hooks) is counted per plugin; a reload refuses
 * new calls, waits for the running ones up to a bounded timeout, and on
 * timeout reports a quiesce failure and leaves the plugin loaded. Plugin
 * tools are unregistered on unload, so the reloaded instance serves them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin, type LoadedPlugin, type PluginLoaderDeps } from '../sdk/src/platform/plugins/loader.ts';
import { PluginInFlightTracker, PluginQuiescingError } from '../sdk/src/platform/plugins/in-flight.ts';
import { PluginManager } from '../sdk/src/platform/plugins/manager.ts';
import { runHotReload } from '../sdk/src/platform/runtime/plugins/hot-reload.ts';
import { PluginLifecycleManager } from '../sdk/src/platform/runtime/plugins/manager.ts';
import type { PluginManifestV2 } from '../sdk/src/platform/runtime/plugins/types.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { HostSlashCommand } from '../sdk/src/platform/runtime/host-ui.ts';

interface DrainProbe {
  generation: number;
  deactivated: number[];
  commands: number[];
  events: number[];
  gate: Promise<void>;
  open: () => void;
}

const PLUGIN_SOURCE = `
const probe = globalThis.__gvDrainProbe;
let generation = 0;
export function init(api) {
  generation = ++probe.generation;
  api.registerTool('slow', { description: 'waits on the test gate' }, async () => {
    await probe.gate;
    return { success: true, output: 'slow-gen-' + generation };
  });
  api.registerTool('fast', { description: 'answers at once' }, async () => ({ success: true, output: 'fast-gen-' + generation }));
  api.registerCommand('ping', 'records the generation', async () => { probe.commands.push(generation); });
  api.onEvent('TEST_EVENT', () => { probe.events.push(generation); });
}
export function deactivate() { probe.deactivated.push(generation); }
`;

const roots: string[] = [];
let probe: DrainProbe;

function newProbe(): DrainProbe {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { generation: 0, deactivated: [], commands: [], events: [], gate, open };
}

beforeEach(() => {
  probe = newProbe();
  (globalThis as { __gvDrainProbe?: DrainProbe }).__gvDrainProbe = probe;
});

afterEach(() => {
  probe.open();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writePlugin(dir: string): PluginManifestV2 {
  mkdirSync(dir, { recursive: true });
  const manifest: PluginManifestV2 = { name: 'drainer', version: '1.0.0', description: 'drain probe' };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  writeFileSync(join(dir, 'index.js'), PLUGIN_SOURCE, 'utf-8');
  return manifest;
}

function makeDeps(inFlight?: PluginInFlightTracker) {
  const commands = new Map<string, HostSlashCommand>();
  const hooks = new Map<string, Set<(envelope: { payload: unknown }) => void>>();
  const toolRegistry = new ToolRegistry();
  const deps = {
    runtimeBus: {
      on(type: string, handler: (envelope: { payload: unknown }) => void) {
        const set = hooks.get(type) ?? new Set();
        hooks.set(type, set);
        set.add(handler);
        return () => set.delete(handler);
      },
    },
    commandRegistry: {
      register: (command: HostSlashCommand) => { commands.set(command.name, command); },
      unregister: (name: string) => { commands.delete(name); },
    },
    toolRegistry,
    getPluginConfig: () => ({}),
    isEnabled: () => true,
    ...(inFlight ? { inFlight } : {}),
  } as unknown as PluginLoaderDeps;
  const emit = (type: string) => { for (const handler of hooks.get(type) ?? []) handler({ payload: {} }); };
  const runCommand = async (name: string) => { await commands.get(name)?.handler([]); };
  return { deps, toolRegistry, emit, runCommand };
}

async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadedFixture(inFlight?: PluginInFlightTracker) {
  const root = mkdtempSync(join(tmpdir(), 'gv-drain-'));
  roots.push(root);
  const pluginDir = join(root, 'drainer');
  const manifest = writePlugin(pluginDir);
  const harness = makeDeps(inFlight);
  const loaded = new Map<string, LoadedPlugin>();
  const first = await loadPlugin({ manifest, pluginDir }, harness.deps);
  expect(first).not.toBeNull();
  loaded.set('drainer', first!);
  const lcm = new PluginLifecycleManager();
  lcm.registerDiscovered(manifest, pluginDir);
  const options = {
    getLoadedPlugin: (name: string) => loaded.get(name),
    removeLoadedPlugin: (name: string) => { loaded.delete(name); },
    storeLoadedPlugin: (name: string, plugin: LoadedPlugin) => { loaded.set(name, plugin); },
  };
  return { ...harness, manifest, pluginDir, lcm, options };
}

describe('runHotReload phase 1 drains in-flight plugin calls', () => {
  test('waits for a running tool call, refuses new calls meanwhile, then reloads onto the new instance', async () => {
    const tracker = new PluginInFlightTracker();
    const fx = await loadedFixture(tracker);
    const slow = fx.toolRegistry.execute('c1', 'plugin_drainer_slow', {});
    await tick();
    expect(tracker.inFlight('drainer')).toBe(1);

    const reload = runHotReload('drainer', fx.manifest, fx.pluginDir, fx.deps, fx.lcm, { ...fx.options, quiesceTimeoutMs: 5_000 });
    await tick();
    expect(fx.lcm.getRecord('drainer')!.reloading).toBe(true);
    // The running call keeps its instance: nothing was unloaded yet.
    expect(probe.deactivated).toEqual([]);
    // New work of every kind is refused while quiescing.
    const refused = await fx.toolRegistry.execute('c2', 'plugin_drainer_fast', {});
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("Plugin 'drainer' is reloading");
    await fx.runCommand('plugin-drainer-ping');
    fx.emit('TEST_EVENT');
    expect(probe.commands).toEqual([]);
    expect(probe.events).toEqual([]);

    probe.open();
    const finished = await slow;
    expect(finished.success).toBe(true);
    expect(finished.output).toBe('slow-gen-1');

    const result = await reload;
    expect(result.success).toBe(true);
    expect(result.degraded).toBe(false);
    expect(probe.deactivated).toEqual([1]);
    expect(fx.lcm.getRecord('drainer')!.reloading).toBe(false);
    // The reloaded instance serves the tool (the old registration was removed).
    const after = await fx.toolRegistry.execute('c3', 'plugin_drainer_fast', {});
    expect(after.output).toBe('fast-gen-2');
    await fx.runCommand('plugin-drainer-ping');
    fx.emit('TEST_EVENT');
    expect(probe.commands).toEqual([2]);
    expect(probe.events).toEqual([2]);
  });

  test('a call still running at the timeout fails the quiesce phase and leaves the plugin loaded and serving', async () => {
    const tracker = new PluginInFlightTracker();
    const fx = await loadedFixture(tracker);
    void fx.toolRegistry.execute('c1', 'plugin_drainer_slow', {});
    await tick();

    const result = await runHotReload('drainer', fx.manifest, fx.pluginDir, fx.deps, fx.lcm, { ...fx.options, quiesceTimeoutMs: 40 });
    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe('quiesce');
    expect(result.error).toBe("1 call(s) into plugin 'drainer' still running after 40ms; the plugin was left loaded and serving");
    expect(probe.deactivated).toEqual([]);
    expect(fx.lcm.getRecord('drainer')!.reloading).toBe(false);
    expect(tracker.isQuiescing('drainer')).toBe(false);
    const served = await fx.toolRegistry.execute('c2', 'plugin_drainer_fast', {});
    expect(served.output).toBe('fast-gen-1');
  });

  test('a plugin loaded without call accounting is not reloaded blind', async () => {
    const fx = await loadedFixture();
    const result = await runHotReload('drainer', fx.manifest, fx.pluginDir, fx.deps, fx.lcm, fx.options);
    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe('quiesce');
    expect(result.error).toContain('PluginLoaderDeps.inFlight is not set');
    expect(probe.deactivated).toEqual([]);
  });
});

describe('PluginManager.reload drains the same way', () => {
  test('a busy plugin is left on its instance and reported; once idle it reloads', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gv-drain-manager-'));
    roots.push(base);
    writePlugin(join(base, 'project', '.goodvibes', 'plugins', 'drainer'));
    const stateFilePath = join(base, 'plugins.json');
    writeFileSync(stateFilePath, JSON.stringify({ enabled: { drainer: true } }), 'utf-8');
    const harness = makeDeps();
    const manager = new PluginManager({ pathOptions: { cwd: join(base, 'project'), homeDir: join(base, 'home') }, stateFilePath });
    await manager.init(harness.deps);

    const slow = harness.toolRegistry.execute('c1', 'plugin_drainer_slow', {});
    await tick();
    const busy = await manager.reload({ quiesceTimeoutMs: 40 });
    expect(busy).toEqual({ reloaded: 0, failed: 1, notDrained: ['drainer'] });
    expect(probe.deactivated).toEqual([]);
    expect((await harness.toolRegistry.execute('c2', 'plugin_drainer_fast', {})).output).toBe('fast-gen-1');

    probe.open();
    expect((await slow).output).toBe('slow-gen-1');
    const idle = await manager.reload({ quiesceTimeoutMs: 40 });
    expect(idle).toEqual({ reloaded: 1, failed: 0, notDrained: [] });
    expect(probe.deactivated).toEqual([1]);
    expect((await harness.toolRegistry.execute('c3', 'plugin_drainer_fast', {})).output).toBe('fast-gen-2');
  });
});

describe('PluginInFlightTracker', () => {
  test('counts sync and async calls, refuses while quiescing, and resolves the drain at zero', async () => {
    const tracker = new PluginInFlightTracker();
    expect(tracker.track('p', () => 7)).toBe(7);
    expect(() => tracker.track('p', () => { throw new Error('boom'); })).toThrow('boom');
    expect(tracker.inFlight('p')).toBe(0);

    let finish!: () => void;
    const running = tracker.track('p', () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(tracker.inFlight('p')).toBe(1);
    const drain = tracker.quiesce('p', 1_000);
    expect(() => tracker.track('p', () => 1)).toThrow(PluginQuiescingError);
    expect(tracker.track('other', () => 2)).toBe(2);
    finish();
    await running;
    const result = await drain;
    expect(result.drained).toBe(true);
    expect(result.inFlight).toBe(0);
    expect(tracker.isQuiescing('p')).toBe(true);
    tracker.resume('p');
    expect(tracker.track('p', () => 3)).toBe(3);
  });
});
