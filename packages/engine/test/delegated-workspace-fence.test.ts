import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationRouteStore } from '../sdk/src/platform/automation/store/routes.js';
import { RouteBindingManager } from '../sdk/src/platform/channels/route-manager.js';
import { createTelegramSourceAccountOwner } from '../sdk/src/platform/channels/telegram/source-account.js';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { SharedSessionBroker } from '../sdk/src/platform/control-plane/session-broker.js';
import type { DelegatedTelegramConfiguration, DelegatedInboundChoices } from '../sdk/src/platform/control-plane/delegated-inbound-wire.js';
import type { NativeInboundSourceRef } from '../sdk/src/platform/control-plane/native-inbound-source.js';
import type { DelegatedTelegramIntake } from '../sdk/src/platform/daemon/delegated-telegram-intake.js';
import { composeDelegatedTelegramIntake } from '../sdk/src/platform/daemon/facade-delegated-telegram.js';
import type { ResolvedDaemonFacadeRuntime } from '../sdk/src/platform/daemon/facade-types.js';
import type { WorkspaceSwapManagerLike } from '../daemon-sdk/src/system-route-types.js';
import { RuntimeEventBus, createEventEnvelope } from '../sdk/src/platform/runtime/events/index.js';
import { createShellPathService } from '../sdk/src/platform/runtime/shell-paths.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../sdk/src/platform/security/http-auth.js';
import { WorkspaceSwapManager, type WorkspaceSwapResult } from '../sdk/src/platform/workspace/workspace-swap-manager.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const original = 'Synthetic external original retained for workspace-fence review';
const configuration: DelegatedTelegramConfiguration = {
  chatId: '42', accountId: '123', pendingRetention: 'memory-only-until-deadline', pendingRetentionMs: 10_000,
  configurationLifetimeMs: 60_000, onExpiry: 'release-original-and-hold',
};
const choices: DelegatedInboundChoices = {
  processingPurpose: 'accept-external-message-for-owner-review', sourceRetention: 'memory-only-until-review-close-or-deadline',
  sourceRetentionMs: 10_000, derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs: 20_000,
  execution: 'none', ownerMayReadOriginal: true,
};
type PendingSource = { ref: NativeInboundSourceRef; approvalId: string };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'delegated-workspace-fence-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const initialRoot = join(directory, 'first');
  const replacementRoot = join(directory, 'second');
  const runtimeBus = new RuntimeEventBus();
  const accounts = createTelegramSourceAccountOwner();
  cleanups.push(() => accounts.invalidate());
  const lease = accounts.attach({ lifetime: new AbortController().signal, isCurrent: async () => true, isCurrentSync: () => true,
    readIdentity: async () => ({ id: '123', username: 'synthetic_bot' }) });
  const routes = new RouteBindingManager({ store: new AutomationRouteStore(join(directory, 'routes.json')) });
  const binding = await routes.upsertBinding({ kind: 'channel', surfaceKind: 'telegram', surfaceId: 'synthetic_bot', externalId: '42', channelId: '42' });
  const broker = new SharedSessionBroker({ storePath: join(directory, 'broker.json'), routeBindings: routes,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false } });
  cleanups.push(() => broker.stop());
  const approvals = new ApprovalBroker({ storePath: join(directory, 'approvals.json') });
  const owner: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'synthetic-workspace-owner',
    principalId: 'pairing:synthetic-workspace-owner', authorityId: 'pairing:synthetic-workspace-owner',
    authorityRevision: 'synthetic-workspace-owner', scopes: ['read:work-ledger', 'write:work-ledger'] };
  const authority: NativeExecutionAuthority = { current: () => owner,
    withCurrent: async (_expected, use) => use(() => owner) };
  let reroot: (path: string) => void | Promise<void> = () => {};
  const rerootCalls: string[] = [];
  const manager = new WorkspaceSwapManager(initialRoot, { runtimeBus, daemonHomeDir: join(directory, 'daemon'),
    getBusySessionCount: () => broker.countBusySessions(),
    rerootStores: async path => { rerootCalls.push(path); await reroot(path); } });
  const construct = (workspaceRoot = manager.getCurrentWorkingDir(), swapManager: WorkspaceSwapManagerLike | null = manager) => {
    const runtime = { sessionBroker: broker, approvalBroker: approvals, routeBindings: routes, runtimeBus,
      gatewayMethods: new GatewayMethodCatalog(), runtimeServices: { workingDirectory: workspaceRoot,
        shellPaths: createShellPathService({ workingDirectory: workspaceRoot, homeDirectory: directory }) },
    } as unknown as ResolvedDaemonFacadeRuntime;
    const host = composeDelegatedTelegramIntake(runtime, accounts.reader, swapManager);
    cleanups.push(() => host.close());
    return host;
  };
  let message = 0;
  const accept = async (host: DelegatedTelegramIntake, readOriginal = () => original) => {
    const account = await lease.acquire();
    expect(account).not.toBeNull();
    return host.accept({ binding: routes.getBinding(binding.id)!, chatId: '42', providerMessageId: String(++message),
      account: account!, readOriginal });
  };
  const approve = async (host: DelegatedTelegramIntake) => {
    const pending = await accept(host) as PendingSource;
    expect(pending.ref).toBeDefined();
    expect(await host.decide({ ref: pending.ref, approvalId: pending.approvalId, approved: true, choices }, authority)).toMatchObject({ outcome: 'transferred' });
    expect(await host.status(pending.ref, authority, true)).toMatchObject({ source: 'available-in-memory', original: { text: original } });
    return pending;
  };
  const emitStarted = async (to = replacementRoot) => {
    runtimeBus.emit('workspace', createEventEnvelope('WORKSPACE_SWAP_STARTED', {
      type: 'WORKSPACE_SWAP_STARTED' as const, from: manager.getCurrentWorkingDir(), to,
    }, { sessionId: '', source: 'synthetic-workspace-transition' }));
    // RuntimeEventBus deliberately delivers subscribers in microtasks.
    await Promise.resolve();
  };
  return { initialRoot, replacementRoot, authority, broker, construct, accept, approve, emitStarted, runtimeBus, manager, rerootCalls,
    onReroot: (callback: typeof reroot) => { reroot = callback; } };
}

