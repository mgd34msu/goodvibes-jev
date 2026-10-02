import { describe, expect, test } from 'bun:test';
import { fitDisplay, getDisplayWidth, joinPrioritizedSegments, padDisplayEnd, truncateDisplay, wrapText } from '../../utils/terminal-width.ts';

describe('terminal width helpers', () => {
  test('truncateDisplay respects wide characters', () => {
    const text = 'abc界🙂xyz';
    const truncated = truncateDisplay(text, 6);
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(6);
  });

  test('padDisplayEnd pads to display width, not string length', () => {
    const text = '界🙂';
    const padded = padDisplayEnd(text, 6);
    expect(getDisplayWidth(padded)).toBe(6);
  });

  test('fitDisplay truncates and pads to exact display width', () => {
    const text = 'very-wide🙂value';
    const fitted = fitDisplay(text, 8);
    expect(getDisplayWidth(fitted)).toBe(8);
  });
});

describe('wrapText', () => {
  test('CJK character at width 1 terminates without hanging', () => {
    // Pre-fix this would infinite-loop; verify it returns in finite time.
    const result = wrapText('漢', 1);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('emoji at width 1 terminates without hanging', () => {
    const result = wrapText('\u{1F600}', 1);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('CJK word wider than width is split across lines', () => {
    const result = wrapText('漢字', 2);
    // Each CJK char is display-width 2; at width 2 each gets its own line.
    expect(result.length).toBeGreaterThan(0);
    for (const line of result) {
      expect(getDisplayWidth(line)).toBeLessThanOrEqual(2);
    }
  });

  test('normal ASCII wrapping still works', () => {
    const result = wrapText('hello world', 5);
    expect(result).toEqual(['hello', 'world']);
  });
});

describe('ANSI escape stripping in getDisplayWidth', () => {
  test('SGR reset sequence \\x1b[0m is not counted as width', () => {
    const withSgr = '\x1b[0m' + 'abc';
    expect(getDisplayWidth(withSgr)).toBe(3);
  });

  test('SGR bold+color sequence is not counted as width', () => {
    const styled = '\x1b[1;38;2;255;0;0m' + 'hello' + '\x1b[0m';
    expect(getDisplayWidth(styled)).toBe(5);
  });

  test('256-colour SGR sequence is not counted as width', () => {
    const styled = '\x1b[38;5;196m' + 'XY' + '\x1b[0m';
    expect(getDisplayWidth(styled)).toBe(2);
  });

  test('OSC-8 hyperlink sequences are not counted as width', () => {
    const osc8 = '\x1b]8;;https://example.com\x07link text\x1b]8;;\x07';
    expect(getDisplayWidth(osc8)).toBe(9); // 'link text' = 9 chars
  });

  test('OSC-8 with ESC\\ terminator is stripped', () => {
    const osc8St = '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\';
    expect(getDisplayWidth(osc8St)).toBe(4); // 'link' = 4 chars
  });

  test('mixed SGR and plain text measures only visible chars', () => {
    const mixed = 'a' + '\x1b[36m' + 'bc' + '\x1b[0m';
    expect(getDisplayWidth(mixed)).toBe(3);
  });

  test('SGR sequence wrapping wide chars: escapes stripped, wide chars counted', () => {
    const styledWide = '\x1b[32m中\x1b[0m';
    expect(getDisplayWidth(styledWide)).toBe(2);
  });

  test('empty ANSI sequences (zero-length payload) produce zero width', () => {
    const s = '\x1b[m\x1b[0m\x1b[1m';
    expect(getDisplayWidth(s)).toBe(0);
  });

  test('cross/tick glyph family counts as width 1 (fixes the "✕t" error-line glitch)', () => {
    // ✕ (U+2715) / ✖ (U+2716) sit inside the emoji block but terminals draw them
    // one cell wide. Counting them as 2 desynced the styled cell grid from the
    // physical glyph and corrupted the following text.
    expect(getDisplayWidth('✕')).toBe(1);
    expect(getDisplayWidth('✖')).toBe(1);
    // Sibling glyphs already width-1 stay width-1.
    expect(getDisplayWidth('✗')).toBe(1);
    expect(getDisplayWidth('✓')).toBe(1);
    // The exact error-line prefix renders at its true width (space + ✕ + space).
    expect(getDisplayWidth(' ✕ ')).toBe(3);
  });
});

describe('bracket-text-without-ESC over-strip guard', () => {
  test('literal bracket text without ESC counts every character', () => {
    // '[31mhi' is 6 literal characters, no ESC prefix, must NOT be stripped.
    expect(getDisplayWidth('[31mhi')).toBe(6);
  });

  test('wrapText is unaffected by ESC-less bracket text', () => {
    const wrapped = wrapText('[31mhi', 4);
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
  });

  test('truncateDisplay is unaffected by ESC-less bracket text', () => {
    const truncated = truncateDisplay('[31mhi', 4);
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(4);
    expect(getDisplayWidth(truncated)).toBeLessThan(6);
  });
});

describe('truncateDisplay: ANSI-safe slice boundaries', () => {
  test('truncation of ANSI-styled string does not cut mid-escape', () => {
    const styled = '\x1b[1;31m' + 'hello world' + '\x1b[0m';
    const truncated = truncateDisplay(styled, 5);
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(5);
    const hasPartialEsc = /\x1b(?![\[\]]|[0-9;]*[A-Za-z]|\])/u.test(truncated);
    expect(hasPartialEsc).toBe(false);
  });

  test('truncateDisplay on ANSI-styled wide chars stays within bounds', () => {
    const styled = '\x1b[32m中文\x1b[0m'; // green + 2 CJK + reset = 4 display
    const truncated = truncateDisplay(styled, 3);
    expect(getDisplayWidth(truncated)).toBeLessThanOrEqual(3);
  });
});

describe('getDisplayWidth: combining marks and variation selectors', () => {
  test('combining diacritical marks (U+0300-U+036F) add zero width', () => {
    const withCombining = 'è';
    expect(getDisplayWidth(withCombining)).toBe(1);
  });

  test('ZWJ (U+200D) adds zero width', () => {
    expect(getDisplayWidth('‍')).toBe(0);
  });

  test('variation selector VS-16 (U+FE0F) adds zero width', () => {
    expect(getDisplayWidth('️')).toBe(0);
  });

  test('control characters add zero width', () => {
    expect(getDisplayWidth('\x01')).toBe(0);
    expect(getDisplayWidth('\x1f')).toBe(0);
    expect(getDisplayWidth('\x7f')).toBe(0);
  });
});

describe('joinPrioritizedSegments: whole-segment drop under width pressure', () => {
  const SEP = ' | ';

  test('all segments fit: joined verbatim in original order, nothing dropped', () => {
    const segs = [
      { text: 'aaa', priority: 0 },
      { text: 'bbb', priority: 1 },
      { text: 'ccc', priority: 2 },
    ];
    expect(joinPrioritizedSegments(segs, SEP, 20)).toBe('aaa | bbb | ccc');
  });

  test('drops the single highest-priority-number (lowest-value) segment whole first', () => {
    const segs = [
      { text: 'essential', priority: 0 },
      { text: 'important', priority: 1 },
      { text: 'decorative', priority: 2 },
    ];
    const width = 'essential | important'.length;
    const result = joinPrioritizedSegments(segs, SEP, width);
    expect(result).toBe('essential | important');
    expect(result).not.toContain('decorative');
    expect(result).not.toContain('deco');
  });

  test('on a priority tie, drops the LATER segment and keeps the earlier one', () => {
    const segs = [
      { text: 'first-essential', priority: 0 },
      { text: 'second-essential', priority: 0 },
      { text: 'decorative', priority: 1 },
    ];
    const width = 'first-essential'.length;
    const result = joinPrioritizedSegments(segs, SEP, width);
    expect(result).toBe('first-essential');
    expect(result).not.toContain('second-essential');
    expect(result).not.toContain('decorative');
  });

  test('drops multiple low-priority segments in priority order until it fits', () => {
    const segs = [
      { text: 'core', priority: 0 },
      { text: 'high', priority: 1 },
      { text: 'mid', priority: 2 },
      { text: 'low', priority: 3 },
    ];
    const width = 'core | high'.length;
    const result = joinPrioritizedSegments(segs, SEP, width);
    expect(result).toBe('core | high');
    expect(result).not.toContain('mid');
    expect(result).not.toContain('low');
  });

  test('falls back to character truncation only when even the sole remaining segment does not fit', () => {
    const segs = [{ text: 'way-too-long-to-fit-in-the-given-width', priority: 0 }];
    const result = joinPrioritizedSegments(segs, SEP, 10);
    expect(getDisplayWidth(result)).toBeLessThanOrEqual(10);
    expect(result.endsWith('…')).toBe(true);
  });

  test('empty segment list returns empty string', () => {
    expect(joinPrioritizedSegments([], SEP, 10)).toBe('');
  });
});
