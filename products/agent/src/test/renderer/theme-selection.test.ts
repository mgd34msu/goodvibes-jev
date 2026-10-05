/**
 * theme-selection.test.ts, choosing a theme at runtime.
 *
 * Covers: the default theme, name normalization (legacy vaporwave, unknown
 * names), the system theme (goodvibes fallback before/without a terminal
 * palette, and a re-resolve when the palette arrives), in-place palette
 * rebuilds on a theme change (base palettes, extendPalette extras, the
 * formerly stale copies), and the protected splash gradient under every theme
 * and mode.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  generateSystemTheme,
  getBundledTheme,
  resolveTheme as resolveThemeFile,
} from '@goodvibes-jev/engine/sdk/platform/presentation';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import {
  activeTokens,
  activeUiTones,
  getActiveThemeName,
  listThemeChoices,
  normalizeThemeName,
  refreshForTerminalPalette,
  setActiveThemeMode,
  setActiveThemeName,
} from '../../renderer/theme.ts';
import { installStartupThemeProbe } from '../../renderer/startup-theme-probe.ts';
import { applyThemeNameSettingChange, resolveConfiguredThemeName } from '../../renderer/theme-mode-config.ts';
import {
  emptyTerminalPalette,
  resetTerminalPaletteForTests,
  setTerminalPalette,
  type TerminalPalette,
} from '../../renderer/terminal-palette.ts';
import { DEFAULT_PANEL_PALETTE, extendPalette } from '../../renderer/polish.ts';
import { buildStatusToken } from '../../renderer/status-token.ts';
import { FULLSCREEN_PALETTE } from '../../renderer/fullscreen-primitives.ts';
import { BORDERS } from '../../renderer/layout.ts';
import { addConversationSplashScreen } from '../../core/conversation-rendering.ts';
import { SPLASH_GRADIENT } from '../../utils/splash-lines.ts';

afterEach(() => {
  resetTerminalPaletteForTests();
  setActiveThemeName('goodvibes');
  setActiveThemeMode('dark');
});

function bundledTokens(name: string, mode: 'dark' | 'light') {
  return resolveThemeFile(getBundledTheme(name)!.json, mode);
}

function config(value: unknown): Pick<ConfigManager, 'get'> {
  return { get: ((_key: string) => value) as unknown as ConfigManager['get'] };
}

/** Use each host's real startup seam, with an isolated persisted config. */
function startWithConfig(configManager: ConfigManager): void {
  installStartupThemeProbe({
    configManager,
    stdout: { isTTY: false } as NodeJS.WriteStream,
    writeAllowed: () => { throw new Error('Headless startup must not query the terminal'); },
    resetDiff: () => {},
    render: () => {},
    invalidateTranscript: () => {},
  });
}

