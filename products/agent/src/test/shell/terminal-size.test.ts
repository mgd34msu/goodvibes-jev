import { describe, expect, test } from 'bun:test';
import { getTerminalSize } from '../../shell/terminal-size.ts';

describe('getTerminalSize', () => {
  test('uses direct stdout dimensions first', () => {
    const size = getTerminalSize({
      columns: 120,
      rows: 44,
    } as NodeJS.WriteStream);

    expect(size).toEqual({ width: 120, height: 44 });
  });

  test('uses getWindowSize when direct stdout dimensions are unavailable', () => {
    const size = getTerminalSize({
      columns: undefined,
      rows: undefined,
      getWindowSize: () => [132, 47] as const,
    } as unknown as NodeJS.WriteStream);

    expect(size).toEqual({ width: 132, height: 47 });
  });
});
