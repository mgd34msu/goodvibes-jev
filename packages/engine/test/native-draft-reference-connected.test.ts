import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { createDaemonCredentialStore, createAtRestCipher } from '../sdk/src/platform/config/daemon-credential-store.js';
import { createPermissionConfigReader, PermissionManager } from '../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { registerDraftMethods } from '../sdk/src/platform/channels/host-drafts/register.js';
import { DraftSyncStore } from '../sdk/src/platform/channels/host-drafts/draft-store.js';
import { channelDraftWireReference } from '../sdk/src/platform/channels/host-drafts/wire-reference.js';
import { createDaemonControlRouteHandlers } from '../daemon-sdk/src/control-routes.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';

const LEGACY_ID = 'draft-20261011000001-deadbeef';
const ORIGINAL_BODY = 'Captured original native draft body';
const cleanup: Array<() => void | Promise<void>> = [];
let log: SqliteDecisionLog;
let previous: ReturnType<typeof installJudgmentPort>;
let port: JudgmentPort;
let beforeRead: ((request: JudgmentRequest<Questions>) => void | Promise<void>) | undefined;
let requests: JudgmentRequest<Questions>[];

beforeEach(() => {
  forgetGateReadings(); beforeRead = undefined; requests = [];
  log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort();
  const semantic = fakePort((_name, question) => choiceAnswer(question,
    question.type === 'choice' && Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject', 0.99));
  port = withDecisionLog({ model: gate.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    requests.push(request); await beforeRead?.(request);
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  previous = installJudgmentPort(port);
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
});

async function fixture(message = ORIGINAL_BODY) {
  const directory = mkdtempSync(join(tmpdir(), 'gv-native-reference-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const config = new ConfigManager({ workingDir: directory, homeDir: directory, surfaceRoot: 'test-native-reference' });
  const secrets = new SecretsManager({ projectRoot: directory, globalHome: directory, daemonHome: join(directory, 'daemon'), surfaceRoot: 'test-native-reference' });
  const credentials = createDaemonCredentialStore(secrets), cipher = createAtRestCipher(credentials);
  const lifetime = new AbortController(), invalidations = new Set<() => void>();
  let humans = 0;
  const manager = new PermissionManager(async () => { humans += 1; throw new Error('No human fallback'); }, createPermissionConfigReader(config), new PolicyRuntimeState());
  const nativeMutationHost = { permissionManager: manager, port, workspaceTrust: null, workspaceRoot: directory,
    signal: lifetime.signal, config: { onDidInvalidate(listener: () => void) { invalidations.add(listener); return () => invalidations.delete(listener); } } };
  const catalog = new GatewayMethodCatalog(), pairing = new PairingTokenManager(join(directory, 'pairing.json'));
  const paired = pairing.mint({ name: 'Synthetic connected draft fixture' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing,
    authToken: () => 'synthetic-reference-shared', userAuth: { validateSession: () => null },
  } as unknown as DaemonControlPlaneContext);
  const drafts = new DraftSyncStore({ workingDirectory: directory, cipher });
  cleanup.push(() => drafts.close());
  await drafts.init();
  const seed = { id: LEGACY_ID, message, status: 'draft' as const, version: 1, title: 'Original title',
    channel: 'slack', route: 'synthetic-native-route', tags: ['private-source-owner'],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
  await drafts.upsert(seed); await drafts.save();
  const surface = registerDraftMethods({ catalog, workingDirectory: directory, credentials, nativeMutationHost,
    logger: { info() {}, warn() {}, error() {} } }, { store: drafts });
  cleanup.push(() => surface.close());
  const tokenFrom = (request: Request) => request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const principalFrom = (request: Request) => helper.describeAuthenticatedPrincipal(tokenFrom(request));
  const handlers = createDaemonControlRouteHandlers({ gatewayMethods: catalog, extractAuthToken: tokenFrom,
    resolveAuthenticatedPrincipal: principalFrom,
    requireAdmin(request: Request) { const principal = principalFrom(request); return principal?.admin ? null
      : Response.json({ error: 'Unauthorized' }, { status: principal ? 403 : 401 }); },
    async parseOptionalJsonBody(request: Request) { const text = await request.text(); return text ? JSON.parse(text) : {}; },
    invokeGatewayMethodCall: (input: Parameters<typeof helper.invokeGatewayMethodCall>[0]) => helper.invokeGatewayMethodCall(input),
  } as unknown as Parameters<typeof createDaemonControlRouteHandlers>[0]);
  const wire: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    wire.push(await request.clone().text());
    return await dispatchGatewayRestRoutes(request, handlers) ?? Response.json({ error: 'Not found' }, { status: 404 });
  } });
  cleanup.push(() => server.stop(true));
  const reference = channelDraftWireReference(LEGACY_ID);
  const call = async (method: string, path: string, body?: Record<string, unknown>, token = paired.token) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    const data: unknown = JSON.parse(text);
    return { status: response.status, ok: response.ok, data, text };
  };
  const input = () => ({ ...seed, id: reference, message: 'Complete queued native draft body', status: 'queued', admission: 'autonomous' });
  return { directory, config, secrets, credentials, cipher, drafts, pairing, paired, reference, seed, input, call, wire, lifetime, invalidations, port: server.port, humans: () => humans };
}

function expectNoNativeAdmission(token: string, protectedValue?: string) {
  expect(requests.filter(request => 'disposition' in request.questions)).toHaveLength(0);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(0);
  const actualReadings = JSON.stringify(requests);
  expect(actualReadings).not.toContain(LEGACY_ID);
  expect(actualReadings).not.toContain(token);
  if (protectedValue) expect(actualReadings).not.toContain(protectedValue);
}

test('real connected native legacy draft save/get/list/delete keeps private IDs off wire and recorded readings', async () => {
  const f = await fixture();
  expect(f.reference).toMatch(/^draft-reference-[a-p]{32}$/);
  expect(channelDraftWireReference('ordinary-native-id')).toBe('ordinary-native-id');
  const saved = await f.call('POST', '/api/channels/drafts', f.input());
  expect(saved.status).toBe(200);
  expect(saved.data).toMatchObject({ created: false, draft: { id: f.reference, status: 'queued' } });
  expect(f.drafts.get(LEGACY_ID)?.status).toBe('queued');
  expect(f.drafts.get(f.reference)).toBeNull();
  const get = await f.call('GET', `/api/channels/drafts/${f.reference}`);
  expect(get.status).toBe(200); expect(get.data).toMatchObject({ id: f.reference });
  const list = await f.call('GET', '/api/channels/drafts');
  expect(list.status).toBe(200); expect(list.data).toMatchObject({ drafts: [{ id: f.reference }] });
  const deleted = await f.call('DELETE', `/api/channels/drafts/${f.reference}`, { admission: 'autonomous' });
  expect(deleted.status).toBe(200); expect(deleted.data).toEqual({ deleted: true, draftId: f.reference });
  expect(f.drafts.get(LEGACY_ID)).toBeNull();
  expect([saved.text, get.text, list.text, deleted.text, ...f.wire].join('')).not.toContain(LEGACY_ID);
  expect(JSON.stringify(requests)).not.toContain(LEGACY_ID);
  expect(JSON.stringify(requests)).toContain(ORIGINAL_BODY);
  expect(JSON.stringify(requests)).toContain('Complete queued native draft body');
  expect(JSON.stringify(requests)).not.toContain(f.paired.token);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(2);
  expect(f.humans()).toBe(0);
});

test('actual registered Agent admission publishes its owned legacy draft through the real paired peer before delivery', async () => {
  const synthetic = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    const label = name === 'disposition' ? 'act'
      : name === 'kind' ? Object.hasOwn(question.criteria, 'read') ? 'read' : 'other'
      : name === 'family' || name === 'capability' ? 'generic' : undefined;
    if (!label) throw new Error(`Unexpected Agent-native fixture question ${name}`);
    return choiceAnswer(question, label, 0.999);
  });
  port = withDecisionLog({ model: synthetic.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.(); requests.push(request);
    return synthetic.port.ask(request);
  } }, log);
  installJudgmentPort(port);
  const f = await fixture();
  const [{ DEFAULT_CONFIG }, { createShellPathService }, { ChannelDeliveryRouter }, { ToolRegistry },
    { CommandRegistry }, { bindAgentResearchSourceOwner }, { channelDraftFilePath, getDraft },
    { registerAgentHarnessTool }, { connectedHostOperatorTokenPath }, { researchScreeningFixture, cleanupResearchScreeningFixtures },
    { resetSessionUntrustedContentLedgerForTests }] = await Promise.all([
      import('../sdk/src/platform/config/schema.js'),
      import('../sdk/src/platform/runtime/shell.js'),
      import('../sdk/src/platform/channels/delivery-router.js'),
      import('../sdk/src/platform/tools/registry.js'),
      import('../../../products/agent/src/input/command-registry.ts'),
      import('../../../products/agent/src/agent/protected-research-report.ts'),
      import('../../../products/agent/src/agent/channel-draft.ts'),
      import('../../../products/agent/src/tools/agent-harness-tool.ts'),
      import('../../../products/agent/src/runtime/connected-host-auth.ts'),
      import('../../../products/agent/src/test/helpers/research-screening.ts'),
      import('../../../products/agent/src/trust/untrusted-content.ts'),
    ]);
  resetSessionUntrustedContentLedgerForTests(); cleanup.push(resetSessionUntrustedContentLedgerForTests);
  const clientRoot = mkdtempSync(join(tmpdir(), 'gv-agent-reference-peer-'));
  cleanup.push(() => rmSync(clientRoot, { recursive: true, force: true }));
  const paths = createShellPathService({ homeDirectory: clientRoot, workingDirectory: clientRoot });
  const path = channelDraftFilePath(paths);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, drafts: [{ ...f.seed, message: ORIGINAL_BODY, channel: 'slack:fixture' }] }));
  const tokenPath = connectedHostOperatorTokenPath(clientRoot);
  mkdirSync(dirname(tokenPath), { recursive: true }); writeFileSync(tokenPath, JSON.stringify({ token: f.paired.token }));
  const connectedEnv = process.env.GOODVIBES_CONNECTED_HOST_TOKEN, daemonEnv = process.env.GOODVIBES_DAEMON_TOKEN;
  delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; delete process.env.GOODVIBES_DAEMON_TOKEN;
  cleanup.push(() => {
    if (connectedEnv === undefined) delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; else process.env.GOODVIBES_CONNECTED_HOST_TOKEN = connectedEnv;
    if (daemonEnv === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN; else process.env.GOODVIBES_DAEMON_TOKEN = daemonEnv;
  });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: clientRoot, homeDir: clientRoot,
    configDir: join(clientRoot, '.goodvibes', 'agent') });
  configManager.set('controlPlane.host', '127.0.0.1'); configManager.set('controlPlane.port', f.port);
  await configManager.flushConfigFileChanges();
  const permissionReader = {
    getAutonomousSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode: 'prompt' as const }, autoApprove: false, directory: clientRoot }),
    getSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode: 'prompt' as const } }),
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => clientRoot,
  };
  const manager = new PermissionManager(undefined, permissionReader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager), delivery: string[] = [];
  const router = new ChannelDeliveryRouter({ strategies: [{ id: 'registered-native-peer-fixture', supportsGuardedDelivery: true,
    canHandle: () => true, async deliver(request) {
      request.signal?.throwIfAborted(); request.assertCurrent?.();
      expect(f.drafts.get(LEGACY_ID)?.status).toBe('queued');
      delivery.push(request.message); return { responseId: 'registered-native-peer-receipt' };
    } }] });
  const context = { workspace: { shellPaths: paths }, platform: { config: {}, channelDeliveryRouter: router, configManager },
    session: { runtime: { sessionId: 'registered-native-peer' } }, clients: {}, extensions: { toolRegistry: registry }, ops: {} } as unknown as import('../../../products/agent/src/input/command-registry.ts').CommandContext;
  const screening = researchScreeningFixture(); cleanup.push(cleanupResearchScreeningFixtures);
  bindAgentResearchSourceOwner(registry, screening.owner); registerAgentHarnessTool(registry, new CommandRegistry(), context);
  const call = await registry.prepareCall('registered-native-peer-call', 'agent_harness', { mode: 'channel_draft_send', draftId: LEGACY_ID });
  const admission = await manager.admitAutonomous(call.callId, call.name, call.args, {
    sourceOf: () => ({ goal: 'Deliver the exact native fixture draft.', criteria: ['Retain the original native draft and paired peer'] }),
    preparedCall: { registry, call }, schemaRevision: call.schemaRevision,
  });
  expect(admission.result.autonomousDecision?.outcome).toBe('act');
  const result = await registry.executePrepared(call, admission);
  expect(result.success).toBe(true); expect(result.output).toBeDefined();
  const receipt: unknown = JSON.parse(result.output!);
  expect(receipt).toMatchObject({ status: 'sent', draftId: f.reference, draft: { id: f.reference, status: 'sent' } });
  expect(getDraft(paths, LEGACY_ID)?.status).toBe('sent'); expect(delivery).toEqual([ORIGINAL_BODY]);
  expect(f.drafts.get(LEGACY_ID)?.status).toBe('queued'); expect(f.drafts.get(f.reference)).toBeNull();
  expect(f.wire).toHaveLength(1); expect(JSON.parse(f.wire[0]!)).toMatchObject({ id: f.reference, admission: 'autonomous', message: ORIGINAL_BODY, status: 'queued' });
  expect(f.wire.join('')).not.toContain(LEGACY_ID); expect(JSON.stringify(requests)).not.toContain(LEGACY_ID);
  expect(JSON.stringify(screening.calls)).not.toContain(LEGACY_ID); expect(result.output).not.toContain(LEGACY_ID);
  expect(JSON.stringify(requests)).not.toContain(f.paired.token); expect(result.output).not.toContain(f.paired.token);
  expect(log.query({ site: 'engine.gate.autonomous-tool' }).length).toBeGreaterThanOrEqual(2);
  expect(f.humans()).toBe(0);
});

