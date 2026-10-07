import { createDaemonControlRouteHandlers } from '../daemon-sdk/src/control-routes.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.js';
import { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { AutomationRouteStore } from '../sdk/src/platform/automation/store/routes.js';
import { RouteBindingManager } from '../sdk/src/platform/channels/route-manager.js';
import { handleTelegramSurfaceWebhook, processTelegramUpdate } from '../sdk/src/platform/adapters/telegram/index.js';
import { TelegramBotApi } from '../sdk/src/platform/channels/telegram/api.js';
import { createTelegramSourceAccountOwner } from '../sdk/src/platform/channels/telegram/source-account.js';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/types.js';
import { DelegatedTelegramIntake, type DelegatedTelegramIngress } from '../sdk/src/platform/daemon/delegated-telegram-intake.js';
import { registerDelegatedTelegramCommands } from '../sdk/src/platform/daemon/facade-delegated-telegram.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../sdk/src/platform/security/http-auth.js';
import type { NativeInboundSourceRef } from '../sdk/src/platform/control-plane/native-inbound-source.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const original = '  /goodvibes 🚲 e\u0301 repeat repeat\r\nEXTERNAL ORIGINAL\t ';
const choices = { processingPurpose: 'accept-external-message-for-owner-review', sourceRetention: 'memory-only-until-review-close-or-deadline', sourceRetentionMs: 10_000,
  derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs: 20_000, execution: 'none', ownerMayReadOriginal: true };
async function fixture(persistedPairing = false) {
  const directory = mkdtempSync(join(tmpdir(), 'delegated-telegram-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const routes = new RouteBindingManager({ store: new AutomationRouteStore(join(directory, 'routes.json')) });
  const sent: string[] = []; let spawned = 0; const configuredUsername = 'synthetic_bot'; let sourceReads = 0;
  const accounts = createTelegramSourceAccountOwner(); const providerCalls: string[] = [];
  let liveToken = ''; let transport = new AbortController();
  const attachAccount = (id: number, username: string, token: string) => {
    transport.abort(); transport = new AbortController(); liveToken = token;
    const api = new TelegramBotApi(token, async (url) => {
      providerCalls.push(url.split('/').pop()!);
      return Response.json({ ok: true, result: { id, username, is_bot: true, first_name: 'Synthetic fixture bot' } });
    });
    return accounts.attach({ lifetime: transport.signal, isCurrent: async () => liveToken === token, isCurrentSync: () => liveToken === token,
      readIdentity: signal => api.getVerifiedIdentity(signal) });
  };
  let lease = attachAccount(123, configuredUsername, '123:synthetic-original');
  cleanups.push(() => { transport.abort(); accounts.invalidate(); });
  const broker = new SharedSessionBroker({ storePath: join(directory, 'broker.json'), routeBindings: routes,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: (_from, _to, text) => { sent.push(text); return true; } } });
  cleanups.push(() => broker.stop());
  const approvals = new ApprovalBroker({ storePath: join(directory, 'approvals.json') });
  let current: NativePairedSnapshot | null = { kind: 'pairing-token', tokenId: 'synthetic-pairing', principalId: 'pairing:synthetic-pairing', authorityId: 'pairing:synthetic-pairing', authorityRevision: 'synthetic-pairing', scopes: ['read:work-ledger', 'write:work-ledger'] };
  let authority: NativeExecutionAuthority = { current: () => current, withCurrent: async (expected, callback) => {
    const assert = () => { if (!current || current.tokenId !== expected.tokenId) throw new Error('Owner revoked'); return current; }; assert(); const result = await callback(assert); assert(); return result;
  } };
  if (persistedPairing) {
    const manager = new PairingTokenManager(join(directory, 'synthetic-pairing.json'));
    const paired = manager.mint({ name: 'Offline test fixture only' });
    const helper = new DaemonControlPlaneHelper({ gatewayMethods: new GatewayMethodCatalog(), pairingTokens: manager, authToken: () => null, userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
    authority = helper.createNativeExecutionAuthority(paired.token, ['read:work-ledger', 'write:work-ledger'])!;
    current = authority.current();
  }
  const hostDeps = { broker, approvals, routes, accounts: accounts.reader, workspaceRoot: directory, selectionPath: join(directory, 'selection.json'), receiptPath: join(directory, 'review.json') };
  const host = new DelegatedTelegramIntake(hostDeps); cleanups.push(() => host.close());
  const catalog = new GatewayMethodCatalog(); registerDelegatedTelegramCommands(catalog, host);
  const invoke = (operation: string, body: Record<string, unknown> = {}) => catalog.invoke(`inbound.telegram.${operation}`, { body,
    context: { admin: true, principalKind: 'token', principalId: authority.current()?.principalId ?? 'revoked-owner', scopes: ['*'] }, isAuthorized: () => current !== null, nativeExecutionAuthority: authority });
  const policyInputs: unknown[] = [];
  const context = { serviceRegistry: { resolveSecret: async () => null }, configManager: { get: (key: string) => {
    if (key === 'surfaces.telegram.botUsername') return configuredUsername;
    if (key === 'surfaces.telegram.botToken') return liveToken;
    if (key === 'surfaces.telegram.webhookSecret') return 'synthetic-webhook-secret';
    return undefined;
  } }, routeBindings: routes, sessionBroker: broker, delegatedTelegram: {
    selects: (chatId: string, threadId?: string) => host.selects(chatId, threadId),
    accept: (input: DelegatedTelegramIngress) => host.accept({ ...input, readOriginal: () => { sourceReads++; return input.readOriginal(); } }),
  },
    authorizeSurfaceIngress: async (input: unknown) => { policyInputs.push(input); return { allowed: true, reason: 'synthetic' }; },
    parseSurfaceControlCommand: () => null, performSurfaceControlCommand: async () => 'unused', performInteractiveSurfaceAction: async () => 'unused',
    trySpawnAgent: () => { spawned++; return { id: 'legacy-fixture-agent' }; }, queueSurfaceReplyFromBinding: () => {},
  } as unknown as SurfaceAdapterContext;
  const configure = (overrides: Record<string, unknown> = {}) => invoke('configure', { chatId: '42', accountId: configuredUsername, pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: 10_000,
    configurationLifetimeMs: 60_000, onExpiry: 'release-original-and-hold', ...overrides });
  const updateDeps = () => ({ acquireSourceAccount: lease.acquire });
  const ingress = async (text = original, id = 1) => (await processTelegramUpdate({ update_id: id, message: { message_id: id, chat: { id: 42, type: 'private' }, from: { id: 99 }, text } }, context, updateDeps())).json() as Promise<{ ref: NativeInboundSourceRef; approvalId: string; outcome: string; reason?: string }>;
  const decide = (pending: { ref: NativeInboundSourceRef; approvalId: string }, overrides: Record<string, unknown> = {}) => invoke('decide', { ...pending, approved: true, choices, ...overrides });
  return { directory, broker, approvals, host, hostDeps, catalog, invoke, authority, context, policyInputs, configure, ingress, decide, sent, accounts, providerCalls,
    get updateDeps() { return updateDeps(); }, sourceReads: () => sourceReads,
    spawned: () => spawned, changeAccount: () => { lease = attachAccount(456, 'replacement_bot', '456:synthetic-replacement'); },
    rotateSameAccount: () => { lease = attachAccount(123, configuredUsername, '123:synthetic-rotated'); },
    revokeOwner: () => { current = null; } };
}

test('actual Telegram adapter → canonical broker → paired owner command → usable non-owner review receiver', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  expect(pending.outcome).toBe('held'); expect(f.spawned()).toBe(0); expect(f.sent).toEqual([]);
  const row = f.broker.getInputs(pending.ref.sessionId)[0]!;
  expect(row.id).toBe(pending.ref.inputId); expect(row.userId).toBe('99'); expect(row.body).not.toContain('EXTERNAL ORIGINAL');
  expect(f.broker.getInputsSince(pending.ref.sessionId)).toEqual([]);
  expect(f.policyInputs[0]).not.toHaveProperty('text');
  const approval = f.approvals.getApproval(pending.approvalId)!;
  expect(approval.requiresOwnerDecision).toBe(true); expect(JSON.stringify(approval)).not.toContain('EXTERNAL ORIGINAL');
  await expect(f.approvals.resolveApproval(pending.approvalId, { approved: true, actor: 'pairing:synthetic-pairing' })).rejects.toThrow();
  expect(await f.decide({ ref: pending.ref, approvalId: pending.approvalId })).toMatchObject({ outcome: 'transferred', execution: 'not-started' });
  const read = await f.invoke('read', { ref: pending.ref });
  expect(read).toMatchObject({ source: 'available-in-memory', original: { text: original }, record: { state: 'accepted-for-review', execution: 'not-started', origin: { kind: 'external-original' } } });
  expect(f.broker.getInputs(pending.ref.sessionId)[0]?.state).toBe('completed');
  expect(await f.invoke('list')).toMatchObject({ records: [{ ref: pending.ref, execution: 'not-started' }] });
  for (const file of readdirSync(f.directory).filter(name => name.endsWith('.json'))) expect(readFileSync(join(f.directory, file), 'utf8')).not.toContain('EXTERNAL ORIGINAL');
  await expect(f.decide({ ref: pending.ref, approvalId: pending.approvalId })).rejects.toThrow();
  expect(await f.invoke('cancel', { ref: pending.ref })).toMatchObject({ outcome: 'cancelled', execution: 'not-started' });
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'expired-or-lost', record: { state: 'cancelled' } });
});

test('unselected Telegram retains legacy path; selected revoked route never falls back', async () => {
  const f = await fixture(); await f.ingress('ordinary legacy fixture'); expect(f.spawned()).toBe(1);
  const config = await f.configure() as { configurationId: string }; await f.invoke('revoke', { configurationId: config.configurationId });
  expect((await f.ingress()).outcome).toBe('held'); expect(f.spawned()).toBe(1); expect(f.approvals.listApprovals()).toHaveLength(0);
});

test('same-bot token rotation preserves an already approved original through its explicit review lifetime', async () => {
  const f = await fixture();
  const configured = await f.configure() as { configurationId: string; accountIdentity: { id: string; revision: string } };
  const pending = await f.ingress(); await f.decide({ ref: pending.ref, approvalId: pending.approvalId });
  const reads = f.sourceReads();
  f.accounts.invalidate();
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'available-in-memory', original: { text: original } });
  f.rotateSameAccount();
  expect(f.accounts.reader.current()).toBeNull();
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'available-in-memory', original: { text: original } });
  const handle = (await f.updateDeps.acquireSourceAccount())!;
  expect(await f.accounts.reader.read(handle)).toMatchObject({ id: configured.accountIdentity.id, revision: configured.accountIdentity.revision });
  expect(f.providerCalls).toEqual(['getMe', 'getMe']);
  expect(f.sourceReads()).toBe(reads);
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'available-in-memory', original: { text: original } });
  await f.invoke('revoke', { configurationId: configured.configurationId });
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'expired-or-lost' });
  expect(f.spawned()).toBe(0); expect(f.sent).toEqual([]);
});

