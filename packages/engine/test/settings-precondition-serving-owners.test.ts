/** Real ConfigManager + strict auth + route/client composition, temporary stores only. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';
import { createDaemonSystemRouteHandlers } from '../daemon-sdk/src/system-routes.js';
import { DaemonServer } from '../sdk/src/platform/daemon/facade.js';
import { DaemonLifecycleRuntime } from '../sdk/src/platform/daemon/facade-lifecycle.js';
import { DaemonHttpRouter } from '../sdk/src/platform/daemon/http/router.js';
import { createServingSettingsPrecondition } from '../sdk/src/platform/daemon/http/settings-precondition.js';
import { captureRemoteSettingsPrecondition, applyRemoteSettingsPrecondition, inspectRemoteSettingsPrecondition,
  resolvePreparedConfigWriteRoute, assertPreparedConfigWriteRoute } from '../sdk/src/platform/config/settings-precondition-client.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), 'serving-settings-')); roots.push(dir); return dir; }
function fixture(kind: 'shared' | 'paired' | 'session' | 'cookie' = 'shared', lifetimeOwner?: () => object | null) {
  const dir = root();
  const manager = new ConfigManager({ configDir: join(dir, 'config'), daemonTierPath: join(dir, 'daemon.json') });
  const pairing = new PairingTokenManager(join(dir, 'pairing.json'));
  const paired = kind === 'paired' ? pairing.mint({ name: 'Synthetic protocol fixture' }) : null;
  const users = new UserAuthManager({ users: [{ username: 'fixture-admin', passwordHash: 'synthetic-unused', roles: ['admin'] }],
    bootstrapFilePath: join(dir, 'unused.json'), bootstrapCredentialPath: join(dir, 'unused.txt') });
  const session = users.createSession('fixture-admin');
  let shared = 'fixture-shared'; let lifetime: object | null = {};
  const currentLifetime = lifetimeOwner ?? (() => lifetime);
  const helper = new DaemonControlPlaneHelper({ authToken: () => shared, pairingTokens: pairing, userAuth: users,
    settingsLifetime: currentLifetime } as unknown as DaemonControlPlaneContext);
  const authority: Parameters<typeof createServingSettingsPrecondition>[1] = { settingsLifetime: currentLifetime,
    captureSettingsAdminAuthority: req => helper.captureSettingsAdminAuthority(req),
    withSettingsAdminAuthority: (req, authority, callback) => helper.withSettingsAdminAuthority(req, authority, callback) };
  const service = createServingSettingsPrecondition(manager, authority);
  const handlers = createDaemonSystemRouteHandlers({ configManager: manager, requireAdmin: (req: Request) => helper.requireAdmin(req),
    parseJsonBody: (req: Request) => req.json(), isValidConfigKey: () => true, settingsPrecondition: service } as never);
  const token = kind === 'shared' ? shared : kind === 'paired' ? paired!.token : session.token;
  const fetchImpl = (async (url, init) => {
    const headers = new Headers(init?.headers);
    if (kind === 'cookie') { headers.delete('authorization'); headers.set('cookie', `goodvibes_session=${token}`); }
    return handlers.postConfig(new Request(String(url), { ...init, headers }));
  }) as typeof fetch;
  const endpoint = { baseUrl: 'http://synthetic.invalid', token, source: 'fixture' };
  return { dir, manager, pairing, users, helper, service, fetchImpl, endpoint, authority,
    revoke() { if (kind === 'shared') pairing.revokeLegacyShared(); else if (kind === 'paired') pairing.revoke(paired!.id); else users.revokeSession(session.token); },
    stop() { lifetime = null; }, rotate() { lifetime = {}; }, tokenABA() { lifetime = {}; shared = 'other'; lifetime = {}; shared = 'fixture-shared'; } };
}

test.each(['shared', 'paired', 'session', 'cookie'] as const)('actual %s owner captures normalized value and commits once', async kind => {
  const f = fixture(kind);
  const prepared = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'payments.budget.perPurchaseCeiling', value: '$12.34' }, { fetchImpl: f.fetchImpl });
  const facts = inspectRemoteSettingsPrecondition(prepared);
  expect(facts.value).toBe(12.34); expect(facts.destinations).toEqual([{ path: join(f.dir, 'daemon.json'), operation: 'set', tier: 'daemon' }]);
  expect((await applyRemoteSettingsPrecondition(prepared)).status).toBe('committed');
  expect(JSON.parse(readFileSync(join(f.dir, 'daemon.json'), 'utf8')).payments.budget.perPurchaseCeiling).toBe(12.34);
  await expect(applyRemoteSettingsPrecondition(prepared)).rejects.toThrow();
});
test.each(['shared', 'paired', 'session', 'cookie'] as const)('actual %s revoke before apply prevents persistence', async kind => {
  const f = fixture(kind); const before = f.manager.get('controlPlane.port');
  const prepared = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'controlPlane.port', value: 4567 }, { fetchImpl: f.fetchImpl });
  f.revoke(); expect((await applyRemoteSettingsPrecondition(prepared)).status).toBe('unknown'); expect(f.manager.get('controlPlane.port')).toBe(before);
});
test.each(['session', 'cookie'] as const)('actual %s revoke from ConfigManager invalidation callback fences effect', async kind => {
  const f = fixture(kind); const before = f.manager.get('controlPlane.port');
  const prepared = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'controlPlane.port', value: 4567 }, { fetchImpl: f.fetchImpl });
  f.manager.onDidInvalidate(f.revoke);
  expect((await applyRemoteSettingsPrecondition(prepared)).status).toBe('unknown'); expect(f.manager.get('controlPlane.port')).toBe(before);
});
test.each(['stop', 'rotate', 'tokenABA'] as const)('actual facade lifetime %s during owner callback fences effect', async change => {
  const f = fixture(); const before = f.manager.get('controlPlane.port');
  const prepared = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'controlPlane.port', value: 4567 }, { fetchImpl: f.fetchImpl });
  f.manager.onDidInvalidate(f[change]);
  expect((await applyRemoteSettingsPrecondition(prepared)).status).toBe('unknown'); expect(f.manager.get('controlPlane.port')).toBe(before);
});
test('remote reset binds the serving schema default and never removes the override', async () => {
  const f = fixture(); f.manager.setDynamic('controlPlane.port', 4567);
  const prepared = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'reset-default', key: 'controlPlane.port' }, { fetchImpl: f.fetchImpl });
  const expected = f.manager.getSchema().find(setting => setting.key === 'controlPlane.port')!.default;
  expect(inspectRemoteSettingsPrecondition(prepared).value).toBe(expected);
  expect((await applyRemoteSettingsPrecondition(prepared)).status).toBe('committed');
  expect(JSON.parse(readFileSync(join(f.dir, 'daemon.json'), 'utf8')).controlPlane.port).toBe(expected);
});
test('actual protected-input boundary blocks raw credential capture and accepts exact reference form', async () => {
  const f = fixture(); let calls = 0;
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => { calls++; return f.fetchImpl(...args); }) as typeof fetch;
  await expect(captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'surfaces.telegram.botToken', value: 'synthetic-inline-secret' }, { fetchImpl })).rejects.toThrow();
  expect(calls).toBe(0);
  const request = new Request('http://synthetic.invalid/config', { headers: { authorization: `Bearer ${f.endpoint.token}` } });
  const result = f.service.handle(request, { settingsPrecondition: { version: 1, action: 'capture', operation: 'set', key: 'surfaces.telegram.botToken', value: 'synthetic-inline-secret' } }, f.service.lifetime());
  expect(result.status).toBe(409); expect(await result.text()).not.toContain('synthetic-inline-secret');
  const prepared = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'surfaces.telegram.botToken', value: 'goodvibes://secrets/telegram/bot' }, { fetchImpl });
  expect(inspectRemoteSettingsPrecondition(prepared).value).toBe('goodvibes://secrets/telegram/bot');
});
test('non-mutating route observation detects runtime arrival and leaves malformed record untouched', async () => {
  const dir = root(); const deps = { hostsDaemon: false, daemonHomeDir: dir };
  const route = await resolvePreparedConfigWriteRoute('controlPlane.port', deps);
  expect(route.mode).toBe('local'); assertPreparedConfigWriteRoute(route);
  writeFileSync(join(dir, 'detached-daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 4567 }));
  expect(() => assertPreparedConfigWriteRoute(route)).toThrow(); expect(() => assertPreparedConfigWriteRoute({ ...route })).toThrow();
  writeFileSync(join(dir, 'detached-daemon.json'), '{broken');
  await expect(resolvePreparedConfigWriteRoute('controlPlane.port', deps)).rejects.toThrow();
  expect(readdirSync(dir)).toEqual(['detached-daemon.json']); expect(readFileSync(join(dir, 'detached-daemon.json'), 'utf8')).toBe('{broken');
});
test('route changes during probe await refuse instead of choosing an unobserved owner', async () => {
  let runtime = { host: '127.0.0.1', port: 4567 };
  const deps = { hostsDaemon: false, daemonHomeDir: '/synthetic', readRuntimeRecord: () => runtime,
    fetchImpl: (async (_input: Parameters<typeof fetch>[0]) => { await Promise.resolve(); runtime = { ...runtime, port: 5678 }; return Response.json({}); }) as typeof fetch };
  await expect(resolvePreparedConfigWriteRoute('controlPlane.port', deps)).rejects.toThrow();
});
test('actual facade source retires lifetime before stop callbacks and token replacement, and wires exact helper', () => {
  const facade = readFileSync(new URL('../sdk/src/platform/daemon/facade.ts', import.meta.url), 'utf8');
  expect(facade).toContain('settingsLifetime: () => this.settingsLifetime');
  const stop = facade.slice(facade.indexOf('  async stop(): Promise<void> {'));
  expect(stop.indexOf('this.settingsLifetime = null')).toBeLessThan(stop.indexOf('this._configWatchUnsub?.()'));
  const enable = facade.slice(facade.indexOf('  enable(dangerConfig:'));
  expect(enable.indexOf('this.settingsLifetime =')).toBeLessThan(enable.indexOf('this.authToken = token ?? null'));
  expect(facade).toContain('this.settingsLifetime = {};\n      this.server = this.serveFactory(');
  const composition = readFileSync(new URL('../sdk/src/platform/daemon/facade-composition.ts', import.meta.url), 'utf8');
  expect(composition).toContain('settingsLifetime: options.settingsLifetime');
  expect(composition).toContain('controlPlaneHelper.withSettingsAdminAuthority(req, authority, callback)');
});

test('source-extracted facade enable cannot reopen SETTINGS during an awaited stop', () => {
  // Execute only the production enable body against a data-only facade stand-in.
  // No DaemonServer constructor, service graph, socket or native module is used.
  const source = readFileSync(new URL('../sdk/src/platform/daemon/facade.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  enable(dangerConfig:');
  const open = source.indexOf('{', start);
  const end = source.indexOf('\n  }\n', open);
  const enable = new Function('logger', `return function(dangerConfig, token) { ${source.slice(open + 1, end)} };`)({ info() {} }) as
    (this: { server: object; tornDown: boolean; settingsLifetime: object | null; enabled: boolean; authToken: string | null;
      controlPlaneGateway: { setServerState(value: unknown): void } }, config: { daemon: boolean }, token?: string) => boolean;
  const state = { server: {}, tornDown: true, settingsLifetime: null as object | null, enabled: false, authToken: 'old',
    controlPlaneGateway: { setServerState() {} } };
  expect(enable.call(state, { daemon: true }, 'replacement')).toBe(true);
  expect(state.settingsLifetime).toBeNull();
  state.tornDown = false; state.settingsLifetime = {};
  const previous = state.settingsLifetime;
  enable.call(state, { daemon: true }, 'replacement');
  expect(state.settingsLifetime).not.toBeNull(); expect(state.settingsLifetime).not.toBe(previous);
});


function actualRouter(f: ReturnType<typeof fixture>) {
  // Constructor gets no runtimeStore or batch manager: no telemetry/service is
  // started. All SETTINGS configuration/auth owners and dispatchers are real.
  const context = { configManager: f.manager, settingsAuthority: f.authority, runtimeStore: null,
    userAuth: f.users, authToken: () => f.endpoint.token, requireAdmin: (req: Request) => f.helper.requireAdmin(req),
    requireAuthenticatedSession: () => null, extractAuthToken: () => f.endpoint.token, describeAuthenticatedPrincipal: () => null,
    controlPlaneGateway: { recordApiRequest() {} }, secretsManager: null, swapManager: null,
  };
  const router = new DaemonHttpRouter(context as never);
  const fetchImpl = (async (url, init) => {
    const response = await router.dispatchApiRoutes(new Request(String(url), init));
    if (!response) throw new Error('Missing real route'); return response;
  }) as typeof fetch;
  return { router, fetchImpl };
}

test('actual router retains capture across separately dispatched HTTP requests', async () => {
  const f = fixture(); const { router, fetchImpl } = actualRouter(f);
  try {
    const prepared = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'controlPlane.port', value: 4567 }, { fetchImpl });
    expect((await applyRemoteSettingsPrecondition(prepared)).status).toBe('committed');
    expect(f.manager.get('controlPlane.port')).toBe(4567);
  } finally { router.dispose(); }
});

test('actual router retires old references across stop/restart and accepts fresh-lifetime capture', async () => {
  const f = fixture(); const { router, fetchImpl } = actualRouter(f); const before = f.manager.get('controlPlane.port');
  const request = { operation: 'set' as const, key: 'controlPlane.port', value: 4567 };
  try {
    const old = await captureRemoteSettingsPrecondition(f.endpoint, request, { fetchImpl });
    f.stop();
    await expect(captureRemoteSettingsPrecondition(f.endpoint, request, { fetchImpl })).rejects.toThrow();
    f.rotate();
    expect((await applyRemoteSettingsPrecondition(old)).status).toBe('unknown'); expect(f.manager.get('controlPlane.port')).toBe(before);
    const fresh = await captureRemoteSettingsPrecondition(f.endpoint, request, { fetchImpl });
    expect((await applyRemoteSettingsPrecondition(fresh)).status).toBe('committed'); expect(f.manager.get('controlPlane.port')).toBe(4567);
  } finally { router.dispose(); }
});

test('actual router serving-token ABA retires the old reference', async () => {
  const f = fixture(); const { router, fetchImpl } = actualRouter(f); const before = f.manager.get('controlPlane.port');
  try {
    const old = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'controlPlane.port', value: 4567 }, { fetchImpl });
    f.tokenABA(); expect((await applyRemoteSettingsPrecondition(old)).status).toBe('unknown'); expect(f.manager.get('controlPlane.port')).toBe(before);
  } finally { router.dispose(); }
});

test.each(['unchanged', 'changed', 'unreadable'] as const)('remote readback reports %s after committed publication without rewriting the outcome', async state => {
  const f = fixture(); const { router, fetchImpl } = actualRouter(f);
  const prepared = await captureRemoteSettingsPrecondition(f.endpoint, { operation: 'set', key: 'controlPlane.port', value: 4567 }, { fetchImpl });
  let changed = false;
  const unsubscribe = f.manager.subscribe('controlPlane.port', () => {
    if (changed || state === 'unchanged') return; changed = true;
    if (state === 'changed') f.manager.set('controlPlane.port', 5678);
    else writeFileSync(f.manager.getDaemonTierPath()!, '{synthetic malformed readback');
  });
  try {
    const receipt = await applyRemoteSettingsPrecondition(prepared);
    expect(receipt.status).toBe('committed');
    expect(receipt).toHaveProperty('verifiedInOwningStore');
    expect('verifiedInOwningStore' in receipt && receipt.verifiedInOwningStore).toBe(state === 'unchanged');
    expect(receipt.completedPaths).toEqual([f.manager.getDaemonTierPath()!]);
    await expect(applyRemoteSettingsPrecondition(prepared)).rejects.toThrow();
    if (state === 'unreadable') expect(readFileSync(f.manager.getDaemonTierPath()!, 'utf8')).toBe('{synthetic malformed readback');
  } finally { unsubscribe(); router.dispose(); }
});


/** Actual stop/enable and lifecycle abort methods, without constructing a service graph. */
function stoppingFacade() {
  const events: string[] = [];
  const promotionAbort = new AbortController();
  const lifecycle = Object.assign(Object.create(DaemonLifecycleRuntime.prototype) as object, {
    promotionAbort, rollbackAbort: new AbortController(),
    promotionTask: null as Promise<void> | null,
    rollbackHandover: null,
    autoUpdater: null as { stop(handover?: boolean): void; drainHandover(handover?: boolean): Promise<void> } | null,
    appliedUpdater: null,
    async onStopping(_restarting: boolean, handover: boolean) { events.push(`onStopping:${handover}`); },
  });
  const state = Object.assign(Object.create(DaemonServer.prototype) as object, {
    settingsLifetime: {} as object | null, tornDown: false, lifecycle,
    server: { stop() { events.push('socket'); } },
    enabled: true, authToken: 'fixture-shared', host: '127.0.0.1', port: 0,
    _restarting: false,
    _configWatchUnsub() { events.push('watcher'); },
    configManager: { get() { return false; } },
    channelHealth: { stop() {} }, replyPoller: null,
    pendingSurfaceReplies: new Map(), httpRouter: { dispose() {} },
    surfaceActionHelper: { closeDelegatedTelegram() {} },
    companionChatManager: { dispose() {} },
    clusterCoordinator: { async stop() {} }, automationManager: { stop() {} },
    sessionBroker: { async stop() {} },
    runtimeServices: { powerManager: { async stop() {} } }, ownsRuntimeServices: false,
    controlPlaneGateway: { setServerState() {} },
    transportEventsHelper: { emitTransportDisconnected() {} },
  });
  const daemon = state as unknown as DaemonServer;
  const stopRuntime = (DaemonServer.prototype as unknown as {
    stopRuntime(this: object, handover: boolean): Promise<void>;
  }).stopRuntime;
  return { state, events, promotionAbort,
    stop(handover: boolean) { return handover ? stopRuntime.call(state, true) : daemon.stop(); },
    enable(token = 'fixture-shared') { return daemon.enable({ daemon: true }, token); },
  };
}

