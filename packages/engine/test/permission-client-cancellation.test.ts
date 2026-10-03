import { expect, mock, spyOn, test } from 'bun:test';
import { createClientApprovalRaiser, type ClientApprovalRaiserOptions } from '../sdk/src/platform/runtime/client/approval-raiser.ts';
import { trustGatedApprovalRaiser } from '../sdk/src/platform/runtime/workspace-trust-approval.ts';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.ts';
import type { ApprovalUpdateNotice, ApprovalUpdateSubscription } from '../sdk/src/platform/runtime/client/approval-updates.ts';

const request: PermissionPromptRequest = { callId: 'synthetic', tool: 'write', args: { path: 'synthetic.txt' }, category: 'write', analysis: { classification: 'write', riskLevel: 'medium', summary: 'Synthetic write', reasons: [] } };
const PRIVATE_REASON = 'synthetic private client context';
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Synthetic client did not settle'); await turn(); }
}
const caught = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);
function cancelled(error: unknown): void {
  expect(error).toMatchObject({ kind: 'aborted', message: 'the permission request was cancelled' });
  expect((error as Error).cause).toBeUndefined(); expect(JSON.stringify(error)).not.toContain(PRIVATE_REASON);
}
function verbs(list: () => unknown | Promise<unknown> = () => []) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const caller: ClientApprovalRaiserOptions['verbs'] = {
    probe: () => ({ available: true }),
    async invoke<T>(method: string, input?: unknown): Promise<T> {
      calls.push({ method, input });
      return (method === 'approvals.raise' ? { approval: { id: 'shared-wire-record' } } : method === 'approvals.list' ? await list() : {}) as T;
    },
  };
  return { caller, calls };
}
function noRemoteMutation(calls: Array<{ method: string; input: unknown }>): void {
  expect(calls.filter(({ method }) => !['approvals.raise', 'approvals.list'].includes(method))).toEqual([]);
  for (const call of calls) {
    expect(call.input).not.toHaveProperty('signal');
    expect(call.input).not.toHaveProperty('options');
  }
}

test('late SSE acquisition is closed after this caller has already cancelled', async () => {
  const wire = verbs(); const opening = deferred<ApprovalUpdateSubscription | null>(); const prompt = deferred<PermissionPromptDecision>();
  const controller = new AbortController(); const close = mock(() => {}); let started = false; let promptSignal: AbortSignal | undefined;
  const raise = createClientApprovalRaiser({ verbs: wire.caller, actor: 'synthetic', localPrompt: () => (_request, options) => { promptSignal = options?.signal; return prompt.promise; }, subscribeApprovalUpdates: async () => { started = true; return opening.promise; } });
  const result = caught(raise({ request, signal: controller.signal }));
  await until(() => started); controller.abort(new Error(PRIVATE_REASON)); cancelled(await result);
  expect(promptSignal).toBe(controller.signal);
  opening.resolve({ close }); prompt.resolve({ approved: true, rememberTier: 'tool' }); await turn();
  expect(close).toHaveBeenCalledTimes(1); noRemoteMutation(wire.calls);
});

test('an acquired SSE handle closes promptly while its gap read is still pending', async () => {
  const reading = deferred<unknown>(); const wire = verbs(() => reading.promise); const prompt = deferred<PermissionPromptDecision>();
  const controller = new AbortController(); const close = mock(() => {});
  const raise = createClientApprovalRaiser({ verbs: wire.caller, actor: 'synthetic', localPrompt: () => () => prompt.promise, subscribeApprovalUpdates: async () => ({ close }) });
  const result = caught(raise({ request, signal: controller.signal }));
  await until(() => wire.calls.some(({ method }) => method === 'approvals.list'));
  controller.abort(new Error(PRIVATE_REASON)); cancelled(await result);
  expect(close).toHaveBeenCalledTimes(1);
  reading.resolve([{ id: 'shared-wire-record', status: 'approved' }]); prompt.reject(new Error('synthetic late prompt rejection')); await turn();
  expect(close).toHaveBeenCalledTimes(1); noRemoteMutation(wire.calls);
});

