import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { SettingsImportPreconditionFacts, SettingsImportPreconditionReceipt } from '@goodvibes-jev/engine/daemon-sdk';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { daemonSecretKeyFor } from '../sdk/src/platform/config/daemon-secret-keys.js';
import { isDaemonOwnedConfigKey } from '../sdk/src/platform/config/config-ownership.js';
import { createPermissionConfigReader, PermissionManager } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { DaemonHttpRouter } from '../sdk/src/platform/daemon/http/router.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { decryptStore } from '../sdk/src/platform/config/secrets-keyfile.js';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';

const cleanup: Array<() => void | Promise<void>> = [];
let log: SqliteDecisionLog, port: JudgmentPort, previous: ReturnType<typeof installJudgmentPort>;
let requests: JudgmentRequest<Questions>[];
let outcome: 'act' | 'reject' | 'confirm';
let beforeRead: ((request: JudgmentRequest<Questions>) => void | Promise<void>) | undefined;
beforeEach(() => {
  forgetGateReadings(); requests = []; outcome = 'act'; beforeRead = undefined;
  log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort(), semantic = fakePort((_name, question) => choiceAnswer(question,
    outcome === 'act' && question.type === 'choice' && !Object.hasOwn(question.criteria, 'act') ? 'reject' : outcome, 0.99));
  port = withDecisionLog({ model: gate.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.(); requests.push(request); await beforeRead?.(request);
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  previous = installJudgmentPort(port);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
});
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function destinations(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => object(item) && typeof item.path === 'string'
    && ['set', 'remove'].includes(String(item.operation)) && typeof item.tier === 'string');
}
function isFacts(value: unknown): value is SettingsImportPreconditionFacts {
  if (!object(value) || value.operation !== 'import' || typeof value.incarnation !== 'number' || !Number.isInteger(value.incarnation) || !destinations(value.destinations)
    || !Array.isArray(value.effects) || !value.effects.every(effect => object(effect) && effect.operation === 'set'
      && typeof effect.key === 'string' && Object.hasOwn(effect, 'value') && destinations(effect.destinations))) return false;
  return !Object.hasOwn(value, 'credential') || object(value.credential) && destinations(value.credential.destinations)
    && Array.isArray(value.credential.items) && value.credential.items.every(item => object(item) && typeof item.key === 'string'
      && ['daemon', 'user'].includes(String(item.scope)) && typeof item.configured === 'boolean');
}
function isReceipt(value: unknown): value is SettingsImportPreconditionReceipt {
  return object(value) && ['committed', 'partial', 'unknown'].includes(String(value.status)) && Array.isArray(value.completedPaths)
    && value.completedPaths.every(path => typeof path === 'string')
    && (!Object.hasOwn(value, 'uncertainPath') || typeof value.uncertainPath === 'string')
    && (!Object.hasOwn(value, 'verifiedInOwningStore') || typeof value.verifiedInOwningStore === 'boolean');
}
function readWireArm(body: unknown): Record<string, unknown> {
  if (!object(body) || !object(body.settingsImportPrecondition) || body.settingsImportPrecondition.version !== 1
    || typeof body.settingsImportPrecondition.reference !== 'string') throw new Error('Invalid native fixture response');
  return body.settingsImportPrecondition;
}
const key = 'surfaces.telegram.botToken', secretKey = daemonSecretKeyFor(key), privateValue = 'synthetic-private-import-value';
function fixture(policy: 'plaintext_allowed' | 'require_secure' = 'plaintext_allowed', scopes?: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'native-settings-import-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), project = join(root, 'project'), daemon = join(root, 'daemon');
  for (const path of [home, project, daemon]) mkdirSync(path, { recursive: true });
  const config = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(daemon, 'settings.json') });
  const secrets = new SecretsManager({ projectRoot: project, globalHome: home, daemonHome: daemon, surfaceRoot: 'daemon', policy });
  const pairing = new PairingTokenManager(join(root, 'pairing.json')), paired = pairing.mint({ name: 'Synthetic native import' });
  const users = new UserAuthManager({ users: [{ username: 'fixture', passwordHash: 'unused', roles: ['admin'] }],
    bootstrapFilePath: join(root, 'unused.json'), bootstrapCredentialPath: join(root, 'unused.txt') });
  let lifetime: object | null = {};
  const catalog = new GatewayMethodCatalog();
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, authToken: () => 'synthetic-shared', pairingTokens: pairing, userAuth: users,
    settingsLifetime: () => lifetime } as unknown as DaemonControlPlaneContext);
  const hostLifetime = new AbortController(); let humans = 0;
  const manager = new PermissionManager(async () => { humans++; throw new Error('No human fallback'); }, createPermissionConfigReader(config), new PolicyRuntimeState());
  const nativeMutationHost = { permissionManager: manager, port, workspaceTrust: null, workspaceRoot: project,
    signal: hostLifetime.signal, config };
  const authority = { settingsLifetime: () => lifetime, captureSettingsAdminAuthority: helper.captureSettingsAdminAuthority.bind(helper),
    withSettingsAdminAuthority: helper.withSettingsAdminAuthority.bind(helper),
    captureNativeExecutionAuthority: (req: Request) => helper.createNativeExecutionAuthority(helper.extractAuthToken(req), scopes),
    extractAuthToken: helper.extractAuthToken.bind(helper), requireAdmin: helper.requireAdmin.bind(helper) };
  const context = { configManager: config, settingsImportAuthority: authority, nativeMutationHost, secretsManager: secrets, runtimeStore: null,
    userAuth: users, authToken: () => 'synthetic-shared', requireAdmin: authority.requireAdmin,
    requireAuthenticatedSession: () => null, extractAuthToken: authority.extractAuthToken, describeAuthenticatedPrincipal: () => null,
    controlPlaneGateway: { recordApiRequest() {} }, swapManager: null };
  const router = new DaemonHttpRouter(context as never); cleanup.push(() => router.dispose());
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => await router.dispatchApiRoutes(req) ?? new Response(null, { status: 404 }) });
  cleanup.push(() => server.stop(true));
  const post = async (arm: object, token = paired.token) => {
    const response = await fetch(`${server.url.origin}/config`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settingsImportPrecondition: { version: 1, ...arm } }) });
    const body: unknown = await response.json();
    return { response, body, capture() {
      const value = readWireArm(body);
      if (value.action !== 'captured' || typeof value.reference !== 'string' || !isFacts(value.facts)) throw new Error('Invalid native capture');
      return { reference: value.reference, facts: value.facts };
    }, applied() {
      const value = readWireArm(body);
      if (value.action !== 'applied' || !isReceipt(value.receipt)) throw new Error('Invalid native receipt');
      return { receipt: value.receipt };
    } };
  };
  const capture = (settings: readonly { key: string; value: unknown }[] = [{ key, value: privateValue }], token?: string) => post({ action: 'capture', settings }, token);
  const apply = (reference: string, token?: string) => post({ action: 'apply', reference }, token);
  return { root, home, project, daemon, config, secrets, pairing, paired, helper, authority, context, capture, apply, post,
    hostLifetime, humans: () => humans, restart: () => { lifetime = {}; } };
}
test.each(['plaintext_allowed', 'require_secure'] as const)('real HTTP %s bulk import records one complete native plan and durable private bytes', async policy => {
  const f = fixture(policy);
  const settings = f.config.getSchema().filter(setting => setting.type === 'boolean' && isDaemonOwnedConfigKey(setting.key)).slice(0, 18)
    .map(setting => ({ key: setting.key, value: !setting.default }));
  expect(settings).toHaveLength(18);
  const captured = await f.capture([...settings, { key, value: privateValue }]);
  expect(captured.response.status).toBe(200); expect(requests).toHaveLength(0);
  const facts = captured.capture().facts;
  expect(facts.effects).toHaveLength(19); expect(facts.credential!.items).toEqual([{ key: secretKey, scope: 'daemon', configured: true }]);
  expect(JSON.stringify(captured.body)).not.toContain(privateValue);
  const applied = await f.apply(captured.capture().reference);
  expect(applied.response.status).toBe(200); expect(applied.applied().receipt.status).toBe('committed');
  expect(applied.applied().receipt.verifiedInOwningStore).toBe(true);
  expect(applied.applied().receipt.completedPaths).toEqual(facts.destinations.map((destination: { path: string }) => destination.path));
  const path = facts.credential!.destinations.find((destination: { tier: string }) => destination.tier === 'daemon')!.path;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const values = policy === 'plaintext_allowed' ? parsed.secrets : JSON.parse(decryptStore(parsed,
    Buffer.from(readFileSync(facts.credential!.destinations.find((destination: { tier: string }) => destination.tier === 'keyfile')!.path, 'utf8').trim(), 'hex')));
  expect(values[secretKey]).toBe(privateValue); expect(f.config.get(key)).toBe(`goodvibes://secrets/goodvibes/${secretKey}`);
  for (const setting of settings) expect(f.config.get(setting.key)).toBe(setting.value);
  expect(f.humans()).toBe(0); expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(1);
  expect(JSON.stringify(requests)).not.toContain(privateValue); expect(JSON.stringify(requests)).not.toContain(f.paired.token);
  expect(JSON.stringify(log.query({}))).not.toContain(privateValue); expect(JSON.stringify(applied.body)).not.toContain(privateValue);
  expect((await f.apply(captured.capture().reference)).response.status).toBe(409);
});
test('shared tokens, copied authority fields and undeclared local keys cannot capture native imports', async () => {
  const f = fixture();
  expect((await f.capture(undefined, 'synthetic-shared')).response.status).toBe(409);
  expect((await f.post({ action: 'capture', settings: [{ key, value: privateValue }], confirm: true, explicitUserRequest: true })).response.status).toBe(400);
  expect((await f.capture([{ key: 'permissions.mode', value: 'auto' }])).response.status).toBe(409);
  expect(requests).toHaveLength(0); expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false); expect(f.config.get(key)).toBe('');
});
test.each(['reject', 'confirm', 'plan'] as const)('native %s import holds every config and credential effect', async decision => {
  const f = fixture(); if (decision === 'plan') f.config.set('permissions.mode', 'plan'); else outcome = decision;
  const captured = await f.capture(); expect(captured.response.status).toBe(200);
  expect((await f.apply(captured.capture().reference)).response.status).toBe(409);
  expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false); expect(f.config.get(key)).toBe(''); expect(f.humans()).toBe(0);
});
test.each(['cancel', 'revoke', 'config', 'restart', 'owner'] as const)('pending real native reading retains %s and publishes nothing', async kind => {
  const f = fixture(), captured = await f.capture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  beforeRead = async request => { if ('disposition' in request.questions) { entered.resolve(); await release.promise; } };
  const pending = f.apply(captured.capture().reference); await entered.promise;
  if (kind === 'cancel') f.hostLifetime.abort();
  if (kind === 'revoke') expect(f.pairing.revoke(f.paired.id)).toBe(true);
  if (kind === 'config') f.config.set('controlPlane.port', 43210);
  if (kind === 'restart') f.restart();
  if (kind === 'owner') f.context.secretsManager = new SecretsManager({ projectRoot: f.project, globalHome: f.home, daemonHome: f.daemon, surfaceRoot: 'daemon', policy: 'plaintext_allowed' });
  release.resolve(); expect((await pending).response.status).toBe(409);
  expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false); expect(f.config.get(key)).toBe('');
});
test('equal-byte config target physical replacement retires native import before publication', async () => {
  const f = fixture(); f.config.setDynamic('controlPlane.port', 43211);
  const captured = await f.capture(), path = f.config.getDaemonTierPath()!;
  const before = readFileSync(path), replacement = `${path}.replacement`; writeFileSync(replacement, before); renameSync(replacement, path);
  expect((await f.apply(captured.capture().reference)).response.status).toBe(409);
  expect(readFileSync(path)).toEqual(before); expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false);
});
test('revoke while the native credential lock waits is possible and fences both owners', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>();
  const original = f.secrets.withPreparedImport.bind(f.secrets);
  f.secrets.withPreparedImport = (handle, operation, current) => { entered.resolve(); return original(handle, operation, current); };
  const captured = await f.capture();
  const release = await acquireCrossProcessLock(`${join(f.daemon, 'secrets.json')}.mutation.lock`, { strictOwnership: true });
  try {
    const pending = f.apply(captured.capture().reference); await entered.promise;
    expect(f.pairing.revoke(f.paired.id)).toBe(true); release();
    expect((await pending).response.status).toBe(409); expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false); expect(f.config.get(key)).toBe('');
  } finally { release(); }
});
test('credential completion cancellation yields honest partial receipt and stops the config tail', async () => {
  const f = fixture(), captured = await f.capture(); f.secrets.onDidChange(() => f.hostLifetime.abort());
  const applied = await f.apply(captured.capture().reference);
  expect(applied.response.status).toBe(200); expect(applied.applied().receipt.status).toBe('partial');
  expect(applied.applied().receipt.completedPaths).toEqual([join(f.daemon, 'secrets.json')]);
  expect(JSON.parse(readFileSync(join(f.daemon, 'secrets.json'), 'utf8')).secrets[secretKey]).toBe(privateValue);
  expect(f.config.get(key)).toBe(''); expect((await f.apply(captured.capture().reference)).response.status).toBe(409);
});
test('literal credential duplicated into a public setting is withheld before any hosted reading', async () => {
  const f = fixture();
  const captured = await f.capture([{ key, value: privateValue }, { key: 'controlPlane.host', value: privateValue }]);
  expect(captured.response.status).toBe(409); expect(requests).toHaveLength(0);
  expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false); expect(JSON.stringify(captured.body)).not.toContain(privateValue);
});
test('malformed credential references and duplicate or out-of-scope settings never stage an import', async () => {
  const f = fixture();
  expect((await f.capture([{ key, value: 'goodvibes://unknown/private-value' }])).response.status).toBe(409);
  expect((await f.capture([{ key, value: privateValue }, { key, value: privateValue }])).response.status).toBe(409);
  expect(requests).toHaveLength(0); expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false);
});
test('another genuinely paired caller cannot consume the original import reference', async () => {
  const f = fixture(), captured = await f.capture(), other = f.pairing.mint({ name: 'Other synthetic paired caller' });
  expect((await f.apply(captured.capture().reference, other.token)).response.status).toBe(409);
  expect((await f.apply(captured.capture().reference)).response.status).toBe(409);
  expect(requests).toHaveLength(0); expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false);
});
test('native scope ceiling is enforced before the private reference is issued', async () => {
  const f = fixture('plaintext_allowed', ['read:status']);
  expect((await f.capture()).response.status).toBe(409); expect(requests).toHaveLength(0);
});
test('construction-owned native workspace replacement is stale even when config owners are unchanged', async () => {
  const f = fixture(), captured = await f.capture();
  renameSync(f.project, `${f.project}.original`); mkdirSync(f.project);
  expect((await f.apply(captured.capture().reference)).response.status).toBe(409);
  expect(existsSync(join(f.daemon, 'secrets.json'))).toBe(false); expect(f.config.get(key)).toBe('');
});
test('same-byte private credential store replacement is rejected before fresh admission', async () => {
  const f = fixture(), path = join(f.daemon, 'secrets.json');
  writeFileSync(path, JSON.stringify({ version: 1, secrets: { [secretKey]: 'private-original' } }));
  const captured = await f.capture(), before = readFileSync(path);
  writeFileSync(`${path}.replacement`, before); renameSync(`${path}.replacement`, path);
  expect((await f.apply(captured.capture().reference)).response.status).toBe(409);
  expect(requests).toHaveLength(0); expect(readFileSync(path)).toEqual(before); expect(f.config.get(key)).toBe('');
});
