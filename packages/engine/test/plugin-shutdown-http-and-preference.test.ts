import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginAPI, type PluginAPIContext } from '../sdk/src/platform/plugins/api.ts';
import { ChannelPluginRegistry, type ChannelPlugin } from '../sdk/src/platform/channels/plugin-registry.ts';
import { PluginInFlightTracker } from '../sdk/src/platform/plugins/in-flight.ts';
import { PluginManager } from '../sdk/src/platform/plugins/manager.ts';
import type { PluginLoaderDeps } from '../sdk/src/platform/plugins/loader.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test.each([false, true])('actual Bun HTTP delivers the channel Response and drains its body (owned=%s)', async (owned) => {
  const channels = new ChannelPluginRegistry();
  const calls = new PluginInFlightTracker();
  const registrations = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  let response: Response | null = null;
  const plugin: ChannelPlugin = {
    id: 'http-fixture', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/fixture',
    async handleInbound() { return new Response('fixture body', { status: 202, headers: { 'x-fixture': 'yes' } }); },
  };
  if (owned) createPluginAPI({ pluginName: 'http-fixture', inFlight: calls, registrations, cleanup, channelRegistry: channels } as unknown as PluginAPIContext).registerChannelPlugin(plugin);
  else channels.register(plugin);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    response = await channels.handleInbound('/fixture', request);
    return response ?? new Response('missing', { status: 404 });
  } });
  try {
    const result = await fetch(new URL('/fixture', server.url));
    expect(result.status).toBe(202);
    expect(result.headers.get('x-fixture')).toBe('yes');
    expect(await result.text()).toBe('fixture body');
    await calls.close(); await registrations.close();
    expect(calls.inFlight('http-fixture')).toBe(0);
    expect(registrations.inFlight('http-fixture')).toBe(0);
  } finally {
    await server.stop(true);
    const captured = response as Response | null;
    if (captured?.body && !captured.bodyUsed) await captured.body.cancel().catch(() => undefined);
    await calls.close(); await registrations.close();
    for (const dispose of cleanup) dispose();
  }
});

test('actual HEAD waits for discarded-body cancellation and preserves response headers', async () => {
  const channels = new ChannelPluginRegistry();
  const calls = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  const cancelEntered = gate(); const finishCancel = gate(); const returned = gate();
  let response: Response | null = null;
  let pulls = 0; let cancels = 0; let didReturn = false;
  createPluginAPI({ pluginName: 'head-fixture', inFlight: calls, cleanup, channelRegistry: channels } as unknown as PluginAPIContext)
    .registerChannelPlugin({ id: 'head-fixture', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/webhook/fixture',
      async handleInbound() {
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('fixture body')); controller.close(); },
          cancel() { cancels++; cancelEntered.resolve(); return finishCancel.promise; },
        }, { highWaterMark: 0 }), { status: 202, statusText: 'Accepted fixture', headers: { 'x-fixture': 'yes', 'content-length': '12' } });
      },
    });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    response = await channels.handleInbound(new URL(request.url).pathname, request);
    didReturn = true; returned.resolve();
    return response ?? new Response('missing', { status: 404 });
  } });
  const client = fetch(new URL('/webhook/fixture', server.url), { method: 'HEAD' });
  // Cleanup observes any client failure even when an earlier assertion fails.
  void client.catch(() => {});
  try {
    expect(await Promise.race([cancelEntered.promise.then(() => true), returned.promise.then(() => false)])).toBe(true);
    let closed = false;
    const closing = calls.close().then(() => { closed = true; });
    expect(cancels).toBe(1);
    expect(pulls).toBe(0);
    expect(didReturn).toBe(false);
    expect(closed).toBe(false);
    expect(calls.inFlight('head-fixture')).toBe(1);
    finishCancel.resolve();
    const received = await client;
    expect(received.status).toBe(202);
    // Bun normalizes the wire reason phrase; the adapter retains the source
    // value on the actual Response supplied to the server.
    expect((response as Response | null)?.statusText).toBe('Accepted fixture');
    expect(received.headers.get('x-fixture')).toBe('yes');
    expect(received.headers.get('content-length')).toBe('12');
    expect(await received.text()).toBe('');
    await closing;
    expect(calls.inFlight('head-fixture')).toBe(0);
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
  } finally {
    finishCancel.resolve();
    await server.stop(true);
    await client.catch(() => undefined);
    const captured = response as Response | null;
    if (captured?.body && !captured.bodyUsed) await captured.body.cancel().catch(() => undefined);
    await calls.close();
    for (const dispose of cleanup) dispose();
  }
});