test('different provider bot with unchanged configured username holds before any selected text read', async () => {
  const f = await fixture();
  const configured = await f.configure() as { accountIdentity: { id: string; revision: string } };
  expect(configured.accountIdentity.id).toBe('123');
  f.changeAccount(); let textReads = 0;
  const response = await processTelegramUpdate({ update_id: 2, message: {
    message_id: 2, chat: { id: 42, type: 'private' }, from: { id: 99 },
    get text() { textReads++; return original; },
  } }, f.context, f.updateDeps);
  expect(await response.json()).toMatchObject({ outcome: 'held' });
  expect(f.context.configManager.get('surfaces.telegram.botUsername')).toBe('synthetic_bot');
  expect(f.accounts.reader.current()).toMatchObject({ id: '456', username: 'replacement_bot' });
  expect(f.accounts.reader.current()?.revision).not.toBe(configured.accountIdentity.revision);
  expect(textReads).toBe(0); expect(f.sourceReads()).toBe(0);
  expect(f.approvals.listApprovals()).toHaveLength(0); expect(f.spawned()).toBe(0); expect(f.sent).toEqual([]);
  expect(await f.configure()).toMatchObject({ outcome: 'held', accountIdentity: { id: '456', username: 'replacement_bot' } });
});

test('verified different-bot replacement retires an approved original but keeps historical review metadata', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress(); await f.decide({ ref: pending.ref, approvalId: pending.approvalId });
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'available-in-memory', original: { text: original } });
  f.changeAccount();
  const replacement = (await f.updateDeps.acquireSourceAccount())!;
  expect(await f.accounts.reader.read(replacement)).toMatchObject({ id: '456', username: 'replacement_bot' });
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'expired-or-lost', recovery: 'new-original-required',
    record: { ref: pending.ref, origin: { accountId: '123' }, state: 'accepted-for-review', execution: 'not-started' } });
  expect(await f.invoke('list')).toMatchObject({ records: [{ ref: pending.ref, origin: { accountId: '123' } }] });
  expect(f.spawned()).toBe(0); expect(f.sent).toEqual([]);
});

