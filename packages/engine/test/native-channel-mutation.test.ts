import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { createPermissionConfigReader, PermissionManager } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { registerRoutingMethods } from '../sdk/src/platform/channels/host-routing/registration.js';
import { registerDraftMethods } from '../sdk/src/platform/channels/host-drafts/register.js';
import { DraftSyncStore } from '../sdk/src/platform/channels/host-drafts/draft-store.js';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';
import { createDaemonControlRouteHandlers } from '../daemon-sdk/src/control-routes.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { normalizeContext } from '../sdk/src/platform/control-plane/host-handlers.js';
import { readNativeMutationAdmission, runNativeMutation, type NativeMutationAdmission } from '../sdk/src/platform/control-plane/native-mutation.js';

const cleanup: Array<() => void | Promise<void>> = [];
let log: SqliteDecisionLog;
let previous: ReturnType<typeof installJudgmentPort>;
let port: JudgmentPort;
let outcome: 'act' | 'reject' = 'act';
let beforeAdmission: (() => void | Promise<void>) | undefined;
let requests: JudgmentRequest<Questions>[];
beforeEach(() => {
  forgetGateReadings(); outcome = 'act'; beforeAdmission = undefined; requests = [];
  log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort(), semantic = fakePort((_name, question) => choiceAnswer(question,
    outcome === 'act' && question.type === 'choice' && !Object.hasOwn(question.criteria, 'act') ? 'reject' : outcome, 0.99));
  port = withDecisionLog({ model: gate.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    requests.push(request);
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  previous = installJudgmentPort(port);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gv-native-channel-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const config = new ConfigManager({ workingDir: directory, homeDir: directory, surfaceRoot: 'test-native-channel' });
  const invalidations = new Set<() => void>(), lifetime = new AbortController();
  let humans = 0;
  const manager = new PermissionManager(async () => { humans++; throw new Error('No human fallback'); }, createPermissionConfigReader(config), new PolicyRuntimeState());
  const admit = manager.admitAutonomous.bind(manager);
  manager.admitAutonomous = async (...args) => {
    const admission = await admit(...args);
    await beforeAdmission?.();
    return admission;
  };
  const nativeMutationHost = { permissionManager: manager, port, workspaceTrust: null, workspaceRoot: directory,
    signal: lifetime.signal, config: { onDidInvalidate(listener: () => void) { invalidations.add(listener); return () => { invalidations.delete(listener); }; } } };
  const catalog = new GatewayMethodCatalog(), pairing = new PairingTokenManager(join(directory, 'pairing.json'));
  const paired = pairing.mint({ name: 'Synthetic local fixture' });
  // Only the real producer's authentication/dispatch methods are exercised.
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-shared',
    userAuth: { validateSession: () => null },
  } as unknown as DaemonControlPlaneContext);
  const logger = { info() {}, warn() {}, error() {} };
  const routing = registerRoutingMethods({ catalog, workingDirectory: directory, logger, nativeMutationHost });
  cleanup.push(() => routing.close());
  const cipher = { async encrypt(value: string) { return `enc:${Buffer.from(value).toString('base64')}`; }, async decrypt(value: string) { return Buffer.from(value.slice(4), 'base64').toString(); } };
  const drafts = new DraftSyncStore({ workingDirectory: directory, cipher });
  cleanup.push(() => drafts.close());
  const draftSurface = registerDraftMethods({ catalog, workingDirectory: directory, logger, nativeMutationHost,
    credentials: { resolveRef: async () => null, resolveConfigSecret: async () => null, put: async () => {}, has: async () => false } }, { store: drafts });
  cleanup.push(() => draftSurface.close());
  const call = (methodId: string, body: Record<string, unknown>, token = paired.token, signal?: AbortSignal) => helper.invokeGatewayMethodCall({ methodId, body, authToken: token, signal,
    context: helper.describeAuthenticatedPrincipal(token) ?? { admin: false, scopes: [] } });
  return { directory, config, manager, nativeMutationHost, catalog, pairing, paired, helper, routing, drafts, cipher, call, lifetime, invalidations, humans: () => humans };
}
const route = () => ({ surfaceKind: 'slack', routeId: 'synthetic-channel', profileId: 'work', admission: 'autonomous' });
const draft = () => ({ id: 'synthetic-draft', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  status: 'draft' as const, message: 'Synthetic project reminder', admission: 'autonomous' });

test('native paired routing and drafts need no secondary gate or external sends', async () => {
  const f = fixture();
  const assignment = await f.call('channels.routing.assign', route()); expect(assignment.status).toBe(200);
  expect(f.routing.store.listAll()[0]?.profileId).toBe('work');
  const saved = await f.call('channels.drafts.save', draft()); expect(saved.status).toBe(200);
  expect(f.drafts.get('synthetic-draft')?.message).not.toBe(draft().message);
  expect(readFileSync(f.drafts.dbPath).includes(Buffer.from(draft().message))).toBe(false);
  expect(f.humans()).toBe(0);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
  expect(JSON.stringify(requests)).not.toContain(f.paired.token);
});

test('wire flags and shared token cannot manufacture a native admission', async () => {
  const f = fixture();
  const forged = { ...route(), confirm: true, explicitUserRequest: true, nativeExecutionAuthority: { current: 'copied' } };
  expect((await f.call('channels.routing.assign', forged, 'synthetic-shared')).status).toBe(403);
  expect((await f.call('channels.routing.assign', { surfaceKind: 'slack', routeId: 'synthetic-channel', profileId: 'work', confirm: true })).status).toBe(403);
  expect(f.routing.store.listAll()).toEqual([]); expect(requests).toHaveLength(0);
});

test('structural plan constraints prevent every store write', async () => {
  const f = fixture(); f.config.set('permissions.mode', 'plan');
  expect((await f.call('channels.routing.assign', route())).status).toBe(422);
  expect((await f.call('channels.drafts.save', draft())).status).toBe(422);
  expect(f.routing.store.listAll()).toEqual([]); expect(f.drafts.get('synthetic-draft')).toBeNull(); expect(f.humans()).toBe(0);
});

test.each(['abort', 'revoke', 'config', 'request'] as const)('pending native admission retains %s authority and commits nothing', async kind => {
  const f = fixture(), controller = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  beforeAdmission = async () => { entered.resolve(); await release.promise; };
  const body = route(), pending = f.call('channels.routing.assign', body, f.paired.token, controller.signal);
  await entered.promise;
  if (kind === 'abort') controller.abort();
  if (kind === 'revoke') expect(f.pairing.revoke(f.paired.id)).toBe(true);
  if (kind === 'config') for (const invalidate of f.invalidations) invalidate();
  if (kind === 'request') body.profileId = 'changed';
  release.resolve(); expect((await pending).ok).toBe(false);
  expect(f.routing.store.listAll()).toEqual([]); expect(f.humans()).toBe(0);
});

test('same selected route content restored after an ABA still invalidates native admission', async () => {
  const f = fixture(); await f.routing.initialize();
  await f.routing.store.upsert({ channelId: 'slack:synthetic-channel', profileId: 'original' });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  beforeAdmission = async () => { entered.resolve(); await release.promise; };
  const pending = f.call('channels.routing.assign', route()); await entered.promise;
  await f.routing.store.upsert({ channelId: 'slack:synthetic-channel', profileId: 'other' });
  await f.routing.store.upsert({ channelId: 'slack:synthetic-channel', profileId: 'original' });
  release.resolve(); expect((await pending).ok).toBe(false);
  expect(f.routing.store.listAll()[0]?.profileId).toBe('original');
});

test('equal-byte physical store replacement is stale before native publication', async () => {
  const f = fixture(); await f.drafts.init(); await f.drafts.upsert(draft()); await f.drafts.save();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  beforeAdmission = async () => { entered.resolve(); await release.promise; };
  const pending = f.call('channels.drafts.save', { ...draft(), title: 'not committed' }); await entered.promise;
  const bytes = readFileSync(f.drafts.dbPath), replacement = `${f.drafts.dbPath}.replacement`;
  writeFileSync(replacement, bytes); renameSync(replacement, f.drafts.dbPath);
  release.resolve(); expect((await pending).ok).toBe(false);
  expect(f.drafts.get('synthetic-draft')?.title).toBeUndefined();
});

test('cancellation during actual encryption leaves both native memory and disk unchanged', async () => {
  const f = fixture(); await f.drafts.init(); await f.drafts.upsert(draft()); await f.drafts.save();
  const before = readFileSync(f.drafts.dbPath), controller = new AbortController();
  f.cipher.encrypt = async value => { controller.abort(); return `enc:${Buffer.from(value).toString('base64')}`; };
  expect((await f.call('channels.drafts.save', { ...draft(), title: 'not committed' }, f.paired.token, controller.signal)).ok).toBe(false);
  expect(f.drafts.get('synthetic-draft')?.title).toBeUndefined(); expect(readFileSync(f.drafts.dbPath)).toEqual(before);
});

test('owner revocation remains available while admitted native encryption is staging', async () => {
  const f = fixture(); await f.drafts.init(); await f.drafts.upsert(draft()); await f.drafts.save();
  const before = readFileSync(f.drafts.dbPath), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.cipher.encrypt = async value => { entered.resolve(); await release.promise; return `enc:${Buffer.from(value).toString('base64')}`; };
  const pending = f.call('channels.drafts.save', { ...draft(), title: 'not committed' });
  await entered.promise;
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
  expect(f.pairing.revoke(f.paired.id)).toBe(true);
  release.resolve(); expect((await pending).ok).toBe(false);
  expect(f.drafts.get('synthetic-draft')?.title).toBeUndefined(); expect(readFileSync(f.drafts.dbPath)).toEqual(before);
});

test('real authenticated REST dispatch reaches native admission with no human header', async () => {
  const f = fixture();
  const tokenFrom = (request: Request) => request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const principalFrom = (request: Request) => f.helper.describeAuthenticatedPrincipal(tokenFrom(request));
  const handlers = createDaemonControlRouteHandlers({ gatewayMethods: f.catalog, extractAuthToken: tokenFrom, resolveAuthenticatedPrincipal: principalFrom,
    requireAdmin: (request: Request) => { const principal = principalFrom(request); return principal?.admin ? null : Response.json({ error: 'Unauthorized' }, { status: principal ? 403 : 401 }); },
    parseOptionalJsonBody: (request: Request) => request.json(), invokeGatewayMethodCall: (input: Parameters<typeof f.helper.invokeGatewayMethodCall>[0]) => f.helper.invokeGatewayMethodCall(input),
  } as unknown as Parameters<typeof createDaemonControlRouteHandlers>[0]);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    return await dispatchGatewayRestRoutes(request, handlers) ?? Response.json({ error: 'not found' }, { status: 404 });
  } }); cleanup.push(() => server.stop(true));
  const post = (token: string) => fetch(`http://127.0.0.1:${server.port}/api/channels/routing`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(route()) });
  expect((await post('')).status).toBe(401); expect((await post('synthetic-shared')).status).toBe(403);
  expect((await post(f.paired.token)).status).toBe(200); expect(f.routing.store.listAll()[0]?.profileId).toBe('work'); expect(f.humans()).toBe(0);
});


