/** Owned native watcher admission and real registry reload settlement (THE-102). */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchCustomProviders } from '../sdk/src/platform/providers/custom-loader.ts';
import { ProviderRegistry } from '../sdk/src/platform/providers/registry.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { bootDaemon, type BootedDaemon } from '../sdk/src/platform/daemon/boot.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { withTestTimeout } from './_helpers/test-timeout.ts';

const PRIVATE = 'synthetic-private-watcher-rejection';
type WatchHandle = ReturnType<typeof watchCustomProviders>;
type NativeCallback = (event: string, filename: string | null) => void;
const nativeWatch = fs.watch;
let root: string;
let watchSpy: Mock<typeof fs.watch>;
let callbacks: NativeCallback[];
let nativeWatchers: fs.FSWatcher[];

let handles: WatchHandle[];
let releases: Array<() => void>;
let restores: Array<() => void>;
let daemons: BootedDaemon[];
let registries: ProviderRegistry[];

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => { resolve = ok; });
  releases.push(resolve);
  return { promise, resolve };
}
function observe(promise: Promise<void>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function ready(count: number) { await until(() => callbacks.length >= count, 'native watcher readiness'); }
function write(dir = root, name = 'native.json') { fs.writeFileSync(join(dir, name), '{}'); }
function writeProvider(dir: string) {
  fs.writeFileSync(join(dir, 'native.json'), JSON.stringify({
    name: 'drain-native', displayName: 'Drain native fixture', type: 'openai-compat',
    baseURL: 'http://127.0.0.1:1/v1',
    models: [{ id: 'held-model', displayName: 'Held model', contextWindow: 8192,
      capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false } }],
  }));
}
function watching(callback: () => void | Promise<void>, bus: RuntimeEventBus | null = null) {
  const handle = watchCustomProviders(bus, callback, root);
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'provider-watcher-drain-'));
  callbacks = []; nativeWatchers = []; handles = []; releases = []; restores = []; daemons = []; registries = [];
  // Wrap the real native watcher; retained callbacks model events snapshotted
  // before close. Readiness is witnessed at fs.watch, never guessed by sleeping.
  watchSpy = spyOn(fs, 'watch').mockImplementation(((dir: string, options: fs.WatchOptions, callback: NativeCallback) => {
    const watcher = nativeWatch(dir, options, callback);
    callbacks.push(callback); nativeWatchers.push(watcher);
    return watcher;
  }) as typeof fs.watch);
});
afterEach(async () => {
  for (const release of releases) release();
  for (const handle of handles) handle.close();
  for (const registry of registries) registry.stopWatching();
  // Optional only for cleanup in the failing-before run against the old API.
  await Promise.allSettled(handles.map((handle) => handle.closeAndDrain?.()));
  await Promise.allSettled(registries.map((registry) => registry.closeWatching?.()));
  await flush();
  for (const daemon of daemons) await daemon.stop();
  for (const restore of restores) restore();
  watchSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('custom provider watcher ownership', () => {
  test('native admission holds close until actual callback settlement; repeated close is identical', async () => {
    const held = gate(); const entered = gate(); let calls = 0;
    const handle = watching(async () => { calls++; entered.resolve(); await held.promise; });
    await ready(1); write(); await withTestTimeout(entered.promise, 4_000, 'reload admission');
    const closing = handle.closeAndDrain(); const settled = observe(closing);
    expect(handle.closeAndDrain()).toBe(closing);
    handle.close(); callbacks[0]!('change', 'late.json');
    await flush(); expect(settled()).toBe(false);
    held.resolve(); await closing;
    callbacks[0]!('change', 'after-drain.json');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls).toBe(1);
  });

  test('a rejected reload is observed and reported only after all admitted work settles', async () => {
    const first = gate(); const second = gate(); let calls = 0;
    const bus = new RuntimeEventBus(); const warnings: string[] = [];
    bus.on('PROVIDER_WARNING', (event) => {
      if (event.payload.type === 'PROVIDER_WARNING') warnings.push(event.payload.message);
    });
    const handle = watching(async () => {
      const call = ++calls;
      await (call === 1 ? first.promise : second.promise);
      if (call === 1) throw new Error(PRIVATE);
    }, bus);
    await ready(1); write(); await until(() => calls === 1, 'first admission');
    write(root, 'second.json'); await until(() => calls === 2, 'second admission');
    const closing = handle.closeAndDrain(); const settled = observe(closing);
    first.resolve(); await flush(); expect(settled()).toBe(false);
    expect(warnings).toEqual(['[custom-loader] Provider watcher reload failed.']);
    second.resolve();
    await expect(closing).rejects.toThrow('Provider watcher drain failed.');
    const error = await closing.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(PRIVATE);
    expect(Object.hasOwn(error as Error, 'cause')).toBe(false);
    expect(handle.closeAndDrain()).toBe(closing);
  });

  test('close before asynchronous setup prevents native watcher acquisition', async () => {
    let calls = 0; const handle = watching(() => { calls++; });
    await handle.closeAndDrain();
    expect(callbacks).toHaveLength(0); expect(calls).toBe(0);
  });

  test('close cancels debounce and fences already-captured native and timer callbacks', async () => {
    let calls = 0; const timers: Array<() => void> = [];
    const handle = watching(() => { calls++; });
    await ready(1);
    const nativeTimeout = globalThis.setTimeout;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      const timer = nativeTimeout(callback, delay);
      if (delay === 300) { timers.push(callback); debounceTimer = timer; }
      return timer;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, 'clearTimeout');
    let closing!: Promise<void>;
    try {
      // Drive the callback captured from the real watcher deterministically:
      // one write may produce multiple native events on different platforms.
      // Keep global timer interception synchronous so unrelated work is excluded.
      callbacks[0]!('rename', 'native.json');
      const firstTimer = debounceTimer;
      callbacks[0]!('change', 'native.json');
      expect(timers).toHaveLength(2);
      expect(clearSpy).toHaveBeenCalledWith(firstTimer);
      clearSpy.mockClear();
      closing = handle.closeAndDrain();
      expect(clearSpy).toHaveBeenCalledWith(debounceTimer);
      for (const timer of timers) timer();
      callbacks[0]!('change', 'late.json');
      expect(timers).toHaveLength(2);
    } finally {
      timerSpy.mockRestore(); clearSpy.mockRestore();
    }
    await closing;
    await flush(); expect(calls).toBe(0);
  });

  test('reentrant close sees the already-admitted callback obligation', async () => {
    const held = gate(); const entered = gate(); let closing: Promise<void> | undefined;
    const handle = watching(() => { closing = handle.closeAndDrain(); entered.resolve(); return held.promise; });
    await ready(1); write(); await withTestTimeout(entered.promise, 4_000, 'reentrant admission');
    const settled = observe(closing!); await flush(); expect(settled()).toBe(false);
    held.resolve(); await closing;
  });

  test('repeated hostile callback failures are observed without reading or retaining rejection data', async () => {
    let calls = 0;
    const hostile = new Proxy({}, { get() { throw new Error('rejection payload was read'); } });
    const handle = watching(() => { calls++; throw hostile; });
    await ready(1);
    for (let count = 1; count <= 3; count++) {
      write(root, `failure-${count}.json`);
      await until(() => calls === count, 'hostile rejection admission');
      await flush();
    }
    const closing = handle.closeAndDrain();
    await expect(closing).rejects.toThrow('Provider watcher drain failed.');
    const error = await closing.catch((reason: unknown) => reason);
    expect(Object.keys(error as Error)).toEqual([]);
    expect(Object.hasOwn(error as Error, 'cause')).toBe(false);
    expect(Object.hasOwn(error as Error, 'errors')).toBe(false);
  });

  test('directly returning the callback own drain rejects instead of deadlocking', async () => {
    const entered = gate();
    const handle = watching(() => { entered.resolve(); return handle.closeAndDrain(); });
    await ready(1); write(); await withTestTimeout(entered.promise, 4_000, 'self-drain admission');
    await expect(handle.closeAndDrain()).rejects.toThrow('Provider watcher drain failed.');
  });
});