test('selected messages without transport proof never inspect or capture text', async () => {
  const f = await fixture(); await f.configure(); let textReads = 0;
  const response = await processTelegramUpdate({ update_id: 1, message: {
    message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 99 },
    get text() { textReads++; return '/start'; },
  } }, f.context);
  expect(await response.json()).toMatchObject({ outcome: 'held' });
  expect(textReads).toBe(0); expect(f.sourceReads()).toBe(0);
  expect(f.approvals.listApprovals()).toHaveLength(0); expect(f.spawned()).toBe(0); expect(f.sent).toEqual([]);
});

test('selected webhook cannot borrow polling proof, while an unselected webhook retains its legacy path', async () => {
  const f = await fixture();
  const request = (id: number) => new Request('https://synthetic.example/webhook/telegram', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'synthetic-webhook-secret' },
    body: JSON.stringify({ update_id: id, message: { message_id: id, chat: { id: 42, type: 'private' }, from: { id: 99 }, text: original } }),
  });
  await handleTelegramSurfaceWebhook(request(1), f.context, f.updateDeps);
  expect(f.spawned()).toBe(1); expect(f.providerCalls).toEqual([]);
  await f.configure();
  const response = await handleTelegramSurfaceWebhook(request(2), f.context, f.updateDeps);
  expect(await response.json()).toMatchObject({ outcome: 'held' });
  expect(f.sourceReads()).toBe(0); expect(f.spawned()).toBe(1);
  expect(f.approvals.listApprovals()).toHaveLength(0); expect(f.providerCalls).toEqual(['getMe']);
});

