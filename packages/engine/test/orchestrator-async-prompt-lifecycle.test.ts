import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { createFeatureFlagManager } from '../sdk/src/platform/runtime/feature-flags/manager.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { waitFor } from './_helpers/test-timeout.js';
import type { ChatResponse } from '../sdk/src/platform/providers/interface.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { Orchestrator, type OrchestratorOptions } from '../sdk/src/platform/core/orchestrator.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { PermissionManager } from '../sdk/src/platform/permissions/manager.js';
import type { ModelDefinition, ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import type { ChatRequest, LLMProvider } from '../sdk/src/platform/providers/interface.js';
import { UNKNOWN_MODEL_PRICING } from '../sdk/src/platform/providers/model-pricing.js';
import { PLAN_MODE_INSTRUCTION_MARKER } from '../sdk/src/platform/permissions/plan-mode-instructions.js';
import { useCoreReadings } from './_helpers/core-readings.ts';

useCoreReadings({ intent: 'chat', needsPlan: false, risk: 0 });
const orchestrators: Orchestrator[] = [];
afterEach(() => { for (const orchestrator of orchestrators.splice(0)) orchestrator.dispose(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(getSystemPrompt: NonNullable<OrchestratorOptions['getSystemPrompt']>, replies?: ChatResponse[], identity: Pick<OrchestratorOptions, 'sessionId' | 'resolveSessionId' | 'runtimeBus' | 'flagManager'> = {}) {
  const conversation = new ConversationManager();
  const requests: ChatRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const model: ModelDefinition = {
    id: 'test', registryKey: 'test:test', displayName: 'Test', description: 'test', provider: 'test',
    contextWindow: 0, selectable: true,
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
  };
  const provider: LLMProvider = {
    name: 'test', models: ['test'],
    chat: async (request) => {
      requests.push(request);
      if (replies) { const reply = replies.shift(); if (!reply) throw new Error('Unexpected extra provider call'); return reply; }
      return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    },
  };
  const providerRegistry = {
    getCurrentModel: () => model, getForModel: () => provider,
    getContextWindowForModel: () => 0,
    getKnownContextWindowForModel: () => 0,
    getTokenLimitsForModel: () => ({ maxOutputTokens: 200 }),
    reconcileObservedContextWindow: () => {}, resolveModelPricing: () => UNKNOWN_MODEL_PRICING,
  } as unknown as ProviderRegistry;
  const configManager = {
    get: (key: string) => key === 'behavior.autoCompactThreshold' ? 0 : false,
    getCategory: () => ({}), getWorkingDirectory: () => process.cwd(),
  } as unknown as ConfigManager;
  const orchestrator = new Orchestrator({
    ...identity,
    conversation, toolRegistry: new ToolRegistry(), getViewportHeight: () => 10, scrollToEnd: () => {},
    permissionManager: { getMode: () => 'plan' } as unknown as PermissionManager,
    getSystemPrompt: (signal) => { signals.push(signal); return getSystemPrompt(signal); },
    services: {
      agentManager: { list: () => [], spawn: () => { throw new Error('unexpected agent spawn'); } },
      contractRunner: { list: () => [] }, contractIntake: { intake: async () => ({ kind: 'turn' }) },
    },
  });
  orchestrator.setCoreServices({ configManager, providerRegistry });
  orchestrators.push(orchestrator);
  return { orchestrator, conversation, requests, signals };
}

describe('Orchestrator async prompt lifecycle wiring', () => {
  test('preserves plan-mode instructions around an asynchronous prompt', async () => {
    const f = fixture(async () => 'reviewed memory');
    await f.orchestrator.handleUserInput('hello');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.systemPrompt).toContain('reviewed memory');
    expect(f.requests[0]?.systemPrompt).toContain(PLAN_MODE_INSTRUCTION_MARKER);
    expect(f.signals[0]).toBe(f.requests[0]?.signal);
    expect(f.signals[0]).toBeInstanceOf(AbortSignal);
  });

  test('abort releases an uncooperative prompt and a queued turn gets a fresh signal', async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let reads = 0;
    const f = fixture(() => { reads++; entered.resolve(); return reads === 1 ? pending.promise : 'new turn memory'; });
    const first = f.orchestrator.handleUserInput('first turn');
    await entered.promise;
    await f.orchestrator.handleUserInput('second turn');
    f.orchestrator.abort();
    await first;
    pending.resolve('stale turn memory');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.systemPrompt).toContain('new turn memory');
    expect(f.requests[0]?.systemPrompt).not.toContain('stale turn memory');
    expect(f.signals[0]?.aborted).toBe(true);
    expect(f.signals[1]).not.toBe(f.signals[0]);
  });

  test('interrupting an unpublished response preserves completed tool history through save and resume', async () => {
    const entered = deferred<void>(), prompt = deferred<string>();
    const f = fixture(() => { entered.resolve(); return prompt.promise; });
    const pending = f.orchestrator.handleUserInput('Inspect the report and check preservation.');
    await entered.promise;
    f.conversation.addAssistantMessage('Inspecting the existing report.', { toolCalls: [{ id: 'read-report', name: 'read', arguments: { path: 'REVIEW.md' } }] });
    f.conversation.addToolResults([{ callId: 'read-report', success: true, output: 'The existing completed review.' }]);
    f.conversation.addAssistantMessage('UNPUBLISHED-FIRST-DRAFT');
    f.conversation.addAssistantMessage('', { toolCalls: [{ id: 'check-files', name: 'exec', arguments: { commands: [{ cmd: 'git diff --exit-code HEAD -- src test' }] } }] });
    f.conversation.addToolResults([{ callId: 'check-files', success: true, output: 'exit_code: 0' }]);
    f.conversation.addAssistantMessage('UNPUBLISHED-FINAL-DRAFT');
    f.conversation.addUserMessage('A later submitted correction.');
    f.orchestrator.abort(); await pending; prompt.resolve('Late prompt result');
    const saved = JSON.parse(JSON.stringify(f.conversation.toJSON()));
    const resumed = new ConversationManager(); resumed.fromJSON(saved);
    const messages = resumed.getMessageSnapshot();
    expect(messages.filter(message => message.role === 'tool').map(message => message.callId)).toEqual(['read-report', 'check-files']);
    expect(messages.filter(message => message.role === 'assistant').flatMap(message => message.toolCalls?.map(call => call.id) ?? [])).toEqual(['read-report', 'check-files']);
    expect(JSON.stringify(messages)).not.toContain('UNPUBLISHED');
    expect(messages.find(message => message.role === 'user' && message.content === 'Inspect the report and check preservation.')).toMatchObject({ cancelled: true });
    expect(messages.find(message => message.role === 'user' && message.content === 'A later submitted correction.')).not.toHaveProperty('cancelled');
    expect(f.requests).toHaveLength(0);
  });

  test('dispose cancels pending reads and does not start queued or later user turns', async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let reads = 0;
    const f = fixture(() => { reads++; entered.resolve(); return pending.promise; });
    const first = f.orchestrator.handleUserInput('first turn');
    await entered.promise;
    await f.orchestrator.handleUserInput('queued turn');
    f.orchestrator.dispose();
    await first;
    pending.resolve('stale memory');
    await f.orchestrator.handleUserInput('after disposal');
    expect(reads).toBe(1);
    expect(f.requests).toHaveLength(0);
  });

  test('a user message queued during background recovery is delivered after its checked turn', async () => {
    const pending = deferred<string>(), entered = deferred<void>();
    let reads = 0;
    const f = fixture(() => { reads++; entered.resolve(); return reads === 1 ? pending.promise : `fresh memory ${reads}`; });
    f.conversation.addUserMessage('Build the project.');
    f.orchestrator.enqueueConversationFollowUp({ key: 'build', summary: 'Build completed' });
    await entered.promise;
    await f.orchestrator.handleUserInput('new user turn');
    expect(f.orchestrator.listQueuedMessages()).toHaveLength(1);
    pending.resolve('first recovery memory');
    await waitFor(() => f.requests.length === 2 && !f.orchestrator.isBusy);
    expect(f.requests[0]?.systemPrompt).toContain('first recovery memory');
    expect(f.requests[1]?.systemPrompt).toContain('fresh memory 2');
    expect(JSON.stringify(f.requests[0]?.messages)).toContain('Build completed');
    expect(new Set(f.signals).size).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(f.requests).toHaveLength(2); // The retired background batch must not replay after the queued user turn.
  });
});


