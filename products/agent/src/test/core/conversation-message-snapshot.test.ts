import { describe, test, expect } from 'bun:test';
import {
  readConversationMessageSnapshots,
  conversationMessagesAsSessionRecords,
} from '../../core/conversation-message-snapshot.ts';

// ---------------------------------------------------------------------------
// Valid round-trip: each role
// ---------------------------------------------------------------------------
describe('readConversationMessageSnapshots – valid round-trips', () => {
  test('user message with string content', () => {
    const input = [{ role: 'user', content: 'hello world' }];
    const result = readConversationMessageSnapshots(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'hello world' });
  });

  test('user message with ContentPart[] content', () => {
    const input = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const result = readConversationMessageSnapshots(input);
    expect(result[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  });

  test('user message with cancelled=true', () => {
    const input = [{ role: 'user', content: 'oops', cancelled: true }];
    const result = readConversationMessageSnapshots(input);
    expect(result[0]).toEqual({ role: 'user', content: 'oops', cancelled: true });
  });

  test('assistant message with string content', () => {
    const input = [{ role: 'assistant', content: 'I can help.' }];
    const result = readConversationMessageSnapshots(input);
    expect(result[0]).toEqual({ role: 'assistant', content: 'I can help.' });
  });

  test('assistant message with all optional fields', () => {
    const input = [{
      role: 'assistant',
      content: 'done',
      toolCalls: [{ id: 'tc1', name: 'bash', arguments: { cmd: 'ls' } }],
      reasoningContent: 'thinking...',
      reasoningSummary: 'thought about it',
      usage: { inputTokens: 10, outputTokens: 20 },
      model: 'claude-opus-4-5',
      provider: 'anthropic',
    }];
    const result = readConversationMessageSnapshots(input);
    expect(result[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'done',
      toolCalls: [{ id: 'tc1', name: 'bash', arguments: { cmd: 'ls' } }],
      reasoningContent: 'thinking...',
      reasoningSummary: 'thought about it',
      usage: { inputTokens: 10, outputTokens: 20 },
      model: 'claude-opus-4-5',
      provider: 'anthropic',
    }));
  });

  test('tool message with required fields only', () => {
    const input = [{ role: 'tool', callId: 'call-123', content: 'result output' }];
    const result = readConversationMessageSnapshots(input);
    expect(result[0]).toEqual({ role: 'tool', callId: 'call-123', content: 'result output' });
  });

  test('tool message with optional toolName', () => {
    const input = [{ role: 'tool', callId: 'call-abc', content: 'ok', toolName: 'bash' }];
    const result = readConversationMessageSnapshots(input);
    expect(result[0]).toEqual({ role: 'tool', callId: 'call-abc', content: 'ok', toolName: 'bash' });
  });

  test('system message', () => {
    const input = [{ role: 'system', content: 'You are a helpful assistant.' }];
    const result = readConversationMessageSnapshots(input);
    expect(result[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
  });

  test('multiple messages of mixed roles', () => {
    const input = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', callId: 'c1', content: 'result' },
      { role: 'system', content: 'Note: context cleared.' },
    ];
    const result = readConversationMessageSnapshots(input);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[2].role).toBe('tool');
    expect(result[3].role).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// Throw at index 2
// ---------------------------------------------------------------------------
describe('readConversationMessageSnapshots – throw at index 2', () => {
  test('throws with index in message for malformed entry at index 2', () => {
    const input = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'unknown_role', content: 'bad' }, // malformed: unknown role
    ];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 2/,
    );
  });

  test('throws with index in message for null entry at index 2', () => {
    const input = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      null, // null is not a Record
    ] as object[];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 2/,
    );
  });
});

// ---------------------------------------------------------------------------
// Rejection cases
// ---------------------------------------------------------------------------
describe('readConversationMessageSnapshots – rejection cases', () => {
  test('assistant with non-string content is rejected', () => {
    const input = [{ role: 'assistant', content: 42 }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('assistant with content array (not string) is rejected', () => {
    // assistant role requires string content, not ContentPart[]
    const input = [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('tool missing callId is rejected', () => {
    const input = [{ role: 'tool', content: 'result' }]; // no callId
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('tool with non-string callId is rejected', () => {
    const input = [{ role: 'tool', callId: 999, content: 'result' }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('user with present-but-wrong-typed cancelled field is rejected', () => {
    // cancelled must be boolean when present; 'x' is a string
    const input = [{ role: 'user', content: 'hello', cancelled: 'x' }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('assistant with present-but-wrong-typed usage (missing inputTokens) is rejected', () => {
    // usage present but missing required inputTokens field
    const input = [{ role: 'assistant', content: 'ok', usage: { outputTokens: 5 } }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('assistant with present-but-wrong-typed usage (non-number) is rejected', () => {
    const input = [{ role: 'assistant', content: 'ok', usage: { inputTokens: '10', outputTokens: 5 } }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('assistant with toolCalls entry missing id is rejected', () => {
    const input = [{
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ name: 'bash', arguments: { cmd: 'ls' } }], // missing id
    }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('assistant with toolCalls entry where id is non-string is rejected', () => {
    const input = [{
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: 123, name: 'bash', arguments: {} }], // id is number
    }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('assistant with toolCalls entry where arguments is not a record is rejected', () => {
    const input = [{
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: 'tc1', name: 'bash', arguments: 'not-an-object' }],
    }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('tool with present-but-wrong-typed toolName is rejected', () => {
    const input = [{ role: 'tool', callId: 'c1', content: 'res', toolName: 42 }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });

  test('unknown role is rejected', () => {
    const input = [{ role: 'function', content: 'legacy' }];
    expect(() => readConversationMessageSnapshots(input)).toThrow(
      /Invalid saved conversation message at index 0/,
    );
  });
});

// ---------------------------------------------------------------------------
// conversationMessagesAsSessionRecords – plain spread
// ---------------------------------------------------------------------------
describe('conversationMessagesAsSessionRecords', () => {
  test('produces plain spread records with correct shape', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ];
    const records = conversationMessagesAsSessionRecords(messages);
    expect(records).toHaveLength(2);
    // Each record is a plain object (spread copy)
    expect(records[0]).toEqual({ role: 'user', content: 'hi' });
    expect(records[1]).toEqual({ role: 'assistant', content: 'hello' });
    // Spread produces a new object, not the same reference
    expect(records[0]).not.toBe(messages[0]);
  });

  test('preserves all fields in spread', () => {
    const messages = [{
      role: 'assistant' as const,
      content: 'done',
      toolCalls: [{ id: 'tc1', name: 'bash', arguments: {} }],
      usage: { inputTokens: 5, outputTokens: 10 },
    }];
    const records = conversationMessagesAsSessionRecords(messages);
    expect(records[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'done',
      toolCalls: [{ id: 'tc1', name: 'bash', arguments: {} }],
      usage: { inputTokens: 5, outputTokens: 10 },
    }));
  });

  test('returns empty array for empty input', () => {
    expect(conversationMessagesAsSessionRecords([])).toEqual([]);
  });
});
