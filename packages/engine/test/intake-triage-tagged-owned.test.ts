import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { createOwnedInboxTagging } from '../sdk/src/platform/intake/triage/tagged-owned.ts';
import { createTriageTagger } from '../sdk/src/platform/intake/triage/tagger/index.ts';
import type { OwnedInboxSource } from '../sdk/src/platform/intake/registration.ts';
import type { InboundChannelItem } from '../sdk/src/platform/intake/provider-adapter.ts';
import { judgmentInputProblem } from '../sdk/src/platform/gate/judgment-input.js';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';
let log: SqliteDecisionLog, port: JudgmentPort, restore: ReturnType<typeof installJudgmentPort>;
let readings: unknown[];
let disposition: string, onRead: (() => void | Promise<void>) | undefined;
beforeEach(() => {
 forgetGateReadings(); readings = []; disposition = 'act'; onRead = undefined; log = new SqliteDecisionLog(':memory:');
 const gate = gateReadingsPort(), semantic = fakePort((_name, question) => choiceAnswer(question, disposition, 0.99));
 port = withDecisionLog({ model: gate.port.model, async ask(request) { readings.push(request.state); request.beforeAttempt?.(); await onRead?.(); request.beforeAttempt?.(); return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request); } }, log);
 restore = installJudgmentPort(port);
});
afterEach(() => { installJudgmentPort(restore); log[Symbol.dispose](); forgetGateReadings(); });
function fixture(options: { provider?: 'slack' | 'discord'; id?: string } = {}) {
 const provider = options.provider ?? 'slack';
 const targets: string[] = [];
 let row: InboundChannelItem = { id: options.id ?? 'slack:C123:123.456', provider, kind: 'dm', fromDigest: '0123456789abcdef', subjectPreview: 'Protected', bodyPreview: 'Preview must not become mutation judgment input', receivedAt: 1, unread: true };
 let credentials = 'synthetic-token', epoch = 0, writes = 0, released = 0, humans = 0;
 const listeners = new Set<() => void>();
 const signal = new AbortController().signal;
 const source: OwnedInboxSource = { providerIds: [provider], ready: Promise.resolve(), close: async () => {}, unregister() {}, async acquireRead() { return { providerIds: [provider], sources: { store: { listItems: () => [structuredClone(row)], countItems: () => 1, countItemsByProvider: () => new Map([[provider, 1]]), maxReceivedAt: () => 1, getImapCheckpoint: () => null }, poller: { snapshotStatuses: () => [], isProviderRunning: () => false } }, validate: async () => {}, assertCurrent() {}, release() { released++; } }; } };
 const manager = new PermissionManager(async () => { humans++; throw new Error('No human fallback'); }, { isAutoApproveEnabled: () => false, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic', getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic' }) } as PermissionConfigReader, new PolicyRuntimeState());
 const tagger = createTriageTagger({ provider, accountScopeId: 'account', credentials: { resolveRef: async () => null, resolveConfigSecret: async () => credentials }, credentialKey: 'synthetic', captureCredential() { const expected = epoch; return { value: credentials, assertCurrent() { if (expected !== epoch) throw new Error('credential changed'); } }; }, signal, assertCurrent() {}, http: (async (url: string | URL | Request) => { targets.push(String(url)); writes++; return provider === 'discord' ? new Response(null, { status: 204 }) : new Response('{"ok":true}'); }) as unknown as typeof fetch });
 const owner = createOwnedInboxTagging({ source, tagger, permissionManager: manager, port, signal, assertCurrent() {}, onInvalidate(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } });
 const operation = { sourceOf: () => ({ goal: 'Apply the priority triage label to the selected Slack message', criteria: ['Only change this message'] }), assertCurrent() {} };
 return { owner, tagger, operation, source, targets, mutate: () => { row.bodyPreview = 'new exact input'; }, pendingRotate: () => { epoch++; credentials = "pending-new"; }, rotate: () => { epoch++; credentials = 'new-token'; for (const listener of listeners) listener(); }, counts: () => ({ writes, released, humans, listeners: listeners.size }) };
}
test('owned exact mirrored mutation gets authentic fresh recorded admission, with no human', async () => {
 const f = fixture(); await f.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], f.operation);
 expect(f.counts()).toEqual({ writes: 1, released: 1, humans: 0, listeners: 0 }); await f.owner.close(); await f.tagger.close();
});
test('Jev reject has zero provider calls and no human fallback', async () => {
 disposition = 'reject'; const f = fixture(); await expect(f.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.counts().writes).toBe(0); expect(f.counts().humans).toBe(0);
});
test('same-ID exact row change during judgment revokes mutation', async () => {
 const f = fixture(); onRead = f.mutate; await expect(f.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.counts().writes).toBe(0); expect(f.counts().released).toBe(1);
});
test('credential ABA/config invalidation during judgment revokes mutation', async () => {
 const f = fixture(); onRead = f.rotate; await expect(f.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.counts().writes).toBe(0);
});
test('unmirrored target cannot manufacture an operation', async () => {
 const f = fixture(); await expect(f.owner.applyTags('slack:C999:123.456', ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.counts().writes).toBe(0);
});
test('source method replacement cannot replace constructor-bound ownership', async () => {
 const f = fixture(); f.source.acquireRead = async () => { throw new Error('substituted'); };
 await f.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], f.operation); expect(f.counts().writes).toBe(1);
});
test('close aborts and drains accepted work before returning', async () => {
 const f = fixture(); let release!: () => void, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; }); onRead = async () => { entered(); await wait; };
 const pending = f.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], f.operation).catch(() => {}); await started;
 let closed = false; const close = f.owner.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false); release(); await pending; await close; expect(f.counts().writes).toBe(0);
 await expect(f.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], f.operation)).rejects.toThrow();
});

