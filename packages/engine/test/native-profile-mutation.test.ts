import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { createPermissionConfigReader, PermissionManager } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { OwnerProfileStore } from '../sdk/src/platform/owner-profile/store.js';
import { registerOwnerProfileGatewayMethods } from '../sdk/src/platform/control-plane/routes/owner-profile.js';
import { composeOccasions } from '../sdk/src/platform/control-plane/routes/occasions-composition.js';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';
import { createDaemonControlRouteHandlers } from '../daemon-sdk/src/control-routes.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import { runDeliveryPublication } from '../sdk/src/platform/utils/delivery-lifetime.js';

const cleanup: Array<() => void | Promise<void>> = [];
let log: SqliteDecisionLog, port: JudgmentPort, prior: ReturnType<typeof installJudgmentPort>;
let beforeRead: ((request: JudgmentRequest<Questions>) => void | Promise<void>) | undefined;
let requests: JudgmentRequest<Questions>[];
beforeEach(() => {
  forgetGateReadings(); beforeRead = undefined; requests = []; log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort(), semantic = fakePort((_name, question) => choiceAnswer(question,
    question.type === 'choice' && !Object.hasOwn(question.criteria, 'act') ? 'reject' : 'act', 0.99));
  const occasionPort = fakePort((name, question) => name === 'subject' ? choiceAnswer(question, 'other', 0.99)
    : name === 'pick' ? choiceAnswer(question, 'line_0', 0.99) : noulAnswer(name === 'fits_0' ? 0.99 : 0.01));
  port = withDecisionLog({ model: gate.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.(); requests.push(request); await beforeRead?.(request);
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions ? semantic.port.ask(request)
      : request.context?.battery?.startsWith('engine.occasions.') ? occasionPort.port.ask(request) : gate.port.ask(request);
  } }, log); prior = installJudgmentPort(port);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  installJudgmentPort(prior); log[Symbol.dispose](); forgetGateReadings();
});

function fixture(channelDeliveryRouter?: Parameters<typeof composeOccasions>[1]['channelDeliveryRouter']) {
  const directory = mkdtempSync(join(tmpdir(), 'gv-native-profile-')), profilePath = join(directory, 'profile.md');
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(profilePath, '# Profile\n\n## Identity\n- Name: Synthetic owner\n');
  const config = new ConfigManager({ workingDir: directory, homeDir: directory, surfaceRoot: 'test-native-profile' });
  const lifetime = new AbortController(), invalidations = new Set<() => void>();
  let humans = 0;
  const manager = new PermissionManager(async () => { humans++; throw new Error('No human fallback'); }, createPermissionConfigReader(config), new PolicyRuntimeState());
  const host = { permissionManager: manager, port, workspaceTrust: null, workspaceRoot: directory, signal: lifetime.signal,
    config: { onDidInvalidate(listener: () => void) { invalidations.add(listener); return () => { invalidations.delete(listener); }; } } };
  const profile = new OwnerProfileStore({ path: profilePath }); profile.loadSync();
  const catalog = new GatewayMethodCatalog(), pairing = new PairingTokenManager(join(directory, 'pairing.json')), paired = pairing.mint({ name: 'Synthetic native profile' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-shared',
    userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
  registerOwnerProfileGatewayMethods(catalog, profile, undefined, { host, target: Object.freeze({ profilePath,
    captureProfileRead: () => profile.captureRead(), assertOwnerCurrent() {} }) });
  const occasions = composeOccasions(catalog, { ownerProfile: profile, configManager: config, statePath: join(directory, 'occasions.json'), nativeMutationHost: host,
    ...(channelDeliveryRouter ? { channelDeliveryRouter } : {}) });
  cleanup.push(() => occasions.dispose());
  const call = (methodId: string, body: Record<string, unknown>, token = paired.token, signal?: AbortSignal) => helper.invokeGatewayMethodCall({ methodId, body, authToken: token, signal,
    context: helper.describeAuthenticatedPrincipal(token) ?? { admin: false, scopes: [] } });
  return { directory, profilePath, profile, occasions, config, catalog, pairing, paired, helper, call, humans: () => humans };
}
const set = () => ({ fieldId: 'identity.name', value: 'Synthetic corrected owner', surface: 'agent', said: '', authority: 'autonomous', admission: 'autonomous' });
const occasion = () => ({ title: 'Synthetic anniversary', date: '10-20', kind: 'remember-only', surface: 'agent', said: '', authority: 'autonomous', admission: 'autonomous' });

async function prepareDueNudge(f: ReturnType<typeof fixture>): Promise<void> {
  f.config.set('daemon.timezone', 'UTC'); f.config.set('occasions.activeHours', '00:00-00:00');
  f.config.set('occasions.nudgeChannel', 'ntfy:synthetic-native-destination');
  const result = await f.call('occasions.confirm', { ...occasion(), date: new Date().toISOString().slice(5, 10) });
  expect(result.body).toMatchObject({ ok: true });
}

test('native sweep records a separate complete send decision before guarded actual delivery', async () => {
  let sends = 0, received: unknown;
  const sink = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    received = await request.json(); sends++; return Response.json({ responseId: 'synthetic-landed' });
  } }); cleanup.push(() => sink.stop(true));
  const router = new ChannelDeliveryRouter({ strategies: [{ id: 'synthetic-native-nudge', supportsGuardedDelivery: true, supportsPublication: true,
    canHandle: () => true, async deliver(request) {
      await Promise.resolve();
      return runDeliveryPublication(request, async current => {
        current(); const response = await fetch(sink.url, { method: 'POST', body: JSON.stringify({ body: request.body, title: request.title }) });
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object' || !('responseId' in result) || typeof result.responseId !== 'string') throw new Error('Synthetic sink receipt missing');
        return { responseId: result.responseId };
      });
    } }] });
  const f = fixture(router); await prepareDueNudge(f);
  const principal = f.helper.describeAuthenticatedPrincipal(f.paired.token);
  if (!principal) throw new Error('Fixture pairing missing');
  const result = await f.catalog.invoke('occasions.sweep', { body: { admission: 'autonomous' }, context: principal,
    nativeExecutionAuthority: f.helper.createNativeExecutionAuthority(f.paired.token, principal.scopes) ?? undefined,
    isAuthorized: scopes => Boolean(f.helper.describeAuthenticatedPrincipal(f.paired.token)?.admin && scopes?.every(scope => principal.scopes.includes(scope))) });
  expect(result).toMatchObject({ delivered: true }); expect(sends).toBe(1); expect(f.humans()).toBe(0);
  expect(JSON.stringify(received)).toContain('Synthetic anniversary');
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(3);
  const delivery = requests.find(request => JSON.stringify(request).includes('occasions.sweep.deliver'));
  expect(delivery).toBeDefined();
  expect(JSON.stringify(delivery)).toContain('synthetic-native-destination');
  expect(JSON.stringify(delivery)).toContain('Synthetic anniversary');
});