test('source expiry denies later decisions without reconstructing broker body', async () => {
  const f = await fixture(); await f.configure({ pendingRetentionMs: 30 }); const pending = await f.ingress(); await Bun.sleep(45);
  await expect(f.decide({ ref: pending.ref, approvalId: pending.approvalId })).rejects.toThrow();
  expect(await f.invoke('status', { ref: pending.ref })).toMatchObject({ outcome: 'held', source: 'expired-or-lost' });
  expect((await f.invoke('list') as { records: unknown[] }).records).toHaveLength(0); expect(f.spawned()).toBe(0);
});

test('approval requires explicit exact source/retention/derived-record choices', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  for (const override of [{ choices: undefined }, { choices: { ...choices, execution: 'start' } }, { choices: { ...choices, sourceRetentionMs: 0 } },
    { ref: { ...pending.ref, inputId: 'forged' } }, { choices: { ...choices, derivedRecordRetentionMs: 1 } }]) {
    await expect(f.decide({ ref: pending.ref, approvalId: pending.approvalId }, override)).rejects.toThrow();
  }
  expect(f.approvals.getApproval(pending.approvalId)?.status).toBe('pending'); expect(f.spawned()).toBe(0);
});

test.each(['account', 'owner', 'configuration'] as const)('%s replacement holds before receiver acceptance', async kind => {
  const f = await fixture(); const config = await f.configure() as { configurationId: string }; const pending = await f.ingress();
  if (kind === 'account') f.changeAccount(); else if (kind === 'owner') f.revokeOwner(); else await f.invoke('revoke', { configurationId: config.configurationId });
  await expect(f.decide({ ref: pending.ref, approvalId: pending.approvalId })).rejects.toThrow(); expect(f.spawned()).toBe(0);
});

test('restart retains selected hold and review metadata, never the original or approval capability', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress(); await f.decide({ ref: pending.ref, approvalId: pending.approvalId });
  f.host.close(); const reopened = new DelegatedTelegramIntake(f.hostDeps); cleanups.push(() => reopened.close());
  expect(await reopened.selects('42')).toBe(true);
  expect(await reopened.status(pending.ref, f.authority, true)).toMatchObject({ source: 'expired-or-lost', record: { state: 'accepted-for-review', execution: 'not-started' } });
  expect(await reopened.accept({ binding: f.hostDeps.routes.listBindings()[0]!, chatId: '42', providerMessageId: 'new', account: await f.updateDeps.acquireSourceAccount(), readOriginal: () => { throw new Error('must not acquire'); } })).toMatchObject({ outcome: 'held' });
});