test('pending credential mutation without post-success notification invalidates prior preparation', async () => {
 const f = fixture(); onRead = f.pendingRotate;
 await expect(f.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.counts().writes).toBe(0);
});


// These are actual snowflakes derived from 2026-10-10T01:00:00Z plus 0, 3 and
// 79 milliseconds (Discord epoch and shift), not numbers chosen to evade PAN checks.
test.each(['1558282921574400000', '1558282921586982912', '1558282921905750016'])('owned Discord protocol ID %s is kept local while the exact effect is admitted', async message => {
 const id = `discord:100000000000000002:${message}`;
 expect(judgmentInputProblem({ itemId: id })).toBe('card-material');
 const f = fixture({ provider: 'discord', id });
 try {
  await f.owner.applyTags(id, ['GoodVibes/Priority'], f.operation);
  expect(f.counts().writes).toBe(1); expect(f.counts().humans).toBe(0);
  expect(f.targets[0]).toContain(`/channels/100000000000000002/messages/${message}/reactions/`);
  const evidence = JSON.stringify(readings);
  expect(evidence).not.toContain(message); expect(evidence).not.toContain('100000000000000002');
  expect(evidence).toContain('GoodVibes/Priority'); expect(evidence).toContain('discord');
 } finally { await f.owner.close(); await f.tagger.close(); }
});

test('card-bearing semantic task text remains refused despite a legitimate owned protocol target', async () => {
 const id = 'discord:100000000000000002:1558282921574400000';
 const f = fixture({ provider: 'discord', id });
 try {
  await expect(f.owner.applyTags(id, ['GoodVibes/Priority'], { ...f.operation,
   sourceOf: () => ({ goal: 'Use payment card 4111111111111111 to perform this task', criteria: ['Only this message'] }),
  })).rejects.toThrow();
  expect(f.counts().writes).toBe(0); expect(f.counts().humans).toBe(0);
  expect(JSON.stringify(readings)).not.toContain('4111111111111111');
 } finally { await f.owner.close(); await f.tagger.close(); }
});


function mutationReferences() {
 const found: Array<{ provider: string; accountRef: string; targetRef: string; kind: string; tags: string[] }> = [];
 const visit = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
  const object = value as Record<string, unknown>;
  if (typeof object['accountRef'] === 'string' && typeof object['targetRef'] === 'string') found.push(object as typeof found[number]);
  for (const entry of Object.values(object)) visit(entry);
 };
 visit(readings); return found;
}

test('operation references cannot be reused or transplanted as targets and each successful admission is fresh', async () => {
 const a = fixture(), b = fixture();
 try {
  await a.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], a.operation);
  const first = mutationReferences()[0];
  expect(first).toMatchObject({ provider: 'slack', kind: 'dm', tags: ['GoodVibes/Priority'] });
  if (!first) throw new Error('Missing semantic target reference');
  for (const target of [first.targetRef, first.accountRef]) {
   await expect(a.owner.applyTags(target, ['GoodVibes/Priority'], a.operation)).rejects.toThrow('unavailable');
   await expect(b.owner.applyTags(target, ['GoodVibes/Priority'], b.operation)).rejects.toThrow('unavailable');
  }
  expect(a.counts().writes).toBe(1); expect(b.counts().writes).toBe(0);
  readings = [];
  await a.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], a.operation);
  const second = mutationReferences()[0]!;
  expect(second.accountRef).toBe(first.accountRef); expect(second.targetRef).not.toBe(first.targetRef);
  readings = [];
  await b.owner.applyTags('slack:C123:123.456', ['GoodVibes/Priority'], b.operation);
  const foreign = mutationReferences()[0]!;
  expect(foreign.accountRef).not.toBe(first.accountRef); expect(foreign.targetRef).not.toBe(first.targetRef);
 } finally { await a.owner.close(); await a.tagger.close(); await b.owner.close(); await b.tagger.close(); }
});
