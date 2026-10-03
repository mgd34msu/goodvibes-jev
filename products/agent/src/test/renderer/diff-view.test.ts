import { describe, test, expect } from 'bun:test';
import { activeDiffTones, activeTokens } from '../../renderer/theme.ts';
import { renderDiffView } from '../../renderer/diff-view.ts';
import { diffRowTints } from '../../renderer/diff-tint.ts';
import { lineToString } from '../setup.ts';

const WIDTH = 80;

const lineText = lineToString;
/** The gutter column: the diff keeps 2 columns between its fill edge and its text. */
const G = 2;

const SAMPLE_DIFF = [
  '--- old.ts (original)',
  '+++ old.ts (updated)',
  '@@ -1,4 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 42;',
  ' const c = 3;',
].join('\n');

describe('renderDiffView', () => {
  test('returns Line array', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    expect(result).toEqual(expect.any(Array));
    expect(result.length).toBeGreaterThan(0);
  });

  test('each line has correct width', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    for (const line of result) {
      expect(line.length).toBe(WIDTH);
    }
  });

  test('shows filename header when provided', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH, 'old.ts');
    const firstLine = lineText(result[0]);
    expect(firstLine).toContain('old.ts');
  });

  test('does not show header when filename omitted', () => {
    const withHeader = renderDiffView(SAMPLE_DIFF, WIDTH, 'file.ts');
    const withoutHeader = renderDiffView(SAMPLE_DIFF, WIDTH);
    expect(withoutHeader.length).toBeLessThan(withHeader.length);
  });

  test('added lines contain + gutter character', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    const addedLines = result.filter((line) => line[G]?.char === '+');
    expect(addedLines.length).toBeGreaterThan(0);
  });

  test('removed lines contain - gutter character', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    const removedLines = result.filter((line) => line[G]?.char === '-');
    expect(removedLines.length).toBeGreaterThan(0);
  });

  test('context lines contain space gutter character', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    // Context lines have a space in the gutter
    const contextLines = result.filter((line) => {
      const firstChar = line[G]?.char;
      return firstChar === ' ' && lineText(line).trim().length > 0;
    });
    expect(contextLines.length).toBeGreaterThan(0);
  });

  test('hunk header line contains @@ marker text', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    expect(result.map(lineText).filter((text) => text.trimStart().startsWith('@@'))).toEqual([
      expect.stringContaining('@@ -1,4 +1,4 @@'),
    ]);
  });

  test('added lines have green foreground color', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    // Actual added code lines have gutter '+' AND the diffAddedBg fill
    // (file headers with +++ have the context fill and muted fg)
    const addedLines = result.filter((line) =>
      line[G]?.char === '+' && line[G]?.bg === diffRowTints(activeTokens().diffContextBg).addedRow
    );
    expect(addedLines.map(lineText)).toEqual([
      expect.stringContaining('const b = 42;'),
    ]);
    expect(addedLines[0]?.[G].fg).toContain(activeDiffTones().add.slice(1));
  });

  test('removed lines have red foreground color', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    // Actual removed code lines have gutter '-' AND the diffRemovedBg fill
    // (file headers with --- have the context fill and muted fg)
    const removedLines = result.filter((line) =>
      line[G]?.char === '-' && line[G]?.bg === diffRowTints(activeTokens().diffContextBg).removedRow
    );
    expect(removedLines.map(lineText)).toEqual([
      expect.stringContaining('const b = 2;'),
    ]);
    expect(removedLines[0]?.[G].fg).toContain(activeDiffTones().del.slice(1));
  });

  test('handles empty diff string (the fill keeps its padding rows)', () => {
    const result = renderDiffView('', WIDTH);
    expect(result).toEqual(expect.any(Array));
    expect(result.map((line) => lineText(line).trim())).toEqual(['', '', '']);
  });

  test('text keeps 2 columns from both fill edges, with a padding row above and below', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    expect(lineText(result[0]).trim()).toBe('');
    expect(lineText(result[result.length - 1]).trim()).toBe('');
    for (const line of result) {
      expect(line[0]!.char).toBe(' ');
      expect(line[1]!.char).toBe(' ');
      expect(line[WIDTH - 1]!.char).toBe(' ');
      expect(line[WIDTH - 2]!.char).toBe(' ');
    }
  });

  test('renders content from added lines', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    // Actual added code lines have the added-row tint (diff-tint.ts: diffAddedBg kept visible on the diff's fill) (not the +++ header with the context fill)
    const addedLines = result.filter((line) =>
      line[G]?.char === '+' && line[G]?.bg === diffRowTints(activeTokens().diffContextBg).addedRow
    );
    expect(addedLines.map(lineText)).toEqual([
      expect.stringContaining('const b = 42;'),
    ]);
  });

  test('renders content from removed lines', () => {
    const result = renderDiffView(SAMPLE_DIFF, WIDTH);
    // Actual removed code lines have the removed-row tint (diff-tint.ts) (not the --- header with the context fill)
    const removedLines = result.filter((line) =>
      line[G]?.char === '-' && line[G]?.bg === diffRowTints(activeTokens().diffContextBg).removedRow
    );
    // The removed line contains 'const b = 2;'
    expect(removedLines.map(lineText)).toEqual([
      expect.stringContaining('const b = 2;'),
    ]);
  });
});
