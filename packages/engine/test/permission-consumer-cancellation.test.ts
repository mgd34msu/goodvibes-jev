import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { UserPermissionRuleStore } from '../sdk/src/platform/permissions/user-rule-store.ts';
import type { PermissionPromptDecision, PermissionPromptRequest, PermissionRequestHandler } from '../sdk/src/platform/permissions/prompt.ts';

const PRIVATE_REASON = 'synthetic private consumer reason';
const args = { files: [{ path: 'synthetic.txt', content: 'synthetic content' }] };
const request = (id: string): PermissionPromptRequest => ({
  callId: id, tool: 'write', args, category: 'write',
  analysis: { classification: 'write', riskLevel: 'medium', summary: 'Synthetic write', reasons: [] },
});
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Synthetic approval did not settle'); await turn(); }
}
const caught = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);
function cancelled(error: unknown): void {
  expect(error).toMatchObject({ name: 'JudgmentError', kind: 'aborted', message: 'the permission request was cancelled' });
  expect((error as Error).cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(PRIVATE_REASON);
}
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort((name, question) => {
  if (name === 'family') return choiceAnswer(question, 'file-mutation', 0.99);
  if (name === 'mutates') return noulAnswer(0.99);
  if (['outward', 'secrets', 'irreversible', 'beyondProject', 'weakensSecurity', 'cardDetails'].includes(name)) return noulAnswer(0.01);
  throw new Error(`Unscripted permission reading: ${name}`);
}).port); });
afterEach(() => { installJudgmentPort(previous); });
function manager(handler: PermissionRequestHandler, store: UserPermissionRuleStore) {
  return new PermissionManager(handler, {
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic',
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as PermissionConfigReader, { recordPermissionRequest() {}, recordPermissionDecision() {}, getRegistry: () => ({ getCurrent: () => undefined }) } as never, null, null, store);
}

test('one explicit coalesced consumer cancels without dismissing the other consumer', async () => {
  const broker = new ApprovalBroker({ storePath: ':memory:' }); await broker.start();
  const held = deferred<PermissionPromptDecision>();
  const first = new AbortController(); const second = new AbortController();
  let promptSignal: AbortSignal | undefined; let prompts = 0;
  const abandoned = caught(broker.requestApproval({ request: request('first'), signal: first.signal, sessionId: 'shared', localPrompt: (_request, options) => {
    prompts++; promptSignal = options?.signal; return held.promise;
  } }));
  await until(() => prompts === 1);
  const active = broker.requestApproval({ request: request('second'), signal: second.signal, sessionId: 'shared' }); await turn();
  first.abort(new Error(PRIVATE_REASON)); cancelled(await abandoned);
  expect(promptSignal!.aborted).toBe(false); expect(second.signal.aborted).toBe(false); expect(prompts).toBe(1);
  expect(broker.listApprovals()).toHaveLength(1); expect(broker.listApprovals()[0]!.status).toBe('pending');
  held.resolve({ approved: true, rememberTier: 'tool' });
  expect(await active).toMatchObject({ approved: true, rememberTier: 'tool' });
  expect(broker.listApprovals()[0]!.status).toBe('approved');
});

test('all coalesced consumers cancel, retire the shared prompt, and reject its late remember reply', async () => {
  const broker = new ApprovalBroker({ storePath: ':memory:' }); await broker.start();
  const held = deferred<PermissionPromptDecision>(); let promptSignal: AbortSignal | undefined;
  const first = new AbortController(); const second = new AbortController();
  const one = caught(broker.requestApproval({ request: request('first'), signal: first.signal, localPrompt: (_request, options) => {
    promptSignal = options?.signal; return held.promise;
  } }));
  await until(() => promptSignal !== undefined);
  const two = caught(broker.requestApproval({ request: request('second'), signal: second.signal })); await turn();
  expect(broker.listApprovals()).toHaveLength(1);
  first.abort(new Error(PRIVATE_REASON)); second.abort(new Error(PRIVATE_REASON));
  cancelled(await one); cancelled(await two);
  await until(() => broker.listApprovals()[0]?.status === 'cancelled');
  expect(promptSignal!.aborted).toBe(true);
  held.resolve({ approved: true, rememberTier: 'tool' }); await turn();
  const approval = broker.listApprovals()[0]!;
  expect((await broker.resolveApproval(approval.id, { approved: true, rememberTier: 'tool', actor: 'synthetic' }))!.status).toBe('cancelled');
  expect(approval.decision).toMatchObject({ approved: false, remember: false });
});

test('an unrequested permission handler cannot delay the owner or persist a grant', async () => {
  const store = new UserPermissionRuleStore(':memory:'); let asks = 0;
  const permissions = manager(() => { asks++; return new Promise(() => {}); }, store);
  expect(await permissions.checkDetailed('write', args)).toMatchObject({ approved: true, sourceLayer: 'config_policy', persisted: false });
  expect(asks).toBe(0); expect(store.list()).toEqual([]);
  const controller = new AbortController(); controller.abort(new Error(PRIVATE_REASON));
  cancelled(await caught(permissions.checkDetailed('write', args, undefined, { signal: controller.signal })));
  expect(asks).toBe(0);
});

test('broker captures the original signal before its first await even if the input is changed', async () => {
  const broker = new ApprovalBroker({ storePath: ':memory:' }); await broker.start();
  const controller = new AbortController();
  const input = { request: request('original'), signal: controller.signal };
  const result = caught(broker.requestApproval(input));
  input.signal = new AbortController().signal; controller.abort(new Error(PRIVATE_REASON));
  cancelled(await result); await turn();
  expect(broker.listApprovals()).toHaveLength(0);
});

test('a wire-raised approval remains live when its coalesced in-process consumer cancels', async () => {
  const broker = new ApprovalBroker({ storePath: ':memory:' }); await broker.start();
  const wire = await broker.raiseApproval({ request: request('wire') });
  const controller = new AbortController();
  const result = caught(broker.requestApproval({ request: request('consumer'), signal: controller.signal })); await turn();
  controller.abort(new Error(PRIVATE_REASON)); cancelled(await result); await turn();
  expect(broker.getApproval(wire.approval.id)!.status).toBe('pending');
  await broker.resolveApproval(wire.approval.id, { approved: true, actor: 'synthetic-wire' });
  expect((await wire.decision).approved).toBe(true);
});

for (const timed of [false, true]) test(`a restored ${timed ? 'timed' : 'untimed'} approval keeps its durable owner`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'permission-restored-owner-')); const path = join(root, 'approvals.json');
  const first = new ApprovalBroker({ storePath: path }); await first.start();
  const raised = await first.raiseApproval({ request: request('restored'), ...(timed ? { timeoutMs: 60_000 } : {}) });
  const restored = new ApprovalBroker({ storePath: path }); await restored.start();
  try {
    const controller = new AbortController();
    const result = caught(restored.requestApproval({ request: request('consumer'), signal: controller.signal })); await turn();
    controller.abort(new Error(PRIVATE_REASON)); cancelled(await result); await turn();
    expect(restored.listApprovals()).toHaveLength(1); expect(restored.getApproval(raised.approval.id)!.status).toBe('pending');
    expect((await restored.resolveApproval(raised.approval.id, { approved: true, actor: 'synthetic-restored' }))!.status).toBe('approved');
  } finally { await first.cancelApproval(raised.approval.id, 'synthetic-cleanup'); await raised.decision; rmSync(root, { recursive: true, force: true }); }
});