describe('theme names', () => {
  test('a fresh ConfigManager applies goodvibes before the first paint', () => {
    const manager = new ConfigManager({ configDir: makeProjectTempDir('theme-default'), readOnly: true });
    // Start away from the default so a missing startup apply cannot pass.
    setActiveThemeName('dracula');
    setActiveThemeMode('light');
    startWithConfig(manager);
    expect(manager.get('display.theme')).toBe('goodvibes');
    expect(manager.get('display.themeMode')).toBe('auto');
    expect(getActiveThemeName()).toBe('goodvibes');
    expect(activeTokens()).toEqual(bundledTokens('goodvibes', 'dark'));
  });

  test.each([
    ['vaporwave', 'vaporwave', 'goodvibes-neon'],
    ['goodvibes-neon', 'goodvibes-neon', 'goodvibes-neon'],
    [' \tVAPORWAVE\n', 'vaporwave', 'goodvibes-neon'],
    ['  Nord  ', 'nord', 'nord'],
    ['  SYSTEM  ', 'system', 'system'],
  ])('saved %j survives typed ingestion and reaches the startup palette', (saved, stored, active) => {
    const configDir = makeProjectTempDir('theme-saved-name');
    const path = join(configDir, 'settings.json');
    const contents = JSON.stringify({ display: { theme: saved, themeMode: 'light' } });
    writeFileSync(path, contents);
    const manager = new ConfigManager({ configDir, readOnly: true });
    startWithConfig(manager);
    expect(manager.get('display.theme')).toBe(stored);
    expect(manager.get('display.themeMode')).toBe('light');
    expect(manager.getIngestionQuarantine()).toHaveLength(0);
    expect(getActiveThemeName()).toBe(active);
    expect(activeTokens()).toEqual(bundledTokens(active === 'system' ? 'goodvibes' : active, 'light'));
    expect(readFileSync(path, 'utf8')).toBe(contents);
  });

  test('normalizeThemeName maps vaporwave to goodvibes-neon and unknowns to the default', () => {
    expect(normalizeThemeName('vaporwave')).toBe('goodvibes-neon');
    expect(normalizeThemeName('Nord')).toBe('nord');
    expect(normalizeThemeName('system')).toBe('system');
    expect(normalizeThemeName('no-such-theme')).toBe('goodvibes');
    expect(normalizeThemeName(undefined)).toBe('goodvibes');
    expect(normalizeThemeName(7)).toBe('goodvibes');
  });

  test('resolveConfiguredThemeName reads display.theme, normalized', () => {
    expect(resolveConfiguredThemeName(config('vaporwave'))).toBe('goodvibes-neon');
    expect(resolveConfiguredThemeName(config('dracula'))).toBe('dracula');
    expect(resolveConfiguredThemeName(config(undefined))).toBe('goodvibes');
    expect(resolveConfiguredThemeName({
      get: ((_key: string) => { throw new Error('no section'); }) as unknown as ConfigManager['get'],
    })).toBe('goodvibes');
  });

  test('applyThemeNameSettingChange applies now and requests a full repaint', () => {
    let repaints = 0;
    const { message } = applyThemeNameSettingChange('nord', () => { repaints += 1; });
    expect(getActiveThemeName()).toBe('nord');
    expect(repaints).toBe(1);
    expect(message).toBe('Theme: nord (applied now)');
  });

  test('the picker lists system first, then every bundled theme with its variants', () => {
    const choices = listThemeChoices();
    expect(choices[0]!.name).toBe('system');
    expect(choices.map((c) => c.name)).toContain('goodvibes-neon');
    expect(choices.find((c) => c.name === 'nord')!.variants).toEqual(['dark']);
  });

  test('every theme resolves in the mode it is set to', () => {
    setActiveThemeName('catppuccin');
    setActiveThemeMode('light');
    expect(activeTokens()).toEqual(bundledTokens('catppuccin', 'light'));
  });
});

describe('the system theme', () => {
  const PALETTE: TerminalPalette = {
    background: '#101820',
    foreground: '#d0d0d0',
    ansi: ['#000000', '#cc3333', '#33cc66', '#cccc33', '#3366cc', '#cc33cc', '#33cccc', '#c0c0c0',
      '#555555', '#ff5555', '#55ff88', '#ffff55', '#5588ff', '#ff55ff', '#55ffff', '#ffffff'],
  };

  test('falls back to goodvibes until a palette arrives, in the active mode', () => {
    setActiveThemeName('system');
    expect(getActiveThemeName()).toBe('system');
    expect(activeTokens()).toEqual(bundledTokens('goodvibes', 'dark'));
    setActiveThemeMode('light');
    expect(activeTokens()).toEqual(bundledTokens('goodvibes', 'light'));
  });

  test('falls back to goodvibes when the terminal answered nothing', () => {
    setTerminalPalette(emptyTerminalPalette());
    setActiveThemeName('system');
    expect(activeTokens()).toEqual(bundledTokens('goodvibes', 'dark'));
  });

  test('re-resolves from the palette once it arrives, and rebuilds the palettes', () => {
    setActiveThemeName('system');
    setTerminalPalette(PALETTE);
    expect(refreshForTerminalPalette()).toBe(true);
    const expected = resolveThemeFile(generateSystemTheme(PALETTE, 'dark'), 'dark');
    expect(activeTokens()).toEqual(expected);
    expect(DEFAULT_PANEL_PALETTE.info).toBe(expected.info);
  });

  test('a palette refresh is a no-op for any other theme', () => {
    setActiveThemeName('nord');
    setTerminalPalette(PALETTE);
    expect(refreshForTerminalPalette()).toBe(false);
    expect(activeTokens()).toEqual(bundledTokens('nord', 'dark'));
  });
});