for (const handover of [false, true]) test(`actual facade stop handover=${handover} retires captured SETTINGS before teardown`, async () => {
  const d = stoppingFacade(); const f = fixture('shared', () => d.state.settingsLifetime);
  const before = f.manager.get('controlPlane.port');
  const prepared = await captureRemoteSettingsPrecondition(f.endpoint,
    { operation: 'set', key: 'controlPlane.port', value: 4567 }, { fetchImpl: f.fetchImpl });
  let lifetimeAtAbort: object | null | undefined;
  d.promotionAbort.signal.addEventListener('abort', () => { lifetimeAtAbort = d.state.settingsLifetime; });
  await d.stop(handover);
  const result = await applyRemoteSettingsPrecondition(prepared);
  expect(lifetimeAtAbort).toBeNull();
  expect(result.status).toBe('unknown'); expect(f.manager.get('controlPlane.port')).toBe(before);
  expect(d.events).toEqual(['watcher', `onStopping:${handover}`, 'socket']);
});

for (const handover of [false, true]) test(`actual synchronous lifecycle abort cannot remint SETTINGS during handover=${handover}`, async () => {
  const d = stoppingFacade(); const f = fixture('shared', () => d.state.settingsLifetime);
  let lifetimeAfterEnable: object | null | undefined;
  let captureStatus = 0;
  d.promotionAbort.signal.addEventListener('abort', () => {
    d.enable();
    lifetimeAfterEnable = d.state.settingsLifetime;
    const request = new Request('http://synthetic.invalid/config', {
      headers: { authorization: `Bearer ${f.endpoint.token}` },
    });
    captureStatus = f.service.handle(request, { settingsPrecondition: {
      version: 1, action: 'capture', operation: 'set', key: 'controlPlane.port', value: 4567,
    } }, f.service.lifetime()).status;
  });
  await d.stop(handover);
  expect(lifetimeAfterEnable).toBeNull();
  expect(captureStatus).toBe(409);
  expect(d.state.settingsLifetime).toBeNull();
});

