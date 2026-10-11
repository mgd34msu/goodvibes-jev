import { afterEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import type { OwnedInboxSource, OwnedInboxTagging } from '@goodvibes-jev/engine/sdk/platform/intake';
import { attachDaemonInboxTagging, type DaemonTriagePermissionHost } from '../../runtime/tagged-inbox-composition.js';
import { registerOwnedMailInbox } from '../../runtime/owned-inbox-mail.js';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { RoutingRegistration } from '../../daemon/handlers/index.js';
import type { DaemonInboxControls } from '../../runtime/daemon-handler-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function source(ready = Promise.resolve()) {
  let closed = 0;
  const owner: OwnedInboxSource = { providerIds: ['slack'], ready, async acquireRead() { throw new Error('No unsolicited read'); }, async close() { closed++; }, unregister() {} };
  return { owner, get closed() { return closed; } };
}
function tagging() {
  let closed = false, closes = 0, applied = 0;
  let pending: Promise<void> | undefined;
  const owner: OwnedInboxTagging = { async applyTags() { if (closed) throw new Error('retired'); applied++; }, close() { closed = true; closes++; return pending ?? Promise.resolve(); } };
  return { owner, hold(promise: Promise<void>) { pending = promise; }, get closes() { return closes; }, get applied() { return applied; } };
}
const request = { provider: 'slack' as const, accountScopeId: 'real-owner-scope', assertCurrent() {} };
test('onReady is explicit, occurs only after source readiness, and does not write', async () => {
  const gate = Promise.withResolvers<void>(), f = source(gate.promise), tags = tagging();
  let delivered: OwnedInboxTagging | undefined;
  const wrapped = await attachDaemonInboxTagging(f.owner, { onReady(owner) { delivered = owner; } }, { createTriageTagging(input) { expect(input.source).toBe(f.owner); expect(input.accountScopeId).toBe('real-owner-scope'); return tags.owner; } }, request);
  cleanups.push(() => wrapped.close()); expect(delivered).toBeUndefined(); expect(tags.applied).toBe(0);
  gate.resolve(); await wrapped.ready; expect(delivered).toBeDefined(); expect(Object.keys(delivered!).sort()).toEqual(['applyTags', 'close']); expect(tags.applied).toBe(0);
});
test('close fences new tag work immediately and drains tags before retiring source', async () => {
  const f = source(), tags = tagging(), gate = Promise.withResolvers<void>(); tags.hold(gate.promise);
  let handle!: OwnedInboxTagging;
  const wrapped = await attachDaemonInboxTagging(f.owner, { onReady(owner) { handle = owner; } }, { createTriageTagging: () => tags.owner }, request);
  await wrapped.ready; const close = wrapped.close(); expect(wrapped.close()).toBe(close);
  await expect(handle.applyTags('slack:C1:1.2', ['GoodVibes/Priority'], { sourceOf: () => ({ goal: 'Apply requested tag', criteria: [] }), assertCurrent() {} })).rejects.toThrow('retired');
  expect(f.closed).toBe(0); gate.resolve(); await close; expect(f.closed).toBe(1);
});
test('source or callback failure retires the tagging and source owners', async () => {
  for (const failsReady of [true, false]) {
    const f = source(failsReady ? Promise.reject(new Error('source failed')) : Promise.resolve()), tags = tagging();
    const wrapped = await attachDaemonInboxTagging(f.owner, { onReady() { throw new Error('callback failed'); } }, { createTriageTagging: () => tags.owner }, request);
    await expect(wrapped.ready).rejects.toThrow(); expect(tags.closes).toBe(1); expect(f.closed).toBe(1);
  }
});
test('mismatched provider source never receives a tagging capability', async () => {
  const f = source(); let created = 0;
  await expect(attachDaemonInboxTagging(f.owner, { onReady() {} }, { createTriageTagging() { created++; return tagging().owner; } }, { ...request, provider: 'email' })).rejects.toThrow('one exact owned source');
  expect(created).toBe(0); expect(f.closed).toBe(1);
});
test('retirement before readiness cannot publish a stale handle', async () => {
  const gate = Promise.withResolvers<void>(), f = source(gate.promise), tags = tagging(); let delivered = 0;
  const wrapped = await attachDaemonInboxTagging(f.owner, { onReady() { delivered++; } }, { createTriageTagging: () => tags.owner }, request);
  await wrapped.close(); gate.resolve(); await expect(wrapped.ready).rejects.toThrow('retired'); expect(delivered).toBe(0);
});
function rootFixture() {
  const directory = makeOwnedTempDir('tagging-root-lifecycle');
  const config = new ConfigManager({ workingDir: directory, homeDir: directory, surfaceRoot: 'daemon' });
  const log = new SqliteDecisionLog(':memory:'); cleanups.push(() => log[Symbol.dispose]());
  const fake = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const host: DaemonTriagePermissionHost = { permissionManager: new PermissionManager(undefined, createPermissionConfigReader(config), new PolicyRuntimeState()), port: withDecisionLog(fake.port, log), signal: new AbortController().signal };
  const configs = new Set<() => void>(), secrets = new Set<(key: string) => void>();
  let reads = 0;
  const input = { configManager: { get() { return undefined; }, onDidInvalidate(listener: () => void) { configs.add(listener); return () => { configs.delete(listener); }; } }, secretsManager: {
    async get() { reads++; return 'synthetic'; }, resolveLocalCredentialSnapshot() { return { state: 'resolved' as const, value: 'synthetic', revision: 'synthetic-revision' }; },
    onDidChange(listener: (key: string) => void) { secrets.add(listener); return () => { secrets.delete(listener); }; },
  } };
  return { host, input, configs, secrets, get reads() { return reads; } };
}
const context = {} as HandlerContext, routing = {} as RoutingRegistration;
test('canonical root subscribes before async factory startup and startup ABA refuses tag ownership', async () => {
  const f = rootFixture(); const ready = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let captured!: DaemonInboxControls;
  const creating = registerOwnedMailInbox(async (_context, _routing, controls) => {
    captured = controls; expect(f.configs.size).toBe(1); expect(f.secrets.size).toBe(1); entered.resolve(); await ready.promise;
    controls.createTriageTagging!({ ...request, source: source().owner });
    return { async close() {} };
  }, context, routing, { gatePolling() {} }, f.input, f.host);
  await entered.promise; for (const listener of f.secrets) { listener('alias'); listener('alias'); }
  ready.resolve(); await expect(creating).rejects.toThrow('revoked'); expect(f.reads).toBe(0); expect(f.configs.size).toBe(0); expect(f.secrets.size).toBe(0);
  expect(() => captured.createTriageTagging!({ ...request, source: source().owner })).toThrow();
});
test('unused explicit root capability performs no credential reads and all subscriptions retire', async () => {
  const f = rootFixture(); const registration = await registerOwnedMailInbox(() => ({ async close() {} }), context, routing, { gatePolling() {} }, f.input, f.host);
  expect(f.reads).toBe(0); await registration.close(); expect(f.configs.size).toBe(0); expect(f.secrets.size).toBe(0);
});