test('real workspace swap retires approved originals synchronously before reroot starts or bus listeners run', async () => {
  const f = await fixture(); const host = f.construct();
  const configured = await host.configure(configuration, f.authority); const pending = await f.approve(host);
  const before = await host.status(pending.ref, f.authority, true) as { record: { workspaceRevision: string } };
  expect(f.broker.countBusySessions()).toBe(0);
  let noticeDelivered = false;
  const unsubscribe = f.runtimeBus.on('WORKSPACE_SWAP_STARTED', () => { noticeDelivered = true; });
  cleanups.push(unsubscribe);
  f.onReroot(path => {
    expect(path).toBe(f.replacementRoot);
    expect(f.manager.getCurrentWorkingDir()).toBe(f.initialRoot);
    expect(noticeDelivered).toBe(false);
    // revoke is synchronous: this cannot pass by yielding to the bus callback.
    expect(() => host.revoke(configured.configurationId as string, f.authority)).toThrow('fresh workspace construction');
  });
  expect(await f.manager.requestSwap(f.replacementRoot)).toEqual({ ok: true, previous: f.initialRoot, current: f.replacementRoot });
  expect(noticeDelivered).toBe(true);
  await expect(host.status(pending.ref, f.authority, true)).rejects.toThrow('fresh workspace construction');
  await expect(host.list(f.authority)).rejects.toThrow('fresh workspace construction');
  let reads = 0;
  expect(await f.accept(host, () => { reads++; return original; })).toMatchObject({ outcome: 'held' });
  expect(reads).toBe(0);
  expect(await host.selects('42')).toBe(true);

  host.startLifecycle();
  await expect(host.configure(configuration, f.authority)).rejects.toThrow('fresh workspace construction');
  await expect(host.status(pending.ref, f.authority, true)).rejects.toThrow('fresh workspace construction');

  const fresh = f.construct();
  expect(await fresh.list(f.authority)).toMatchObject({ records: [], pending: [] });
  expect(await fresh.selects('42')).toBe(false);
  await fresh.configure(configuration, f.authority); const next = await f.approve(fresh);
  const after = await fresh.status(next.ref, f.authority, true) as { record: { workspaceRevision: string } };
  expect(after.record.workspaceRevision).not.toBe(before.record.workspaceRevision);
});

