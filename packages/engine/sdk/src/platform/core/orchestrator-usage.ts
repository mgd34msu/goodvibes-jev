/**
 * orchestrator-usage.ts, the running token totals, as a name.
 *
 * `Orchestrator.usage` was an inferred object literal on the class, so a caller
 * that folds these across conversations, and has to declare the accumulator's
 * type to do it, could reach the shape and not the name. A surface doing
 * exactly that wrote the four fields out again locally.
 *
 * It lives beside the class rather than in it because the class is at its
 * line ceiling, and because a type callers name is not orchestration logic.
 */

import type { ConversationMessageSnapshot, TokenUsage } from './conversation.js';

/** The running token totals an Orchestrator accumulates over a conversation. */
export interface OrchestratorUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function assertTokenUsage(value: unknown): asserts value is TokenUsage {
  const invalid = (): never => { throw new TypeError('Cannot sum conversation usage: invalid assistant token usage.'); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const count = record[field];
    if (count === undefined && (field === 'cacheReadTokens' || field === 'cacheWriteTokens')) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) invalid();
  }
}

function addTokens(total: number, count: number): number {
  const result = total + count;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError('Cannot sum conversation usage: token total exceeds the safe integer range.');
  }
  return result;
}

/**
 * Fold a transcript's assistant usage into running totals, plus the context
 * size the latest real turn request reported (input + cache read + cache
 * write). A resumed session hydrates its counters from this. Follow-up
 * acknowledgements (`followUp`) count toward the totals but never toward the
 * context size: that request leaves out the tool definitions, so its input is
 * smaller than what the session's next turn will send.
 *
 * @throws TypeError if present assistant usage is malformed or any total
 * exceeds the safe integer range. Counts must be non-negative safe integers;
 * callers restoring untrusted sessions should show usage as unavailable on
 * this failure, rather than substituting zero for unknown billing data.
 */
export function sumConversationUsage(
  messages: readonly ConversationMessageSnapshot[],
): { usage: OrchestratorUsageTotals; lastInputTokens: number } {
  const usage: OrchestratorUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastInputTokens = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || message.usage === undefined) continue;
    assertTokenUsage(message.usage);
    usage.input = addTokens(usage.input, message.usage.inputTokens);
    usage.output = addTokens(usage.output, message.usage.outputTokens);
    usage.cacheRead = addTokens(usage.cacheRead, message.usage.cacheReadTokens ?? 0);
    usage.cacheWrite = addTokens(usage.cacheWrite, message.usage.cacheWriteTokens ?? 0);
    if (message.followUp) continue;
    lastInputTokens = addTokens(addTokens(message.usage.inputTokens, message.usage.cacheReadTokens ?? 0), message.usage.cacheWriteTokens ?? 0);
  }
  return { usage, lastInputTokens };
}
