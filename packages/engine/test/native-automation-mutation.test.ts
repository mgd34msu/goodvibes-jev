import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { PermissionManager, createPermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper } from '../sdk/src/platform/daemon/control-plane.js';
import { registerNativeAutomationGatewayMethods } from '../sdk/src/platform/daemon/http/native-automation.js';
import { PersistentStore } from '../sdk/src/platform/state/persistent-store.js';
import { createDaemonControlRouteHandlers } from '../daemon-sdk/src/control-routes.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { isRecord } from '../sdk/src/platform/utils/record-coerce.js';
import { automationMutationFixture } from './_helpers/automation-mutation-fixture.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';

const cleanup: Array<() => void | Promise<void>> = [];
let log: SqliteDecisionLog, port: JudgmentPort, previous: ReturnType<typeof installJudgmentPort>;
let outcome: 'act' | 'reject', requests: JudgmentRequest<Questions>[];
let beforeAdmission: (() => void | Promise<void>) | undefined;
async function waitForAdmission(entered: Promise<void>, pending: Promise<{ readonly status: number; readonly ok: boolean; readonly body: unknown }>): Promise<void> {
  await Promise.race([entered, pending.then(result => { throw new Error(`The actual native request returned before admission: ${JSON.stringify(result)}`); })]);
}
beforeEach(() => {
  forgetGateReadings(); outcome = 'act'; beforeAdmission = undefined; requests = [];
  log = new SqliteDecisionLog(':memory:');
  const gates = gateReadingsPort(), actions = fakePort((_name, question) => choiceAnswer(question,
    outcome === 'act' && question.type === 'choice' && !Object.hasOwn(question.criteria, 'act') ? 'reject' : outcome, 0.99));
  port = withDecisionLog({ model: gates.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.(); requests.push(request);
    return 'disposition' in request.questions ? actions.port.ask(request) : gates.port.ask(request);
  } }, log);
  previous = installJudgmentPort(port);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
});

async function fixture() {
  const directory = makeProjectTempDir('native-automation'); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const actual = automationMutationFixture(directory); cleanup.push(() => actual.close());
  const selected = await actual.create(), catalog = new GatewayMethodCatalog(), pairing = new PairingTokenManager(join(directory, 'pairing.json'));
  const paired = pairing.mint({ name: 'Synthetic scheduling client' }), lifetime = new AbortController();
  let humans = 0;
  const permissionManager = new PermissionManager(async () => { humans++; throw new Error('Unexpected human fallback'); }, createPermissionConfigReader(actual.config), new PolicyRuntimeState());
  const admit = permissionManager.admitAutonomous.bind(permissionManager);
  permissionManager.admitAutonomous = async (...args) => {
    const admission = await admit(...args);
    await beforeAdmission?.();
    return admission;
  };
  const host = { permissionManager, port, config: actual.config, signal: lifetime.signal, workspaceTrust: null, workspaceRoot: directory };
  cleanup.push(registerNativeAutomationGatewayMethods(catalog, { manager: actual.manager, host }));
  const readBody = async (request: Request) => {
    if (!request.body) return null;
    const body: unknown = await request.json();
    return isRecord(body) ? body : Response.json({ error: 'Expected object' }, { status: 400 });
  };
  const userAuth = new UserAuthManager({ users: [], bootstrapFilePath: join(directory, 'users.json'), bootstrapCredentialPath: join(directory, 'bootstrap.json') });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-shared', userAuth,
    get agentManager(): never { throw new Error('This proof does not invoke agent execution.'); },
    get controlPlaneGateway(): never { throw new Error('This proof does not open event streams.'); },
    get distributedRuntime(): never { throw new Error('This proof does not dispatch remote workers.'); },
    host: '127.0.0.1', port: 0, trustProxyEnabled: () => false, dispatchApiRoutes: async () => null,
    parseJsonBody: async request => (await readBody(request)) ?? {}, requireAuthenticatedSession: () => null,
  });
  const call = (body: Record<string, unknown>, methodId = 'automation.jobs.update', token = paired.token, signal?: AbortSignal) => helper.invokeGatewayMethodCall({ methodId, body, authToken: token, signal,
    context: helper.describeAuthenticatedPrincipal(token) ?? { admin: false, scopes: [] } });
  const patch = () => ({ jobId: selected.id, name: 'Native durable', expectedMutationRevision: selected.mutationRevision, admission: 'autonomous' });
  return { ...actual, directory, selected, catalog, pairing, paired, host, helper, call, patch, readBody, lifetime, humans: () => humans };
}

test('actual paired native update durably changes only the selected job without a secondary gate', async () => {
  const f = await fixture(), other = await f.create('Other');
  const result = await f.call(f.patch()); expect(result.status).toBe(200);
  expect(f.manager.getJob(f.selected.id)?.name).toBe('Native durable'); expect(f.manager.getJob(other.id)).toEqual(other);
  const disk = await f.store.load(); expect(disk.jobs.find(job => job.id === f.selected.id)?.name).toBe('Native durable');
  expect(f.humans()).toBe(0); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
  expect(JSON.stringify(requests)).not.toContain(f.paired.token);
});