test('unknown native handles and caller aliases cannot create a mirrored draft or a recorded grant', async () => {
  const f = await fixture(), before = readFileSync(f.drafts.dbPath);
  const unknown = `draft-reference-${'p'.repeat(32)}`;
  const result = await f.call('POST', '/api/channels/drafts', { ...f.input(), id: unknown,
    nativeReferenceSubjects: { draft: { id: f.reference } }, confirm: true, explicitUserRequest: true });
  expect(result.ok).toBe(false); expect(result.status).toBe(404);
  expect(f.drafts.get(unknown)).toBeNull(); expect(readFileSync(f.drafts.dbPath)).toEqual(before);
  expectNoNativeAdmission(f.paired.token);
});

test.each(['wire-body', 'selected-native-body'] as const)('native handle never exempts protected %s content', async kind => {
  const card = '4111 1111 1111 1111';
  const f = await fixture(kind === 'selected-native-body' ? card : ORIGINAL_BODY), before = readFileSync(f.drafts.dbPath);
  const result = await f.call('POST', '/api/channels/drafts', { ...f.input(), ...(kind === 'wire-body' ? { message: card } : {}) });
  expect(result.ok).toBe(false); expect(result.text).not.toContain(card);
  expect(readFileSync(f.drafts.dbPath)).toEqual(before); expect(f.drafts.get(LEGACY_ID)?.status).toBe('draft');
  expectNoNativeAdmission(f.paired.token, card);
});

