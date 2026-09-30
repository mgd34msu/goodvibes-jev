import { freezeSupport } from '../verification/projection.js';
import { ANSWER_EXCERPT_LIMITS as LIMITS, KnowledgeAnswerExcerptHeldError as Held,
  type AnswerExcerptDocument, type AnswerExcerptSpan } from './types.js';

/** Mechanical paragraph boundaries only: no short-sentence floor or token windows.
 * Single newlines keep tables and label/value rows intact. Offer the adjacent
 * blocks and the whole document so subject headings and late exceptions can
 * remain in the selected original span, not just in hidden reading context.
 */
export function answerExcerptSpans(document: AnswerExcerptDocument): readonly AnswerExcerptSpan[] {
  const text = document.text;
  const blocks: { start: number; end: number }[] = [];
  const append = (start: number, end: number) => {
    while (start < end && /\s/u.test(text[start]!)) start++;
    while (end > start && /\s/u.test(text[end - 1]!)) end--;
    if (start < end) blocks.push({ start, end });
  };
  let start = 0;
  for (const boundary of text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
    append(start, boundary.index); start = boundary.index + boundary[0].length;
  }
  append(start, text.length);
  const spans: AnswerExcerptSpan[] = [];
  const seen = new Set<string>();
  const add = (start: number, end: number) => {
    const key = `${start}:${end}`; if (seen.has(key)) return;
    seen.add(key);
    if (spans.length >= LIMITS.candidates) throw new Held('budget');
    spans.push({ reference: `span-${spans.length + 1}`, document: document.reference, start, end, text: text.slice(start, end) });
  };
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!; add(block.start, block.end);
    add(blocks[Math.max(0, index - 1)]!.start, blocks[Math.min(blocks.length - 1, index + 1)]!.end);
  }
  // Indentation or trailing whitespace can be meaningful (for example code).
  // Always offer the entire original field, not merely the trimmed blocks.
  if (blocks.length) add(0, text.length);
  return freezeSupport(spans);
}
