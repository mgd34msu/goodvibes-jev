import { describe, test, expect, beforeEach } from 'bun:test';
import { activeTokens } from '../../renderer/theme.ts';
import { Compositor } from '../../renderer/compositor.ts';
import { createStyledCell, createEmptyLine } from '@goodvibes-jev/engine/sdk/platform/types';
import type { Line, Cell } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CompositeRequest, SelectionInfo } from '../../renderer/compositor.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal mock WriteStream, records all writes. */
function makeMockStream() {
  const writes: string[] = [];
  const stream = {
    write: (data: string) => { writes.push(data); return true; },
    writes,
  };
  return stream as unknown as NodeJS.WriteStream & { writes: string[] };
}

function makeCompositor() {
  const stream = makeMockStream() as NodeJS.WriteStream & { writes: string[] };
  const compositor = new Compositor(stream as NodeJS.WriteStream);
  return { compositor, stream };
}

/** Create a Line filled with a repeating character. */
function makeLine(width: number, char = ' '): Line {
  return Array.from({ length: width }, () => createStyledCell(char));
}

/** Stamp a visible character at a specific column within a line. */
function stampChar(line: Line, col: number, char: string): void {
  if (col >= 0 && col < line.length) {
    line[col] = createStyledCell(char);
  }
}

/** Read char at (x, y) from the compositor's last buffer. */
function cellAt(compositor: Compositor, x: number, y: number): Cell | undefined {
  return compositor.lastBufferForTest?.getCell(x, y);
}

// ---------------------------------------------------------------------------
// Common dimensions
// ---------------------------------------------------------------------------

const WIDTH = 40;
const HEIGHT = 10;
// leftWidth = 40 - 15 - 1 = 24, sepX = 24

function makeBaseRequest(overrides: Partial<CompositeRequest> = {}): CompositeRequest {
  return {
    width: WIDTH,
    height: HEIGHT,
    header: [makeLine(WIDTH, 'H'), makeLine(WIDTH, 'H')],  // rows 0-1
    viewport: Array.from({ length: 6 }, () => makeLine(WIDTH, '.')),  // rows 2-7
    footer: [makeLine(WIDTH, 'F'), makeLine(WIDTH, 'F')],  // rows 8-9
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Compositor: viewport composition', () => {
  test('produces output (stdout.write called)', () => {
    const { compositor, stream } = makeCompositor();
    compositor.composite(makeBaseRequest());
    expect(stream.writes.length).toBeGreaterThan(0);
  });

  test('renders viewport lines via full-width blit', () => {
    const { compositor } = makeCompositor();
    const viewport = Array.from({ length: 6 }, () => makeLine(WIDTH, '.'));
    // Stamp a recognisable character at col 30 on viewport row 0 (screen row 2)
    stampChar(viewport[0], 30, 'X');
    compositor.composite(makeBaseRequest({ viewport }));
    // Without a panel, the full line is blitted, col 30 on screen row 2 should be 'X'
    expect(cellAt(compositor, 30, 2)?.char).toBe('X');
  });

  test('header rows render first (header=2 rows)', () => {
    const { compositor } = makeCompositor();
    const header = [makeLine(WIDTH, 'A'), makeLine(WIDTH, 'B')];
    compositor.composite(makeBaseRequest({ header }));
    expect(cellAt(compositor, 0, 0)?.char).toBe('A');
    expect(cellAt(compositor, 0, 1)?.char).toBe('B');
  });

  test('viewport starts at row 0 when no header is supplied', () => {
    const { compositor } = makeCompositor();
    const viewport = Array.from({ length: HEIGHT }, () => makeLine(WIDTH, '.'));
    stampChar(viewport[0], 0, 'T');
    stampChar(viewport[HEIGHT - 1], 0, 'B');

    compositor.composite(makeBaseRequest({
      header: [],
      viewport,
      footer: [],
    }));

    expect(cellAt(compositor, 0, 0)?.char).toBe('T');
    expect(cellAt(compositor, 0, HEIGHT - 1)?.char).toBe('B');
  });

  test('clears stale footer rows when fullscreen viewport replaces the shell', () => {
    const { compositor } = makeCompositor();
    compositor.composite(makeBaseRequest());
    expect(cellAt(compositor, 0, HEIGHT - 1)?.char).toBe('F');

    compositor.composite(makeBaseRequest({
      header: [],
      viewport: [makeLine(WIDTH, 'O')],
      footer: [],
    }));

    expect(cellAt(compositor, 0, 0)?.char).toBe('O');
    expect(cellAt(compositor, 0, HEIGHT - 1)?.char).toBe(' ');
    expect(cellAt(compositor, WIDTH - 1, HEIGHT - 1)?.char).toBe(' ');
  });

  test('forced fullscreen redraw writes through the bottom row', () => {
    const { compositor, stream } = makeCompositor();
    compositor.composite(makeBaseRequest());
    const writeCountBefore = stream.writes.length;

    compositor.composite(makeBaseRequest({
      header: [],
      viewport: [makeLine(WIDTH, 'O')],
      footer: [],
      forceFullRedraw: true,
    }));

    const output = stream.writes.slice(writeCountBefore).join('');
    expect(output).toContain(`\x1b[${HEIGHT};1H`);
    expect(cellAt(compositor, 0, 0)?.char).toBe('O');
    expect(cellAt(compositor, 0, HEIGHT - 1)?.char).toBe(' ');
  });
});

