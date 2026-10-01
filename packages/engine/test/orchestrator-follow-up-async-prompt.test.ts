import { afterEach, describe, expect, test } from 'bun:test';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { OrchestratorFollowUpRuntime, type OrchestratorFollowUpRuntimeOptions } from '../sdk/src/platform/core/orchestrator-follow-up-runtime.js';
import type { ChatRequest, ChatResponse } from '../sdk/src/platform/providers/interface.js';
import type { ModelDefinition, ProviderRegistry } from '../sdk/src/platform/providers/registry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const response: ChatResponse = { content: 'Update acknowledged', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
const runtimes: OrchestratorFollowUpRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose(); });
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(getSystemPrompt: OrchestratorFollowUpRuntimeOptions['getSystemPrompt'], chat = async (_request: ChatRequest) => response) {
  const conversation = new ConversationManager();
  conversation.addUserMessage('original user message');
  const requests: ChatRequest[] = [];
  const failures: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const state = { isThinking: false, isCompacting: false };
  const model: ModelDefinition = {
    id: 'test', registryKey: 'test:test', displayName: 'Test', description: 'test', provider: 'test',
    contextWindow: 200_000, selectable: true,
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
  };
  const registry = {
    getForModel: () => ({ chat: async (request: ChatRequest) => { requests.push(request); return chat(request); } }),
    getTokenLimitsForModel: () => ({ maxOutputTokens: 200 }),
  } as unknown as ProviderRegistry;
  const runtime = new OrchestratorFollowUpRuntime({
    conversation,
    getSystemPrompt: (signal) => { signals.push(signal); return getSystemPrompt(signal); },
    getViewportHeight: () => 10, scrollToEnd: () => {}, requestRender: () => {},
    getThinkingState: () => state, getQueuedUserMessageCount: () => 0,
    getCurrentModel: () => ({ ...model }), getProviderRegistry: () => registry,
    routeLowPriorityMessage: (message) => failures.push(message), applyUsage: () => {},
  });
  runtimes.push(runtime);
  return { runtime, conversation, requests, failures, signals, state };
}

describe('follow-up system-prompt lifetime', () => {
  test('awaits the prompt and uses the same signal in the provider request', async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    const f = fixture(() => { entered.resolve(); return pending.promise; });
    f.runtime.enqueue({ key: 'update', summary: 'The build finished' });
    await entered.promise;
    expect(f.requests).toHaveLength(0);
    pending.resolve('current follow-up memory');
    await flushMicrotasks();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.systemPrompt).toBe('current follow-up memory');
    expect(f.requests[0]?.signal).toBe(f.signals[0]);
    expect(f.signals[0]).toBeInstanceOf(AbortSignal);
    expect(f.conversation.getMessagesForLLM().at(-1)?.content).toBe(response.content);
  });

  test('cancellation discards a late prompt and a later batch uses a fresh signal', async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let reads = 0;
    const f = fixture(() => { reads++; entered.resolve(); return reads === 1 ? pending.promise : 'new memory'; });
    f.runtime.enqueue({ key: 'old', summary: 'Older update' });
    await entered.promise;
    f.runtime.cancel();
    await flushMicrotasks();
    pending.reject(new Error('late stale lookup'));
    f.runtime.enqueue({ key: 'new', summary: 'Newer update' });
    await flushMicrotasks();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.systemPrompt).toBe('new memory');
    expect(f.signals[0]?.aborted).toBe(true);
    expect(f.signals[1]).not.toBe(f.signals[0]);
    expect(f.failures).toEqual([]);
  });

  test('a newer user turn requeues the batch and rereads after that turn', async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let reads = 0;
    const f = fixture(() => { reads++; entered.resolve(); return reads === 1 ? pending.promise : 'after user turn'; });
    f.runtime.enqueue({ key: 'update', summary: 'Keep this update' });
    await entered.promise;
    f.state.isThinking = true;
    f.runtime.cancel(true);
    await flushMicrotasks();
    pending.resolve('stale pre-turn memory');
    expect(f.requests).toHaveLength(0);
    f.state.isThinking = false;
    f.runtime.scheduleFlush();
    await flushMicrotasks();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.systemPrompt).toBe('after user turn');
    expect(JSON.stringify(f.requests[0]?.messages)).toContain('Keep this update');
    expect(f.signals[1]).not.toBe(f.signals[0]);
  });

  test('a cancelled provider response cannot append a stale acknowledgement', async () => {
    const pending = deferred<ChatResponse>();
    const entered = deferred<void>();
    const f = fixture(() => 'sync prompt', async () => { entered.resolve(); return pending.promise; });
    f.runtime.enqueue({ key: 'update', summary: 'Build finished' });
    await entered.promise;
    f.runtime.cancel();
    pending.resolve(response);
    await flushMicrotasks();
    expect(f.conversation.getMessagesForLLM()).toHaveLength(1);
    expect(f.failures).toEqual([]);
  });

  for (const asynchronous of [false, true]) {
    test(`reports a ${asynchronous ? 'rejected' : 'thrown'} prompt failure without a provider call`, async () => {
      const error = new Error('reviewed memory unavailable');
      const f = fixture(() => { if (asynchronous) return Promise.reject(error); throw error; });
      f.runtime.enqueue({ key: 'update', summary: 'Build finished' });
      await flushMicrotasks();
      expect(f.requests).toHaveLength(0);
      expect(f.failures).toHaveLength(1);
      expect(f.failures[0]).toContain(error.message);
    });
  }

  test('disposing a queued runtime prevents prompt reads and provider requests', async () => {
    let reads = 0;
    const f = fixture(() => { reads++; return 'unused'; });
    f.runtime.enqueue({ key: 'update', summary: 'Build finished' });
    f.runtime.dispose();
    await flushMicrotasks();
    expect(reads).toBe(0);
    expect(f.requests).toHaveLength(0);
  });
});