test('raw dense caller ID retains the original card floor instead of acquiring native alias authority', async () => {
  const f = await fixture(), before = readFileSync(f.drafts.dbPath);
  const result = await f.call('POST', '/api/channels/drafts', { ...f.input(), id: LEGACY_ID });
  expect(result.ok).toBe(false); expect(result.text).not.toContain(LEGACY_ID);
  expectNoNativeAdmission(f.paired.token); expect(readFileSync(f.drafts.dbPath)).toEqual(before);
});

test('shared token and caller confirmation flags cannot own a native reference', async () => {
  const f = await fixture(), before = readFileSync(f.drafts.dbPath);
  const result = await f.call('POST', '/api/channels/drafts', { ...f.input(), confirm: true, explicitUserRequest: true,
    nativeExecutionAuthority: { current: { kind: 'pairing-token' } } }, 'synthetic-reference-shared');
  expect(result.status).toBe(403); expectNoNativeAdmission(f.paired.token); expect(readFileSync(f.drafts.dbPath)).toEqual(before);
});

test.each(['revoke', 'selected-row-aba', 'physical-aba', 'key-aba', 'configuration', 'cancel'] as const)(
  'genuine connected pending admission retains %s and writes nothing', async kind => {
    const f = await fixture(), before = readFileSync(f.drafts.dbPath);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    beforeRead = async request => { if ('disposition' in request.questions) { entered.resolve(); await release.promise; } };
    const pending = f.call('POST', '/api/channels/drafts', f.input());
    await entered.promise;
    try {
      if (kind === 'revoke') expect(f.pairing.revoke(f.paired.id)).toBe(true);
      if (kind === 'selected-row-aba') {
        await f.drafts.upsert({ ...f.seed, title: 'Transient other row' }); await f.drafts.upsert(f.seed);
      }
      if (kind === 'physical-aba') {
        const replacement = `${f.drafts.dbPath}.replacement`; writeFileSync(replacement, before); renameSync(replacement, f.drafts.dbPath);
      }
      if (kind === 'key-aba') {
        const key = 'GOODVIBES_DAEMON_DRAFT_AESKEY', original = await f.secrets.get(key);
        if (!original) throw new Error('Native cipher fixture key unavailable');
        await f.secrets.set(key, Buffer.alloc(32, 9).toString('base64'), { scope: 'daemon', medium: 'secure' });
        await f.secrets.set(key, original, { scope: 'daemon', medium: 'secure' });
      }
      if (kind === 'configuration') for (const invalidate of f.invalidations) invalidate();
      if (kind === 'cancel') f.lifetime.abort();
    } finally { release.resolve(); }
    const result = await pending;
    expect(result.ok).toBe(false); expect(result.text).not.toContain(LEGACY_ID);
    if (kind === 'revoke') expect(result.status).toBe(409);
    expect(JSON.stringify(requests)).not.toContain(LEGACY_ID);
    expect(JSON.stringify(requests)).not.toContain(f.paired.token);
    expect(f.drafts.get(LEGACY_ID)?.status).toBe('draft');
    expect(readFileSync(f.drafts.dbPath)).toEqual(before); expect(f.humans()).toBe(0);
  },
);

test('original paired owner is retained through the actual native decryption await before any reading', async () => {
  const f = await fixture(), before = readFileSync(f.drafts.dbPath);
  const decrypt = f.cipher.decrypt;
  f.cipher.decrypt = async (...args) => {
    const plaintext = await decrypt(...args);
    f.pairing.revoke(f.paired.id);
    return plaintext;
  };
  const result = await f.call('POST', '/api/channels/drafts', f.input());
  expect(result.status).toBe(409); expectNoNativeAdmission(f.paired.token); expect(readFileSync(f.drafts.dbPath)).toEqual(before);
});

test('an existing target does not bypass the current structural plan restriction', async () => {
  const f = await fixture(), before = readFileSync(f.drafts.dbPath);
  f.config.set('permissions.mode', 'plan');
  const result = await f.call('POST', '/api/channels/drafts', f.input());
  expect(result.status).toBe(422); expect(readFileSync(f.drafts.dbPath)).toEqual(before); expect(f.humans()).toBe(0);
});