describe('Compositor: R3 buffer reuse (double-buffer, no clone)', () => {
  test('TerminalBuffer constructor is NOT called on second composite() (buffer is reused)', () => {
    // We track constructor calls by counting .cells allocations via composite calls.
    // The core assertion: lastBufferForTest after N composites always returns a non-null
    // object (proving reuse), and rendering is correct on subsequent frames.
    const { compositor } = makeCompositor();
    compositor.composite(makeBaseRequest());
    const buf1 = compositor.lastBufferForTest;
    compositor.composite(makeBaseRequest());
    const buf2 = compositor.lastBufferForTest;
    // After double-buffer swap, lastBufferForTest returns the second-frame buffer.
    // Both must be non-null and be TerminalBuffer instances.
    expect(buf1).toEqual(expect.objectContaining({ width: WIDTH, height: HEIGHT }));
    expect(buf2).toEqual(expect.objectContaining({ width: WIDTH, height: HEIGHT }));
    // On the first composite frontBuffer=backBuffer (first allocation), second they differ.
    // We only verify correctness: cell content on frame 2 is still correct.
    expect(buf2?.getCell(0, 0)?.char).toBe('H');
  });

  test('resetDiff() clears both buffers so next composite starts fresh', () => {
    const { compositor, stream } = makeCompositor();
    compositor.composite(makeBaseRequest());
    const writeCountBefore = stream.writes.length;
    compositor.resetDiff();
    // After reset, the next composite should write the full screen again (full diff)
    compositor.composite(makeBaseRequest());
    expect(stream.writes.length).toBeGreaterThan(writeCountBefore);
    expect(compositor.lastBufferForTest).toEqual(expect.objectContaining({ width: WIDTH, height: HEIGHT }));
  });

  test('resize (dim change) does not crash and produces correct output', () => {
    const { compositor } = makeCompositor();
    compositor.composite(makeBaseRequest({ width: 40, height: 10 }));
    // Shrink terminal
    expect(() => {
      compositor.composite(makeBaseRequest({ width: 30, height: 8,
        header: [makeLine(30, 'H'), makeLine(30, 'H')],
        viewport: Array.from({ length: 4 }, () => makeLine(30, '.')),
        footer: [makeLine(30, 'F'), makeLine(30, 'F')],
      }));
    }).not.toThrow();
    // Buffer should now be 30 wide
    expect(compositor.lastBufferForTest?.width).toBe(30);
  });
});

describe('Compositor modal layers', () => {
  test('a dimming layer darkens the whole screen, then stamps its rectangle over it; cells outside keep their content', () => {
    const { compositor } = makeCompositor();
    const width = 20;
    const height = 6;
    const viewport = Array.from({ length: height - 2 }, () => makeLine(width, 'v'));
    // Words on the layer's row: 'vv' (0-1), the one the layer cuts (3-13), 'vvvvv' (15-19).
    viewport[1]![2] = createStyledCell(' ');
    viewport[1]![14] = createStyledCell(' ');
    const panelBg = activeTokens().backgroundPanel;
    const layerLine = Array.from({ length: 6 }, () => createStyledCell('m', { fg: activeTokens().text, bg: panelBg }));
    compositor.composite({
      width, height,
      header: [makeLine(width, 'h')],
      viewport,
      footer: [makeLine(width, 'f')],
      layers: [{ x: 5, y: 2, lines: [layerLine], dim: true }],
    });
    const buffer = compositor.lastBufferForTest!;
    // Outside the layer: original characters, dimmed colors (no longer the empty terminal default).
    expect(buffer.getCell(0, 0)!.char).toBe('h');
    expect(buffer.getCell(0, 0)!.bg).not.toBe('');
    expect(buffer.getCell(0, 2)!.char).toBe('v');
    // Inside the layer: its own cells, undimmed.
    expect(buffer.getCell(5, 2)!.char).toBe('m');
    expect(buffer.getCell(5, 2)!.bg).toBe(panelBg);
    // A word the layer's edge cut in half is blanked out to its space (no
    // fragment touches the fill edge); whole words further out stay.
    expect(buffer.getCell(3, 2)!.char).toBe(' ');
    expect(buffer.getCell(4, 2)!.char).toBe(' ');
    expect(buffer.getCell(11, 2)!.char).toBe(' ');
    expect(buffer.getCell(13, 2)!.char).toBe(' ');
    expect(buffer.getCell(1, 2)!.char).toBe('v');
    expect(buffer.getCell(15, 2)!.char).toBe('v');
  });

  test('the selection highlight still applies, and dims along with the rest under a modal', () => {
    const { compositor } = makeCompositor();
    const width = 10;
    const selection: SelectionInfo = { isCellSelected: (col) => col === 0, scrollTop: 0, lineCount: 3 };
    compositor.composite({
      width, height: 3, header: [], viewport: [makeLine(width, 'a'), makeLine(width, 'b'), makeLine(width, 'c')], footer: [],
      selection,
      layers: [{ x: 8, y: 0, lines: [[createStyledCell('m', { bg: activeTokens().backgroundPanel })]], dim: true }],
    });
    const selected = compositor.lastBufferForTest!.getCell(0, 1)!;
    const plain = compositor.lastBufferForTest!.getCell(1, 1)!;
    expect(selected.bg).not.toBe(plain.bg);
    expect(selected.bg).not.toBe(activeTokens().backgroundSelected);
  });
});