describe('a theme change reaches every palette', () => {
  test('base palettes rebuild in place', () => {
    const fullscreen = FULLSCREEN_PALETTE;
    setActiveThemeName('dracula');
    expect(FULLSCREEN_PALETTE).toBe(fullscreen);
    expect(FULLSCREEN_PALETTE.controlsBg).toBe(activeUiTones().bg.base);
    expect(DEFAULT_PANEL_PALETTE.good).toBe(activeTokens().success);
  });

  test('extendPalette extras are rebuilt from the new theme', () => {
    const C = extendPalette(DEFAULT_PANEL_PALETTE, () => ({ series: activeTokens().secondary }));
    setActiveThemeName('gruvbox');
    expect(C.series).toBe(bundledTokens('gruvbox', 'dark').secondary);
    setActiveThemeName('rosepine');
    expect(C.series).toBe(bundledTokens('rosepine', 'dark').secondary);
  });

  test('status tokens (formerly copied once) follow the theme', () => {
    setActiveThemeName('tokyonight');
    expect(buildStatusToken('good', 'ok')[0]!.fg).toBe(activeTokens().success);
    setActiveThemeName('solarized');
    expect(buildStatusToken('good', 'ok')[0]!.fg).toBe(activeTokens().success);
  });

  test('BORDERS colours read the active theme', () => {
    setActiveThemeName('one-dark');
    expect(BORDERS.ERROR.color).toBe(activeUiTones().state.bad);
  });
});

// ---------------------------------------------------------------------------
// Protected splash: the wordmark gradient never follows the theme.
// ---------------------------------------------------------------------------

function renderSplash(width: number): Line[] {
  const lines: Line[] = [];
  const context = {
    history: {
      addLine: (l: Line) => { lines.push(l); },
      addLines: (ls: Line[]) => { lines.push(...ls); },
      getLineCount: () => lines.length,
    },
    blockRegistry: [], collapseState: new Map<string, boolean>(), errorLineRegistry: [],
    messageKindRegistry: new Map(), configManager: null,
    splashOptions: { workingDir: '/w', model: 'm', provider: 'p', toolCount: 1 },
  };
  addConversationSplashScreen(context as never, width);
  return lines;
}

/** Per wordmark row, the fg of every gradient-painted (bold) cell, left to right. */
function gradientRows(lines: Line[]): string[][] {
  return lines
    .map((line) => line.filter((cell) => cell.bold).map((cell) => cell.fg))
    .filter((row) => row.length > 1);
}

describe('the splash gradient is protected', () => {
  test('the named constant pins the two stops', () => {
    expect(SPLASH_GRADIENT.start).toBe('#00ffff');
    expect(SPLASH_GRADIENT.end).toBe('#d000ff');
  });

  for (const choice of listThemeChoices()) {
    for (const mode of ['dark', 'light'] as const) {
      test(`${choice.name}/${mode}: every wordmark row runs from #00ffff toward #d000ff`, () => {
        setActiveThemeName('goodvibes-neon');
        setActiveThemeMode('dark');
        const reference = gradientRows(renderSplash(100));
        setActiveThemeName(choice.name);
        setActiveThemeMode(mode);
        const rows = gradientRows(renderSplash(100));
        expect(rows.length).toBeGreaterThan(0);
        expect(rows).toEqual(reference);
        // Cells carry truecolor "r;g;b" (interpolateColor). Row start is the
        // cyan stop #00ffff exactly; the last cell sits one step short of the
        // purple stop #d000ff.
        for (const row of rows) {
          expect(row[0]).toBe('0;255;255');
          const [r, g, b] = row[row.length - 1]!.split(';').map(Number);
          expect(r).toBeGreaterThan(0xc0);
          expect(g).toBeLessThan(0x20);
          expect(b).toBe(255);
        }
      });
    }
  }
});