test.each(['throw', 'reject'] as const)('HEAD cancellation failure is preserved and drains ownership (%s)', async (mode) => {
  const channels = new ChannelPluginRegistry();
  const calls = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  const failure = new Error('fixture HEAD cancellation failed');
  let cancels = 0;
  createPluginAPI({ pluginName: 'head-failure', inFlight: calls, cleanup, channelRegistry: channels } as unknown as PluginAPIContext)
    .registerChannelPlugin({ id: 'head-failure', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/fixture',
      async handleInbound() {
        return new Response(new ReadableStream<Uint8Array>({ cancel() {
          cancels++;
          if (mode === 'throw') throw failure;
          return Promise.reject(failure);
        } }, { highWaterMark: 0 }));
      },
    });
  try {
    await expect(channels.handleInbound('/fixture', new Request('http://127.0.0.1/fixture', { method: 'HEAD' }))).rejects.toBe(failure);
    await calls.close();
    expect(cancels).toBe(1);
    expect(calls.inFlight('head-failure')).toBe(0);
  } finally {
    await calls.close();
    for (const dispose of cleanup) dispose();
  }
});

test('native HEAD omits unknown representation length instead of reporting an empty representation', async () => {
  const channels = new ChannelPluginRegistry();
  const calls = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  createPluginAPI({ pluginName: 'head-length', inFlight: calls, cleanup, channelRegistry: channels } as unknown as PluginAPIContext)
    .registerChannelPlugin({ id: 'head-length', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/fixture',
      async handleInbound() { return new Response('fixture body', { status: 202, headers: { 'x-fixture': 'yes' } }); },
    });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    return (await channels.handleInbound('/fixture', request)) ?? new Response('missing', { status: 404 });
  } });
  try {
    const head = await fetch(new URL('/fixture', server.url), { method: 'HEAD' });
    expect(head.status).toBe(202);
    expect(head.headers.get('x-fixture')).toBe('yes');
    expect(head.headers.get('content-length')).toBeNull();
    expect(await head.text()).toBe('');
    const get = await fetch(new URL('/fixture', server.url));
    expect(get.headers.get('content-length')).toBe('12');
    expect(await get.text()).toBe('fixture body');
    await calls.close();
    expect(calls.inFlight('head-length')).toBe(0);
  } finally {
    await server.stop(true);
    await calls.close();
    for (const dispose of cleanup) dispose();
  }
});

test('actual HTTP disconnect keeps shutdown pending until the source cancellation settles', async () => {
  const channels = new ChannelPluginRegistry();
  const calls = new PluginInFlightTracker();
  const registrations = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  const cancelEntered = gate(); const finishCancel = gate(); const finishPull = gate();
  let first = true;
  let response: Response | null = null;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(new TextEncoder().encode('fixture first chunk')); }
      else await finishPull.promise;
    },
    cancel() { cancelEntered.resolve(); return finishCancel.promise; },
  });
  createPluginAPI({ pluginName: 'disconnect-fixture', inFlight: calls, registrations, cleanup, channelRegistry: channels } as unknown as PluginAPIContext)
    .registerChannelPlugin({ id: 'disconnect-fixture', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/fixture',
      async handleInbound() { return new Response(source, { status: 202 }); },
    });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    response = await channels.handleInbound('/fixture', request);
    return response ?? new Response('missing', { status: 404 });
  } });
  const abort = new AbortController();
  try {
    const result = await fetch(new URL('/fixture', server.url), { signal: abort.signal });
    expect(result.status).toBe(202);
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('fixture first chunk');
    let closed = false;
    const closing = calls.close().then(() => { closed = true; });
    expect(calls.inFlight('disconnect-fixture')).toBe(1);
    abort.abort();
    await cancelEntered.promise;
    expect(closed).toBe(false);
    finishCancel.resolve(); finishPull.resolve();
    await closing; await registrations.close();
    expect(calls.inFlight('disconnect-fixture')).toBe(0);
    reader.releaseLock();
  } finally {
    abort.abort(); finishCancel.resolve(); finishPull.resolve();
    await server.stop(true);
    const captured = response as Response | null;
    if (captured?.body && !captured.bodyUsed) await captured.body.cancel().catch(() => undefined);
    await calls.close(); await registrations.close();
    for (const dispose of cleanup) dispose();
  }
});