async function registryFixture() {
  seedBenchmarkCache(root, 'goodvibes');
  const daemon = await bootDaemon({ homeDirectory: root, workingDir: root, daemonHomeDir: join(root, 'daemon'), port: 0, token: 'owned-watcher-fixture' });
  daemons.push(daemon);
  // Inspect the actual daemon graph, rather than construct a lookalike registry.
  const registry = (daemon.server as unknown as { runtimeServices: { providerRegistry: ProviderRegistry } }).runtimeServices.providerRegistry;
  registries.push(registry);
  await registry.ready();
  const dir = (registry as unknown as { getCustomProvidersDir(): string }).getCustomProvidersDir();
  const bus = daemon.server.eventBus;
  const changed: Array<{ type: 'PROVIDERS_CHANGED'; added: string[]; removed: string[]; updated: string[] }> = [];
  bus.on('PROVIDERS_CHANGED', (event) => {
    if (event.payload.type === 'PROVIDERS_CHANGED') changed.push(event.payload);
  });
  return { registry, dir, bus, changed };
}
function holdLoads(registry: ProviderRegistry) {
  const first = gate(); const second = gate(); let calls = 0;
  const real = registry.loadCustomProviders;
  const load = spyOn(registry, 'loadCustomProviders').mockImplementation(async function (this: ProviderRegistry) {
    const call = ++calls;
    expect(this).toBe(registry);
    await (call === 1 ? first.promise : second.promise);
    return real.call(this);
  });
  restores.push(() => load.mockRestore());
  return { first, second, calls: () => calls };
}