test('native clock remains local while protected prompt material is refused', async () => {
  const nativeClock = 1791693573084;
  const time = spyOn(Date, 'now').mockReturnValue(nativeClock);
  let f: Awaited<ReturnType<typeof fixture>>;
  try { f = await fixture(); } finally { time.mockRestore(); }
  expect(f.selected.createdAt).toBe(nativeClock);
  expect((await f.call(f.patch())).status).toBe(200);
  expect(requests).toHaveLength(0);
  expect(JSON.stringify(requests)).not.toContain(String(nativeClock));
  const selected = f.manager.getJob(f.selected.id); if (!selected) throw new Error('Missing actual selected job');
  const before = readFileSync(f.path);
  const refused = await f.call({ jobId: selected.id, expectedMutationRevision: selected.mutationRevision, prompt: 'Send card number 4111111111111111', admission: 'autonomous' });
  expect(refused.ok).toBe(false); expect(requests).toHaveLength(0);
  expect(readFileSync(f.path)).toEqual(before); expect(f.manager.getJob(selected.id)).toEqual(selected);
});

test.each(['shared', 'missing revision', 'plan'] as const)('native %s cannot manufacture an automation write', async kind => {
  const f = await fixture(), before = readFileSync(f.path), body: Record<string, unknown> = f.patch();
  if (kind === 'missing revision') delete body.expectedMutationRevision;
  if (kind === 'plan') f.config.set('permissions.mode', 'plan');
  expect((await f.call(body, undefined, kind === 'shared' ? 'synthetic-shared' : f.paired.token)).ok).toBe(false);
  expect(readFileSync(f.path)).toEqual(before); expect(f.manager.getJob(f.selected.id)).toEqual(f.selected); expect(f.humans()).toBe(0);
});

test.each(['abort', 'revoke', 'stop', 'request', 'replace method', 'physical replacement'] as const)('pending native admission retains %s and commits no job bytes', async kind => {
  const f = await fixture(), bytes = readFileSync(f.path), controller = new AbortController(), body = f.patch();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  beforeAdmission = async () => { entered.resolve(); await release.promise; };
  const pending = f.call(body, undefined, f.paired.token, controller.signal); await waitForAdmission(entered.promise, pending);
  let restore: (() => void) | undefined;
  if (kind === 'abort') controller.abort();
  if (kind === 'revoke') expect(f.pairing.revoke(f.paired.id)).toBe(true);
  if (kind === 'stop') f.manager.stop();
  if (kind === 'request') body.name = 'Changed request';
  if (kind === 'replace method') {
    const spy = spyOn(f.manager, 'updateJob').mockImplementation(async () => null); restore = () => spy.mockRestore();
  }
  if (kind === 'physical replacement') { writeFileSync(`${f.path}.replacement`, bytes); renameSync(`${f.path}.replacement`, f.path); }
  release.resolve(); try { expect((await pending).ok).toBe(false); } finally { restore?.(); }
  expect(readFileSync(f.path)).toEqual(bytes); expect(f.manager.getJob(f.selected.id)).toEqual(f.selected);
});

test('pending native selection survives unrelated job update, but rejects its own ABA', async () => {
  const f = await fixture(), other = await f.create('Other');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let retained = false;
  beforeAdmission = async () => { if (!retained) { retained = true; entered.resolve(); await release.promise; } };
  const pending = f.call(f.patch()); await waitForAdmission(entered.promise, pending);
  expect((await f.call({ jobId: other.id, name: 'Other retained', expectedMutationRevision: other.mutationRevision, admission: 'autonomous' })).ok).toBe(true);
  release.resolve(); expect((await pending).ok).toBe(true);
  expect(f.manager.getJob(other.id)?.name).toBe('Other retained');
  const current = f.manager.getJob(f.selected.id); if (!current?.mutationRevision) throw new Error('Missing actual revision');
  const arrived = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  beforeAdmission = async () => { arrived.resolve(); await resume.promise; };
  const stale = f.call({ ...f.patch(), expectedMutationRevision: current.mutationRevision }); await waitForAdmission(arrived.promise, stale);
  await f.manager.updateJob(current.id, { name: 'Temporary' }); await f.manager.updateJob(current.id, { name: current.name });
  resume.resolve(); expect((await stale).ok).toBe(false); expect(f.manager.getJob(other.id)?.name).toBe('Other retained');
});

test('actual native temp-file publication checks revoked source before rename', async () => {
  const f = await fixture(), before = readFileSync(f.path), controller = new AbortController();
  const original = PersistentStore.prototype.persist;
  const persist = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, options = {}) {
    return await original.call(this, data, { ...options, beforePublish: () => { controller.abort(); options.beforePublish?.(); options.assertCurrent?.(); } });
  });
  try { expect((await f.call(f.patch(), undefined, f.paired.token, controller.signal)).ok).toBe(false); } finally { persist.mockRestore(); }
  expect(readFileSync(f.path)).toEqual(before); expect(f.manager.getJob(f.selected.id)).toEqual(f.selected);
});