test('a response arriving after actual HTTP disconnect is cancelled before its owner drains', async () => {
  const channels = new ChannelPluginRegistry();
  const calls = new PluginInFlightTracker();
  const registrations = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  const entered = gate(); const serverAborted = gate(); const releaseHandler = gate();
  const cancelEntered = gate(); const finishCancel = gate(); const returned = gate();
  let response: Response | null = null;
  let pulls = 0; let cancels = 0; let didReturn = false;
  createPluginAPI({ pluginName: 'late-fixture', inFlight: calls, registrations, cleanup, channelRegistry: channels } as unknown as PluginAPIContext)
    .registerChannelPlugin({ id: 'late-fixture', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/fixture',
      async handleInbound(request) {
        request.signal.addEventListener('abort', serverAborted.resolve, { once: true });
        entered.resolve();
        await releaseHandler.promise;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('late fixture')); controller.close(); },
          cancel() { cancels++; cancelEntered.resolve(); return finishCancel.promise; },
        }, { highWaterMark: 0 }), { status: 202 });
      },
    });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    response = await channels.handleInbound('/fixture', request);
    didReturn = true; returned.resolve();
    return response ?? new Response('missing', { status: 404 });
  } });
  const abort = new AbortController();
  const client = fetch(new URL('/fixture', server.url), { signal: abort.signal }).catch((error: unknown) => error);
  try {
    await entered.promise;
    abort.abort();
    await serverAborted.promise;
    let closed = false;
    const closing = calls.close().then(() => { closed = true; });
    releaseHandler.resolve();
    expect(await Promise.race([cancelEntered.promise.then(() => true), returned.promise.then(() => false)])).toBe(true);
    expect(cancels).toBe(1);
    expect(pulls).toBe(0);
    expect(didReturn).toBe(false);
    expect(closed).toBe(false);
    finishCancel.resolve();
    await returned.promise; await closing; await registrations.close();
    expect(calls.inFlight('late-fixture')).toBe(0);
    expect(pulls).toBe(0);
  } finally {
    abort.abort(); releaseHandler.resolve(); finishCancel.resolve();
    await client;
    await server.stop(true);
    const captured = response as Response | null;
    if (captured?.body && !captured.bodyUsed) await captured.body.cancel().catch(() => undefined);
    await calls.close(); await registrations.close();
    for (const dispose of cleanup) dispose();
  }
});

test('request abort retires an unclaimed response returned to an in-process channel caller', async () => {
  const channels = new ChannelPluginRegistry();
  const calls = new PluginInFlightTracker();
  const cleanup: Array<() => void> = [];
  const entered = gate(); const release = gate();
  let cancellations = 0;
  createPluginAPI({ pluginName: 'unclaimed-fixture', inFlight: calls, cleanup, channelRegistry: channels } as unknown as PluginAPIContext)
    .registerChannelPlugin({ id: 'unclaimed-fixture', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/fixture',
      async handleInbound() { return new Response(new ReadableStream<Uint8Array>({ cancel() { cancellations++; entered.resolve(); return release.promise; } }, { highWaterMark: 0 })); },
    });
  const abort = new AbortController();
  const response = await channels.handleInbound('/fixture', new Request('http://127.0.0.1/fixture', { signal: abort.signal }));
  let closed = false;
  const closing = calls.close().then(() => { closed = true; });
  try {
    expect(calls.inFlight('unclaimed-fixture')).toBe(1);
    expect(response?.bodyUsed).toBe(false);
    abort.abort(); await entered.promise;
    expect(cancellations).toBe(1);
    expect(closed).toBe(false);
    expect(response?.bodyUsed).toBe(true);
    release.resolve(); await closing;
    expect(calls.inFlight('unclaimed-fixture')).toBe(0);
  } finally {
    release.resolve();
    if (response?.body && !response.bodyUsed) await response.body.cancel();
    await closing;
    for (const dispose of cleanup) dispose();
  }
});