test('cancelling a polling consumer clears its owned default timer', async () => {
  const wire = verbs(); const prompt = deferred<PermissionPromptDecision>(); const controller = new AbortController();
  const timers = spyOn(globalThis, 'setTimeout'); const clear = spyOn(globalThis, 'clearTimeout');
  const raise = createClientApprovalRaiser({ verbs: wire.caller, actor: 'synthetic', localPrompt: () => () => prompt.promise, pollIntervalMs: 123456 });
  const result = caught(raise({ request, signal: controller.signal }));
  try {
    await until(() => timers.mock.calls.some((call) => call[1] === 123456));
    const index = timers.mock.calls.findIndex((call) => call[1] === 123456); const timer = timers.mock.results[index]!.value;
    controller.abort(new Error(PRIVATE_REASON)); cancelled(await result); await turn();
    expect(clear.mock.calls.some((call) => call[0] === timer)).toBe(true);
    prompt.resolve({ approved: true, rememberTier: 'tool' }); await turn(); noRemoteMutation(wire.calls);
  } finally { timers.mockRestore(); clear.mockRestore(); prompt.resolve({ approved: false }); }
});

test('one cancelled remote participant does not close or decide its active peer', async () => {
  const wire = verbs(); const first = new AbortController(); const second = new AbortController();
  const prompts = [deferred<PermissionPromptDecision>(), deferred<PermissionPromptDecision>()];
  const subscribers: Array<{ update: (notice: ApprovalUpdateNotice) => void; close: ReturnType<typeof mock> }> = [];
  let prompted = 0;
  const raise = createClientApprovalRaiser({ verbs: wire.caller, actor: 'synthetic', localPrompt: () => () => prompts[prompted++]!.promise, subscribeApprovalUpdates: async (update) => {
    const close = mock(() => {}); subscribers.push({ update, close }); return { close };
  } });
  const abandoned = caught(raise({ request, signal: first.signal })); await until(() => subscribers.length === 1);
  const active = raise({ request, signal: second.signal }); await until(() => subscribers.length === 2);
  first.abort(new Error(PRIVATE_REASON)); cancelled(await abandoned);
  expect(subscribers[0]!.close).toHaveBeenCalledTimes(1); expect(subscribers[1]!.close).not.toHaveBeenCalled();
  subscribers[1]!.update({ approval: { id: 'shared-wire-record', status: 'approved' }, createdAt: 0 });
  expect((await active).approved).toBe(true); expect(second.signal.aborted).toBe(false);
  expect(subscribers[1]!.close).toHaveBeenCalledTimes(1);
  for (const prompt of prompts) prompt.resolve({ approved: true, rememberTier: 'tool' }); await turn(); noRemoteMutation(wire.calls);
});

test('a late daemon raise does not start a local prompt after cancellation', async () => {
  const opening = deferred<unknown>(); let invoked = false; const prompt = mock(async () => ({ approved: true }));
  const controller = new AbortController();
  const raise = createClientApprovalRaiser({ actor: 'synthetic', localPrompt: () => prompt, verbs: {
    probe: () => ({ available: true }), async invoke<T>() { invoked = true; return await opening.promise as T; },
  } });
  const result = caught(raise({ request, signal: controller.signal })); await until(() => invoked);
  controller.abort(new Error(PRIVATE_REASON)); cancelled(await result);
  opening.resolve({ approval: { id: 'wire-owner-remains' } }); await turn(); expect(prompt).not.toHaveBeenCalled();
});

