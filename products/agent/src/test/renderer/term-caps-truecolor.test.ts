/**
 * term-caps-truecolor.test.ts, the compositor's color level (renderer/term-caps.ts).
 *
 * A 256-color stream depth is raised to truecolor when the environment says
 * the terminal draws 24-bit color, so gradients are not downsampled into
 * bands; every other answer of the shared probe is kept.
 */

import { describe, expect, test } from 'bun:test';
import { probeColorCaps } from '../../renderer/term-caps.ts';

function mockStream(depth: number): NodeJS.WriteStream {
  return { getColorDepth: () => depth } as unknown as NodeJS.WriteStream;
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key]!;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
}

const QUIET = { NO_COLOR: undefined, COLORTERM: undefined, TERM_PROGRAM: undefined };

describe('probeColorCaps', () => {
  test('depth=8 with no truecolor hint stays ansi256', () => {
    withEnv({ ...QUIET, TERM: 'xterm-256color' }, () => {
      const caps = probeColorCaps(mockStream(8));
      expect(caps.capability).toBe('ansi256');
      expect(caps.syncedOutput).toBe(true);
    });
  });

  test('depth=8 with COLORTERM=truecolor yields truecolor (gradients stay smooth)', () => {
    withEnv({ ...QUIET, TERM: 'tmux-256color', COLORTERM: 'truecolor' }, () => {
      expect(probeColorCaps(mockStream(8)).capability).toBe('truecolor');
    });
  });

  test('depth=8 on a terminal known to draw 24-bit color yields truecolor', () => {
    for (const term of ['xterm-ghostty', 'xterm-kitty', 'alacritty', 'foot', 'xterm-direct']) {
      withEnv({ ...QUIET, TERM: term }, () => {
        expect(probeColorCaps(mockStream(8)).capability).toBe('truecolor');
      });
    }
    withEnv({ ...QUIET, TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty' }, () => {
      expect(probeColorCaps(mockStream(8)).capability).toBe('truecolor');
    });
  });

  test('COLORTERM values that do not promise 24-bit color keep 256 colors', () => {
    withEnv({ ...QUIET, TERM: 'xterm-256color', COLORTERM: '1' }, () => {
      expect(probeColorCaps(mockStream(8)).capability).toBe('ansi256');
    });
    withEnv({ ...QUIET, TERM: 'screen-256color' }, () => {
      expect(probeColorCaps(mockStream(8)).capability).toBe('ansi256');
    });
    withEnv({ ...QUIET, TERM: 'screen-256color', COLORTERM: '24bit' }, () => {
      expect(probeColorCaps(mockStream(8)).capability).toBe('truecolor');
    });
  });

  test('depth=4 stays basic16 even when COLORTERM claims truecolor', () => {
    withEnv({ ...QUIET, TERM: 'xterm', COLORTERM: 'truecolor' }, () => {
      expect(probeColorCaps(mockStream(4)).capability).toBe('basic16');
    });
  });

  test('NO_COLOR and TERM=dumb still turn color off', () => {
    withEnv({ ...QUIET, NO_COLOR: '1', TERM: 'xterm-kitty', COLORTERM: 'truecolor' }, () => {
      expect(probeColorCaps(mockStream(24)).capability).toBe('none');
    });
    withEnv({ ...QUIET, TERM: 'dumb', COLORTERM: 'truecolor' }, () => {
      expect(probeColorCaps(mockStream(8)).capability).toBe('none');
    });
  });
});
