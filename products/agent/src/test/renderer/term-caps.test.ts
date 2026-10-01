/**
 * term-caps.test.ts
 *
 * DiffEngine integration: color emission per terminal capability level.
 */

import { describe, test, expect } from 'bun:test';
import {
  SYNC_BEGIN,
  SYNC_END,
  type TermColorCaps,
} from '@goodvibes-jev/engine/terminal-shell';
import { DiffEngine } from '../../renderer/diff.ts';
import { TerminalBuffer } from '../../renderer/buffer.ts';

// ---------------------------------------------------------------------------
// DiffEngine integration, color emission per capability
// ---------------------------------------------------------------------------

describe('DiffEngine color capability integration', () => {
  function makeCell(fg: string, bg = '', char = 'X') {
    return {
      char,
      fg,
      bg,
      bold: false,
      dim: false,
      underline: false,
      italic: false,
      strikethrough: false,
    };
  }

  function diffWithCaps(caps: TermColorCaps, fg: string, bg = ''): string {
    const engine = new DiffEngine(caps);
    const buf = new TerminalBuffer(10, 3);
    buf.setCell(0, 0, makeCell(fg, bg));
    return engine.diff(null, buf);
  }

  test('truecolor: hex color emits \\x1b[38;2;r;g;bm', () => {
    const caps: TermColorCaps = { capability: 'truecolor', syncedOutput: false };
    const diff = diffWithCaps(caps, '#ff0000');
    expect(diff).toContain('\x1b[38;2;255;0;0m');
  });

  test('ansi256: hex color emits \\x1b[38;5;Nm', () => {
    const caps: TermColorCaps = { capability: 'ansi256', syncedOutput: false };
    const diff = diffWithCaps(caps, '#ff0000');
    // #ff0000 → index 196
    expect(diff).toContain('\x1b[38;5;196m');
    expect(diff).not.toContain('38;2;');
  });

  test('basic16: hex color emits plain SGR code (e.g. \\x1b[31m)', () => {
    const caps: TermColorCaps = { capability: 'basic16', syncedOutput: false };
    // #aa0000 → nearest 16 = 31 (red)
    const diff = diffWithCaps(caps, '#aa0000');
    expect(diff).toContain('\x1b[31m');
    expect(diff).not.toContain('38;2;');
    expect(diff).not.toContain('38;5;');
  });

  test('none: no color SGR emitted at all', () => {
    const caps: TermColorCaps = { capability: 'none', syncedOutput: false };
    const diff = diffWithCaps(caps, '#ff0000');
    // Should not contain any color codes
    expect(diff).not.toContain('38;2;');
    expect(diff).not.toContain('38;5;');
    expect(diff).not.toContain('\x1b[31m');
    // Should also not contain reset SGR
    expect(diff).not.toContain('\x1b[0m');
  });

  test('synced=true: diff is wrapped in DEC 2026 markers', () => {
    const caps: TermColorCaps = { capability: 'truecolor', syncedOutput: true };
    const diff = diffWithCaps(caps, '#ff0000');
    expect(diff.startsWith(SYNC_BEGIN)).toBe(true);
    expect(diff.endsWith(SYNC_END)).toBe(true);
  });

  test('synced=false: diff is NOT wrapped in DEC 2026 markers', () => {
    const caps: TermColorCaps = { capability: 'truecolor', syncedOutput: false };
    const diff = diffWithCaps(caps, '#ff0000');
    expect(diff).not.toContain(SYNC_BEGIN);
    expect(diff).not.toContain(SYNC_END);
  });

  test('none: empty diff returned for a cell (char still rendered, no style)', () => {
    const caps: TermColorCaps = { capability: 'none', syncedOutput: false };
    const diff = diffWithCaps(caps, '');
    // Cell X at (0,0) should still position and emit the char
    // We only check that it contains a cursor-position sequence and the char
    expect(diff).toContain('\x1b[1;1H');
    expect(diff).toContain('X');
  });

  test('ansi256: bg hex emits \\x1b[48;5;Nm', () => {
    const caps: TermColorCaps = { capability: 'ansi256', syncedOutput: false };
    const diff = diffWithCaps(caps, '', '#0000ff');
    // #0000ff → index 21
    expect(diff).toContain('\x1b[48;5;21m');
  });

  test('truecolor: palette index passes through as 256-color (\\x1b[38;5;Nm)', () => {
    const caps: TermColorCaps = { capability: 'truecolor', syncedOutput: false };
    const engine = new DiffEngine(caps);
    const buf = new TerminalBuffer(10, 3);
    // '196' is already a palette index (no # prefix, no semicolon)
    buf.setCell(0, 0, makeCell('196'));
    const diff = engine.diff(null, buf);
    expect(diff).toContain('\x1b[38;5;196m');
  });
});