test('gateway refuses metadata/body/actor authority and insufficient scopes', async () => {
  const f = await fixture();
  await expect(f.catalog.invoke('inbound.telegram.list', { body: {}, context: { admin: true, principalId: 'pairing:synthetic-pairing', principalKind: 'token', scopes: ['*'] }, isAuthorized: () => true })).rejects.toMatchObject({ status: 403 });
  await expect(f.catalog.invoke('inbound.telegram.list', { body: {}, context: { admin: true, principalId: 'different', principalKind: 'token', scopes: ['*'] }, isAuthorized: () => true, nativeExecutionAuthority: f.authority })).rejects.toMatchObject({ status: 403 });
});

test('real persisted paired authority reaches configure/decide and owner read after approval scope ends', async () => {
  const f = await fixture(true); await f.configure(); const pending = await f.ingress();
  expect(await f.decide({ ref: pending.ref, approvalId: pending.approvalId })).toMatchObject({ outcome: 'transferred' });
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'available-in-memory', original: { text: original } });
});
test('selected bot command is held without onboarding response and duplicate delivery reuses one input', async () => {
  const f = await fixture(); await f.configure();
  const first = await f.ingress('/start'); const again = await f.ingress('/start');
  expect(first.outcome).toBe('held'); expect(again.ref).toEqual(first.ref); expect(f.approvals.listApprovals()).toHaveLength(1); expect(f.spawned()).toBe(0);
});
test('explicit denial succeeds and expires original without transfer', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  expect(await f.invoke('decide', { ref: pending.ref, approvalId: pending.approvalId, approved: false })).toMatchObject({ outcome: 'held', reason: 'owner-denied' });
  expect(await f.invoke('status', { ref: pending.ref })).toMatchObject({ source: 'expired-or-lost' });
  expect(f.broker.getInputs(pending.ref.sessionId)[0]?.state).toBe('cancelled');
});

test('edited Telegram update retires the prior exact original without capturing its replacement', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  const response = await processTelegramUpdate({ update_id: 2, edited_message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 99 }, text: 'replacement external text' } }, f.context, f.updateDeps);
  expect(await response.json()).toMatchObject({ outcome: 'held' });
  await expect(f.decide({ ref: pending.ref, approvalId: pending.approvalId })).rejects.toThrow();
  expect(f.approvals.listApprovals()).toHaveLength(1);
});

test('remove/recreate of a deterministic route cannot inherit pending source authority', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  const route = f.hostDeps.routes.listBindings()[0]!; await f.hostDeps.routes.removeBinding(route.id); await Bun.sleep(2);
  await f.hostDeps.routes.upsertBinding({ kind: route.kind, surfaceKind: route.surfaceKind, surfaceId: route.surfaceId, externalId: route.externalId, channelId: route.channelId, threadId: route.threadId });
  await expect(f.decide({ ref: pending.ref, approvalId: pending.approvalId })).rejects.toThrow();
});

test('approved source expiry makes durable review metadata honest without body reconstruction', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  await f.decide({ ref: pending.ref, approvalId: pending.approvalId }, { choices: { ...choices, sourceRetentionMs: 30 } }); await Bun.sleep(45);
  expect(await f.invoke('read', { ref: pending.ref })).toMatchObject({ source: 'expired-or-lost', recovery: 'new-original-required', record: { execution: 'not-started' } });
});

test('out-of-order edit tombstones the provider message before a delayed original arrives', async () => {
  const f = await fixture(); await f.configure();
  await processTelegramUpdate({ update_id: 2, edited_message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 99 }, text: 'edited first' } }, f.context, f.updateDeps);
  expect((await f.ingress()).outcome).toBe('held'); expect(f.approvals.listApprovals()).toHaveLength(0);
});

test('daemon lifecycle restart permits explicit reconfiguration without restoring old source grants', async () => {
  const f = await fixture(); await f.configure(); const first = await f.ingress();
  f.host.close(); f.host.startLifecycle();
  await expect(f.decide({ ref: first.ref, approvalId: first.approvalId })).rejects.toThrow();
  expect((await f.ingress('new message while configuration is revoked', 2)).outcome).toBe('held');
  await f.configure(); const next = await f.ingress('fresh original after explicit reconfiguration', 3);
  expect(await f.decide({ ref: next.ref, approvalId: next.approvalId })).toMatchObject({ outcome: 'transferred' });
  expect(await f.invoke('read', { ref: next.ref })).toMatchObject({ source: 'available-in-memory' });
});

