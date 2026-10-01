import { describe, expect, test } from 'bun:test';
import { ConversationManager, type ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.ts';
import { messagesToInternal, restoreKeptMessages } from '../sdk/src/platform/core/conversation-utils.ts';
import { compactSmallWindow } from '../sdk/src/platform/core/context-compaction.ts';
import type { ProviderMessage } from '../sdk/src/platform/providers/interface.ts';

// The defect this pins: replaceMessagesForLLM rebuilt the kept messages from
// provider messages with role and text only, so a compaction stripped every
// kept assistant message of its tool calls, model and reasoning. The next
// request then carried tool results with no call before them, and a transcript
// lost the call names. Every consumer compacts through this method (the main
// session, spawned agents, companion chat), so it is fixed here.

const USAGE = { inputTokens: 900, outputTokens: 120 };

function conversationWithTurns(): ConversationManager {
  const cm = new ConversationManager();
  for (let k = 0; k < 3; k++) {
    cm.addUserMessage(`question ${k}`);
    cm.addAssistantMessage('', {
      toolCalls: [{ id: `r${k}`, name: 'read', arguments: { path: `src/f${k}.ts` } }],
      model: 'route-llm',
      provider: 'abacus',
      reasoningContent: `thinking ${k}`,
      reasoningSummary: `summary ${k}`,
      usage: USAGE,
    });
    cm.addToolResults([{ callId: `r${k}`, success: true, output: `line ${k}` }]);
    cm.addAssistantMessage(`answer ${k}`, { model: 'route-llm', provider: 'abacus', usage: USAGE });
  }
  return cm;
}

function assistants(messages: ConversationMessageSnapshot[]) {
  return messages.flatMap((m) => (m.role === 'assistant' ? [m] : []));
}

function callsPairWithResults(messages: readonly ProviderMessage[]): boolean {
  const calls = new Set(messages.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [])));
  return messages.every((m) => m.role !== 'tool' || calls.has(m.callId));
}

