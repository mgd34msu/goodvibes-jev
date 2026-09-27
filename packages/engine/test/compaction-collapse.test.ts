/**
 * compaction-collapse.test.ts
 *
 * The collapse strategy's handoff: the `engine.compaction.collapse-keep`
 * reading picks the collapsed messages that carry decisions, outcomes,
 * requirements, file changes and open work; code quotes them in order under
 * "## Key Decisions and Outcomes", beside the most recent exchange, within
 * (1 - MAX_COMPRESSION_RATIO) of the tokens before collapse. Pins what is
 * asked (one question per message, as few requests as the limits allow),
 * what is quoted, the budget, and that a read with no port throws.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { validateContextBudget, type EntryType, type Questions } from '@goodvibes-jev/judgment';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { runCollapse } from '../sdk/src/platform/runtime/compaction/strategies/collapse.ts';
import { packKeepRequests } from '../sdk/src/platform/runtime/compaction/batteries/collapse-keep.ts';
import { MAX_COMPRESSION_RATIO } from '../sdk/src/platform/runtime/compaction/quality-score.ts';
import type { StrategyInput } from '../sdk/src/platform/runtime/compaction/types.ts';
import type { ProviderMessage } from '../sdk/src/platform/providers/interface.ts';
import { compactionQualityPort } from './_helpers/compaction-quality.ts';

const CONVERSATION: ProviderMessage[] = [
  { role: 'user', content: 'Fix the CSV export dropping its last row. Do not change the public API.' },
  { role: 'assistant', content: 'Let me look at the exporter.', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'src/export.ts' } }] },
  { role: 'tool', callId: 'c1', name: 'read', content: 'export function toRows(text) { const lines = text.split("\\n"); lines.pop(); return lines; }' },
  { role: 'assistant', content: 'Removed the unconditional lines.pop() in toRows in src/export.ts; the last row is kept now.' },
  { role: 'user', content: 'thanks' },
  { role: 'user', content: 'Now add a test for it.' },
  { role: 'assistant', content: 'Adding test/export.test.ts next.' },
];

function input(messages: ProviderMessage[], tokensBefore = 10_000): StrategyInput {
  return { sessionId: 's-1', messages, tokensBefore, contextWindow: 100_000, strategy: 'collapse' };
}

function handoffText(messages: readonly ProviderMessage[]): string {
  const [handoff] = messages;
  const content = handoff!.content as Array<{ type: 'text'; text: string }>;
  return content[0]!.text;
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

describe('the collapse handoff', () => {
  test('quotes the messages read as key, in order, before the most recent exchange', async () => {
    const { port, requests } = compactionQualityPort({ keep: (n) => (n === 1 || n === 4 ? 0.9 : 0.1) });
    installJudgmentPort(port);
    const output = await runCollapse(input(CONVERSATION));

    // One request; the recent exchange (#6, #7) is quoted on its own and not asked about.
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toEqual(['keep_1', 'keep_2', 'keep_3', 'keep_4', 'keep_5']);
    expect((requests[0]!.state as { conversation: string }).conversation).toContain('#3 tool result (read): export function toRows');

    expect(output.messages).toHaveLength(1);
    const text = handoffText(output.messages);
    expect(text).toContain([
      '## Key Decisions and Outcomes',
      '- user: Fix the CSV export dropping its last row. Do not change the public API.',
      '- assistant: Removed the unconditional lines.pop() in toRows in src/export.ts; the last row is kept now.',
      '',
      '## Most Recent Exchange',
      'User: Now add a test for it.',
      'Assistant: Adding test/export.test.ts next.',
      '',
      '## Context Note',
    ].join('\n'));
    expect(text).not.toContain('thanks');
    expect(output.summary).toBe(`Collapse: 7 messages → 1 handoff message (~${output.tokensAfter} tokens).`);
    expect(output.strategy).toBe('collapse');
  });

  test('says so when no message is read as key', async () => {
    installJudgmentPort(compactionQualityPort({ keep: () => 0.1 }).port);
    const text = handoffText((await runCollapse(input(CONVERSATION))).messages);
    expect(text).toContain('## Key Decisions and Outcomes\n(no decisions or outcomes found)\n');
  });

  test('a conversation that is only the recent exchange asks nothing', async () => {
    const { port, requests } = compactionQualityPort();
    installJudgmentPort(port);
    const text = handoffText((await runCollapse(input(CONVERSATION.slice(5)))).messages);
    expect(requests).toHaveLength(0);
    expect(text).toContain('User: Now add a test for it.');
  });

  test('stays within the compression budget: long quotes are clipped, then the oldest key messages are left out', async () => {
    const long = Array.from({ length: 40 }, (_, i): ProviderMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `decision ${i}: ` + 'keep the retry budget at five attempts '.repeat(80),
    }));
    installJudgmentPort(compactionQualityPort({ keep: () => 0.9 }).port);
    const tokensBefore = 8_000;
    const output = await runCollapse(input(long, tokensBefore));
    const budget = Math.floor(tokensBefore * (1 - MAX_COMPRESSION_RATIO));
    expect(output.tokensAfter).toBeLessThanOrEqual(budget);
    const text = handoffText(output.messages);
    expect(text).toContain('more characters]');
    expect(text).toMatch(/\[\d+ earlier key message\(s\) left out for length\]/);
    // The newest key message survives; the recent exchange is always quoted.
    expect(text).toContain('- user: decision 36:');
    expect(text).toContain('User: decision 38:');
    expect(text).toContain('Assistant: decision 39:');
  });

  test('a read with no judgment port installed throws', async () => {
    await expect(runCollapse(input(CONVERSATION))).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('request packing', () => {
  test('a long conversation is split into as few requests as the limits allow, each message asked once', async () => {
    const many = Array.from({ length: 120 }, (_, i): ProviderMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i} ` + 'x'.repeat(3_000),
    }));
    const { port, requests } = compactionQualityPort();
    installJudgmentPort(port);
    await runCollapse(input(many, 200_000));

    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(() => validateContextBudget(request.state as EntryType, request.questions as Questions)).not.toThrow();
    }
    const asked = requests.flatMap((request) => Object.keys(request.questions));
    expect(asked).toEqual(Array.from({ length: 118 }, (_, i) => `keep_${i + 1}`));

    // Fewest requests: no two neighbouring runs would fit in one.
    const runs = packKeepRequests(Array.from({ length: 118 }, (_, i) => ({ number: i + 1, text: `${i % 2 === 0 ? 'user' : 'assistant'}: message ${i} ${'x'.repeat(3_000)}` })));
    expect(runs).toHaveLength(requests.length);
    for (let i = 1; i < runs.length; i++) {
      expect(packKeepRequests([...runs[i - 1]!, ...runs[i]!])).toHaveLength(2);
    }
  });
});