test('accepted native delivery followed by source retirement returns only an exact partial fact', async () => {
  let sends = 0, retire: (() => void) | undefined;
  const router = new ChannelDeliveryRouter({ strategies: [{ id: 'synthetic-native-nudge', supportsGuardedDelivery: true, supportsPublication: true,
    canHandle: () => true, async deliver(request) {
      return runDeliveryPublication(request, current => { current(); sends++; retire?.(); return { responseId: 'synthetic-already-landed' }; });
    } }] });
  const f = fixture(router); await prepareDueNudge(f);
  f.config.set('occasions.nudgeChannel', 'ntfy:first-native-destination,ntfy:second-native-destination');
  retire = () => f.config.set('permissions.mode', 'plan');
  const result = await f.call('occasions.sweep', { admission: 'autonomous' });
  expect(result.body).toEqual({ complete: false, acceptedDeliveries: 1, stopped: 'request-retired-after-delivery' });
  expect(sends).toBe(1); expect(f.humans()).toBe(0);
  expect(JSON.stringify(result.body)).not.toContain('Synthetic anniversary');
  expect(JSON.stringify(result.body)).not.toContain('first-native-destination');
});

test('owner revocation during the fresh native sweep send reading commits no delivery', async () => {
  let sends = 0, entered = false;
  const router = new ChannelDeliveryRouter({ strategies: [{ id: 'synthetic-native-nudge', supportsGuardedDelivery: true,
    canHandle: () => true, async deliver(request) { request.assertCurrent?.(); sends++; return {}; } }] });
  const f = fixture(router); await prepareDueNudge(f);
  beforeRead = request => {
    if ('disposition' in request.questions && JSON.stringify(request).includes('occasions.sweep.deliver')) {
      entered = true;
      expect(f.pairing.revoke(f.paired.id)).toBe(true);
    }
  };
  expect((await f.call('occasions.sweep', { admission: 'autonomous' })).ok).toBe(false);
  expect(entered).toBe(true); expect(sends).toBe(0); expect(f.humans()).toBe(0);
});

test('native profile original dispatch retains genuine paired owner', async () => {
  const f = fixture(), principal = f.helper.describeAuthenticatedPrincipal(f.paired.token);
  if (!principal) throw new Error('Fixture pairing missing');
  const result = await f.catalog.invoke('profile.set', { body: set(), context: principal,
    nativeExecutionAuthority: f.helper.createNativeExecutionAuthority(f.paired.token, principal.scopes) ?? undefined,
    isAuthorized: scopes => {
      const current = f.helper.describeAuthenticatedPrincipal(f.paired.token);
      return Boolean(current?.admin && scopes?.every(scope => current.scopes.includes(scope) || current.scopes.includes('*')));
    } });
  expect(result).toMatchObject({ ok: true });
});

