/**
 * How the stored-reading gates cut a file into windows and make one file
 * reading from its windows' readings.
 */
import { describe, expect, test } from 'bun:test';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { fileReading, isSettledNo, numberedText, windowsOf } from '../scripts/file-readings.ts';

const reading = (verdict: YesNoReading['verdict'], outcome: YesNoReading['outcome'], probability: number): YesNoReading => ({
  kind: 'yes-no',
  verdict,
  outcome,
  probability,
});

describe('windowsOf', () => {
  test('keeps every line, in order, within the line and character limits', () => {
    const text = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n');
    const windows = windowsOf(text, { maxLines: 10, maxChars: 1_000 });
    expect(windows.map(({ firstLine, lastLine }) => [firstLine, lastLine])).toEqual([[1, 10], [11, 20], [21, 25]]);
    expect(windows.flatMap(({ lines }) => lines.map(({ text: line }) => line)).join('\n')).toBe(text);
  });

  test('cuts a line longer than the window into pieces under its own line number', () => {
    const windows = windowsOf(`short\n${'x'.repeat(25)}\nend`, { maxLines: 10, maxChars: 10 });
    expect(windows.map(({ lines }) => lines.map(({ line, text }) => `${line}:${text.length}`))).toEqual([
      ['1:5'], ['2:10'], ['2:10'], ['2:5', '3:3'],
    ]);
  });

  test('numbers each line of a window', () => {
    const [window] = windowsOf('a\nb', { maxLines: 10, maxChars: 100 });
    expect(numberedText(window!)).toBe('1| a\n2| b');
  });
});

describe('fileReading', () => {
  test('any yes window makes the file yes, with the weakest yes outcome', () => {
    const file = fileReading([reading('no', 'act', 0.1), reading('yes', 'confirm', 0.57), reading('yes', 'act', 0.9)]);
    expect(file).toEqual({ verdict: 'yes', outcome: 'confirm', probability: 0.9 });
  });

  test('an uncertain window with no yes makes the file uncertain', () => {
    expect(fileReading([reading('no', 'act', 0.1), reading('uncertain', 'escalate', 0.5)]).verdict).toBe('uncertain');
  });

  test('a file is a settled no only when every window is', () => {
    const settled = fileReading([reading('no', 'act', 0.1), reading('no', 'act', 0.2)]);
    expect(isSettledNo(settled)).toBe(true);
    const unsure = fileReading([reading('no', 'act', 0.1), reading('no', 'confirm', 0.42)]);
    expect(unsure).toEqual({ verdict: 'no', outcome: 'confirm', probability: 0.42 });
    expect(isSettledNo(unsure)).toBe(false);
  });
});
