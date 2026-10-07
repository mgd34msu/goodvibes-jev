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
import { processTelegramUpdate } from '../sdk/src/platform/adapters/telegram/index.js';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/types.js';
import { DelegatedTelegramIntake } from '../sdk/src/platform/daemon/delegated-telegram-intake.js';
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
  const sent: string[] = []; let spawned = 0; let account = 'synthetic_bot';
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
  const hostDeps = { broker, approvals, routes, accountId: () => account, workspaceRoot: directory, selectionPath: join(directory, 'selection.json'), receiptPath: join(directory, 'review.json') };
  const host = new DelegatedTelegramIntake(hostDeps); cleanups.push(() => host.close());
  const catalog = new GatewayMethodCatalog(); registerDelegatedTelegramCommands(catalog, host);
  const invoke = (operation: string, body: Record<string, unknown> = {}) => catalog.invoke(`inbound.telegram.${operation}`, { body,
    context: { admin: true, principalKind: 'token', principalId: authority.current()?.principalId ?? 'revoked-owner', scopes: ['*'] }, isAuthorized: () => current !== null, nativeExecutionAuthority: authority });
  const policyInputs: unknown[] = [];
  const context = { serviceRegistry: {}, configManager: { get: () => account }, routeBindings: routes, sessionBroker: broker, delegatedTelegram: host,
    authorizeSurfaceIngress: async (input: unknown) => { policyInputs.push(input); return { allowed: true, reason: 'synthetic' }; },
    parseSurfaceControlCommand: () => null, performSurfaceControlCommand: async () => 'unused', performInteractiveSurfaceAction: async () => 'unused',
    trySpawnAgent: () => { spawned++; return { id: 'legacy-fixture-agent' }; }, queueSurfaceReplyFromBinding: () => {},
  } as unknown as SurfaceAdapterContext;
  const configure = (overrides: Record<string, unknown> = {}) => invoke('configure', { chatId: '42', accountId: account, pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: 10_000,
    configurationLifetimeMs: 60_000, onExpiry: 'release-original-and-hold', ...overrides });
  const ingress = async (text = original, id = 1) => (await processTelegramUpdate({ update_id: id, message: { message_id: id, chat: { id: 42, type: 'private' }, from: { id: 99 }, text } }, context)).json() as Promise<{ ref: NativeInboundSourceRef; approvalId: string; outcome: string; reason?: string }>;
  const decide = (pending: { ref: NativeInboundSourceRef; approvalId: string }, overrides: Record<string, unknown> = {}) => invoke('decide', { ...pending, approved: true, choices, ...overrides });
  return { directory, broker, approvals, host, hostDeps, catalog, invoke, authority, context, policyInputs, configure, ingress, decide, sent,
    spawned: () => spawned, changeAccount: () => { account = 'replacement_bot'; }, revokeOwner: () => { current = null; } };
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
  expect(await reopened.accept({ binding: f.hostDeps.routes.listBindings()[0]!, chatId: '42', providerMessageId: 'new', readOriginal: () => { throw new Error('must not acquire'); } })).toMatchObject({ outcome: 'held' });
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
});

test('edited Telegram update retires the prior exact original without capturing its replacement', async () => {
  const f = await fixture(); await f.configure(); const pending = await f.ingress();
  const response = await processTelegramUpdate({ update_id: 2, edited_message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 99 }, text: 'replacement external text' } }, f.context);
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
  await processTelegramUpdate({ update_id: 2, edited_message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 99 }, text: 'edited first' } }, f.context);
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
  const pending = f.host.accept({ binding: f.hostDeps.routes.listBindings()[0]!, chatId: '42', providerMessageId: '2', readOriginal: () => { reads++; return original; } });
  f.host.close(); f.host.startLifecycle(); await f.configure();
  expect(await pending).toMatchObject({ outcome: 'held' }); expect(reads).toBe(0);
});
