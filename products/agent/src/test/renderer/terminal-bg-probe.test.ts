/**
 * terminal-bg-probe.test.ts, fake-terminal harness for the OSC 11 background probe.
 *
 * Drives the pure parser/classifier and the TerminalBackgroundProbe stream filter
 * against scripted byte streams: BEL vs ST terminators, rgb: 4-digit / 2-digit /
 * # colour variants, replies split across chunks, replies interleaved with
 * keystrokes (keystrokes MUST survive to the tokenizer, the reply MUST be
 * consumed), timeout → dark, the query written unwrapped under tmux, and garbage → dark. Also
 * the config forcing paths via installBackgroundThemeProbe.
 *
 * Note: the install tests assert the INJECTED applyThemeMode callback
 * (R2 owns the probe; R4 owns theme.ts and wires applyThemeMode:setActiveThemeMode)
 * rather than a global active-theme singleton, the behaviour under test is
 * identical (which mode is applied, and when).
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyBackgroundLuminance,
  DEFAULT_PROBE_TIMEOUT_MS,
  installBackgroundThemeProbe,
  LUMINANCE_LIGHT_THRESHOLD,
  OSC11_QUERY,
  parseColorSpec,
  type ProbeResolution,
  type ThemeMode,
  TerminalBackgroundProbe,
} from '../../renderer/terminal-bg-probe.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

const BEL = '\x07';
const ST = '\x1b\\';

/** Build a probe that records every resolution into `out`. */
function makeProbe(out: ProbeResolution[], timeoutMs = 1_000): TerminalBackgroundProbe {
  return new TerminalBackgroundProbe({ timeoutMs, onResolve: (r) => out.push(r) });
}

// ---------------------------------------------------------------------------
// parseColorSpec, colour-spec variants
// ---------------------------------------------------------------------------

