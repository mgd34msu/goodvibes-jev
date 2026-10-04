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

test('one coalesced consumer cancels without dismissing the live prompt or its remembered grant', async () => {
  const broker = new ApprovalBroker({ storePath: ':memory:' }); await broker.start();
  const held = deferred<PermissionPromptDecision>();
  const first = new AbortController(); const second = new AbortController();
  const firstStore = new UserPermissionRuleStore(':memory:'); const secondStore = new UserPermissionRuleStore(':memory:');
  let promptSignal: AbortSignal | undefined; let prompts = 0; let joined = 0;
  let next: PermissionPromptDecision | undefined;
  const handler: PermissionRequestHandler = (input, options) => {
    joined++;
    expect(input).not.toHaveProperty('signal');
    return broker.requestApproval({ request: input, signal: options?.signal, sessionId: 'shared', localPrompt: (_request, execution) => {
      prompts++; promptSignal = execution?.signal;
      return next === undefined ? held.promise : Promise.resolve(next);
    } });
  };
  const firstManager = manager(handler, firstStore); const secondManager = manager(handler, secondStore);
  const abandoned = caught(firstManager.checkDetailed('write', args, undefined, { signal: first.signal }));
  await until(() => prompts === 1);
  const active = secondManager.checkDetailed('write', args, undefined, { signal: second.signal });
  await until(() => joined === 2); await turn();
  first.abort(new Error(PRIVATE_REASON)); cancelled(await abandoned);
  expect(promptSignal).toBeDefined(); expect(promptSignal!.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false); expect(prompts).toBe(1);
  expect(broker.listApprovals()).toHaveLength(1); expect(broker.listApprovals()[0]!.status).toBe('pending');
  expect(broker.listApprovals()[0]!.request).not.toHaveProperty('signal');
  held.resolve({ approved: true, rememberTier: 'tool' });
  expect((await active).approved).toBe(true); await turn();
  expect(firstStore.list()).toHaveLength(0); expect(secondStore.list()).toHaveLength(1);
  expect((await secondManager.checkDetailed('write', args)).sourceLayer).toBe('user_rule');
  next = { approved: false };
  expect(await firstManager.checkDetailed('write', args)).toMatchObject({ approved: false, sourceLayer: 'user_prompt' });
  expect(firstStore.list()).toHaveLength(0); expect(prompts).toBe(2);
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

test('an unresponsive permission handler cannot persist a delayed remembered answer after cancellation', async () => {
  const held = deferred<PermissionPromptDecision>(); const controller = new AbortController();
  const store = new UserPermissionRuleStore(':memory:'); let asks = 0; let forwarded: AbortSignal | undefined;
  const permissions = manager((_request, options) => { forwarded = options?.signal; return ++asks === 1 ? held.promise : Promise.resolve({ approved: false }); }, store);
  const options = { signal: controller.signal };
  const result = caught(permissions.checkDetailed('write', args, undefined, options));
  await until(() => asks === 1); options.signal = new AbortController().signal;
  controller.abort(new Error(PRIVATE_REASON)); cancelled(await result);
  expect(forwarded).toBe(controller.signal);
  held.resolve({ approved: true, rememberTier: 'tool' }); await turn();
  expect(store.list()).toHaveLength(0);
  expect(await permissions.checkDetailed('write', args)).toMatchObject({ approved: false, sourceLayer: 'user_prompt' });
  expect(asks).toBe(2);
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

test('late rejection from an unresponsive handler is drained without a remembered grant', async () => {
  const held = deferred<PermissionPromptDecision>(); const controller = new AbortController();
  const store = new UserPermissionRuleStore(':memory:'); let asked = false;
  const permissions = manager(() => { asked = true; return held.promise; }, store);
  const result = caught(permissions.checkDetailed('write', args, undefined, { signal: controller.signal }));
  await until(() => asked); controller.abort(new Error(PRIVATE_REASON)); cancelled(await result);
  held.reject(new Error('synthetic late prompt failure')); await turn(); expect(store.list()).toHaveLength(0);
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

for (const tier of ['session', 'tool'] as const) test(`a decision getter cannot cancel and then install a ${tier} grant`, async () => {
  const controller = new AbortController(); const store = new UserPermissionRuleStore(':memory:'); let asks = 0;
  const permissions = manager(async () => ++asks === 1 ? {
    rememberTier: tier,
    get approved() { controller.abort(new Error(PRIVATE_REASON)); return true; },
  } : { approved: false }, store);
  cancelled(await caught(permissions.checkDetailed('write', args, undefined, { signal: controller.signal })));
  expect(store.list()).toHaveLength(0);
  expect(await permissions.checkDetailed('write', args)).toMatchObject({ approved: false, sourceLayer: 'user_prompt' });
  expect(asks).toBe(2);
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
