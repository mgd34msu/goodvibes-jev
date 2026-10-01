import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import type { ProjectIndex } from '@goodvibes-jev/engine/sdk/platform/state';
import { RuntimeEventBus } from '../../runtime/index.js';
import { createRuntimeServices } from '../../runtime/services.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function configuration() {
  const root = makeOwnedTempDir('daemon-owner-state');
  const workingDir = join(root, 'workspace'); const homeDirectory = join(root, 'home');
  const cache = join(homeDirectory, '.goodvibes', 'tui');
  mkdirSync(cache, { recursive: true }); mkdirSync(workingDir, { recursive: true });
  writeFileSync(join(cache, 'benchmarks.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }));
  const config = new ConfigManager({ configDir: join(homeDirectory, '.goodvibes', 'daemon'), workingDir, homeDir: homeDirectory, surfaceRoot: 'tui' });
  return { config, workingDir, homeDirectory };
}
async function graph(input = configuration(), failInbox = false) {
  const { config, workingDir, homeDirectory } = input;
  const services = await createRuntimeServices({ configManager: config, workingDir, homeDirectory,
    runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
    inboxFactory: (context, _routing, options) => {
      if (failInbox) throw new Error('fixture inbox startup failure');
      return registerInboxSurface(context, { ...options, adapters: new Map() });
    },
  });
  return { services, config, workingDir };
}

test('closed graph detaches callbacks from its borrowed config and feature manager', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  let built: Awaited<ReturnType<typeof graph>> | undefined;
  try {
    built = await graph();
    const hooks = spyOn(built.services.hookDispatcher, 'fire').mockResolvedValue({ ok: true });
    const features = spyOn(built.services.featureFlags, 'applyConfigState');
    const optimizer = spyOn(built.services.providerOptimizer, 'setEnabled');
    await built.services.close();
    hooks.mockClear(); features.mockClear(); optimizer.mockClear();
    built.config.set('watchers.enabled', !built.config.get('watchers.enabled'));
    built.services.featureFlags.applyConfigState('provider-optimizer', 'enabled');
    expect(hooks).not.toHaveBeenCalled();
    expect(features.mock.calls.filter(([id]) => id !== 'provider-optimizer')).toEqual([]);
    expect(optimizer).not.toHaveBeenCalled();
    expect(built.config.get('watchers.enabled')).toBeDefined();
    hooks.mockRestore(); features.mockRestore(); optimizer.mockRestore();
  } finally { await built?.services.close(); discovery.mockRestore(); }
}, 30_000);

test('failed startup releases borrowed subscriptions and the same config can build again', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const input = configuration();
  const subscribe = input.config.subscribe.bind(input.config);
  const live = new Set<object>();
  const observation = spyOn(input.config, 'subscribe').mockImplementation((key, listener) => {
    // Observe subscription ownership without expanding ConfigValue's complete
    // generic schema union inside Bun's spy wrapper.
    const release = subscribe(key as never, listener as never); const token = {};
    live.add(token);
    return () => { live.delete(token); release(); };
  });
  let built: Awaited<ReturnType<typeof graph>> | undefined;
  try {
    await expect(graph(input, true)).rejects.toThrow('fixture inbox startup failure');
    expect(live.size).toBe(0);
    built = await graph(input);
    expect(live.size).toBeGreaterThan(0);
    await built.services.close();
    expect(live.size).toBe(0);
    input.config.set('watchers.enabled', !input.config.get('watchers.enabled'));
    expect(live.size).toBe(0);
  } finally { await built?.services.close(); observation.mockRestore(); discovery.mockRestore(); }
}, 30_000);

test('closed graph flushes its default ProjectIndex and retires the delayed writer', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  let built: Awaited<ReturnType<typeof graph>> | undefined;
  let index: ProjectIndex | undefined;
  const createTimeout = globalThis.setTimeout;
  let staleWriter: (() => void) | undefined;
  try {
    built = await graph();
    index = (built.services.agentOrchestrator as unknown as { toolDeps: { projectIndex: ProjectIndex } }).toolDeps.projectIndex;
    globalThis.setTimeout = ((callback: never, milliseconds?: never, ...args: never[]) => {
      if (Number(milliseconds) === 5000) staleWriter = callback;
      return createTimeout(callback, milliseconds, ...args);
    }) as typeof setTimeout;
    index.upsertFile('src/owned.ts', 17);
    globalThis.setTimeout = createTimeout;
    expect(staleWriter).toBeDefined();
    await built.services.close();
    const path = join(built.workingDir, '.goodvibes', 'project-index.json');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).tree['src/']['owned.ts']).toBe(17);
    expect((index as unknown as { flushTimer: unknown }).flushTimer).toBeNull();
    rmSync(built.workingDir, { recursive: true, force: true });
    staleWriter?.();
    await Promise.resolve();
    expect(existsSync(built.workingDir)).toBe(false);
    expect(() => index!.upsertFile('src/late.ts', 9)).toThrow('disposed');
    expect(existsSync(built.workingDir)).toBe(false);
  } finally {
    globalThis.setTimeout = createTimeout;
    await index?.dispose(); await built?.services.close(); discovery.mockRestore();
  }
}, 30_000);