test('current-root mismatch fences the host even when no workspace event was observed', async () => {
  const f = await fixture(); let currentRoot = f.initialRoot;
  const host = f.construct(f.initialRoot, { getCurrentWorkingDir: () => currentRoot,
    getWorkspaceRevision: () => f.manager.getWorkspaceRevision(),
    subscribeBeforeSwap: listener => f.manager.subscribeBeforeSwap(listener), requestSwap: path => f.manager.requestSwap(path) });
  await host.configure(configuration, f.authority); const pending = await f.approve(host);
  currentRoot = f.replacementRoot;
  await expect(host.status(pending.ref, f.authority, true)).rejects.toThrow('fresh workspace construction');
  currentRoot = f.initialRoot; host.startLifecycle();
  await expect(host.configure(configuration, f.authority)).rejects.toThrow('fresh workspace construction');
  await expect(host.list(f.authority)).rejects.toThrow('fresh workspace construction');
});

test('same-root stop/start supports fresh approval and reinstalls workspace invalidation', async () => {
  const f = await fixture(); const host = f.construct();
  await host.configure(configuration, f.authority); const first = await f.approve(host);
  host.close(); host.startLifecycle();
  expect(await host.status(first.ref, f.authority, true)).toMatchObject({ source: 'expired-or-lost', recovery: 'new-original-required' });
  let reads = 0;
  expect(await f.accept(host, () => { reads++; return original; })).toMatchObject({ outcome: 'held' });
  expect(reads).toBe(0);
  const configured = await host.configure(configuration, f.authority); const next = await f.approve(host);
  f.onReroot(() => {
    expect(() => host.revoke(configured.configurationId as string, f.authority)).toThrow('fresh workspace construction');
  });
  // A real reroot is a transition even if its pathname is unchanged.
  expect(await f.manager.requestSwap(f.initialRoot)).toMatchObject({ ok: true, current: f.initialRoot });
  await expect(host.status(next.ref, f.authority, true)).rejects.toThrow('fresh workspace construction');
  host.startLifecycle();
  await expect(host.configure(configuration, f.authority)).rejects.toThrow('fresh workspace construction');
});

test('failed reroot cannot revive a host even though the manager retains its original root', async () => {
  const f = await fixture(); const host = f.construct();
  const configured = await host.configure(configuration, f.authority); const pending = await f.approve(host);
  f.onReroot(() => {
    expect(() => host.revoke(configured.configurationId as string, f.authority)).toThrow('fresh workspace construction');
    throw new Error('Synthetic reroot failure');
  });
  expect(await f.manager.requestSwap(f.replacementRoot)).toMatchObject({ ok: false, code: 'INVALID_PATH' });
  expect(f.manager.getCurrentWorkingDir()).toBe(f.initialRoot);
  host.startLifecycle();
  await expect(host.status(pending.ref, f.authority, true)).rejects.toThrow('fresh workspace construction');
  await expect(host.configure(configuration, f.authority)).rejects.toThrow('fresh workspace construction');
  const fresh = f.construct();
  expect(await fresh.status(pending.ref, f.authority, true)).toMatchObject({ source: 'expired-or-lost' });
  await fresh.configure(configuration, f.authority); await f.approve(fresh);
});

test('a throwing synchronous fence prevents workspace mutation and reports failure', async () => {
  const f = await fixture(); const notices: string[] = [];
  const unsubscribe = f.runtimeBus.onDomain('workspace', envelope => { notices.push(envelope.type); });
  cleanups.push(unsubscribe);
  const detach = f.manager.subscribeBeforeSwap(() => { throw new Error('Synthetic fence failure'); });
  expect(await f.manager.requestSwap(f.replacementRoot)).toMatchObject({ ok: false,
    reason: 'Workspace transition fence failed; no workspace stores were re-rooted.' });
  expect(f.manager.getWorkspaceRevision()).toBe(1);
  expect(f.rerootCalls).toEqual([]);
  expect(existsSync(f.replacementRoot)).toBe(false);
  expect(f.manager.getCurrentWorkingDir()).toBe(f.initialRoot);
  expect(notices).toEqual(['WORKSPACE_SWAP_FAILED']);
  detach();
  let nested: Promise<WorkspaceSwapResult> | undefined;
  f.manager.subscribeBeforeSwap(() => { nested = f.manager.requestSwap(f.initialRoot); });
  expect(await f.manager.requestSwap(f.replacementRoot)).toMatchObject({ ok: true });
  expect(f.manager.getWorkspaceRevision()).toBe(2);
  expect(await nested).toMatchObject({ ok: false, code: 'WORKSPACE_BUSY' });
  expect(f.rerootCalls).toEqual([f.replacementRoot]);
});

