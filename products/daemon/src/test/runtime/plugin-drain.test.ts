import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { PluginLoaderDeps } from '@goodvibes-jev/engine/sdk/platform/plugins';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

test('the actual runtime graph drains its plugin before completing shutdown', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue();
  let fixture: DaemonFixture | undefined;
  let restoreClose = () => {};
  let release!: () => void;
  let called!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { called = resolve; });
  const probe = { held, called, deactivated: false };
  const globals = globalThis as unknown as { __jevDaemonPluginDrain?: typeof probe };
  globals.__jevDaemonPluginDrain = probe;
  try {
    fixture = await startDaemonFixture({ root: makeOwnedTempDir('daemon-plugin-drain'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
    const directory = join(fixture.workingDirectory, '.goodvibes', 'plugins', 'fixture');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', description: 'owned fixture' }));
    writeFileSync(join(directory, 'index.js'), `
const probe = globalThis.__jevDaemonPluginDrain;
export function init(api) {
  api.registerTool('held', {}, async () => {
    probe.called();
    await probe.held;
    return { success: true, output: 'settled' };
  });
}
export function deactivate() { probe.deactivated = true; }
`);
    const tools = new ToolRegistry();
    const manager = fixture.services.pluginManager;
    await manager.init({ toolRegistry: tools, getPluginConfig: () => ({}), isEnabled: () => true } as unknown as PluginLoaderDeps);
    expect((await manager.enable('fixture')).ok).toBe(true);
    const running = tools.execute('first', 'plugin_fixture_held', {});
    await entered;
    let beganClose!: () => void;
    const beginning = new Promise<void>((resolve) => { beganClose = resolve; });
    const realClose = manager.close.bind(manager);
    const closeSpy = spyOn(manager, 'close').mockImplementation(() => { beganClose(); return realClose(); });
    restoreClose = () => closeSpy.mockRestore();
    let closed = false;
    const closing = fixture.services.close().then(() => { closed = true; });
    // Await the actual owner call, or fail if the graph finishes without it.
    expect(await Promise.race([beginning.then(() => true), closing.then(() => false)])).toBe(true);
    expect(closed).toBe(false);
    expect(probe.deactivated).toBe(false);
    release();
    expect((await running).output).toBe('settled');
    await closing;
    expect(probe.deactivated).toBe(true);
    expect(tools.has('plugin_fixture_held')).toBe(false);
    expect(manager.isEnabled('fixture')).toBe(true);
    await expect(manager.reload()).rejects.toThrow('closed');
  } finally {
    release();
    try { await fixture?.stop(); await fixture?.services.pluginManager.close(); }
    finally { restoreClose(); delete globals.__jevDaemonPluginDrain; benchmarks.mockRestore(); discovery.mockRestore(); }
  }
}, 30_000);