test('actual native profile and occasion writes record autonomous origin without inventing human words', async () => {
  const f = fixture(); const result = await f.call('profile.set', set()); expect(result).toMatchObject({ ok: true });
  expect(f.profile.get('identity.name')?.value).toBe('Synthetic corrected owner');
  expect(f.profile.get('identity.name')?.provenance).toMatchObject({ origin: 'autonomous', said: '', surface: 'agent' });
  const recorded = await f.call('occasions.confirm', occasion()); expect(recorded.ok).toBe(true);
  expect(readFileSync(f.profilePath, 'utf8')).toContain('Synthetic anniversary');
  expect(f.humans()).toBe(0); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(2);
  expect(JSON.stringify(requests)).not.toContain(f.paired.token);
});

test('raw autonomous flags, shared auth, and claimed human provenance cannot replace native proof', async () => {
  const f = fixture(), bytes = readFileSync(f.profilePath);
  expect((await f.call('profile.set', set(), 'synthetic-shared')).status).toBe(403);
  expect((await f.call('profile.set', { ...set(), admission: undefined })).ok).toBe(false);
  expect((await f.call('profile.set', { ...set(), authority: 'owner-direct', said: 'invented human quote' })).status).toBe(400);
  expect(readFileSync(f.profilePath)).toEqual(bytes); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('native occasion state effects and removal retain their actual durable target', async () => {
  const f = fixture();
  const confirmation = await f.call('occasions.confirm', occasion()); expect(confirmation.body).toMatchObject({ ok: true });
  if (!confirmation.body || typeof confirmation.body !== 'object' || !('occasionId' in confirmation.body) || typeof confirmation.body.occasionId !== 'string') throw new Error('Fixture occasion missing');
  const occasionId = confirmation.body.occasionId;
  const answer = await f.call('occasions.answer', { occasionId, answer: 'no', occurrence: '2026-10-20', admission: 'autonomous' });
  expect(answer.body).toMatchObject({ ok: true });
  expect(await f.occasions.state.acknowledgements()).toHaveLength(1);
  const removed = await f.call('occasions.remove', { occasionId, confirmed: true, authority: 'autonomous', admission: 'autonomous' });
  expect(removed.body).toMatchObject({ ok: true }); expect(await f.occasions.state.acknowledgements()).toHaveLength(0);
  expect(readFileSync(f.profilePath, 'utf8')).not.toContain('Synthetic anniversary');
  expect(f.humans()).toBe(0); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(3);
});

for (const kind of ['abort', 'revoke', 'request', 'physical', 'parent ABA', 'ABA', 'plan'] as const) test(`native profile ${kind} before grant preserves exact owner file`, async () => {
  const f = fixture(), body = set(), controller = new AbortController(), before = readFileSync(f.profilePath);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  beforeRead = async request => { if ('disposition' in request.questions) { entered.resolve(); await release.promise; } };
  const pending = f.call('profile.set', body, f.paired.token, controller.signal); await entered.promise;
  if (kind === 'abort') controller.abort();
  if (kind === 'revoke') expect(f.pairing.revoke(f.paired.id)).toBe(true);
  if (kind === 'request') body.value = 'Changed after preparation';
  if (kind === 'physical') { const replacement = `${f.profilePath}.replacement`; writeFileSync(replacement, before); renameSync(replacement, f.profilePath); }
  if (kind === 'parent ABA') { const displaced = `${f.directory}.displaced`; renameSync(f.directory, displaced); renameSync(displaced, f.directory); }
  if (kind === 'ABA') { f.profile.loadSync(); f.profile.loadSync(); }
  if (kind === 'plan') f.config.set('permissions.mode', 'plan');
  release.resolve(); expect((await pending).ok).toBe(false); expect(readFileSync(f.profilePath)).toEqual(before);
});

test('actual profile REST bytes require paired native proof and carry truthful provenance', async () => {
  const f = fixture(), tokenFrom = (request: Request) => request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const principalFrom = (request: Request) => f.helper.describeAuthenticatedPrincipal(tokenFrom(request));
  const handlers = createDaemonControlRouteHandlers({ gatewayMethods: f.catalog, extractAuthToken: tokenFrom, resolveAuthenticatedPrincipal: principalFrom,
    requireAdmin: (request: Request) => { const principal = principalFrom(request); return principal?.admin ? null : Response.json({ error: 'Unauthorized' }, { status: principal ? 403 : 401 }); },
    parseOptionalJsonBody: (request: Request) => request.json(), invokeGatewayMethodCall: (input: Parameters<typeof f.helper.invokeGatewayMethodCall>[0]) => f.helper.invokeGatewayMethodCall(input),
  } as unknown as Parameters<typeof createDaemonControlRouteHandlers>[0]);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    return await dispatchGatewayRestRoutes(request, handlers) ?? Response.json({ error: 'not found' }, { status: 404 });
  } }); cleanup.push(() => server.stop(true));
  const post = (token: string) => fetch(`http://127.0.0.1:${server.port}/api/profile/set`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(set()) });
  expect((await post('')).status).toBe(401); expect((await post('synthetic-shared')).status).toBe(403);
  const response = await post(f.paired.token); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true });
  expect(f.profile.get('identity.name')?.provenance).toMatchObject({ origin: 'autonomous', said: '' }); expect(f.humans()).toBe(0);
});