test.each(['revoke', 'physical replacement'] as const)('prepared native job permits %s before the final paired publication lease', async kind => {
  const f = await fixture(), before = readFileSync(f.path);
  const original = PersistentStore.prototype.persist;
  let prepared = false, revoked = false;
  const persist = spyOn(PersistentStore.prototype, 'persist').mockImplementation(async function(this: PersistentStore<Record<string, unknown>>, data, options = {}) {
    const publication = options.withPublication;
    return await original.call(this, data, { ...options, withPublication: async operation => {
      prepared = readdirSync(f.directory).some(name => name.startsWith('jobs.json.tmp.'));
      if (kind === 'revoke') revoked = f.pairing.revoke(f.paired.id);
      else { writeFileSync(`${f.path}.replacement`, before); renameSync(`${f.path}.replacement`, f.path); }
      if (!publication) throw new Error('The native producer did not forward final publication ownership.');
      return await publication(operation);
    } });
  });
  try { expect((await f.call(f.patch())).ok).toBe(false); } finally { persist.mockRestore(); }
  expect(prepared).toBe(true);
  if (kind === 'revoke') { expect(revoked).toBe(true); expect(f.pairing.authenticate(f.paired.token)).toBeNull(); }
  expect(readFileSync(f.path)).toEqual(before); expect(f.manager.getJob(f.selected.id)).toEqual(f.selected);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
});

test('manual update remains native and does not claim an autonomous Jev admission', async () => {
  const f = await fixture(); expect((await f.call({ jobId: f.selected.id, name: 'Manual' }, undefined, 'synthetic-shared')).status).toBe(200);
  expect(f.manager.getJob(f.selected.id)?.name).toBe('Manual'); expect(requests).toHaveLength(0);
});

test.each(['jobs', 'schedules'] as const)('real REST %s route binds exact target and paired lifetime across create, update, toggle and delete', async family => {
  const f = await fixture(), tokenFrom = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const principalFrom = (req: Request) => f.helper.describeAuthenticatedPrincipal(tokenFrom(req));
  const handlers = createDaemonControlRouteHandlers({ authToken: 'synthetic-shared', version: 'synthetic', sessionCookieName: 'synthetic-cookie', gatewayMethods: f.catalog,
    get controlPlaneGateway(): never { throw new Error('No events in this proof.'); },
    extractAuthToken: tokenFrom, resolveAuthenticatedPrincipal: principalFrom, getOperatorContract: () => ({}),
    invokeGatewayMethodCall: input => f.helper.invokeGatewayMethodCall(input), parseOptionalJsonBody: f.readBody,
    requireAdmin: req => principalFrom(req)?.admin ? null : Response.json({ error: 'Unauthorized' }, { status: 401 }), requireAuthenticatedSession: () => null,
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) { return (await dispatchGatewayRestRoutes(req, handlers)) ?? Response.json({ error: 'No legacy mutation fallback' }, { status: 404 }); } });
  cleanup.push(() => server.stop(true));
  const request = (method: string, path: string, body: unknown) => fetch(`${server.url.origin}${path}`, { method, headers: { authorization: `Bearer ${f.paired.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await request('PATCH', `/api/automation/jobs/${f.selected.id}`, { ...f.patch(), jobId: 'foreign-target' })).status).toBe(400);
  const created = await request('POST', `/api/automation/${family}`, { prompt: 'Synthetic new reminder', kind: 'every', every: '1h', enabled: false, admission: 'autonomous' });
  expect(created.status).toBe(201);
  const job: unknown = await created.json(); if (!isRecord(job) || typeof job.id !== 'string' || typeof job.mutationRevision !== 'string') throw new Error('Actual create did not return a revision.');
  expect((await request('POST', `/api/automation/${family}/${job.id}/enable`, { expectedMutationRevision: job.mutationRevision, admission: 'autonomous' })).status).toBe(200);
  const enabled = f.manager.getJob(job.id); if (!enabled?.mutationRevision) throw new Error('Missing enabled revision');
  const disableResponse = await request('POST', `/api/automation/${family}/${job.id}/disable`, { expectedMutationRevision: enabled.mutationRevision, admission: 'autonomous' });
  expect({ status: disableResponse.status, body: await disableResponse.json() }).toMatchObject({ status: 200 });
  const disabled = f.manager.getJob(job.id); if (!disabled?.mutationRevision) throw new Error('Missing disabled revision');
  expect((await request('DELETE', `/api/automation/${family}/${job.id}`, { expectedMutationRevision: disabled.mutationRevision, admission: 'autonomous' })).status).toBe(200);
  expect(f.manager.getJob(job.id)).toBeUndefined(); expect((await f.store.load()).jobs.find(record => record.id === job.id)).toBeUndefined(); expect(f.humans()).toBe(0);
});