for (const handover of [false, true]) test(`repeated actual stop handover=${handover} retires lifetime and still joins its handover`, async () => {
  const d = stoppingFacade(); d.state.tornDown = true;
  let release!: () => void;
  d.state.lifecycle.promotionTask = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const stopping = d.stop(handover).then(() => { settled = true; });
  try {
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(d.promotionAbort.signal.aborted).toBe(true);
    expect(d.state.settingsLifetime).toBeNull();
    expect(d.events).toEqual([]);
  } finally { release(); await stopping; }
  expect(settled).toBe(true);
  expect(d.events).toEqual([]);
});

test('actual update and rollback lifecycle uses the shared direct handover stop', () => {
  const facade = readFileSync(new URL('../sdk/src/platform/daemon/facade.ts', import.meta.url), 'utf8');
  expect(facade).toContain('stopGracefully: () => this.stopRuntime(true)');
  const lifecycle = readFileSync(new URL('../sdk/src/platform/daemon/facade-lifecycle.ts', import.meta.url), 'utf8');
  expect(lifecycle).toContain('stopGracefully: this.options.stopGracefully');
});


for (const handover of [false, true]) test(`failed actual updater stop handover=${handover} keeps SETTINGS retired and permits cleanup retry`, async () => {
  const d = stoppingFacade(); const f = fixture('shared', () => d.state.settingsLifetime);
  let stops = 0;
  d.state.lifecycle.autoUpdater = {
    stop() { if (++stops === 1) throw new Error('synthetic updater timer failure'); },
    async drainHandover() {},
  };
  await expect(d.stop(handover)).rejects.toThrow('synthetic updater timer failure');
  const tornDownAfterFailure = d.state.tornDown;
  d.enable();
  const lifetimeAfterEnable = d.state.settingsLifetime;
  const request = new Request('http://synthetic.invalid/config', {
    headers: { authorization: `Bearer ${f.endpoint.token}` },
  });
  const captureStatus = f.service.handle(request, { settingsPrecondition: {
    version: 1, action: 'capture', operation: 'set', key: 'controlPlane.port', value: 4567,
  } }, f.service.lifetime()).status;
  await d.stop(handover);
  expect(tornDownAfterFailure).toBe(false);
  expect(lifetimeAfterEnable).toBeNull(); expect(captureStatus).toBe(409);
  expect(d.events).toEqual(['watcher', `onStopping:${handover}`, 'socket']);
  expect(d.state.settingsLifetime).toBeNull();
  expect(stops).toBe(2);
});


test('actual enable rotates a live non-null serving lifetime with its replacement token', async () => {
  const d = stoppingFacade(); const previous = d.state.settingsLifetime;
  expect(d.enable('synthetic-replacement-token')).toBe(true);
  expect(d.state.settingsLifetime).not.toBeNull();
  expect(d.state.settingsLifetime).not.toBe(previous);
  expect(d.state.authToken).toBe('synthetic-replacement-token');
  expect(d.state.tornDown).toBe(false);
  await d.stop(false);
});
