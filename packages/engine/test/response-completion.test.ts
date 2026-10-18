import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRequest, ChatResponse } from '../sdk/src/platform/providers/interface.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/record.js';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { ResponseCompletionGuard, waitForResponseDelegates } from '../sdk/src/platform/core/response-completion.js';
import { registry } from '../sdk/src/platform/core/judgment-registry.js';
import { executeOrchestratorTurnLoop, type OrchestratorTurnLoopContext } from '../sdk/src/platform/core/orchestrator-turn-loop.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import { UNKNOWN_MODEL_PRICING } from '../sdk/src/platform/providers/model-pricing.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const unfinished = 'I wrote the consolidated artifact. But consolidating those findings does not finish your original request. The reviewers did not inspect every file. I should not have presented the work as finished.';
function source(response = unfinished) {
  const conversation = new ConversationManager();
  conversation.addUserMessage('Inspect every source file and write a comprehensive review to artifacts/review.md.');
  conversation.addAssistantMessage('Partial reviewer findings.');
  conversation.addUserMessage('What part of my prompt was difficult to understand?');
  return { conversation, response, request: 'What part of my prompt was difficult to understand?', tools: ['read', 'write'] };
}
const answered = (failure?: string, probability = .99) => fakePort(name => noulAnswer(name === failure ? probability : .01));

test('the completion battery is registered', () => {
  expect(registry.get('engine.core.response-completion')).toBeDefined();
});

test('truthful admissions of unfinished work hold completion and retain the original request', async () => {
  const fake = answered('unfinished'); installJudgmentPort(fake.port);
  const result = await new ResponseCompletionGuard().check(source());
  expect(result).toContain('The requested work remains unfinished');
  expect(fake.requests).toHaveLength(1);
  expect(Object.keys(fake.requests[0]!.questions)).toEqual(['false_blocker', 'unfinished', 'unsupported', 'unanswered', 'unnecessary_permission']);
  expect(JSON.stringify(fake.requests[0]!.state)).toContain('Inspect every source file');
  expect(JSON.stringify(fake.requests[0]!.state)).toContain(unfinished);
});

test('every dimension and weak positive readings can hold completion', async () => {
  for (const name of ['false_blocker', 'unfinished', 'unsupported', 'unanswered', 'unnecessary_permission']) {
    for (const probability of [.99, .4]) {
      installJudgmentPort(answered(name, probability).port);
      expect(await new ResponseCompletionGuard().check(source())).toBeString();
    }
  }
  installJudgmentPort(answered().port);
  expect(await new ResponseCompletionGuard().check(source('The requested review is complete.'))).toBeNull();
});

test('rejected drafts keep returning to execution until Jev accepts without a hidden retry limit', async () => {
  installJudgmentPort(answered('unfinished').port);
  const guard = new ResponseCompletionGuard();
  for (let i = 0; i < 8; i++) expect(await guard.check(source())).toBeString();
  expect(() => guard.beginFinalization({ content: unfinished })).toThrow();
  installJudgmentPort(answered().port);
  const input = source('Review and artifact complete.');
  expect(await guard.check(input)).toBeNull();
  expect(guard.beginFinalization({ content: input.response })).not.toThrow();
});

test('missing Jev and malformed results cannot approve a response', async () => {
  await expect(new ResponseCompletionGuard().check(source())).rejects.toThrow();
  const fake = answered();
  installJudgmentPort({ model: fake.port.model, ask: async () => ({ answers: {} }) as never });
  await expect(new ResponseCompletionGuard().check(source())).rejects.toThrow();
});

test('late protected text is refused before any request and image bytes are not sent', async () => {
  const fake = answered(); installJudgmentPort(fake.port);
  const input = source(); input.conversation.addUserMessage('password=synthetic-private-value');
  await expect(new ResponseCompletionGuard().check(input)).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
  const imageInput = source('Hello.');
  imageInput.conversation.addUserMessage([{ type: 'image', data: 'private-image-bytes', mediaType: 'image/png' }]);
  await new ResponseCompletionGuard().check(imageInput);
  expect(JSON.stringify(fake.requests)).not.toContain('private-image-bytes');
});

