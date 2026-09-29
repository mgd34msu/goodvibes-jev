// file-readings.ts
//
// Used by the gates whose question is read through Jev once per file content
// and stored for an offline check (the stale 'server' error-kind docs gate):
// the content hash a stored reading is keyed by, the fixed windows a long
// file is read in, how the readings of a file's windows make the file's
// reading, and the one rule the gate applies to a stored reading.

import { createHash } from 'node:crypto';
import type { Outcome, YesNoReading } from '@goodvibes-jev/judgment';

/** The sha256 of a file's text, the key a stored reading is valid for. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** One window of a file: its one-based first and last line and those lines. */
export interface TextWindow {
  readonly firstLine: number;
  readonly lastLine: number;
  /** The window's lines, each with its one-based line number. */
  readonly lines: readonly { readonly line: number; readonly text: string }[];
}

/** Window size, in lines and in characters: a request buffer size, not a judgment. */
export interface WindowSize {
  readonly maxLines: number;
  readonly maxChars: number;
}

/**
 * Cuts a file into consecutive windows of at most `maxLines` lines and
 * `maxChars` characters. A single line longer than `maxChars` is cut into
 * pieces of that size, each its own window under the same line number, so no
 * text is ever dropped to fit a window.
 */
export function windowsOf(text: string, size: WindowSize): TextWindow[] {
  const pieces: { line: number; text: string }[] = [];
  text.split('\n').forEach((lineText, index) => {
    if (lineText.length <= size.maxChars) {
      pieces.push({ line: index + 1, text: lineText });
      return;
    }
    for (let start = 0; start < lineText.length; start += size.maxChars) {
      pieces.push({ line: index + 1, text: lineText.slice(start, start + size.maxChars) });
    }
  });
  const windows: TextWindow[] = [];
  let current: { line: number; text: string }[] = [];
  let chars = 0;
  const close = (): void => {
    if (current.length === 0) return;
    windows.push({ firstLine: current[0]!.line, lastLine: current[current.length - 1]!.line, lines: current });
    current = [];
    chars = 0;
  };
  for (const piece of pieces) {
    if (current.length >= size.maxLines || (current.length > 0 && chars + piece.text.length + 1 > size.maxChars)) close();
    current.push(piece);
    chars += piece.text.length + 1;
  }
  close();
  return windows;
}

/** A window's text with each line prefixed by its line number. */
export function numberedText(window: TextWindow): string {
  return window.lines.map(({ line, text }) => `${line}| ${text}`).join('\n');
}

/** A file's reading, made from the readings of its windows. */
export interface FileReading {
  readonly verdict: YesNoReading['verdict'];
  readonly outcome: Outcome;
  readonly probability: number;
}

const OUTCOME_STRENGTH: Readonly<Record<Outcome, number>> = { escalate: 0, confirm: 1, act: 2 };

/**
 * A file reads yes when any window reads yes, uncertain when none reads yes
 * and any reads uncertain, and no only when every window reads no. The
 * outcome is the weakest outcome among the windows that decided the verdict,
 * and the probability is the highest yes probability of any window.
 */
export function fileReading(windows: readonly YesNoReading[]): FileReading {
  const probability = Number(Math.max(0, ...windows.map((window) => window.probability)).toFixed(4));
  for (const verdict of ['yes', 'uncertain'] as const) {
    const deciding = windows.filter((window) => window.verdict === verdict);
    if (deciding.length > 0) return { verdict, outcome: weakest(deciding), probability };
  }
  return { verdict: 'no', outcome: windows.length === 0 ? 'act' : weakest(windows), probability };
}

function weakest(windows: readonly YesNoReading[]): Outcome {
  return windows.reduce<Outcome>((low, window) => (OUTCOME_STRENGTH[window.outcome] < OUTCOME_STRENGTH[low] ? window.outcome : low), 'act');
}

/** Only a settled no passes: a yes, an uncertain reading or a no below act fails. */
export function isSettledNo(reading: Pick<FileReading, 'verdict' | 'outcome'>): boolean {
  return reading.verdict === 'no' && reading.outcome === 'act';
}

/** Runs `task` over `items` with at most `limit` in flight. */
export async function eachWithLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
