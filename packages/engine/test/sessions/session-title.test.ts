import { describe, expect, test } from 'bun:test';
import { createSessionTitleGenerator, sanitizeSessionTitle } from '../../sdk/src/platform/sessions/index.js';
import type { ConversationMessageSnapshot } from '../../sdk/src/platform/core/conversation.js';

const firstUser: ConversationMessageSnapshot[] = [{ role: 'user', content: 'help me refactor the auth module' }];

describe('shared session title generation', () => {
  test('keeps the exact prompt and request limits using the supplied model', async () => {
    const calls: unknown[][] = [];
    const generator = createSessionTitleGenerator({ chat: async (...args) => { calls.push(args); return '"Refactor Auth Module."\nextra'; } });
    expect(await generator.generate(() => [{ role: 'user', content: 'x'.repeat(2200) }])).toBe('Refactor Auth Module');
    expect(calls).toEqual([[`Title this conversation. First user message:\n"""${'x'.repeat(2000)}"""`, {
      maxTokens: 24,
      systemPrompt: 'You write terse chat titles. Reply with ONLY a 3 to 6 word title, Title Case, no surrounding quotes, no trailing punctuation, no preamble.',
    }]]);
  });

  test('uses the first nonempty user text including multipart messages', async () => {
    let prompt = '';
    const generator = createSessionTitleGenerator({ chat: async (value) => { prompt = value; return 'Title'; } });
    await generator.generate(() => [
      { role: 'system', content: 'ignore system' }, { role: 'assistant', content: 'ignore assistant' },
      { role: 'user', content: '  ' },
      { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'request' }] },
      { role: 'user', content: 'later request' },
    ]);
    expect(prompt).toBe('Title this conversation. First user message:\n"""first request"""');
  });

  test('no user text does not consume the single attempt', async () => {
    let calls = 0;
    const generator = createSessionTitleGenerator({ chat: async () => { calls++; return 'Title'; } });
    expect(await generator.generate(() => [{ role: 'user', content: [] }])).toBeNull();
    expect(await generator.generate(() => firstUser)).toBe('Title');
    expect(calls).toBe(1);
  });

  test('overlapping and later calls never repeat the model attempt', async () => {
    let release!: (value: string) => void; let calls = 0;
    const generator = createSessionTitleGenerator({ chat: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
    const pending = generator.generate(() => firstUser);
    expect(await generator.generate(() => firstUser)).toBeNull();
    release('Title'); expect(await pending).toBe('Title');
    expect(await generator.generate(() => firstUser)).toBeNull(); expect(calls).toBe(1);
  });

  for (const result of ['reject', 'empty'] as const) test(`${result} consumes the attempt without retry`, async () => {
    let calls = 0; let snapshots = 0;
    const readMessages = () => { snapshots++; return firstUser; };
    const generator = createSessionTitleGenerator({ chat: async () => { calls++; if (result === 'reject') throw new Error('offline'); return '  '; } });
    expect(await generator.generate(readMessages)).toBeNull();
    expect(await generator.generate(readMessages)).toBeNull(); expect(calls).toBe(1); expect(snapshots).toBe(1);
  });

  test('sanitization preserves the first-line, quote, whitespace, punctuation and 60-character contract', () => {
    expect(sanitizeSessionTitle('  `Refactor\t  Auth Module!`\nmore')).toBe('Refactor Auth Module');
    expect(sanitizeSessionTitle(' \nNext line')).toBeNull();
    expect(sanitizeSessionTitle('a'.repeat(61))).toBe('a'.repeat(60));
  });
});