test('a busy refusal preserves intake because no workspace transition was admitted', async () => {
  const f = await fixture(); const host = f.construct();
  await host.configure(configuration, f.authority); const pending = await f.accept(host) as PendingSource;
  expect(await f.manager.requestSwap(f.replacementRoot)).toMatchObject({ ok: false, code: 'WORKSPACE_BUSY' });
  expect(f.manager.getWorkspaceRevision()).toBe(0);
  expect(f.rerootCalls).toEqual([]);
  expect(await host.decide({ ref: pending.ref, approvalId: pending.approvalId, approved: true, choices }, f.authority)).toMatchObject({ outcome: 'transferred' });
  expect(await host.status(pending.ref, f.authority, true)).toMatchObject({ source: 'available-in-memory' });
});

test('mutable managers without a synchronous hook cannot create a delegated grant', async () => {
  const f = await fixture();
  const host = f.construct(f.initialRoot, { getCurrentWorkingDir: () => f.initialRoot,
    getWorkspaceRevision: () => f.manager.getWorkspaceRevision(), requestSwap: path => f.manager.requestSwap(path) });
  await expect(host.configure(configuration, f.authority)).rejects.toThrow('fresh workspace construction');
  let reads = 0;
  expect(await f.accept(host, () => { reads++; return original; })).toMatchObject({ outcome: 'held' });
  expect(reads).toBe(0);
});

test('mutable managers without a revision fence cannot create a delegated grant', async () => {
  const f = await fixture();
  const host = f.construct(f.initialRoot, { getCurrentWorkingDir: () => f.initialRoot,
    subscribeBeforeSwap: listener => f.manager.subscribeBeforeSwap(listener), requestSwap: path => f.manager.requestSwap(path) });
  await expect(host.configure(configuration, f.authority)).rejects.toThrow('fresh workspace construction');
});

test.each(['same-root', 'round-trip'] as const)('a stopped host cannot revive after an unobserved %s workspace transition', async kind => {
  const f = await fixture(); const host = f.construct();
  await host.configure(configuration, f.authority); const pending = await f.approve(host);
  expect(f.manager.getWorkspaceRevision()).toBe(0);
  host.close();
  if (kind === 'round-trip') expect(await f.manager.requestSwap(f.replacementRoot)).toMatchObject({ ok: true });
  expect(await f.manager.requestSwap(f.initialRoot)).toMatchObject({ ok: true });
  expect(f.manager.getCurrentWorkingDir()).toBe(f.initialRoot);
  expect(f.manager.getWorkspaceRevision()).toBe(kind === 'same-root' ? 1 : 2);
  host.startLifecycle();
  await expect(host.configure(configuration, f.authority)).rejects.toThrow('fresh workspace construction');
  await expect(host.status(pending.ref, f.authority, true)).rejects.toThrow('fresh workspace construction');
  const fresh = f.construct();
  await fresh.configure(configuration, f.authority); await f.approve(fresh);
});

test('a fixed-root host without a swap manager can still explicitly configure and approve', async () => {
  const f = await fixture(); const host = f.construct(f.initialRoot, null);
  expect(await host.configure(configuration, f.authority)).toHaveProperty('configurationId');
  await f.approve(host);
});

test('the async workspace notice remains a defensive fence for transitions outside the manager', async () => {
  const f = await fixture(); const host = f.construct();
  await host.configure(configuration, f.authority); const pending = await f.approve(host);
  await f.emitStarted();
  await expect(host.status(pending.ref, f.authority, true)).rejects.toThrow('fresh workspace construction');
});