describe('daemon-owned ProviderRegistry watcher drain', () => {
  test('ordinary stop remains restartable; terminal close includes both held generations', async () => {
    const { registry, dir, bus, changed } = await registryFixture();
    const held = holdLoads(registry);
    const firstCount = callbacks.length + 1;
    registry.startWatching(bus); await ready(firstCount); writeProvider(dir);
    await until(() => held.calls() === 1, 'old generation admission');
    expect(registry.stopWatching()).toBeUndefined();
    registry.startWatching(bus); await ready(firstCount + 1); write(dir, 'second.json');
    await until(() => held.calls() === 2, 'new generation admission');
    const closing = registry.closeWatching(); const settled = observe(closing);
    expect(registry.closeWatching()).toBe(closing);
    expect(() => registry.startWatching(bus)).toThrow('Provider watcher ownership is closed.');
    held.second.resolve(); await until(() => changed.length === 1, 'new real reload emission');
    await flush(); expect(settled()).toBe(false);
    held.first.resolve(); await closing;
    expect(changed).toEqual([{ type: 'PROVIDERS_CHANGED', added: ['drain-native:held-model'], removed: [], updated: [] }, { type: 'PROVIDERS_CHANGED', added: [], removed: [], updated: [] }]);
    expect(registry.require('drain-native').models).toContain('held-model');
    for (const callback of callbacks.slice(firstCount - 1)) callback('change', 'late.json');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(held.calls()).toBe(2); expect(changed).toHaveLength(2);
  });

  test('retired failed generation stays observable after its pending work is removed', async () => {
    const { registry, dir, bus, changed } = await registryFixture();
    const held = holdLoads(registry); const count = callbacks.length + 1;
    registry.startWatching(bus); await ready(count); write(dir);
    await until(() => held.calls() === 1, 'rejecting real reload wrapper');
    registry.stopWatching();
    // Force the real loader's ensure-directory operation to reject after admission.
    fs.renameSync(dir, `${dir}-before-rejection`);
    fs.writeFileSync(dir, 'blocks the providers directory');
    held.first.resolve();
    await flush(); await flush();
    const closing = registry.closeWatching();
    await expect(closing).rejects.toThrow('Provider registry watcher drain failed.');
    expect(registry.closeWatching()).toBe(closing); expect(changed).toHaveLength(0);
  });

  test('native close reentry includes the retiring generation and cannot reopen admission', async () => {
    const { registry, dir, bus } = await registryFixture();
    const held = holdLoads(registry); const count = callbacks.length + 1;
    registry.startWatching(bus); await ready(count); write(dir);
    await until(() => held.calls() === 1, 'reentrant generation admission');
    const native = nativeWatchers[count - 1]!;
    const realClose = native.close.bind(native);
    let closing: Promise<void> | undefined;
    const closeSpy = spyOn(native, 'close').mockImplementation(() => {
      realClose();
      closing = registry.closeWatching();
    });
    restores.push(() => closeSpy.mockRestore());
    expect(() => registry.startWatching(bus)).toThrow('Provider watcher ownership is closed.');
    const settled = observe(closing!); await flush(); expect(settled()).toBe(false);
    held.first.resolve(); await closing;
    expect(callbacks).toHaveLength(count);
  });

  test('a recursive start supersedes the outer start without orphaning a watcher', async () => {
    const { registry, bus } = await registryFixture();
    const count = callbacks.length + 1;
    registry.startWatching(bus); await ready(count);
    const native = nativeWatchers[count - 1]!;
    const realClose = native.close.bind(native);
    const closeSpy = spyOn(native, 'close').mockImplementation(() => {
      realClose(); registry.startWatching(bus);
    });
    restores.push(() => closeSpy.mockRestore());
    registry.startWatching(bus); await ready(count + 1);
    await flush();
    expect(callbacks).toHaveLength(count + 1);
    await registry.closeWatching();
  });

  test('closing an idle registry is terminal even before the first start', async () => {
    const { registry, bus } = await registryFixture();
    const closing = registry.closeWatching(); await closing;
    expect(registry.closeWatching()).toBe(closing);
    registry.stopWatching();
    expect(() => registry.startWatching(bus)).toThrow('Provider watcher ownership is closed.');
  });
});