test('a postclaim permission floor change during native encryption blocks durable publication', async () => {
  const f = fixture(); await f.drafts.init(); await f.drafts.upsert(draft()); await f.drafts.save();
  const before = readFileSync(f.drafts.dbPath);
  f.cipher.encrypt = async value => {
    f.config.set('permissions.mode', 'plan');
    return `enc:${Buffer.from(value).toString('base64')}`;
  };
  expect((await f.call('channels.drafts.save', { ...draft(), title: 'not committed' })).ok).toBe(false);
  expect(f.drafts.get('synthetic-draft')?.title).toBeUndefined(); expect(readFileSync(f.drafts.dbPath)).toEqual(before);
});

test('the original native token is invocation-bound and retires at exact publication scope exit', async () => {
  const f = fixture(), invocation = {}, principal = f.helper.describeAuthenticatedPrincipal(f.paired.token);
  if (!principal) throw new Error('Fixture pairing missing');
  let captured: NativeMutationAdmission | undefined;
  await runNativeMutation({ host: f.nativeMutationHost, method: 'channels.routing.assign', body: route(), invocation,
    context: { ...normalizeContext(principal), nativeExecutionAuthority: f.helper.createNativeExecutionAuthority(f.paired.token, principal.scopes) ?? undefined,
      isAuthorized: scopes => Boolean(f.helper.describeAuthenticatedPrincipal(f.paired.token)?.admin && scopes?.every(scope => principal.scopes.includes(scope))) },
    target: { channelId: 'slack:synthetic-channel', present: false }, assertTargetCurrent() {}, mutate: async (_current, admission) => {
      if (!admission) throw new Error('Native fixture proof missing'); captured = admission;
      expect(readNativeMutationAdmission(admission, invocation).method).toBe('channels.routing.assign');
      expect(() => readNativeMutationAdmission({ ...admission }, invocation)).toThrow('Unknown');
      expect(() => readNativeMutationAdmission(admission, {})).toThrow('Unknown');
      expect(Object.isFrozen(readNativeMutationAdmission(admission, invocation))).toBe(true);
    } });
  if (!captured) throw new Error('Native fixture proof missing');
  const retired = captured;
  expect(() => readNativeMutationAdmission(retired, invocation)).toThrow('Unknown');
});