test('workspace trust coalesces its choice while preserving independent consumer signals', async () => {
  const choice = deferred<'trusted' | 'restricted'>(); let trustAsks = 0; let trusted = false;
  const signals: Array<AbortSignal | undefined> = [];
  const manager: Parameters<typeof trustGatedApprovalRaiser>[0] = { async load() {}, isCategoryAllowed: () => trusted, isDecided: () => trusted, async setLevel(level) { trusted = level === 'trusted'; } };
  const raise = trustGatedApprovalRaiser(manager, async (input) => { signals.push(input.signal); expect(input.request).not.toHaveProperty('signal'); return { approved: true }; }, () => { trustAsks++; return choice.promise; });
  const first = new AbortController(); const second = new AbortController();
  const abandoned = caught(raise({ request, signal: first.signal }));
  const active = raise({ request, signal: second.signal }); await until(() => trustAsks === 1); await turn();
  first.abort(new Error(PRIVATE_REASON)); cancelled(await abandoned);
  choice.resolve('trusted'); expect((await active).approved).toBe(true); await turn();
  expect(trustAsks).toBe(1); expect(signals).toEqual([second.signal]);
});

test('cancellation during trust loading starts neither the trust ask nor the tool ask', async () => {
  const load = deferred<void>(); const controller = new AbortController(); let loading = false;
  const ask = mock(async () => ({ approved: true })); const trust = mock(async () => 'trusted' as const);
  const manager: Parameters<typeof trustGatedApprovalRaiser>[0] = { async load() { loading = true; await load.promise; }, isCategoryAllowed: () => true, isDecided: () => true, async setLevel() {} };
  const raise = trustGatedApprovalRaiser(manager, ask, trust);
  const result = caught(raise({ request, signal: controller.signal })); await until(() => loading);
  controller.abort(new Error(PRIVATE_REASON)); cancelled(await result); load.resolve(); await turn();
  expect(ask).not.toHaveBeenCalled(); expect(trust).not.toHaveBeenCalled();
});

for (const late of [false, true]) for (const asynchronous of [false, true]) test(`a ${asynchronous ? 'rejecting' : 'throwing'} ${late ? 'late-acquired' : 'acquired'} subscription close is contained once`, async () => {
  const { logger } = await import('../sdk/src/platform/utils/logger.ts');
  const warning = spyOn(logger, 'warn').mockImplementation(() => {});
  const wire = verbs(); const opening = deferred<ApprovalUpdateSubscription | null>(); const prompt = deferred<PermissionPromptDecision>();
  const controller = new AbortController(); let started = false;
  const close = mock(asynchronous ? async () => { throw new Error(PRIVATE_REASON); } : () => { throw new Error(PRIVATE_REASON); });
  const raise = createClientApprovalRaiser({ verbs: wire.caller, actor: 'synthetic', localPrompt: () => () => prompt.promise, subscribeApprovalUpdates: async () => {
    started = true; return late ? opening.promise : { close };
  } });
  const result = caught(raise({ request, signal: controller.signal }));
  try {
    await until(() => started); await turn(); controller.abort(new Error(PRIVATE_REASON)); cancelled(await result);
    if (late) opening.resolve({ close });
    prompt.resolve({ approved: true }); await turn();
    expect(close).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(PRIVATE_REASON);
    noRemoteMutation(wire.calls);
  } finally { warning.mockRestore(); prompt.resolve({ approved: false }); opening.resolve({ close }); }
});


for (const offline of [false, true]) for (const throwsReason of [false, true]) test(`a local decision getter cannot ${throwsReason ? 'leak its abort reason' : 'approve after cancellation'} ${offline ? 'offline' : 'on the daemon'}`, async () => {
  const wire = verbs(); const controller = new AbortController();
  const caller = offline ? { ...wire.caller, probe: () => ({ available: false as const, reason: 'synthetic offline' }) } : wire.caller;
  const raise = createClientApprovalRaiser({ verbs: caller, actor: 'synthetic', localPrompt: () => async () => ({
    get approved() {
      controller.abort(new Error(PRIVATE_REASON));
      if (throwsReason) throw controller.signal.reason;
      return true;
    }, remember: true,
  }) });
  cancelled(await caught(raise({ request, signal: controller.signal })));
  await turn(); noRemoteMutation(wire.calls);
});
