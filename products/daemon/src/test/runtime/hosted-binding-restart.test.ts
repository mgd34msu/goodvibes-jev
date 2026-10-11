/** Native listener lifecycle; provider discovery/transport is explicitly synthetic here. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { HostedSessionManager } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import { CompanionChatManager } from '@goodvibes-jev/engine/sdk/platform/companion';
import { captureRemoteSettingsPrecondition, applyRemoteSettingsPrecondition, type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath, legacyWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import type { DaemonFixture } from '../../testing/daemon-fixture.js';
import { startGatewayFixture } from '../helpers/gateway-route-fixture.js';

const fixtures: DaemonFixture[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  try { for (const f of fixtures.splice(0).reverse()) await f.stop(); }
  finally { for (const restore of restores.splice(0).reverse()) restore(); }
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hostedId(value: unknown): string {
  if (!record(value) || !record(value.session) || typeof value.session.id !== 'string') {
    throw new Error('Native hosted create did not return its session identity');
  }
  expect(value.session.status).toBe('idle');
  return value.session.id;
}
async function fixture() {
  const f = await startGatewayFixture({ configure(config) { config.set('provider.model', 'mock:mock-model'); } });
  fixtures.push(f);
  const s = f.services;
  const store = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(s.shellPaths),
    fallbackReadPath: legacyWorkspaceRegisterPath(s.shellPaths), homeDir: dirname(s.shellPaths.resolveUserPath()),
    daemonStateDir: s.shellPaths.resolveUserPath() });
  await store.add(f.workingDirectory);
  const paired = s.pairingTokens.mint({ name: 'Owned native listener lifecycle fixture' });
  const url = () => `http://127.0.0.1:${f.daemon.boundPort}`;
  const request = (method: string, body: Record<string, unknown> = {}) => fetch(`${url()}/api/control-plane/methods/${method}/invoke`, {
    method: 'POST', headers: { Authorization: `Bearer ${paired.token}`, Origin: url(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }), signal: AbortSignal.timeout(5_000),
  });
  const create = () => request('sessions.hosted.create', {
    workspaceRoot: f.workingDirectory, title: 'TA30 synthetic read-only hosted', detachPolicy: 'survive',
  });
  return { f, paired, url, request, create };
}

function captureNativeListener() {
  const original = Bun.serve;
  let listener: ReturnType<typeof Bun.serve> | undefined;
  const capture = spyOn(Bun, 'serve').mockImplementation(options => {
    const server = original(options); listener = server; return server;
  });
  restores.push(() => capture.mockRestore());
  return { current() {
    if (!listener) throw new Error('The native fixture listener did not bind');
    return listener;
  }, restore() { capture.mockRestore(); } };
}
function holdActualClose(listener: ReturnType<typeof Bun.serve>) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = listener.stop;
  const held = spyOn(listener, 'stop').mockImplementation((...args) => {
    const result = original.apply(listener, args);
    entered.resolve();
    return Promise.resolve(result).then(() => release.promise);
  });
  restores.push(() => { release.resolve(); held.mockRestore(); });
  return { entered: entered.promise, release: () => release.resolve() };
}

test('binding reconfiguration retains live hosted owners and existing/new native sessions', async () => {
  let disposed = 0;
  const original = HostedSessionManager.prototype.dispose;
  const observing = spyOn(HostedSessionManager.prototype, 'dispose').mockImplementation(function (this: HostedSessionManager) {
    disposed++; return original.call(this);
  });
  restores.push(() => observing.mockRestore());
  const { f, create, request } = await fixture();
  const before = await create(); expect(before.status).toBe(200);
  const first = hostedId(await before.json());
  f.services.configManager.set('controlPlane.port', f.daemon.boundPort);
  f.services.configManager.flushConfigFileChanges();
  await f.daemon.waitForRestart();
  expect(disposed).toBe(0);
  const after = await create(); expect(after.status).toBe(200);
  const second = hostedId(await after.json()); expect(second).not.toBe(first);
  const listing = await request('sessions.hosted.list'); expect(listing.status).toBe(200);
  const body: unknown = await listing.json();
  if (!record(body) || !Array.isArray(body.sessions)) throw new Error('Native session list was absent');
  expect(body.sessions.filter(record).map(session => session.id).sort()).toEqual([first, second].sort());
  await f.daemon.stop(); expect(disposed).toBe(1); expect(f.daemon.isRunning).toBe(false);
}, 60_000);

test('concurrent binding mutations use the latest actual configuration after native close drains', async () => {
  const capture = captureNativeListener();
  const { f, create } = await fixture();
  const listener = capture.current(); capture.restore();
  const oldPort = f.daemon.boundPort;
  const available = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('owned port acquisition') });
  const latestPort = available.port;
  await available.stop(true);
  if (latestPort === undefined) throw new Error('The owned candidate port was absent');
  const close = holdActualClose(listener);
  try {
    f.services.configManager.set('controlPlane.port', oldPort);
    await close.entered;
    f.services.configManager.set('controlPlane.port', latestPort);
    f.services.configManager.set('controlPlane.hostMode', 'custom');
    f.services.configManager.set('controlPlane.host', '127.0.0.1');
    f.services.configManager.set('controlPlane.port', latestPort);
    f.services.configManager.flushConfigFileChanges();
    expect(f.daemon.isRunning).toBe(false);
    close.release(); await f.daemon.waitForRestart();
    expect(f.daemon.boundHost).toBe('127.0.0.1'); expect(f.daemon.boundPort).toBe(latestPort);
    expect((await create()).status).toBe(200);
  } finally { close.release(); }
}, 60_000);

test('permanent stop waits for actual detached native close and fences late rebinding', async () => {
  const capture = captureNativeListener(); const { f, url } = await fixture();
  const listener = capture.current(); capture.restore(); const originalUrl = url();
  const close = holdActualClose(listener);
  let stopping: Promise<void> | undefined;
  try {
    f.services.configManager.set('controlPlane.port', f.daemon.boundPort); await close.entered;
    let stopped = false;
    stopping = f.daemon.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    f.services.configManager.set('controlPlane.port', Number(new URL(originalUrl).port));
    close.release(); await stopping; await f.daemon.waitForRestart();
    expect(f.daemon.isRunning).toBe(false);
    await expect(fetch(originalUrl + '/status', { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  } finally { close.release(); await stopping; }
}, 60_000);

test('same-binding rebind and paired-token revocation retire original settings handles without writes', async () => {
  const { f, paired, url } = await fixture();
  const endpoint = { baseUrl: url(), token: paired.token, source: 'owned-native-fixture' };
  const original = f.services.configManager.get('display.theme');
  const first = await captureRemoteSettingsPrecondition(endpoint, { operation: 'set', key: 'display.theme', value: 'nord' });
  f.services.configManager.set('controlPlane.port', f.daemon.boundPort);
  await f.daemon.waitForRestart();
  expect((await applyRemoteSettingsPrecondition(first)).status).toBe('unknown');
  expect(f.services.configManager.get('display.theme')).toBe(original);
  const second = await captureRemoteSettingsPrecondition(endpoint, { operation: 'set', key: 'display.theme', value: 'nord' });
  f.services.pairingTokens.revoke(paired.id);
  expect((await applyRemoteSettingsPrecondition(second)).status).toBe('unknown');
  expect(f.services.configManager.get('display.theme')).toBe(original);
}, 60_000);


test('stop reentered from native binding construction closes the unpublished socket', async () => {
  const { f } = await fixture();
  const original = Bun.serve;
  let acquired: ReturnType<typeof Bun.serve> | undefined;
  let stopping: Promise<void> | undefined;
  const reenter = spyOn(Bun, 'serve').mockImplementation(options => {
    const server = original(options);
    acquired = server;
    stopping = f.daemon.stop();
    return server;
  });
  restores.push(() => reenter.mockRestore());
  try {
    f.services.configManager.set('controlPlane.port', f.daemon.boundPort);
    await f.daemon.waitForRestart();
    await stopping;
    if (!acquired || !stopping) throw new Error('The actual rebind boundary was not reached');
    expect(f.daemon.isRunning).toBe(false);
    await expect(fetch(`http://127.0.0.1:${acquired.port}/status`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  } finally { reenter.mockRestore(); await stopping; }
}, 60_000);


test.each(['synchronous', 'queued'] as const)('%s config mutation during native listener construction cannot publish a stale binding', async timing => {
  const { f } = await fixture();
  const available = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('owned candidate') });
  const latestPort = available.port; await available.stop(true);
  if (latestPort === undefined) throw new Error('The actual latest port was absent');
  const publishedPorts: number[] = [];
  const unsubscribe = f.services.runtimeBus.onDomain('transport', ({ payload }) => {
    if (payload.type === 'TRANSPORT_CONNECTED') publishedPorts.push(f.daemon.boundPort);
  });
  restores.push(unsubscribe);
  const original = Bun.serve; let mutated = false;
  const reenter = spyOn(Bun, 'serve').mockImplementation(options => {
    const server = original(options);
    if (!mutated) {
      mutated = true;
      const change = () => f.services.configManager.set('controlPlane.port', latestPort);
      if (timing === 'queued') queueMicrotask(change); else change();
    }
    return server;
  });
  restores.push(() => reenter.mockRestore());
  f.services.configManager.set('controlPlane.port', f.daemon.boundPort);
  await f.daemon.waitForRestart();
  expect(mutated).toBe(true);
  expect(publishedPorts).toEqual([latestPort]);
  expect(f.daemon.boundPort).toBe(latestPort);
}, 60_000);


test('initial native listener construction A to B to A selects the latest owned binding', async () => {
  const ports: number[] = [];
  const candidates: ReturnType<typeof Bun.serve>[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const available = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('owned initial candidate') });
      candidates.push(available);
      if (available.port === undefined) throw new Error('The native candidate port was absent');
      ports.push(available.port);
    }
  } finally { await Promise.all(candidates.map(server => server.stop(true))); }
  const [first, second] = ports;
  if (first === undefined || second === undefined) throw new Error('Both native ports are required');
  let config: ConfigManager | undefined;
  const original = Bun.serve; const acquiredPorts: number[] = [];
  const reenter = spyOn(Bun, 'serve').mockImplementation(options => {
    const server = original(options);
    if (server.port !== undefined) acquiredPorts.push(server.port);
    if (!config) throw new Error('The actual native config owner was unavailable');
    if (acquiredPorts.length === 1) config.set('controlPlane.port', second);
    else if (acquiredPorts.length === 2) config.set('controlPlane.port', first);
    return server;
  });
  restores.push(() => reenter.mockRestore());
  const f = await startGatewayFixture({ configure(owner) {
    config = owner; owner.set('provider.model', 'mock:mock-model'); owner.set('controlPlane.port', first);
  } });
  fixtures.push(f);
  expect(acquiredPorts).toHaveLength(3);
  expect(f.daemon.boundPort).toBe(first);
  expect(config?.get('controlPlane.port')).toBe(first);
  const response = await fetch(`http://127.0.0.1:${first}/api/control-plane/auth`);
  expect(response.status).toBe(200);
  await expect(fetch(`http://127.0.0.1:${second}/status`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
}, 60_000);

test('native startup manager await retains the latest binding before connection publication', async () => {
  const available = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('owned startup candidate') });
  const latestPort = available.port;
  if (latestPort === undefined) throw new Error('The owned startup port was absent');
  const capture = captureNativeListener();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = CompanionChatManager.prototype.init;
  let initialized = 0;
  const held = spyOn(CompanionChatManager.prototype, 'init').mockImplementation(function (this: CompanionChatManager) {
    initialized++;
    return original.call(this).then(() => { entered.resolve(); return release.promise; });
  });
  restores.push(() => { release.resolve(); held.mockRestore(); });
  let config: ConfigManager | undefined;
  const starting = startGatewayFixture({ configure(owner) {
    config = owner; owner.set('provider.model', 'mock:mock-model');
  } }).then(f => { fixtures.push(f); return f; });
  try {
    await entered.promise;
    if (!config) throw new Error('The actual startup configuration owner was absent');
    const oldPort = capture.current().port;
    expect(oldPort).not.toBe(latestPort);
    await available.stop(true);
    config.set('controlPlane.port', latestPort);
    release.resolve();
    const f = await starting;
    expect(f.daemon.boundPort).toBe(latestPort);
    expect(config.get('controlPlane.port')).toBe(latestPort);
    expect(initialized).toBe(1);
    expect((await fetch(`http://127.0.0.1:${latestPort}/api/control-plane/auth`)).status).toBe(200);
    await expect(fetch(`http://127.0.0.1:${oldPort}/status`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
  } finally { release.resolve(); await available.stop(true); await starting; }
}, 60_000);