for (const directResult of [false, true]) {
  test(`background ${directResult ? 'completed result' : 'failure notice'} resumes the original request and cannot bypass final validation`, async () => {
    const rejected = 'The requested review did not finish. No completed artifact was produced.';
    const fake = fakePort((name, _question, state) => noulAnswer(name === 'unfinished' && (state as { response?: string }).response === rejected ? .99 : .01));
    installJudgmentPort(fake.port);
    const f = fixture(() => 'current memory', [
      { content: rejected, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' },
      { content: 'Recovered and finished the original request.', toolCalls: [], usage: { inputTokens: 2, outputTokens: 2 }, stopReason: 'completed' },
    ]);
    f.conversation.addUserMessage('Review the full repository and produce the findings artifact.');
    f.orchestrator.enqueueConversationFollowUp({ key: 'failed-contract', summary: 'Contract planning failed.', ...(directResult ? { result: rejected } : {}) });
    await waitFor(() => f.requests.length === 2 && !f.orchestrator.isBusy);
    const checked = fake.requests.filter(request => request.context?.battery === 'engine.core.response-completion');
    expect(checked).toHaveLength(2);
    expect(JSON.stringify(checked[0]?.state)).toContain('Review the full repository');
    expect(f.requests[1]?.systemPrompt).toContain('[Response completion check]');
    expect(JSON.stringify(f.requests[0]?.messages)).toContain('Contract planning failed');
    expect(f.conversation.getMessageSnapshot().filter(message => message.role === 'user')).toHaveLength(1);
    expect(f.conversation.getMessageSnapshot().at(-1)).toMatchObject({ role: 'assistant', content: 'Recovered and finished the original request.' });
    expect(f.requests[0]?.maxTokens).not.toBe(160);
  });
}

test('background evidence cannot restart explicitly cancelled work or mint a native permit', async () => {
  for (const native of [false, true]) {
    const f = fixture(() => 'current memory');
    f.conversation.addUserMessage('Review the repository.');
    if (native) f.orchestrator.bindNativeConversationProject('project');
    else f.conversation.markLastUserMessageCancelled();
    f.orchestrator.enqueueConversationFollowUp({ key: 'failed-contract', summary: 'Contract failed.' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.requests).toHaveLength(0);
    expect(f.conversation.getMessageSnapshot().filter(message => message.role === 'assistant')).toHaveLength(0);
  }
});


test('resuming a surface identity moves real turn events and compaction ownership to the saved session', async () => {
  let sessionId = 'startup-session';
  const runtimeBus = new RuntimeEventBus(), completed: string[] = [];
  runtimeBus.on('TURN_COMPLETED', event => { completed.push(event.sessionId ?? 'missing-session'); });
  const f = fixture(async () => 'memory', undefined, { sessionId, resolveSessionId: () => sessionId, runtimeBus, flagManager: createFeatureFlagManager() });
  await f.orchestrator.handleUserInput('hello before resume');
  const previous = f.orchestrator.getCompactionManager()!;
  expect(previous).not.toBeNull();
  sessionId = 'saved-review-session';
  f.conversation.resetAll();
  await f.orchestrator.handleUserInput('hello after resume');
  expect(completed).toEqual(['startup-session', 'saved-review-session']);
  expect(f.orchestrator.getCompactionManager()).not.toBe(previous);
  expect(previous.disposed).toBeTrue();
});