test('the explicit broker drains late prompt rejection after its consumer cancels', async () => {
  const broker = new ApprovalBroker({ storePath: ':memory:' }); await broker.start();
  const held = deferred<PermissionPromptDecision>(); const controller = new AbortController(); let asked = false;
  const pending = caught(broker.requestApproval({ request: request('late-failure'), signal: controller.signal, localPrompt: () => { asked = true; return held.promise; } }));
  await until(() => asked); controller.abort(new Error(PRIVATE_REASON)); cancelled(await pending);
  held.reject(new Error('synthetic late prompt failure')); await turn();
  expect(broker.listApprovals()[0]!.status).toBe('cancelled');
});

for (const cancelAll of [false, true]) test(`cancellation during initial persistence preserves ${cancelAll ? 'no abandoned prompt' : 'the other prompt owner'}`, async () => {
  const { PersistentStore } = await import('../sdk/src/platform/state/persistent-store.ts');
  type Snapshot = { approvals: readonly import('../sdk/src/platform/control-plane/approval-broker.ts').SharedApprovalRecord[] };
  const entered = deferred<void>(); const release = deferred<void>(); const answer = deferred<PermissionPromptDecision>();
  class DelayedStore extends PersistentStore<Snapshot> {
    count = 0;
    override async persist(snapshot: Snapshot): Promise<void> {
      if (++this.count === 1) { entered.resolve(); await release.promise; }
      return super.persist(snapshot);
    }
  }
  const store = new DelayedStore(':memory:'); const broker = new ApprovalBroker({ store }); await broker.start();
  const first = new AbortController(); const second = new AbortController(); let prompts = 0;
  const one = caught(broker.requestApproval({ request: request('creator'), signal: first.signal, localPrompt: () => { prompts++; return answer.promise; } }));
  await entered.promise;
  const rawTwo = broker.requestApproval({ request: request('joiner'), signal: second.signal });
  const two = rawTwo.then((value) => value, (error: unknown) => error); await turn();
  try {
    first.abort(new Error(PRIVATE_REASON)); if (cancelAll) second.abort(new Error(PRIVATE_REASON));
    cancelled(await one); if (cancelAll) cancelled(await two);
    expect(prompts).toBe(0);
    release.resolve();
    if (cancelAll) {
      await until(() => broker.listApprovals()[0]?.status === 'cancelled'); await turn();
      expect(prompts).toBe(0);
    } else {
      await until(() => prompts === 1);
      answer.resolve({ approved: true, rememberTier: 'tool' });
      expect(await two).toMatchObject({ approved: true, rememberTier: 'tool' });
    }
  } finally {
    release.resolve(); answer.resolve({ approved: false });
    for (const approval of broker.listApprovals()) if (approval.status === 'pending') await broker.cancelApproval(approval.id, 'synthetic-cleanup');
    await one; await two;
  }
});