test('a configuration command awaiting startup cannot mint a post-restart grant', async () => {
  const f = await fixture(); const pending = f.configure(); const failure = pending.then(() => null, error => error);
  f.host.close(); f.host.startLifecycle(); expect(await failure).toBeInstanceOf(Error);
  expect(f.approvals.listApprovals()).toHaveLength(0);
});

test('pre-restart ingress cannot acquire its original under a replacement configuration', async () => {
  const f = await fixture(); await f.configure(); await f.ingress(); let reads = 0;
  const account = await f.updateDeps.acquireSourceAccount();
  const pending = f.host.accept({ binding: f.hostDeps.routes.listBindings()[0]!, chatId: '42', providerMessageId: '2', account, readOriginal: () => { reads++; return original; } });
  f.host.close(); f.host.startLifecycle(); await f.configure();
  expect(await pending).toMatchObject({ outcome: 'held' }); expect(reads).toBe(0);
});

test('explicit pre-transfer cancel retires the canonical queue without claiming work completion', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  expect(f.broker.countBusySessions()).toBe(1);
  expect(await f.invoke('cancel', { ref: pending.ref })).toMatchObject({ outcome: 'cancelled', execution: 'not-started' });
  expect(f.broker.getInputs(pending.ref.sessionId)[0]?.state).toBe('cancelled'); expect(f.broker.countBusySessions()).toBe(0);
  await expect(f.decide({ ref: pending.ref, approvalId: pending.approvalId })).rejects.toThrow();
});

