/**
 * judged-views.ts
 *
 * The conversation before and after a compaction, rendered as text a judgment
 * request can hold. Everything here is code: which messages the compaction
 * carried over unchanged is an exact comparison, and fitting the text into the
 * request is character counting.
 *
 * A compaction keeps some messages exactly as they were and writes new text in
 * place of the rest (a handoff note, a summary). The source view shows every
 * pre-compaction message once, numbered; the compacted view shows the text the
 * compaction wrote and names each run of carried messages by those numbers
 * instead of repeating them, so a reader sees each message once and knows
 * exactly which ones survived.
 */

import type { ProviderMessage } from '../../providers/interface.js';

/**
 * Characters of rendered conversation one judgment request carries, across
 * both views. The request limit is 32k tokens of state plus the longest
 * question, estimated at three characters a token (about 96k characters);
 * JSON encoding of newlines and quotes and the question text need the rest.
 */
export const VIEW_BUDGET_CHARS = 60_000;

/** Characters each rendered entry costs beyond its body (position label, clip note). */
const ENTRY_OVERHEAD_CHARS = 40;

/** The shortest body an entry is clipped to before the oldest source messages are left out instead. */
const MIN_ENTRY_CHARS = 160;

/** The compaction as the judgment requests see it. */
export interface CompactionViews {
  /** The pre-compaction conversation, every message numbered (clipped to fit). */
  readonly source: string;
  /** The compacted conversation: written messages in full (clipped to fit), carried runs named by position. */
  readonly compacted: string;
  /** Only the text the compaction wrote, which is what it claims about the conversation; empty when it wrote nothing. */
  readonly written: string;
}

/** Plain text of one message, including tool calls, tool results and image placeholders. */
export function renderMessage(msg: ProviderMessage): string {
  if (msg.role === 'tool') {
    return `tool result${msg.name ? ` (${msg.name})` : ''}: ${msg.content}`;
  }
  if (msg.role === 'assistant') {
    const calls = (msg.toolCalls ?? []).map((call) => `[calls ${call.name} ${JSON.stringify(call.arguments)}]`);
    return ['assistant:', msg.content, ...calls].filter((part) => part.length > 0).join(' ');
  }
  const body = typeof msg.content === 'string'
    ? msg.content
    : msg.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join(' ');
  return `user: ${body}`;
}

/**
 * For each output message, the index of the input message it repeats exactly,
 * or -1 when the compaction wrote it. Each input message is matched at most once.
 */
function matchCarried(input: readonly ProviderMessage[], output: readonly ProviderMessage[]): number[] {
  const unmatched = new Map<string, number[]>();
  input.forEach((msg, index) => {
    const key = JSON.stringify(msg);
    const list = unmatched.get(key);
    if (list) list.push(index);
    else unmatched.set(key, [index]);
  });
  return output.map((msg) => unmatched.get(JSON.stringify(msg))?.shift() ?? -1);
}

interface Entry {
  readonly body: string;
  /** Source messages may be left out, oldest first, when even clipped entries do not fit. */
  readonly droppable: boolean;
  omitted: boolean;
}

/** Cost of the entries still in the view when every body is clipped to `cap`. */
function costAt(entries: readonly Entry[], cap: number): number {
  return entries.reduce((sum, entry) => (entry.omitted ? sum : sum + Math.min(entry.body.length, cap) + ENTRY_OVERHEAD_CHARS), 0);
}

/**
 * The largest body length that fits every entry into `budget` (water filling:
 * short entries stay whole, long ones share what is left equally). When that
 * falls below MIN_ENTRY_CHARS, the oldest source messages are left out until
 * the rest fit at MIN_ENTRY_CHARS.
 */
function fit(entries: Entry[], budget: number): number {
  if (costAt(entries, Number.POSITIVE_INFINITY) <= budget) return Number.POSITIVE_INFINITY;
  const lengths = entries.map((entry) => entry.body.length).sort((a, b) => a - b);
  let remaining = budget - entries.length * ENTRY_OVERHEAD_CHARS;
  let cap = 0;
  for (let i = 0; i < lengths.length; i++) {
    const share = remaining / (lengths.length - i);
    if (lengths[i]! > share) {
      cap = Math.floor(share);
      break;
    }
    remaining -= lengths[i]!;
  }
  if (cap >= MIN_ENTRY_CHARS) return cap;
  for (const entry of entries) {
    if (costAt(entries, MIN_ENTRY_CHARS) <= budget) break;
    if (entry.droppable) entry.omitted = true;
  }
  return MIN_ENTRY_CHARS;
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)} [${text.length - cap} more characters]`;
}

/** Names a run of input positions (zero based), as the source view numbers them. */
function span(from: number, to: number): string {
  return from === to ? `message #${from + 1}` : `messages #${from + 1} to #${to + 1}`;
}

/**
 * Builds the source, compacted and written views of one compaction within
 * `budget` characters.
 */
export function compactionViews(
  input: readonly ProviderMessage[],
  output: readonly ProviderMessage[],
  budget: number = VIEW_BUDGET_CHARS,
): CompactionViews {
  const carriedFrom = matchCarried(input, output);

  const sourceEntries: Entry[] = input.map((msg) => ({ body: renderMessage(msg), droppable: true, omitted: false }));
  const writtenEntries = output.map((msg, index) => (carriedFrom[index]! >= 0
    ? undefined
    : { body: renderMessage(msg), droppable: false, omitted: false }));
  const cap = fit([...sourceEntries, ...writtenEntries.filter((entry): entry is Entry => entry !== undefined)], budget);

  const sourceLines: string[] = [];
  let omittedFrom = -1;
  sourceEntries.forEach((entry, index) => {
    if (!entry.omitted) {
      sourceLines.push(`#${index + 1} ${clip(entry.body, cap)}`);
      return;
    }
    if (omittedFrom < 0) omittedFrom = index;
    if (sourceEntries[index + 1]?.omitted !== true) {
      sourceLines.push(`[${span(omittedFrom, index)} left out here for length]`);
      omittedFrom = -1;
    }
  });

  const compactedLines: string[] = [];
  const writtenLines: string[] = [];
  let runFrom = -1;
  output.forEach((_, index) => {
    const from = carriedFrom[index]!;
    if (from >= 0) {
      if (runFrom < 0) runFrom = from;
      const next = carriedFrom[index + 1];
      if (next === undefined || next !== from + 1) {
        compactedLines.push(`[${span(runFrom, from)} of the source, unchanged]`);
        runFrom = -1;
      }
      return;
    }
    const line = clip(writtenEntries[index]!.body, cap);
    compactedLines.push(line);
    writtenLines.push(line);
  });

  return {
    source: sourceLines.join('\n\n'),
    compacted: compactedLines.join('\n\n'),
    written: writtenLines.join('\n\n'),
  };
}