test('unrequested callback decision getters cannot install a grant or cancel a check', async () => {
  const controller = new AbortController(); const store = new UserPermissionRuleStore(':memory:'); let asks = 0;
  const permissions = manager(async () => { asks++; return { rememberTier: 'tool', get approved() { controller.abort(); return true; } }; }, store);
  expect(await permissions.checkDetailed('write', args, undefined, { signal: controller.signal })).toMatchObject({ approved: true, persisted: false, sourceLayer: 'config_policy' });
  expect(controller.signal.aborted).toBe(false); expect(asks).toBe(0); expect(store.list()).toEqual([]);
});

test('synchronous retirement blocks an approval still awaiting broker start', async () => {
  const broker = new ApprovalBroker({ storePath: ':memory:' }); await broker.start();
  const controller = new AbortController();
  const raised = await broker.raiseApproval({ request: request('retire-race'), signal: controller.signal });
  const decision = broker.resolveApproval(raised.approval.id, { approved: true, rememberTier: 'tool', actor: 'synthetic' });
  controller.abort(new Error(PRIVATE_REASON)); await decision; await turn();
  expect((await raised.decision).approved).toBe(false);
  expect(broker.getApproval(raised.approval.id)!.status).toBe('cancelled');
});

test('a remembered-rule sweep cannot approve a consumer retired while the decision is projected', async () => {
  const broker = new ApprovalBroker({ storePath: ':memory:' }); await broker.start();
  const controller = new AbortController();
  const winner = await broker.raiseApproval({ request: { ...request('winner'), args: { path: 'winner.txt' } } });
  const candidate = await broker.raiseApproval({ request: { ...request('candidate'), args: { path: 'candidate.txt' } }, signal: controller.signal });
  let actorReads = 0;
  await broker.resolveApproval(winner.approval.id, {
    approved: true, rememberTier: 'tool',
    get actor() { if (++actorReads === 3) controller.abort(new Error(PRIVATE_REASON)); return 'synthetic'; },
  });
  await turn();
  expect(controller.signal.aborted).toBe(true);
  expect((await winner.decision).approved).toBe(true);
  expect((await candidate.decision).approved).toBe(false);
  expect(broker.getApproval(candidate.approval.id)!.status).toBe('cancelled');
});