test('an admitted enable preference survives shutdown during initialization and activates on restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-plugin-enable-close-'));
  const project = join(root, 'project');
  const directory = join(project, '.goodvibes', 'plugins', 'fixture');
  const stateFilePath = join(root, 'plugins.json');
  mkdirSync(directory, { recursive: true });
  const entered = gate(); const release = gate();
  const probe = { entered, release, generations: 0, deactivated: 0 };
  const globals = globalThis as unknown as { __jevEnableClose?: typeof probe };
  globals.__jevEnableClose = probe;
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', description: 'owned fixture' }));
  writeFileSync(join(directory, 'index.js'), `
const probe = globalThis.__jevEnableClose;
export async function init(api) {
  probe.generations++;
  probe.entered.resolve();
  await probe.release.promise;
  api.registerCommand('ping', 'fixture', () => {});
}
export function deactivate() { probe.deactivated++; }
`);
  writeFileSync(stateFilePath, JSON.stringify({ enabled: {}, config: { fixture: { retained: true } }, trust: {}, quarantine: {} }));
  const commands = new Set<string>();
  const deps = {
    commandRegistry: { register(command: { name: string }) { commands.add(command.name); }, unregister(name: string) { commands.delete(name); } },
    getPluginConfig: () => ({}), isEnabled: () => true,
  } as unknown as PluginLoaderDeps;
  const options = { pathOptions: { cwd: project, homeDir: join(root, 'home') }, stateFilePath };
  const manager = new PluginManager(options);
  let restarted: PluginManager | undefined;
  try {
    await manager.init(deps);
    const enabling = manager.enable('fixture');
    await entered.promise;
    const committed = readFileSync(stateFilePath, 'utf8');
    expect(JSON.parse(committed).enabled.fixture).toBe(true);
    const closing = manager.close();
    release.resolve();
    expect(await enabling).toMatchObject({ ok: false });
    await closing;
    expect(readFileSync(stateFilePath, 'utf8')).toBe(committed);
    expect(commands.size).toBe(0);
    restarted = new PluginManager(options);
    await restarted.init(deps);
    expect(restarted.isEnabled('fixture')).toBe(true);
    expect(probe.generations).toBe(2);
    expect(commands.size).toBe(1);
    expect(restarted.getPluginConfig('fixture')).toEqual({ retained: true });
  } finally {
    release.resolve();
    await manager.close(); await restarted?.close();
    delete globals.__jevEnableClose;
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['load-failure', 'closed-before-enable', 'missing-plugin'] as const)('enable refuses normally without preserving an uncommitted preference (%s)', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-plugin-enable-refusal-'));
  const project = join(root, 'project');
  const directory = join(project, '.goodvibes', 'plugins', 'fixture');
  const stateFilePath = join(root, 'plugins.json');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', description: 'owned failure fixture' }));
  writeFileSync(join(directory, 'index.js'), `export function init() { throw new Error('fixture ordinary load failure'); }`);
  writeFileSync(stateFilePath, JSON.stringify({ enabled: {}, config: { fixture: { retained: true } }, trust: {}, quarantine: {} }));
  const original = readFileSync(stateFilePath, 'utf8');
  const manager = new PluginManager({ pathOptions: { cwd: project, homeDir: join(root, 'home') }, stateFilePath });
  try {
    await manager.init({ getPluginConfig: () => ({}), isEnabled: () => true } as unknown as PluginLoaderDeps);
    if (mode === 'closed-before-enable') {
      await manager.close();
      await expect(manager.enable('fixture')).rejects.toThrow('closed');
    } else {
      expect(await manager.enable(mode === 'missing-plugin' ? 'missing' : 'fixture')).toMatchObject({ ok: false });
    }
    expect(manager.isEnabled('fixture')).toBe(false);
    expect(JSON.parse(readFileSync(stateFilePath, 'utf8'))).toEqual(JSON.parse(original));
    if (mode !== 'load-failure') expect(readFileSync(stateFilePath, 'utf8')).toBe(original);
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});