test('projected observations remain bound to their original values through final publication', async () => {
  for (const beforeConsumption of [true, false]) {
    const fake = answered(); installJudgmentPort(fake.port);
    const requirements = { observation: 'password=synthetic-original-value' };
    const input = { ...source('Finished.'), requirements }, guard = new ResponseCompletionGuard();
    expect(await guard.check(input)).toBeNull();
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-original-value');
    const final = { content: input.response };
    if (beforeConsumption) {
      requirements.observation = 'password=synthetic-changed-value';
      expect(() => guard.beginFinalization(final)).toThrow();
    } else {
      const current = guard.beginFinalization(final);
      requirements.observation = 'password=synthetic-changed-value';
      expect(current).toThrow();
    }
  }
});

test('cancellation, transcript changes and retired ports cannot release a pending completion', async () => {
  for (const change of ['abort', 'transcript', 'port', 'response']) {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const fake = answered(), controller = new AbortController(), input = source();
    installJudgmentPort({ model: fake.port.model, ask: async request => { started.resolve(); await release.promise; return fake.port.ask(request); } });
    const pending = new ResponseCompletionGuard().check(input, { signal: controller.signal });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await Promise.race([started.promise, pending.then(() => { throw new Error('Completed before the held port request'); })]);
    if (change === 'abort') controller.abort();
    if (change === 'transcript') input.conversation.addUserMessage('Stop.');
    if (change === 'port') installJudgmentPort(fake.port);
    if (change === 'response') input.response = 'A different draft.';
    release.resolve(); expect(await outcome).toHaveProperty('error');
  }
});

