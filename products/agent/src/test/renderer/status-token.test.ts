// ---------------------------------------------------------------------------
// status-token.test.ts, buildStatusToken unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { buildStatusToken, type StatusState } from '../../renderer/status-token.ts';
import { DEFAULT_PANEL_PALETTE } from '../../renderer/polish.ts';

describe('buildStatusToken', () => {
  const STATES: StatusState[] = ['good', 'warn', 'bad', 'info'];

  test('returns a non-empty Cell array for each state', () => {
    for (const state of STATES) {
      const cells = buildStatusToken(state, 'test');
      expect(cells.length).toBeGreaterThan(0);
    }
  });

  test('text always starts with the glyph for each state', () => {
    const glyphs: Record<StatusState, string> = {
      good: '\u2713',
      warn: '\u26a0',
      bad:  '\u2715',
      info: '\u25cb',
    };
    for (const state of STATES) {
      const cells = buildStatusToken(state, 'label');
      const text = cells.map((c) => c.char).join('');
      expect(text[0]).toBe(glyphs[state]);
    }
  });

  test('all cells share the state color as fg', () => {
    const colors: Record<StatusState, string> = {
      good: DEFAULT_PANEL_PALETTE.good,
      warn: DEFAULT_PANEL_PALETTE.warn,
      bad:  DEFAULT_PANEL_PALETTE.bad,
      info: DEFAULT_PANEL_PALETTE.info,
    };
    for (const state of STATES) {
      const cells = buildStatusToken(state, 'x');
      for (const cell of cells) {
        expect(cell.fg).toBe(colors[state]);
      }
    }
  });

  test('includes label text in cells', () => {
    const cells = buildStatusToken('good', 'approvals');
    const text = cells.map((c) => c.char).join('');
    expect(text).toContain('approvals');
  });

  test('count suffix appended when opts.count provided', () => {
    const cells = buildStatusToken('bad', 'denials', { count: 7 });
    const text = cells.map((c) => c.char).join('');
    expect(text).toContain('(7)');
  });

  test('count 0 still renders suffix', () => {
    const cells = buildStatusToken('info', 'pending', { count: 0 });
    const text = cells.map((c) => c.char).join('');
    expect(text).toContain('(0)');
  });

  test('glyph override via opts.glyph replaces default', () => {
    const cells = buildStatusToken('good', 'ok', { glyph: '!' });
    const text = cells.map((c) => c.char).join('');
    expect(text[0]).toBe('!');
  });

  test('no count suffix when opts.count is undefined', () => {
    const cells = buildStatusToken('good', 'approvals');
    const text = cells.map((c) => c.char).join('');
    expect(text).not.toContain('(');
  });

  test('wide char label produces continuation cell with empty char', () => {
    // Use CJK label, each CJK char is display-width 2 and needs a continuation
    // cell. Without the fix, split('') would produce broken surrogate halves.
    const cells = buildStatusToken('good', '界字');
    // At least one cell with char==='' (continuation) must exist
    const hasContinuation = cells.some((c) => c.char === '');
    expect(hasContinuation).toBe(true);
  });

  test('emoji label produces continuation cell', () => {
    const cells = buildStatusToken('info', '\u{1F600}');
    const hasContinuation = cells.some((c) => c.char === '');
    expect(hasContinuation).toBe(true);
  });

  test('wide char cells maintain state color on continuation', () => {
    const cells = buildStatusToken('warn', '界');
    const colors: Record<StatusState, string> = {
      good: DEFAULT_PANEL_PALETTE.good,
      warn: DEFAULT_PANEL_PALETTE.warn,
      bad:  DEFAULT_PANEL_PALETTE.bad,
      info: DEFAULT_PANEL_PALETTE.info,
    };
    for (const cell of cells) {
      expect(cell.fg).toBe(colors.warn);
    }
  });
});
