import { createHash } from 'node:crypto';

export interface ReadObservation {
  startLine: number;
  completeLines: number;
  numbered: boolean;
  contentSha256: string;
  truncated: boolean;
}

const digest = (content: string) => createHash('sha256').update(content).digest('hex');

/** Describes actual formatted text, never credits the requested end or file total. */
export function observeReadContent(content: string, startLine: number, completeLines: number, numbered: boolean): ReadObservation {
  return { startLine, completeLines, numbered, contentSha256: digest(content), truncated: false };
}

/** A clipped final row is not a complete source line, even if its number survived. */
export function clipReadContent(file: { content?: string | undefined; readObservation?: ReadObservation | undefined }, characters: number): void {
  if (file.content === undefined || file.content.length <= characters) return;
  file.content = file.content.slice(0, characters);
  if (file.readObservation) file.readObservation = { ...file.readObservation, truncated: true,
    completeLines: Math.min(file.readObservation.completeLines, file.content.split('\n').length - 1), contentSha256: digest(file.content) };
}

/** Normalize host-bound complete rows for evidence and immutable-input checking. */
export function returnedReadRows(file: { content: string; readObservation?: unknown }): string[] {
  if (file.readObservation === undefined) return file.content.split('\n').filter(row => /^[ \t]*\d+ \|/.test(row));
  const value = file.readObservation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const observed = value as ReadObservation;
  if (!Number.isSafeInteger(observed.startLine) || observed.startLine < 1 || !Number.isSafeInteger(observed.completeLines)
    || observed.completeLines < 0 || !Number.isSafeInteger(observed.startLine + observed.completeLines)
    || typeof observed.numbered !== 'boolean' || observed.contentSha256 !== digest(file.content)) return [];
  const rows = file.content.split('\n');
  if (observed.completeLines > rows.length) return [];
  const complete = rows.slice(0, observed.completeLines);
  if (!observed.numbered) return complete.map((row, index) => `${String(observed.startLine + index).padStart(5)} | ${row}`);
  return complete.every((row, index) => Number(/^[ \t]*(\d+) \|/.exec(row)?.[1]) === observed.startLine + index) ? complete : [];
}