describe('compaction keeps kept messages whole', () => {
  test('small-window keep-last-N keeps tool calls, model, provider, reasoning and usage', () => {
    const cm = conversationWithTurns();
    const before = cm.getMessageSnapshot();
    cm.replaceMessagesForLLM(compactSmallWindow(cm.getMessagesForLLM(), 4));
    const after = cm.getMessageSnapshot();
    // summary pair + the last 4 stored messages, byte for byte.
    expect(after).toHaveLength(6);
    expect(after.slice(2)).toEqual(before.slice(-4));
    const withCall = assistants(after).find((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withCall?.toolCalls?.[0]).toEqual({ id: 'r2', name: 'read', arguments: { path: 'src/f2.ts' } });
    expect(withCall?.model).toBe('route-llm');
    expect(withCall?.provider).toBe('abacus');
    expect(withCall?.reasoningContent).toBe('thinking 2');
    expect(withCall?.reasoningSummary).toBe('summary 2');
    expect(withCall?.usage).toEqual(USAGE);
  });

  test('the next request pairs every kept tool result with its call', () => {
    const cm = conversationWithTurns();
    cm.replaceMessagesForLLM(cm.getMessagesForLLM().slice(-4));
    const next = cm.getMessagesForLLM();
    expect(next.some((m) => m.role === 'tool')).toBe(true);
    expect(callsPairWithResults(next)).toBe(true);
  });

  test('a kept message is a copy: later edits to the old array do not reach the store', () => {
    const cm = conversationWithTurns();
    const kept = cm.getMessagesForLLM().slice(-4);
    cm.replaceMessagesForLLM(kept);
    const stored = assistants(cm.getMessageSnapshot()).find((m) => m.toolCalls);
    (kept.find((m) => m.role === 'assistant' && m.toolCalls) as { toolCalls: { name: string }[] }).toolCalls[0]!.name = 'mutated';
    expect(assistants(cm.getMessageSnapshot()).find((m) => m.toolCalls)?.toolCalls?.[0]?.name).toBe(stored?.toolCalls?.[0]?.name);
  });

  test('provider messages a compaction wrote itself keep their tool calls', () => {
    const cm = conversationWithTurns();
    cm.replaceMessagesForLLM([
      { role: 'user', content: 'summary' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x1', name: 'read', arguments: { path: 'z.ts' } }] },
      { role: 'tool', callId: 'x1', content: 'a\nb\n', name: 'read' },
    ]);
    const after = cm.getMessageSnapshot();
    expect(assistants(after)[0]?.toolCalls).toEqual([{ id: 'x1', name: 'read', arguments: { path: 'z.ts' } }]);
    expect(after[2]).toEqual({ role: 'tool', callId: 'x1', content: 'a\nb\n', toolName: 'read' });
    expect(callsPairWithResults(cm.getMessagesForLLM())).toBe(true);
  });

  test('a copied (not identical) kept assistant message is matched to its source by its exact, unique provider projection', () => {
    const cm = conversationWithTurns();
    const copies = structuredClone(cm.getMessagesForLLM().slice(-4));
    cm.replaceMessagesForLLM(copies);
    const withCall = assistants(cm.getMessageSnapshot()).find((m) => m.toolCalls);
    expect(withCall?.model).toBe('route-llm');
    expect(withCall?.reasoningContent).toBe('thinking 2');
    expect(assistants(cm.getMessageSnapshot()).at(-1)?.content).toBe('answer 2');
  });

  test('system messages stay at the front and the title survives', () => {
    const cm = conversationWithTurns();
    cm.title = 'Fix retry backoff';
    cm.addSystemMessage('note');
    cm.replaceMessagesForLLM(cm.getMessagesForLLM().slice(-4));
    expect(cm.title).toBe('Fix retry backoff');
    const after = cm.getMessageSnapshot();
    expect(after[0]).toEqual({ role: 'system', content: 'note' });
    expect(after.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  test('messagesToInternal keeps an assistant message\'s tool calls', () => {
    const [assistant] = messagesToInternal([
      { role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'exec', arguments: { cmd: 'ls' } }] },
    ]);
    expect(assistant).toEqual({ role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'exec', arguments: { cmd: 'ls' } }] });
    expect(messagesToInternal([{ role: 'assistant', content: 'y' }])[0]).toEqual({ role: 'assistant', content: 'y' });
  });

  test('restoreKeptMessages converts when the provider list does not line up with the store', () => {
    const stored: ConversationMessageSnapshot[] = [{ role: 'user', content: 'a' }];
    const kept: ProviderMessage[] = [{ role: 'tool', callId: 'c', content: 'out' }];
    expect(restoreKeptMessages(kept, [], stored)).toEqual([{ role: 'tool', callId: 'c', content: 'out' }]);
  });

  test('copied tool results retain their exact outcome and copied users retain cancellation', () => {
    const cm = conversationWithTurns();
    cm.markLastUserMessageCancelled();
    const before = cm.getMessageSnapshot().slice(-4);
    cm.replaceMessagesForLLM(structuredClone(cm.getMessagesForLLM().slice(-4)));
    expect(cm.getMessageSnapshot()).toEqual(before);
    expect(cm.getMessageSnapshot()[0]).toMatchObject({ role: 'user', cancelled: true });
    expect(cm.getMessageSnapshot()[2]).toMatchObject({ role: 'tool', outcome: 'ok' });
  });

  test('changed tool arguments do not borrow metadata from an old call with the same id', () => {
    const cm = conversationWithTurns();
    const copied = structuredClone(cm.getMessagesForLLM().slice(-4));
    const call = copied.find((message) => message.role === 'assistant')?.toolCalls?.[0];
    expect(call).toBeDefined();
    call!.arguments = { path: 'different.ts' };
    cm.replaceMessagesForLLM(copied);
    const assistant = assistants(cm.getMessageSnapshot()).find((message) => message.toolCalls);
    expect(assistant?.toolCalls?.[0]?.arguments).toEqual({ path: 'different.ts' });
    expect(assistant?.model).toBeUndefined();
    expect(assistant?.usage).toBeUndefined();
  });

  test('ambiguous cloned occurrences never acquire another turn\'s metadata', () => {
    const cm = new ConversationManager();
    cm.addAssistantMessage('same text', { model: 'older', usage: { inputTokens: 1, outputTokens: 2 } });
    cm.addUserMessage('next');
    cm.addAssistantMessage('same text', { model: 'newer', usage: { inputTokens: 3, outputTokens: 4 } });
    const copied = structuredClone(cm.getMessagesForLLM().slice(-1));
    cm.replaceMessagesForLLM(copied);
    expect(cm.getMessageSnapshot()).toEqual([{ role: 'assistant', content: 'same text' }]);
  });

  test('identity preserves the right duplicate occurrence and each source can be restored once', () => {
    const cm = new ConversationManager();
    cm.addAssistantMessage('same text', { model: 'older' });
    cm.addUserMessage('next');
    cm.addAssistantMessage('same text', { model: 'newer' });
    const last = cm.getMessagesForLLM().at(-1)!;
    cm.replaceMessagesForLLM([last, last]);
    const after = assistants(cm.getMessageSnapshot());
    expect(after[0]?.model).toBe('newer');
    expect(after[1]).toEqual({ role: 'assistant', content: 'same text' });
  });

  test('a same-role but unrelated provider list cannot confer stored provenance', () => {
    const stored: ConversationMessageSnapshot[] = [{ role: 'assistant', content: 'original', model: 'private-model' }];
    const unrelated: ProviderMessage[] = [{ role: 'assistant', content: 'unrelated' }];
    expect(restoreKeptMessages(unrelated, unrelated, stored)).toEqual([{ role: 'assistant', content: 'unrelated' }]);
  });

  test('consuming one duplicate does not make an ambiguous clone claim the other occurrence', () => {
    const cm = new ConversationManager();
    cm.addAssistantMessage('same text', { model: 'older' });
    cm.addUserMessage('next');
    cm.addAssistantMessage('same text', { model: 'newer' });
    const first = cm.getMessagesForLLM()[0]!;
    cm.replaceMessagesForLLM([first, structuredClone(first)]);
    const after = assistants(cm.getMessageSnapshot());
    expect(after[0]?.model).toBe('older');
    expect(after[1]).toEqual({ role: 'assistant', content: 'same text' });
  });

  test('whole-record retention preserves additive assistant metadata from persisted sessions', () => {
    const cm = new ConversationManager();
    const messages = [{ role: 'assistant' as const, content: 'finished work', followUp: true as const,
      model: 'synthetic-model', provider: 'synthetic-provider', usage: { inputTokens: 6, outputTokens: 2 } }];
    cm.fromJSON({ messages });
    cm.replaceMessagesForLLM(cm.getMessagesForLLM());
    expect(cm.getMessageSnapshot()).toEqual(messages);
  });

  test('an ambiguous copied multimodal user record does not alias the caller\'s array', () => {
    const cm = new ConversationManager();
    cm.addUserMessage([{ type: 'text', text: 'same content' }]);
    cm.markLastUserMessageCancelled();
    cm.addUserMessage([{ type: 'text', text: 'same content' }]);
    const copied = structuredClone(cm.getMessagesForLLM().slice(-1));
    cm.replaceMessagesForLLM(copied);
    const user = copied[0];
    if (user?.role !== 'user' || typeof user.content === 'string' || user.content[0]?.type !== 'text') {
      throw new Error('Expected synthetic multimodal user fixture');
    }
    user.content[0].text = 'caller mutation';
    expect(cm.getMessageSnapshot()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'same content' }] }]);
  });

  test('a newly written multimodal provider record owns its converted array', () => {
    const cm = conversationWithTurns();
    const content = [{ type: 'text' as const, text: 'new summary' }];
    cm.replaceMessagesForLLM([{ role: 'user', content }]);
    content[0]!.text = 'caller mutation';
    content.push({ type: 'text', text: 'extra caller part' });
    expect(cm.getMessageSnapshot()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'new summary' }] }]);
  });
});