test('real HTTP routes authenticate paired owner and expose all seven delegated commands', async () => {
  const f = await fixture(); const manager = new PairingTokenManager(join(f.directory, 'http-pairing.json'));
  const paired = manager.mint({ name: 'Offline HTTP fixture only' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: f.catalog, pairingTokens: manager, authToken: () => 'synthetic-shared',
    userAuth: { validateSession: () => null },
  } as unknown as DaemonControlPlaneContext);
  const tokenFrom = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const resolvePrincipal = (req: Request) => helper.describeAuthenticatedPrincipal(tokenFrom(req));
  const handlers = createDaemonControlRouteHandlers({
    gatewayMethods: f.catalog, extractAuthToken: tokenFrom, resolveAuthenticatedPrincipal: resolvePrincipal,
    requireAdmin: (req: Request) => { const principal = resolvePrincipal(req); return principal?.admin ? null : Response.json({ error: 'Unauthorized' }, { status: principal ? 403 : 401 }); },
    parseOptionalJsonBody: (req: Request) => req.json(),
    invokeGatewayMethodCall: (input: Parameters<typeof helper.invokeGatewayMethodCall>[0]) => helper.invokeGatewayMethodCall(input),
  } as unknown as Parameters<typeof createDaemonControlRouteHandlers>[0]);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    return await dispatchGatewayRestRoutes(request, handlers) ?? Response.json({ error: 'Not found' }, { status: 404 });
  } });
  cleanups.push(() => server.stop(true));
  const post = (operation: string, body: Record<string, unknown>, token = paired.token) => fetch(`http://127.0.0.1:${server.port}/api/inbound/telegram/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const configuration = { chatId: '42', accountId: 'synthetic_bot', pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: 10_000,
    configurationLifetimeMs: 60_000, onExpiry: 'release-original-and-hold' };
  expect((await post('configure', configuration, '')).status).toBe(401);
  expect((await post('configure', configuration, 'synthetic-shared')).status).toBe(403);
  const configured = await post('configure', configuration); expect(configured.status).toBe(200); const config = await configured.json() as { configurationId: string };
  const pending = await f.ingress();
  expect(await (await post('status', { ref: pending.ref })).json()).toMatchObject({ outcome: 'awaiting-owner' });
  const decision = await post('decide', { ref: pending.ref, approvalId: pending.approvalId, approved: true, choices });
  expect(decision.status).toBe(200); expect(await decision.json()).toMatchObject({ outcome: 'transferred', execution: 'not-started' });
  expect(await (await post('read', { ref: pending.ref })).json()).toMatchObject({ source: 'available-in-memory', original: { text: original } });
  expect(await (await post('list', {})).json()).toMatchObject({ records: [{ ref: pending.ref }] });
  expect(await (await post('cancel', { ref: pending.ref })).json()).toMatchObject({ outcome: 'cancelled', execution: 'not-started' });
  expect(await (await post('revoke', { configurationId: config.configurationId })).json()).toMatchObject({ outcome: 'revoked' });
  manager.revoke(paired.id); expect((await post('read', { ref: pending.ref })).status).toBe(401);
});

test('selected groups preserve require-mention denial without reading source text or inventing exemption', async () => {
  const f = await fixture(); await f.configure(); let reads = 0;
  const context = { ...f.context, authorizeSurfaceIngress: async (input: { mentioned?: boolean }) => ({ allowed: input.mentioned === true, reason: 'mention-required' }) } as unknown as SurfaceAdapterContext;
  const message = { message_id: 451, chat: { id: 42, type: 'supergroup' }, from: { id: 99 }, get text() { reads++; return '/goodvibes @synthetic_bot external'; } };
  const response = await processTelegramUpdate({ update_id: 451, message }, context);
  expect(response.status).toBe(403); expect(reads).toBe(0); expect(f.spawned()).toBe(0); expect(f.approvals.listApprovals()).toHaveLength(0);
});

test('blocked provider proof is cancellable without holding the real paired-owner lock', async () => {
  const f = await fixture(true); let entered = false; let notify!: () => void; const waiting = new Promise<void>(resolve => { notify = resolve; });
  const host = new DelegatedTelegramIntake({ ...f.hostDeps, accounts: { ...f.hostDeps.accounts, acquire: async () => { entered = true; notify(); return new Promise<never>(() => {}); } } });
  cleanups.push(() => host.close()); const catalog = new GatewayMethodCatalog(); registerDelegatedTelegramCommands(catalog, host);
  const controller = new AbortController();
  const operation = catalog.invoke('inbound.telegram.configure', { body: { chatId: '42', accountId: 'synthetic_bot', pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: 1000, configurationLifetimeMs: 10000, onExpiry: 'release-original-and-hold' }, signal: controller.signal,
    context: { admin: true, principalKind: 'token', principalId: f.authority.current()!.principalId, scopes: ['*'] }, isAuthorized: () => true, nativeExecutionAuthority: f.authority });
  await waiting; expect(entered).toBe(true);
  expect(await Promise.race([f.authority.withCurrent(f.authority.current()!, async check => { check(); return 'available'; }), Bun.sleep(100).then(() => 'blocked')])).toBe('available');
  controller.abort(); await expect(operation).rejects.toThrow();
  expect(await host.selects('42')).toBe(true);
  expect(f.approvals.listApprovals()).toHaveLength(0);
});

test('provider preflight cannot install its old selection after host restart', async () => {
  const f = await fixture(); const proof = await f.hostDeps.accounts.acquire();
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const host = new DelegatedTelegramIntake({ ...f.hostDeps, accounts: { ...f.hostDeps.accounts, acquire: async () => { entered(); await gate; return proof; } } });
  cleanups.push(() => host.close()); const catalog = new GatewayMethodCatalog(); registerDelegatedTelegramCommands(catalog, host);
  const operation = catalog.invoke('inbound.telegram.configure', { body: { chatId: '42', accountId: 'synthetic_bot', pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: 1000, configurationLifetimeMs: 10000, onExpiry: 'release-original-and-hold' },
    context: { admin: true, principalKind: 'token', principalId: f.authority.current()!.principalId, scopes: ['*'] }, isAuthorized: () => true, nativeExecutionAuthority: f.authority });
  await waiting; host.close(); host.startLifecycle(); release(); await expect(operation).rejects.toThrow();
  expect(await host.selects('42')).toBe(true); expect((await host.list(f.authority)).pending).toEqual([]);
});

test('provider proof has a finite deadline even without caller cancellation', async () => {
  const f = await fixture(); const host = new DelegatedTelegramIntake({ ...f.hostDeps, accounts: { ...f.hostDeps.accounts, acquire: async () => new Promise<never>(() => {}) } });
  cleanups.push(() => host.close());
  await expect(host.prepareAccount()).rejects.toThrow('timed out');
  expect(f.approvals.listApprovals()).toHaveLength(0);
}, 10_000);