describe('parseColorSpec', () => {
  test('rgb: 4-hex-digit channels scale to 8-bit (ffff → 255)', () => {
    expect(parseColorSpec('rgb:ffff/ffff/ffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColorSpec('rgb:0000/0000/0000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  test('rgb: 2-hex-digit channels', () => {
    expect(parseColorSpec('rgb:ff/ff/ff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColorSpec('rgb:1e/1e/1e')).toEqual({ r: 30, g: 30, b: 30 });
  });

  test('rgb: half-scale midpoints (8000 → 128, 80 → 128)', () => {
    expect(parseColorSpec('rgb:8000/8000/8000')).toEqual({ r: 128, g: 128, b: 128 });
    expect(parseColorSpec('rgb:80/80/80')).toEqual({ r: 128, g: 128, b: 128 });
  });

  test('rgba: parses and ignores alpha', () => {
    expect(parseColorSpec('rgba:ffff/ffff/ffff/8000')).toEqual({ r: 255, g: 255, b: 255 });
  });

  test('#RRGGBB and #RRRRGGGGBBBB hex forms', () => {
    expect(parseColorSpec('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColorSpec('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColorSpec('#ffffffffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  test('garbage / malformed specs return null', () => {
    expect(parseColorSpec('notacolor')).toBeNull();
    expect(parseColorSpec('rgb:zz/zz/zz')).toBeNull();
    expect(parseColorSpec('rgb:ff/ff')).toBeNull();
    expect(parseColorSpec('#abc')).toBeNull();
    expect(parseColorSpec('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyBackgroundLuminance, threshold + endpoints
// ---------------------------------------------------------------------------

describe('classifyBackgroundLuminance', () => {
  test('white → light, black → dark', () => {
    expect(classifyBackgroundLuminance({ r: 255, g: 255, b: 255 })).toBe('light');
    expect(classifyBackgroundLuminance({ r: 0, g: 0, b: 0 })).toBe('dark');
  });

  test('typical dark editor bg (#1e1e1e) → dark, cream (#fdf6e3) → light', () => {
    expect(classifyBackgroundLuminance({ r: 30, g: 30, b: 30 })).toBe('dark');
    expect(classifyBackgroundLuminance({ r: 253, g: 246, b: 227 })).toBe('light');
  });

  test('threshold is documented at LUMINANCE_LIGHT_THRESHOLD (0.5)', () => {
    expect(LUMINANCE_LIGHT_THRESHOLD).toBe(0.5);
    expect(classifyBackgroundLuminance({ r: 100, g: 100, b: 100 })).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// TerminalBackgroundProbe.feed, the stream filter
// ---------------------------------------------------------------------------

describe('TerminalBackgroundProbe.feed', () => {
  test('BEL-terminated light reply resolves light and is fully consumed', () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out);
    const passthrough = probe.feed(`\x1b]11;rgb:ffff/ffff/ffff${BEL}`);
    expect(passthrough).toBe('');
    expect(out).toEqual([{ mode: 'light', reason: 'light-reply' }]);
    expect(probe.active).toBe(false);
  });

  test('ST-terminated dark reply resolves dark', () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out);
    const passthrough = probe.feed(`\x1b]11;rgb:1e1e/1e1e/1e1e${ST}`);
    expect(passthrough).toBe('');
    expect(out).toEqual([{ mode: 'dark', reason: 'dark-reply' }]);
  });

  test('reply split across three chunks resolves once complete', () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out);
    expect(probe.feed('\x1b]11;rgb:ff')).toBe('');
    expect(out.length).toBe(0);
    expect(probe.feed('ff/ffff/ff')).toBe('');
    expect(out.length).toBe(0);
    expect(probe.feed(`ff${BEL}`)).toBe('');
    expect(out).toEqual([{ mode: 'light', reason: 'light-reply' }]);
  });

  test('reply interleaved with keystrokes: keys pass through, reply is consumed', () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out);
    const passthrough = probe.feed(`a\x1b]11;rgb:ffff/ffff/ffff${BEL}b`);
    expect(passthrough).toBe('ab');
    expect(out).toEqual([{ mode: 'light', reason: 'light-reply' }]);
  });

  test('keystrokes split around a split reply all survive in order', () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out);
    let seen = '';
    seen += probe.feed('x\x1b]11;rgb:00');
    seen += probe.feed('00/0000/0000');
    seen += probe.feed(`${ST}y`);
    expect(seen).toBe('xy');
    expect(out).toEqual([{ mode: 'dark', reason: 'dark-reply' }]);
  });

  test('garbage reply (valid terminator, unparseable body) resolves dark', () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out);
    expect(probe.feed(`\x1b]11;notacolor${BEL}`)).toBe('');
    expect(out).toEqual([{ mode: 'dark', reason: 'unparseable' }]);
  });

  test('never corrupts the composer: an incomplete/garbled fragment never leaks', async () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out, 15);
    probe.startTimeout();
    const passthrough = probe.feed('k\x1b]11;rgb:ffff/ffff');
    expect(passthrough).toBe('k'); // only the real keystroke escaped
    await new Promise((r) => setTimeout(r, 40));
    expect(out).toEqual([{ mode: 'dark', reason: 'timeout' }]);
    expect(probe.feed('typed')).toBe('typed');
  });

  test('a bare ESC keystroke is held one chunk then released (no OSC 11 follows)', () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out);
    expect(probe.feed('\x1b')).toBe('');
    expect(probe.feed('[A')).toBe('\x1b[A');
    expect(out.length).toBe(0);
    expect(probe.active).toBe(true);
  });

  test('no reply → timeout → dark', async () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out, 15);
    probe.startTimeout();
    await new Promise((r) => setTimeout(r, 40));
    expect(out).toEqual([{ mode: 'dark', reason: 'timeout' }]);
    expect(probe.active).toBe(false);
  });

  test('resolves only once (a late reply after timeout is ignored)', async () => {
    const out: ProbeResolution[] = [];
    const probe = makeProbe(out, 10);
    probe.startTimeout();
    await new Promise((r) => setTimeout(r, 30));
    probe.feed(`\x1b]11;rgb:ffff/ffff/ffff${BEL}`);
    expect(out).toEqual([{ mode: 'dark', reason: 'timeout' }]);
  });
});

// ---------------------------------------------------------------------------
// query bytes
// ---------------------------------------------------------------------------

describe('query bytes', () => {
  test('OSC11_QUERY is the ST-terminated background query', () => {
    expect(OSC11_QUERY).toBe('\x1b]11;?\x1b\\');
  });

  test('DEFAULT_PROBE_TIMEOUT_MS is a small startup window', () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// installBackgroundThemeProbe, config forcing + auto/TTY gating
// (asserts the injected applyThemeMode; R4 wires the real theme setter)
// ---------------------------------------------------------------------------

/** Minimal ConfigManager-shaped stub returning a fixed themeMode value. */
function fakeConfig(themeMode: unknown): Pick<ConfigManager, 'get'> {
  return {
    get: ((key: string) => (key === 'display.themeMode' ? themeMode : undefined)),
  } as unknown as Pick<ConfigManager, 'get'>;
}

describe('installBackgroundThemeProbe: forcing paths', () => {
  test("forced 'dark' applies dark, writes no query, filter is passthrough", () => {
    let wrote = '';
    const applied: ThemeMode[] = [];
    const handle = installBackgroundThemeProbe({
      configManager: fakeConfig('dark'), isTTY: true, 
      applyThemeMode: (m) => { applied.push(m); },
      writeQuery: (b) => { wrote += b; }, requestRepaint: () => {},
    });
    expect(applied).toEqual(['dark']);
    expect(wrote).toBe('');
    expect(handle.filterInput('abc')).toBe('abc');
  });

  test("forced 'light' applies light before first paint, no query", () => {
    let wrote = '';
    const applied: ThemeMode[] = [];
    installBackgroundThemeProbe({
      configManager: fakeConfig('light'), isTTY: true, 
      applyThemeMode: (m) => { applied.push(m); },
      writeQuery: (b) => { wrote += b; }, requestRepaint: () => {},
    });
    expect(applied).toEqual(['light']);
    expect(wrote).toBe('');
  });

  test('auto + non-TTY stays dark and never queries', () => {
    let wrote = '';
    const applied: ThemeMode[] = [];
    installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: false, 
      applyThemeMode: (m) => { applied.push(m); },
      writeQuery: (b) => { wrote += b; }, requestRepaint: () => {},
    });
    expect(applied).toEqual(['dark']);
    expect(wrote).toBe('');
  });

  test('unset config defaults to auto (queries on a TTY)', () => {
    let wrote = '';
    installBackgroundThemeProbe({
      configManager: fakeConfig(undefined), isTTY: true, 
      applyThemeMode: () => {},
      writeQuery: (b) => { wrote += b; }, requestRepaint: () => {},
    });
    expect(wrote).toBe(OSC11_QUERY);
  });
});

describe('installBackgroundThemeProbe: auto probe flow', () => {
  test('auto + TTY writes the query; a light reply applies light + repaints once', () => {
    let wrote = '';
    let repaints = 0;
    const applied: ThemeMode[] = [];
    const resolutions: ProbeResolution[] = [];
    const handle = installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: true, timeoutMs: 1_000,
      applyThemeMode: (m) => { applied.push(m); },
      writeQuery: (b) => { wrote += b; }, requestRepaint: () => { repaints++; },
      onResolve: (r) => resolutions.push(r),
    });
    expect(wrote).toBe(OSC11_QUERY);
    expect(applied).toEqual([]); // still dark (unapplied) until the reply lands
    const passthrough = handle.filterInput(`\x1b]11;rgb:ffff/ffff/ffff${BEL}`);
    expect(passthrough).toBe('');
    expect(applied).toEqual(['light']);
    expect(repaints).toBe(1);
    expect(resolutions).toEqual([{ mode: 'light', reason: 'light-reply' }]);
  });

  test('auto + TTY: a dark reply stays dark and does NOT repaint', () => {
    let repaints = 0;
    const applied: ThemeMode[] = [];
    const handle = installBackgroundThemeProbe({
      configManager: fakeConfig('auto'), isTTY: true, timeoutMs: 1_000,
      applyThemeMode: (m) => { applied.push(m); },
      writeQuery: () => {}, requestRepaint: () => { repaints++; },
    });
    handle.filterInput(`\x1b]11;rgb:0000/0000/0000${ST}`);
    expect(applied).toEqual([]); // dark reply → no apply call, stays default dark
    expect(repaints).toBe(0);
  });

  test('auto + TTY under tmux writes the query as it is (tmux answers it; a passthrough envelope is dropped)', () => {
    const saved = process.env['TMUX'];
    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0';
    try {
      let wrote = '';
      installBackgroundThemeProbe({
        configManager: fakeConfig('auto'), isTTY: true,
        applyThemeMode: () => {},
        writeQuery: (b) => { wrote += b; }, requestRepaint: () => {},
      });
      expect(wrote).toBe(OSC11_QUERY);
      expect(wrote).not.toContain('\x1bPtmux;');
    } finally {
      if (saved === undefined) delete process.env['TMUX'];
      else process.env['TMUX'] = saved;
    }
  });
});
