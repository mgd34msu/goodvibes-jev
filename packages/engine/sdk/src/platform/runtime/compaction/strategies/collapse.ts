/**
 * strategies/collapse.ts
 *
 * Collapse strategy, full context collapse into a single compacted summary
 * message. This is the most aggressive strategy, used when token pressure
 * exceeds 85% or when manually triggered.
 *
 * All messages are reduced to a structured handoff that preserves:
 * - Key decisions and outcomes: the collapsed messages that state a
 *   decision, an outcome, a user requirement or constraint, a file change,
 *   or an open task the continuation still depends on, picked by the
 *   `engine.compaction.collapse-keep` reading and quoted in order
 * - The most recent user/assistant exchange
 *
 * Fitting the handoff is code: the quoted text shares a budget of
 * (1 - MAX_COMPRESSION_RATIO) of the tokens before collapse, the point at
 * which the quality score gives full credit for compression. Long quotes are
 * clipped evenly; when clipping is not enough the oldest key messages are
 * left out and counted.
 */

import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { OwnedJudgmentOptions } from '../../owned-judgment-work.js';
import type { ProviderMessage } from '../../../providers/interface.js';
import { estimateTokens } from '../../../core/compaction-types.js';
import { collapseKeep, type KeepEntry } from '../batteries/collapse-keep.js';
import { clip, fit, renderMessage, type Entry } from '../judged-views.js';
import { MAX_COMPRESSION_RATIO } from '../quality-score.js';
import type { StrategyInput, StrategyOutput } from '../types.js';

export const COLLAPSE_KEEP_SITE = 'runtime.compaction.collapse';

/** Characters per token in the strategy's own estimate (core/compaction-types.ts estimateTokens). */
const CHARS_PER_TOKEN = 4;

/** Refits allowed when JSON escaping pushes the handoff past its budget. */
const MAX_REFITS = 3;

/** One quoted body in the handoff; recent-exchange bodies are never left out. */
interface Quote extends Entry {
  readonly prefix: string;
}

/**
 * Applies the collapse strategy: reduces all messages to a single structured
 * handoff message that preserves the essential session context.
 *
 * @param input - Strategy input containing messages and context.
 * @returns Strategy output with a single collapsed message.
 */
export async function runCollapse(input: StrategyInput, options: OwnedJudgmentOptions = {}): Promise<StrategyOutput> {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  const startMs = Date.now();
  const { messages, tokensBefore, sessionId, strategy } = input;
  const warnings: string[] = [];

  // The last user/assistant exchange is quoted as it stands.
  const lastUserIndex = messages.findLastIndex((m) => m.role === 'user');
  const lastAssistantIndex = messages.findLastIndex((m) => m.role === 'assistant');
  const recent: Quote[] = [];
  const lastUserText = lastUserIndex >= 0 ? extractText(messages[lastUserIndex]!) : '';
  const lastAssistantText = lastAssistantIndex >= 0 ? extractText(messages[lastAssistantIndex]!) : '';
  if (lastUserText) recent.push({ prefix: 'User: ', body: lastUserText, droppable: false, omitted: false });
  if (lastAssistantText) recent.push({ prefix: 'Assistant: ', body: lastAssistantText, droppable: false, omitted: false });

  const keys: Quote[] = (await selectKeyMessages(messages, new Set([lastUserIndex, lastAssistantIndex]), options))
    .map((text) => ({ prefix: '- ', body: text, droppable: true, omitted: false }));

  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  const render = (cap: number): string => {
    const omitted = keys.filter((quote) => quote.omitted).length;
    const kept = keys.filter((quote) => !quote.omitted).map((quote) => quote.prefix + clip(quote.body, cap));
    const keySection = keys.length === 0
      ? ['(no decisions or outcomes found)']
      : [...(omitted > 0 ? [`[${omitted} earlier key message(s) left out for length]`] : []), ...kept];
    return [
      `[Session Collapse: ${new Date().toISOString()}]`,
      `Session: ${sessionId}`,
      `${messages.length} message(s) collapsed to reduce context from ~${tokensBefore} tokens.`,
      '',
      '## Key Decisions and Outcomes',
      ...keySection,
      '',
      '## Most Recent Exchange',
      recent.length > 0
        ? recent.map((quote) => quote.prefix + clip(quote.body, cap)).join('\n')
        : '(no user/assistant exchange found)',
      '',
      '## Context Note',
      'The full conversation history has been collapsed. Please resume from the above context.',
    ].join('\n');
  };
  const handoffOf = (text: string): ProviderMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

  const budgetTokens = Math.floor(tokensBefore * (1 - MAX_COMPRESSION_RATIO));
  const quotes = [...keys, ...recent];
  const fixedChars = render(0).length - quotes.reduce((sum, quote) => sum + clip(quote.body, 0).length, 0);
  let bodyBudget = budgetTokens * CHARS_PER_TOKEN - fixedChars;
  let compacted = handoffOf(render(fit(quotes, bodyBudget)));
  let tokensAfter = estimateTokens(JSON.stringify(compacted));
  for (let refit = 0; refit < MAX_REFITS && tokensAfter > budgetTokens; refit++) {
    bodyBudget -= (tokensAfter - budgetTokens) * CHARS_PER_TOKEN;
    compacted = handoffOf(render(fit(quotes, bodyBudget)));
    tokensAfter = estimateTokens(JSON.stringify(compacted));
  }

  if (tokensAfter >= tokensBefore) {
    warnings.push('collapse: compacted output is not smaller than input; possible data issue');
  }

  return {
    messages: compacted,
    tokensAfter,
    summary: `Collapse: ${messages.length} messages → 1 handoff message (~${tokensAfter} tokens).`,
    strategy,
    durationMs: Date.now() - startMs,
    warnings,
  };
}

/**
 * The rendered text of every collapsed message the keep reading selects, in
 * conversation order. The recent exchange is quoted on its own and is not asked about.
 */
async function selectKeyMessages(messages: readonly ProviderMessage[], recentIndexes: ReadonlySet<number>, options: OwnedJudgmentOptions): Promise<string[]> {
  const entries: KeepEntry[] = messages
    .map((msg, index) => ({ number: index + 1, text: renderMessage(msg) }))
    .filter((entry) => !recentIndexes.has(entry.number - 1));
  if (entries.length === 0) return [];
  const supplied = options.port;
  const capture = supplied ? undefined : captureJudgmentPort(COLLAPSE_KEEP_SITE, options);
  const signal = options.signal ?? capture?.signal;
  const readings = await collapseKeep.select(supplied ?? capture!.port, entries, { site: COLLAPSE_KEEP_SITE, ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  options.assertCurrent?.();
  capture?.assertCurrent();
  return entries.filter((entry) => readings.get(entry.number)?.verdict === 'yes').map((entry) => entry.text);
}

/** Extracts plain text from a ProviderMessage. */
function extractText(msg: ProviderMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}