function loop(replies: string[]) {
  const input = source(), bus = new RuntimeEventBus(), events: string[] = [], requests: string[] = [];
  const unsubscribe = bus.on('TURN_COMPLETED', event => { events.push(event.type); });
  const model = { id: 'test-model', provider: 'test', registryKey: 'test:test-model', displayName: 'Test', description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 0, selectable: true };
  const provider = { name: 'test', models: ['test-model'], chat: async (request: { systemPrompt?: string | undefined }) => {
    if (requests.length) expect(request.systemPrompt).toContain('[Response completion check]');
    const response = replies.shift(); if (response === undefined) throw new Error('Unexpected extra provider call');
    requests.push(response);
    return { content: response, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' as const };
  } };
  const context: OrchestratorTurnLoopContext = {
    conversation: input.conversation, toolRegistry: new ToolRegistry(), getSystemPrompt: () => 'Assistant.', getAbortSignal: () => undefined,
    hookDispatcher: null, requestRender() {}, runtimeBus: bus, agentManager: { list: () => [], spawn: () => { throw new Error('No delegation'); } },
    configManager: { get: () => undefined } as never,
    providerRegistry: { require: () => provider, getCurrentModel: () => model, getForModel: () => provider,
      getTokenLimitsForModel: () => ({ maxOutputTokens: 4096, maxToolResultTokens: 50_000, maxToolCalls: 128, maxReasoningTokens: 16384 }),
      getContextWindowForModel: () => 0, recordContextWindowRejection() {}, reconcileObservedContextWindow() {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING },
    cacheHitTracker: { getMetrics: () => ({ turns: 0, hitRate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0 }) },
    helperModel: { getUsage: () => ({ calls: 0, inputTokens: 0, outputTokens: 0 }) } as never,
    sessionId: 's', preTurnPlan: null, planManager: null, text: input.request, turnId: 't',
    emitterContext: () => ({ sessionId: 's', traceId: 't', source: 'test' }), executeToolCalls: async () => [], checkContextWindowPreflight: async () => 'ok',
    normalizeUsage: usage => usage, estimateFreshTurnInputTokens: () => 0, getMessageQueueLength: () => 0, isReconciliationEnabled: () => false,
    setPendingToolCalls() {}, setAutoSpawnTimeout() {}, setStreamingActive() {}, setStreamingInputTokens() {}, addStreamingOutputTokens() {},
    setLastRequestInputTokens() {}, setLastInputTokens() {}, markTurnFailed() {}, noteModelContextWindowWarning() {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    isPassiveKnowledgeInjectionEnabled: () => false, isPassiveCodeInjectionEnabled: () => false, getAlreadyInjectedKnowledgeIds: () => [],
    addInjectedKnowledgeIds() {}, recordTurnKnowledgeInjection() {}, nextTurnKnowledgeSequence: () => 1,
    contractIntake: { intake: async () => ({ kind: 'turn' }) }, directUserInput: true,
  };
  return { context, events, requests, bus, unsubscribe };
}

test('the real direct-input main loop resumes rejected finals and emits completion only for the accepted response', async () => {
  const fake = fakePort((name, _question, request) => noulAnswer(name === 'unfinished' && JSON.stringify(request).includes('does not finish your original request')
    && !JSON.stringify(request).includes('FINISHED') ? .99 : .01));
  installJudgmentPort(fake.port);
  const f = loop([unfinished, 'FINISHED: the remaining review and its report are complete.']);
  try {
    await executeOrchestratorTurnLoop(f.context);
    expect(f.requests).toHaveLength(2);
    expect(f.events).toEqual(['TURN_COMPLETED']);
    expect(f.context.conversation.getMessageSnapshot().some(m => m.role === 'system' && m.content.includes('[Response completion check]'))).toBe(true);
    expect(f.context.conversation.getMessagesForLLM().at(-1)?.content).toContain('FINISHED');
  } finally { f.unsubscribe(); }
});

test('the real main loop cannot emit success after repeated unfinished responses', async () => {
  for (const attempts of [4, 8]) {
    installJudgmentPort(answered('unfinished').port);
    const f = loop(Array.from({ length: attempts }, () => unfinished));
    try {
      await expect(executeOrchestratorTurnLoop(f.context)).rejects.toThrow();
      expect(f.events).toEqual([]);
    } finally { f.unsubscribe(); }
  }
});

test('an accepted check is bound to its draft, can be consumed once, and retains cancellation and port fences', async () => {
  const fake = answered(); installJudgmentPort(fake.port);
  const input = source('Finished.'), guard = new ResponseCompletionGuard(), controller = new AbortController();
  expect(() => guard.beginFinalization({ content: 'Finished.' })).toThrow();
  await guard.check(input, { signal: controller.signal });
  const draft = { content: input.response };
  const current = guard.beginFinalization(draft);
  input.conversation.addAssistantMessage(draft.content);
  expect(current).not.toThrow();
  expect(() => guard.beginFinalization(draft)).toThrow();
  draft.content = 'Different unchecked content'; expect(current).toThrow();
  draft.content = input.response; expect(current).not.toThrow();
  controller.abort(); expect(current).toThrow();
});

test('a captured original request remains evidence when compaction replaces the active transcript', async () => {
  const fake = answered(); installJudgmentPort(fake.port);
  const input = source(), guard = new ResponseCompletionGuard({ request: input.request, conversation: input.conversation });
  input.conversation.replaceMessagesForLLM([{ role: 'user', content: '[Session Summary] Some review findings were gathered.' }]);
  await guard.check(input);
  expect(JSON.stringify(fake.requests[0]!.state)).toContain('Inspect every source file');
});

test('actual tool progress resets consecutive rejected-final attempts without creating a completion permit', async () => {
  installJudgmentPort(answered('unfinished').port);
  const guard = new ResponseCompletionGuard(), input = source();
  for (let attempt = 0; attempt < 3; attempt++) expect(await guard.check(input)).toBeString();
  guard.noteToolResults([{ success: true }]);
  expect(await guard.check(input)).toBeString();
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});

test('retirement during post-turn work cannot publish an already checked terminal response', async () => {
  const fake = answered(); installJudgmentPort(fake.port);
  const f = loop(['FINISHED']);
  let terminal: (() => void) | undefined;
  try {
    await executeOrchestratorTurnLoop({ ...f.context, onTurnTerminal: publish => { terminal = publish; } });
    expect(terminal).toBeDefined(); expect(f.events).toEqual([]);
    installJudgmentPort(undefined);
    expect(() => terminal!()).toThrow();
    expect(f.events).toEqual([]);
  } finally { f.unsubscribe(); }
});


test('an unavailable final checker holds the task, retries, and remains cancellable', async () => {
  const controller = new AbortController(), input = source('Finished.'), guard = new ResponseCompletionGuard();
  const waiting = Promise.withResolvers<void>();
  const pending = guard.checkUntilAvailable(() => input, { signal: controller.signal }, () => waiting.resolve());
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await waiting.promise;
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
  controller.abort();
  expect(await outcome).toHaveProperty('error');
});

test('a restored final checker can approve the same held draft without a fresh model call', async () => {
  const input = source('Finished.'), guard = new ResponseCompletionGuard();
  let waiting = 0;
  const pending = guard.checkUntilAvailable(() => input, {}, () => { waiting++; installJudgmentPort(answered().port); });
  expect(await pending).toBeNull();
  expect(waiting).toBe(1);
  expect(guard.beginFinalization({ content: input.response })).not.toThrow();
});

test('permanent checker errors return a repair instruction instead of retrying unchanged evidence forever', async () => {
  for (const kind of ['invalid-request', 'rejected', 'invalid-response', 'unrecorded'] as const) {
    const fake = answered(); let calls = 0, waits = 0;
    installJudgmentPort({ model: fake.port.model, ask: async () => { calls++; throw new JudgmentError(kind, 'Synthetic permanent failure'); } });
    const guard = new ResponseCompletionGuard(), input = source('Finished.');
    const correction = await guard.checkUntilAvailable(() => input, {}, () => { waits++; });
    expect(correction).toContain('validation failure');
    expect(correction).toContain('Continue the original authorized task');
    expect(calls).toBe(1); expect(waits).toBe(0);
    expect(() => guard.beginFinalization({ content: input.response })).toThrow();
  }
});

test('locally refused user evidence returns for repair before touching Jev and cannot approve completion', async () => {
  const fake = answered(); installJudgmentPort(fake.port);
  const input = source(); input.conversation.addUserMessage('password=synthetic-private-value');
  const guard = new ResponseCompletionGuard(); let waits = 0;
  const correction = await guard.checkUntilAvailable(() => input, {}, () => { waits++; });
  expect(correction).toContain('evidence could not be admitted');
  expect(fake.requests).toHaveLength(0); expect(waits).toBe(0);
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});

test('a permanent battery failure cancels a stuck sibling and preserves the repair reason', async () => {
  const input = source(); input.conversation.addToolResults([{ callId: 'read', success: true, output: 'Read parser.ts.' }]);
  const fake = answered(); let siblingSignal: AbortSignal | undefined;
  installJudgmentPort({ model: fake.port.model, ask: async request => {
    if (request.context?.battery === 'engine.core.execution-assurance') throw new JudgmentError('rejected', 'Synthetic HTTP 400');
    siblingSignal = request.signal;
    return new Promise(() => {});
  } });
  const guard = new ResponseCompletionGuard();
  const correction = await guard.checkUntilAvailable(() => input, { signal: AbortSignal.timeout(500) });
  expect(correction).toContain('service rejected the request');
  expect(siblingSignal?.aborted).toBe(true);
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});

test('transport-level retries report checker waiting while completion remains held', async () => {
  const fake = answered(); let waits = 0;
  installJudgmentPort({ model: fake.port.model, ask: async request => {
    request.onRetry?.({ logicalRequestId: 'retry', attempt: 1, delayMs: 1, reason: 'unavailable' } as never);
    return fake.port.ask(request);
  } });
  const input = source('Finished.'), guard = new ResponseCompletionGuard();
  expect(await guard.checkUntilAvailable(() => input, {}, () => { waits++; })).toBeNull();
  expect(waits).toBe(1);
});

test('a permanent checker refusal returns control to the real main loop and only a fresh successful check permits completion', async () => {
  const fake = answered(); let calls = 0;
  installJudgmentPort({ model: fake.port.model, ask: async request => {
    if (request.context?.battery === 'engine.core.response-completion' && ++calls === 1) throw new JudgmentError('rejected', 'Synthetic HTTP 400');
    return fake.port.ask(request);
  } });
  const f = loop(['First completion draft.', 'FINISHED: repaired response.']);
  try {
    await executeOrchestratorTurnLoop(f.context);
    expect(f.requests).toHaveLength(2); expect(calls).toBe(2);
    expect(f.events).toEqual(['TURN_COMPLETED']);
  } finally { f.unsubscribe(); }
});

test('the main loop exposes completion checking while the reader is pending and clears it on cancellation', async () => {
  const fake = answered(), started = Promise.withResolvers<void>(), controller = new AbortController();
  installJudgmentPort({ model: fake.port.model, ask: async request => {
    if (request.context?.battery !== 'engine.core.response-completion') return fake.port.ask(request);
    started.resolve(); return new Promise(() => {});
  } });
  const f = loop(['Finished.']), phases: ('checking' | 'waiting' | null)[] = [];
  const pending = executeOrchestratorTurnLoop({ ...f.context, getAbortSignal: () => controller.signal,
    setCompletionActivity: phase => { phases.push(phase); } });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  try {
    await started.promise;
    expect(phases).toEqual(['checking']); expect(f.events).toEqual([]);
    controller.abort(); expect(await outcome).toHaveProperty('error');
    expect(phases).toEqual(['checking', null]); expect(f.events).toEqual([]);
  } finally { controller.abort(); await outcome; f.unsubscribe(); }
});


test('a contract handoff stays in the actual main loop, recovers a failed planner, and cannot finish before the artifact exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-turn-recovery-')), report = join(root, 'review.md');
  const f = loop([]), requests: ChatRequest[] = [], controller = new AbortController();
  const owner: AgentRecord = { id: 'contract-owner', task: 'Review the full repository and write review.md.', status: 'running', template: 'orchestrator',
    tools: [], startedAt: Date.now(), toolCallCount: 0, orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'direct' };
  const handoff = Promise.withResolvers<void>();
  let wroteArtifact = false;
  const fake = fakePort((name, _question, state) => {
    const draft = (state as { response?: string }).response;
    if (name === 'unfinished' && draft?.includes('did not finish')) return noulAnswer(.99);
    if (name === 'unfinished' && draft?.startsWith('FINISHED')) expect(wroteArtifact).toBe(true);
    return noulAnswer(.01);
  }); installJudgmentPort(fake.port);
  const responses: ChatResponse[] = [
    { content: 'Delegating the review.', toolCalls: [{ id: 'spawn', name: 'agent', arguments: { mode: 'spawn', task: owner.task } }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' },
    { content: 'The comprehensive review did not finish, and no findings artifact was produced.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' },
    { content: 'Recovering the review and writing its findings.', toolCalls: [{ id: 'write', name: 'write', arguments: { path: report, content: 'Completed repository review findings.' } }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' },
    { content: 'FINISHED: reviewed the repository and wrote review.md.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' },
  ];
  const provider = { name: 'test', models: ['test'], chat: async (request: ChatRequest) => {
    requests.push(request);
    if (requests.length === 2) expect(JSON.stringify(request.messages)).toContain('planner failed');
    if (requests.length === 3) expect(request.systemPrompt).toContain('[Response completion check]');
    const response = responses.shift(); if (!response) throw new Error('Unexpected provider call'); return response;
  } };
  f.context.toolRegistry.register({ definition: { name: 'agent', description: 'Start contract work', parameters: { type: 'object' } },
    execute: async () => ({ success: true, output: '{}' }) });
  f.context.toolRegistry.register({ definition: { name: 'write', description: 'Write the report', parameters: { type: 'object' } },
    execute: async () => ({ success: true }) });
  const pending = executeOrchestratorTurnLoop({ ...f.context, text: owner.task, getAbortSignal: () => controller.signal,
    providerRegistry: { ...f.context.providerRegistry, getForModel: () => provider },
    agentManager: { list: () => [owner], spawn: () => { throw new Error('Unexpected automatic spawn'); } },
    executeToolCalls: async (_turn, calls) => calls.map(call => {
      if (call.name === 'agent') { handoff.resolve(); return { callId: call.id, success: true,
        output: JSON.stringify({ contractStarted: true, agentId: owner.id, contractId: 'contract' }) }; }
      writeFileSync(String(call.arguments.path), String(call.arguments.content)); wroteArtifact = true;
      return { callId: call.id, success: true, output: 'Wrote review.md.' };
    }),
  });
  try {
    await handoff.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.events).toEqual([]); expect(requests).toHaveLength(1);
    owner.status = 'failed'; owner.error = 'planner failed: completion check HTTP 400';
    await pending;
    expect(f.events).toEqual(['TURN_COMPLETED']);
    expect(requests).toHaveLength(4);
    expect(readFileSync(report, 'utf8')).toContain('Completed repository review');
    const checkedDrafts = fake.requests.filter(request => request.context?.battery === 'engine.core.response-completion').map(request => (request.state as { response: string }).response);
    expect(checkedDrafts).toEqual(['The comprehensive review did not finish, and no findings artifact was produced.', 'FINISHED: reviewed the repository and wrote review.md.']);
  } finally { controller.abort(); await pending.catch(() => {}); f.unsubscribe(); rmSync(root, { recursive: true, force: true }); }
});


test('repeated tool errors trigger recovery instead of terminating the original request', async () => {
  installJudgmentPort(answered().port);
  const f = loop([]); let rounds = 0;
  const errors: string[] = []; f.bus.on('TURN_ERROR', event => { errors.push(event.type); });
  f.context.toolRegistry.register({ definition: { name: 'probe', description: 'Inspect work', parameters: { type: 'object' } }, execute: async () => ({ success: false }) });
  const provider = { name: 'test', models: ['test'], chat: async (request: ChatRequest): Promise<ChatResponse> => {
    rounds++;
    if (rounds === 11) expect(request.systemPrompt).toContain('[Tool recovery]');
    return { content: rounds > 10 ? 'FINISHED' : '', usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: rounds > 10 ? 'completed' : 'tool_call',
      toolCalls: rounds > 10 ? [] : [{ id: `call-${rounds}`, name: 'probe', arguments: { attempt: rounds } }] };
  } };
  try {
    await executeOrchestratorTurnLoop({ ...f.context, providerRegistry: { ...f.context.providerRegistry, getForModel: () => provider },
      executeToolCalls: async (_turn, calls) => calls.map(call => ({ callId: call.id, success: false, error: 'The proposed plan requires repair.' })) });
    expect(rounds).toBe(11); expect(errors).toEqual([]); expect(f.events).toEqual(['TURN_COMPLETED']);
  } finally { f.unsubscribe(); }
});


test('a contract waiting for a necessary user decision returns control to its coordinator', async () => {
  const input = source();
  input.conversation.addAssistantMessage('', { toolCalls: [{ id: 'agent', name: 'agent', arguments: { mode: 'spawn' } }] });
  input.conversation.addToolResults([{ callId: 'agent', success: true, output: '{"agentId":"owner"}' }]);
  const manager = { list: () => [{ id: 'owner', task: 'Review the repository', status: 'running', fullOutput: '' }] } as never;
  const evidence = await waitForResponseDelegates(input.conversation, manager, {}, [], () => false);
  expect(evidence).toContain('"status":"running"');
  expect(evidence).toContain('original request');
});
