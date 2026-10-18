import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { ResponseCompletionGuard, ResponseCompletionError } from '../sdk/src/platform/core/response-completion.js';
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

test('repeated failure ends in an error and never silently accepts the last rejected draft', async () => {
  installJudgmentPort(answered('unfinished').port);
  const guard = new ResponseCompletionGuard();
  for (let i = 0; i < 3; i++) expect(await guard.check(source())).toBeString();
  await expect(guard.check(source())).rejects.toBeInstanceOf(ResponseCompletionError);
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

test('the real main loop cannot emit success after repeated unfinished responses or unavailable Jev', async () => {
  for (const available of [true, false]) {
    installJudgmentPort(available ? answered('unfinished').port : undefined);
    const f = loop(Array.from({ length: 4 }, () => unfinished));
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
