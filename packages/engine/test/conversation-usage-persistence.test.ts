/** Untrusted JSONL usage stays unknown instead of becoming NaN, concatenated strings or zero. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationManager, type ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.js';
import { sumConversationUsage } from '../sdk/src/platform/core/orchestrator-usage.js';
import { SessionManager } from '../sdk/src/platform/sessions/manager.js';

function persisted(messages: object[]): ConversationMessageSnapshot[] {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-usage-'));
  try {
    const sessions = new SessionManager('/unused', { sessionsDir: dir });
    sessions.save('usage', messages, { title: 'Usage fixture', model: 'test', provider: 'test', timestamp: 1 });
    const conversation = new ConversationManager();
    conversation.fromJSON({ messages: sessions.load('usage').messages as ConversationMessageSnapshot[] });
    return conversation.getMessageSnapshot();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const valid = { inputTokens: 10, outputTokens: 2 };

describe('persisted conversation usage', () => {
  test('valid totals and the follow-up marker survive the actual session writer and loader', () => {
    expect(sumConversationUsage(persisted([
      { role: 'assistant', content: 'Main.', usage: { ...valid, cacheReadTokens: 20, cacheWriteTokens: 30 } },
      { role: 'assistant', content: 'Follow-up.', usage: valid, followUp: true },
      { role: 'assistant', content: 'Unbilled.' },
    ]))).toEqual({ usage: { input: 20, output: 4, cacheRead: 20, cacheWrite: 30 }, lastInputTokens: 60 });
  });

  for (const [name, usage] of [
    ['null usage', null], ['string usage', 'private-invalid-value'], ['array usage', []],
    ['missing input', { outputTokens: 2 }], ['missing output', { inputTokens: 10 }],
    ['string input', { ...valid, inputTokens: 'private-invalid-value' }],
    ['null output', { ...valid, outputTokens: null }],
    ['negative input', { ...valid, inputTokens: -1 }],
    ['fractional output', { ...valid, outputTokens: 0.5 }],
    ['unsafe input', { ...valid, inputTokens: Number.MAX_SAFE_INTEGER + 1 }],
    ['NaN input serialized as null', { ...valid, inputTokens: Number.NaN }],
    ['infinite output serialized as null', { ...valid, outputTokens: Number.POSITIVE_INFINITY }],
    ['null cache read', { ...valid, cacheReadTokens: null }],
    ['string cache write', { ...valid, cacheWriteTokens: 'private-invalid-value' }],
  ] as const) {
    test(`${name} fails explicitly without exposing values`, () => {
      const messages = persisted([{ role: 'assistant', content: 'Private reply.', usage }]);
      expect(() => sumConversationUsage(messages)).toThrow(new TypeError('Cannot sum conversation usage: invalid assistant token usage.'));
    });
  }

  test('absent usage remains unbilled, rather than being a malformed present record', () => {
    expect(sumConversationUsage(persisted([{ role: 'assistant', content: 'No usage.' }]))).toEqual({
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lastInputTokens: 0,
    });
  });

  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    test(`aggregate ${field} overflow fails explicitly`, () => {
      const messages = persisted([
        { role: 'assistant', content: 'First.', usage: { inputTokens: 0, outputTokens: 0, [field]: Number.MAX_SAFE_INTEGER } },
        { role: 'assistant', content: 'Second.', usage: { inputTokens: 0, outputTokens: 0, [field]: 1 } },
      ]);
      expect(() => sumConversationUsage(messages)).toThrow(new TypeError('Cannot sum conversation usage: token total exceeds the safe integer range.'));
    });
  }

  test('context-size addition overflow also fails explicitly', () => {
    const messages = persisted([{ role: 'assistant', content: 'Main.', usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 1 } }]);
    expect(() => sumConversationUsage(messages)).toThrow(TypeError);
  });
});
