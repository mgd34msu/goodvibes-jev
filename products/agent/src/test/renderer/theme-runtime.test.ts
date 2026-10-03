/**
 * theme-runtime.test.ts, the active-mode runtime.
 *
 * Covers the active-mode accessors, the flip + reversibility of the live token
 * layers, and the display.themeMode config coercion.
 *
 * The opaque-surface chrome palette (FULLSCREEN_PALETTE, read by the Agent
 * workspace's content builders) registers an in-place rebuild via
 * registerThemeRefresh, so setActiveThemeMode rebuilds them without replacing
 * the object reference (read by reference across many call sites). Every role,
 * surface fills included, follows the active theme and mode, and a flip is
 * reversible.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  activeTheme,
  activeUiTones,
  getActiveThemeMode,
  resolveTheme,
  resolveUiTones,
  setActiveThemeMode,
} from '../../renderer/theme.ts';
import {
  coerceThemeModeSetting,
  resolveConfiguredThemeMode,
} from '../../renderer/theme-mode-config.ts';
import { installBackgroundThemeProbe } from '../../renderer/terminal-bg-probe.ts';
import { FULLSCREEN_PALETTE } from '../../renderer/fullscreen-primitives.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

/** Minimal ConfigManager-shaped stub whose get() returns a fixed value. */
function fakeConfig(value: unknown): Pick<ConfigManager, 'get'> {
  return { get: (() => value) } as unknown as Pick<ConfigManager, 'get'>;
}
function throwingConfig(): Pick<ConfigManager, 'get'> {
  return { get: (() => { throw new Error('no section'); }) } as unknown as Pick<ConfigManager, 'get'>;
}

// Always restore the shared default so sibling golden suites see dark.
afterEach(() => setActiveThemeMode('dark'));

describe('active mode accessors', () => {
  test('default is dark', () => {
    expect(getActiveThemeMode()).toBe('dark');
    expect(activeTheme()).toBe(resolveTheme('dark'));
    expect(activeUiTones()).toBe(resolveUiTones('dark'));
  });

  test('setActiveThemeMode(light) flips both live token layers', () => {
    setActiveThemeMode('light');
    expect(getActiveThemeMode()).toBe('light');
    expect(activeTheme()).toBe(resolveTheme('light'));
    expect(activeUiTones()).toBe(resolveUiTones('light'));
  });

  test('setActiveThemeMode(dark) flips back byte-identically', () => {
    setActiveThemeMode('light');
    setActiveThemeMode('dark');
    expect(activeTheme()).toBe(resolveTheme('dark'));
    expect(activeUiTones()).toBe(resolveUiTones('dark'));
  });
});

describe('opaque-surface chrome palettes rebuild in place (the trio port)', () => {
  test('fullscreen palette identity is stable across flips and restores byte-identically', () => {
    const ref = FULLSCREEN_PALETTE;
    const darkSnapshot = { ...FULLSCREEN_PALETTE };
    setActiveThemeMode('light');
    setActiveThemeMode('dark');
    expect(FULLSCREEN_PALETTE).toBe(ref);              // never replaced, only rebuilt
    expect({ ...FULLSCREEN_PALETTE }).toEqual(darkSnapshot);
  });

  test('fullscreen palette flips its info role in light and restores in dark', () => {
    const darkInfo = FULLSCREEN_PALETTE.info;
    expect(darkInfo).toBe(resolveUiTones('dark').state.info);
    setActiveThemeMode('light');
    expect(FULLSCREEN_PALETTE.info).toBe(resolveUiTones('light').state.info);
    expect(FULLSCREEN_PALETTE.info).not.toBe(darkInfo);
    setActiveThemeMode('dark');
    expect(FULLSCREEN_PALETTE.info).toBe(darkInfo);
  });

  test('fullscreen surface fills and title follow the theme in both modes', () => {
    expect(FULLSCREEN_PALETTE.categoryBg).toBe(resolveUiTones('dark').bg.section);
    expect(FULLSCREEN_PALETTE.controlsBg).toBe(resolveUiTones('dark').bg.base);
    expect(FULLSCREEN_PALETTE.title).toBe(resolveUiTones('dark').accent.browser);
    setActiveThemeMode('light');
    expect(FULLSCREEN_PALETTE.categoryBg).toBe(resolveUiTones('light').bg.section);
    expect(FULLSCREEN_PALETTE.contextBg).toBe(resolveUiTones('light').bg.surface);
    expect(FULLSCREEN_PALETTE.title).toBe(resolveUiTones('light').accent.browser);
  });
});

describe('theme-mode config', () => {
  test('coerceThemeModeSetting narrows valid values, else default', () => {
    expect(coerceThemeModeSetting('auto')).toBe('auto');
    expect(coerceThemeModeSetting('dark')).toBe('dark');
    expect(coerceThemeModeSetting('light')).toBe('light');
    expect(coerceThemeModeSetting(undefined)).toBe('auto');
    expect(coerceThemeModeSetting('nonsense')).toBe('auto');
    expect(coerceThemeModeSetting(42)).toBe('auto');
  });

  test('resolveConfiguredThemeMode reads the key and defaults to auto', () => {
    expect(resolveConfiguredThemeMode(fakeConfig('light'))).toBe('light');
    expect(resolveConfiguredThemeMode(fakeConfig(undefined))).toBe('auto');
    expect(resolveConfiguredThemeMode(throwingConfig())).toBe('auto');
  });
});

describe('installBackgroundThemeProbe wired to setActiveThemeMode (R4 startup path)', () => {
  const noop = () => {};

  test('forced light applies the mode before first paint (no probe)', () => {
    installBackgroundThemeProbe({
      configManager: fakeConfig('light'),
      applyThemeMode: setActiveThemeMode,
      isTTY: false,
      writeQuery: noop,
      requestRepaint: noop,
    });
    expect(getActiveThemeMode()).toBe('light');
  });

  test('auto + non-TTY stays dark (headless/piped: probe cannot run)', () => {
    setActiveThemeMode('light'); // prove it actively resolves to dark, not just leftover
    installBackgroundThemeProbe({
      configManager: fakeConfig('auto'),
      applyThemeMode: setActiveThemeMode,
      isTTY: false,
      writeQuery: noop,
      requestRepaint: noop,
    });
    expect(getActiveThemeMode()).toBe('dark');
  });
});
