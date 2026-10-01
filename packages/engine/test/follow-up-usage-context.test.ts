/**
 * A follow-up acknowledgement is billed, but it is not the session's context.
 *
 * The follow-up runtime asks the model for a short acknowledgement with the
 * conversation and no tool definitions. In the live run that request reported
 * 1,796 input tokens while the session's real turn requests were 13.3k and
 * 31.1k, and the context meter showed 1.8k. These tests pin that the
 * acknowledgement is marked on the message, that the orchestrator's usage hook
 * receives it for the totals only, and that sumConversationUsage (the resume
 * path) skips it for the context size.
 */
import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../sdk/src/platform/core/conversation.ts';
import { OrchestratorFollowUpRuntime } from '../sdk/src/platform/core/orchestrator-follow-up-runtime.ts';
import { sumConversationUsage } from '../sdk/src/platform/core/orchestrator-usage.ts';
import { Orchestrator } from '../sdk/src/platform/core/orchestrator.ts';
import { waitFor } from './_helpers/test-timeout.js';
import type { ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.ts';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('follow-up acknowledgement usage', () => {
  test('the acknowledgement message is marked followUp and its usage goes to the totals hook', async () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage('spawn a reviewer and do not wait');
    conversation.addAssistantMessage('Started.', { usage: { inputTokens: 13292, outputTokens: 139 } });
    const applied: Array<{ inputTokens: number }> = [];
    const model = { id: 'route-llm', registryKey: 'abacusai:route-llm', provider: 'abacusai', displayName: 'route-llm', capabilities: { reasoning: false } };
    const runtime = new OrchestratorFollowUpRuntime({
      conversation,
      getViewportHeight: () => 20,
      scrollToEnd: () => {},
      getSystemPrompt: () => 'system',
      requestRender: () => {},
      getThinkingState: () => ({ isThinking: false, isCompacting: false }),
      getQueuedUserMessageCount: () => 0,
      getProviderRegistry: () => ({
        getForModel: () => ({
          chat: async () => ({ content: 'The reviewer finished.', usage: { inputTokens: 1796, outputTokens: 24 } }),
        }),
        getTokenLimitsForModel: () => ({ maxOutputTokens: 4096 }),
      }) as never,
      getCurrentModel: () => model as never,
      routeLowPriorityMessage: () => {},
      applyUsage: (usage) => { applied.push(usage); },
    });
    runtime.enqueue({ key: 'agent:1:done', summary: 'reviewer finished' });
    await flush();
    await flush();

    const last = conversation.getMessageSnapshot().at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.role === 'assistant' && last.followUp).toBe(true);
    expect(applied.map((u) => u.inputTokens)).toEqual([1796]);
    // The marker never reaches the provider payload.
    expect(JSON.stringify(conversation.getMessagesForLLM())).not.toContain('followUp');
  });

  test('sumConversationUsage takes the context size from the latest real turn, not an acknowledgement', () => {
    const messages: ConversationMessageSnapshot[] = [
      { role: 'user', content: 'spawn' },
      { role: 'assistant', content: '', usage: { inputTokens: 13292, outputTokens: 139 } },
      { role: 'assistant', content: 'Started.', usage: { inputTokens: 1710, outputTokens: 29 }, followUp: true },
      { role: 'assistant', content: 'Done.', usage: { inputTokens: 1796, outputTokens: 24 }, followUp: true },
    ];
    const { usage, lastInputTokens } = sumConversationUsage(messages);
    expect(lastInputTokens).toBe(13292);
    expect(usage.input).toBe(13292 + 1710 + 1796);
    expect(usage.output).toBe(139 + 29 + 24);
  });

  test('a real turn after acknowledgements sets the context size, cache reads included', () => {
    const messages: ConversationMessageSnapshot[] = [
      { role: 'assistant', content: 'Done.', usage: { inputTokens: 1796, outputTokens: 24 }, followUp: true },
      { role: 'assistant', content: 'Started the loop.', usage: { inputTokens: 0, outputTokens: 39, cacheReadTokens: 31107 } },
    ];
    expect(sumConversationUsage(messages).lastInputTokens).toBe(31107);
  });
});

