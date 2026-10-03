/**
 * The status line's context meter with an unknown window. Live run on
 * abacusai route-llm (no stated window): the meter drew "100% 29.9k / 8.2k"
 * from a guessed 8192. An unknown window is now said plainly, with no bar and
 * no percent, since neither can be computed.
 */
import { describe, expect, test } from 'bun:test';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { renderStatusLine } from '../../renderer/status-line.ts';
import { lineToString } from '../setup.ts';

const unknown = (width = 120): Line => renderStatusLine({
  width,
  branch: 'main',
  context: { usedTokens: 29_871, windowTokens: null, compactFraction: 0.8 },
});

describe('an unknown context window', () => {
  test('reads "context 29.9k / unknown" with no bar and no percent', () => {
    const text = lineToString(unknown());
    expect(text).toContain('context 29.9k / unknown');
    expect(text).not.toMatch(/[█░│]/);
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toContain('8.2k');
  });

  test('keeps the right padding and narrows by dropping the word first', () => {
    for (const width of [120, 52, 46]) {
      const line = unknown(width);
      expect(line.length).toBe(width);
      expect(line.slice(width - 3).every((cell) => cell.char === ' ')).toBe(true);
    }
    expect(lineToString(unknown(52))).toContain('context 29.9k / unknown');
    const narrow = lineToString(unknown(46));
    expect(narrow).toContain('29.9k / unknown');
    expect(narrow).not.toContain('context');
  });

  test('a known window still draws the bar and percent', () => {
    const text = lineToString(renderStatusLine({ width: 120, branch: 'main', context: { usedTokens: 50_000, windowTokens: 200_000, compactFraction: 0.8 } }));
    expect(text).toMatch(/context [█░│]{16} 25% 50\.0k \/ 200\.0k/);
  });
});
