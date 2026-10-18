/** Usage compatibility for persisted legacy acknowledgements. New background updates run through ordinary checked turns. */
import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../sdk/src/platform/core/conversation.ts';
import { sumConversationUsage } from '../sdk/src/platform/core/orchestrator-usage.ts';
import type { ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.ts';

describe('persisted follow-up acknowledgement usage', () => {
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

});