describe('conversation usage edge cases', () => {
  test('empty, non-assistant and unbilled messages contribute nothing', () => {
    const empty = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lastInputTokens: 0 };
    expect(sumConversationUsage([])).toEqual(empty);
    expect(sumConversationUsage([
      { role: 'user', content: 'hello' }, { role: 'system', content: 'notice' },
      { role: 'tool', callId: 't1', content: 'result' }, { role: 'assistant', content: 'unbilled' },
    ])).toEqual(empty);
  });

  test('a follow-up-only transcript has billed totals but no main context size', () => {
    expect(sumConversationUsage([
      { role: 'assistant', content: 'Done.', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 30 }, followUp: true },
    ])).toEqual({ usage: { input: 10, output: 2, cacheRead: 20, cacheWrite: 30 }, lastInputTokens: 0 });
  });

  test('all cache usage is accumulated and a zero-input latest real turn resets the context', () => {
    const messages: ConversationMessageSnapshot[] = [
      { role: 'assistant', content: 'First.', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 30 } },
      { role: 'assistant', content: 'Follow-up.', usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 }, followUp: true },
    ];
    expect(sumConversationUsage(messages)).toEqual({ usage: { input: 13, output: 6, cacheRead: 25, cacheWrite: 36 }, lastInputTokens: 60 });
    messages.push({ role: 'assistant', content: 'Reset.', usage: { inputTokens: 0, outputTokens: 1 } });
    const before = structuredClone(messages);
    expect(sumConversationUsage(messages)).toEqual({ usage: { input: 13, output: 7, cacheRead: 25, cacheWrite: 36 }, lastInputTokens: 0 });
    expect(messages).toEqual(before);
  });

  test('the marker survives persistence, is excluded from LLM messages, and distinguishes real turns from acknowledgements', () => {
    const conversation = new ConversationManager();
    const usage = { inputTokens: 10, outputTokens: 2 };
    conversation.addAssistantMessage('Done.', { usage, followUp: true });
    conversation.addAssistantMessage('Done.', { usage, followUp: true });
    expect(conversation.getMessageSnapshot()).toHaveLength(2);
    conversation.addAssistantMessage('Done.', { usage });
    expect(conversation.getMessageSnapshot()).toHaveLength(3);
    const restored = new ConversationManager();
    restored.fromJSON(JSON.parse(JSON.stringify(conversation.toJSON())));
    expect(restored.getMessageSnapshot()[0]).toMatchObject({ followUp: true });
    expect(sumConversationUsage(restored.getMessageSnapshot())).toEqual({ usage: { input: 30, output: 6, cacheRead: 0, cacheWrite: 0 }, lastInputTokens: 10 });
    expect(JSON.stringify(restored.getMessagesForLLM())).not.toContain('followUp');
  });

  test('distinct completed requests with identical replies are billed twice; repeated enqueue keys are suppressed within the dedup window', async () => {
    const conversation = new ConversationManager();
    let calls = 0;
    const applied = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const model = { id: 'test', registryKey: 'test:test', provider: 'test', displayName: 'test', capabilities: { reasoning: false } };
    const runtime = new OrchestratorFollowUpRuntime({
      conversation, getViewportHeight: () => 20, scrollToEnd: () => {}, getSystemPrompt: () => '', requestRender: () => {},
      getThinkingState: () => ({ isThinking: false, isCompacting: false }), getQueuedUserMessageCount: () => 0,
      getCurrentModel: () => model as never,
      getProviderRegistry: () => ({
        getForModel: () => ({ chat: async () => { calls++; return { content: 'Done.', usage: { inputTokens: 10, outputTokens: 2 } }; } }),
        getTokenLimitsForModel: () => ({ maxOutputTokens: 4096 }),
      }) as never,
      routeLowPriorityMessage: () => {},
      applyUsage: (usage) => { applied.input += usage.inputTokens; applied.output += usage.outputTokens; },
    });
    const first = { key: 'request:one', summary: 'First request finished.' };
    runtime.enqueue(first);
    runtime.enqueue(first);
    await waitFor(() => conversation.getMessageCount() === 1);
    runtime.enqueue(first);
    runtime.enqueue({ key: 'request:two', summary: 'Second request finished.' });
    await waitFor(() => calls === 2);
    await flush();
    expect(calls).toBe(2);
    expect(conversation.getMessageCount()).toBe(2);
    const restored = new ConversationManager();
    restored.fromJSON(JSON.parse(JSON.stringify(conversation.toJSON())));
    expect(sumConversationUsage(restored.getMessageSnapshot())).toEqual({ usage: applied, lastInputTokens: 0 });
    expect(applied.input).toBe(20);
  });

  for (const [name, responseUsage, freshInput] of [
    ['OpenAI cache-inclusive input', { inputTokens: 100, outputTokens: 2, cacheReadTokens: 80 }, 20],
    ['Anthropic explicit cache breakout', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, 10],
  ] as const) {
    test(`live and resumed totals agree for ${name} without replacing the main context counters`, async () => {
      const conversation = new ConversationManager();
      conversation.addAssistantMessage('Main turn.', {
        usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 200, cacheWriteTokens: 300 },
      });
      const orchestrator = new Orchestrator({
        conversation, getViewportHeight: () => 20, scrollToEnd: () => {},
        toolRegistry: {} as never, permissionManager: {} as never,
        services: { agentManager: {} as never, contractRunner: {} as never, contractIntake: {} as never },
      });
      const model = { id: 'test', registryKey: 'test:test', provider: 'test', displayName: 'test', capabilities: { reasoning: false } };
      orchestrator.setCoreServices({ providerRegistry: {
        getCurrentModel: () => model,
        getForModel: () => ({ chat: async () => ({ content: 'The reviewer finished.', usage: responseUsage }) }),
        getTokenLimitsForModel: () => ({ maxOutputTokens: 4096 }),
      } as never });
      orchestrator.lastRequestInputTokens = 100;
      orchestrator.lastInputTokens = 600;
      orchestrator.usage = sumConversationUsage(conversation.getMessageSnapshot()).usage;
      try {
        orchestrator.enqueueConversationFollowUp({ key: 'review:done', summary: 'The reviewer finished.' });
        await waitFor(() => conversation.getMessageSnapshot().length === 2);
        expect(orchestrator.usage.input).toBe(100 + freshInput);
        expect(orchestrator.usage.output).toBe(7);
        expect(orchestrator.lastRequestInputTokens).toBe(100);
        expect(orchestrator.lastInputTokens).toBe(600);
        expect(conversation.getMessageSnapshot()[1]).toMatchObject({ followUp: true, usage: { inputTokens: freshInput } });
        const restored = new ConversationManager();
        restored.fromJSON(JSON.parse(JSON.stringify(conversation.toJSON())));
        expect(sumConversationUsage(restored.getMessageSnapshot())).toEqual({
          usage: orchestrator.usage,
          lastInputTokens: orchestrator.lastInputTokens,
        });
      } finally { orchestrator.dispose(); }
    });
  }
});
