import { snapshotJudgmentInput } from '../gate/judgment-input.js';

/** Whitespace gaps are mechanical candidates, never evidence that a sentence ended. */
export function speechCandidates(paragraph: string): number[] {
  const offsets = [...paragraph.matchAll(/\s+/g)].map(match => match.index!);
  offsets.push(paragraph.length);
  return offsets;
}
export function snapshotSpeechSeams(raw: unknown): { paragraph: string; candidates: readonly number[]; nextCursor: number | null } {
  const value = snapshotJudgmentInput(raw) as { paragraph: string; candidates: number[]; nextCursor: number | null };
  if (typeof value.paragraph !== 'string' || !value.paragraph || value.paragraph.length > 32768
    || !Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > 64
    || value.candidates.some((offset, i) => !Number.isInteger(offset) || offset <= 0 || offset > value.paragraph.length || (i > 0 && offset <= value.candidates[i - 1]!))
    || (value.nextCursor !== null && (!Number.isInteger(value.nextCursor) || value.nextCursor < 64 || value.nextCursor >= 4096))) throw new Error('Unsupported speech source');
  return value;
}
export function canonicalSpeechSeams(content: string, start: number, end: number, cursor: number) {
  // Require one complete trimmed paragraph, never a caller-selected excerpt.
  let found = false;
  let position = 0;
  for (const raw of content.split(/(\n{2,})/)) {
    const text = raw.trim(); const offset = position + raw.indexOf(text);
    if (text && offset === start && offset + text.length === end) found = true;
    position += raw.length;
  }
  if (!found) throw new Error('Unsupported speech source');
  const paragraph = content.slice(start, end); const candidates = speechCandidates(paragraph);
  if (candidates.length > 4096 || cursor >= candidates.length) throw new Error('Unsupported speech source');
  return snapshotSpeechSeams({ paragraph, candidates: candidates.slice(cursor, cursor + 64), nextCursor: cursor + 64 < candidates.length ? cursor + 64 : null });
}
