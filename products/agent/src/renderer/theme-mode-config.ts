/**
 * theme-mode-config, the appearance/theme-mode preference surface.
 *
 * The preference lives at the config key `display.themeMode` (auto | dark |
 * light, default auto), stored under the existing SDK `display` section
 * alongside `display.theme` (the color palette, a separate, independent
 * concept: theme picks the palette, themeMode picks light/dark appearance).
 *
 * `display.themeMode` is a real CONFIG_SCHEMA entry (SDK 2.0.0+); this module
 * no longer carries a synthetic descriptor for it, the settings modal and
 * the agent workspace both resolve it through the normal schema path like
 * every other key.
 *
 * DIVERGENCE FROM THE W4 BRIEF (recorded): the brief listed theme-mode-config.ts
 * as the NEW home for the config-read helpers, but the terminal-bg-probe.ts change landed FIRST and
 * inlined resolveConfiguredThemeMode / coerceThemeModeSetting /
 * THEME_MODE_CONFIG_KEY / ThemeModeSetting into terminal-bg-probe.ts (so R2
 * could ship the probe before this file existed). Rather than duplicate those
 * (which would let the two copies drift, the exact failure S1 exists to
 * prevent), this module RE-EXPORTS them from terminal-bg-probe as the single
 * source. Deliberately free of terminal/probe state so the settings-modal
 * data layer can import it without pulling in the stateful probe class.
 */

import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { normalizeThemeName, setActiveThemeMode, setActiveThemeName } from './theme.ts';
import { coerceThemeModeSetting } from './terminal-bg-probe.ts';

export {
  THEME_MODE_CONFIG_KEY,
  coerceThemeModeSetting,
  resolveConfiguredThemeMode,
} from './terminal-bg-probe.ts';

/**
 * Apply a display.themeMode settings change with the honest timing contract:
 * forced dark/light flip the active mode NOW (caller passes its full-repaint
 * hook); auto is only evaluated by the startup probe, so it takes effect on the
 * next launch, the returned message states which happened. Called by the
 * settings-modal onSettingApplied hook (ui-openers).
 */
export function applyThemeModeSettingChange(
  value: unknown,
  requestFullRepaint?: () => void,
): { message: string } {
  const next = coerceThemeModeSetting(value);
  if (next === 'dark' || next === 'light') {
    setActiveThemeMode(next);
    requestFullRepaint?.();
    return { message: `Theme mode: ${next} (applied now)` };
  }
  return { message: 'Theme mode: auto (probes terminal on next startup)' };
}

/** Config key backing the color theme (bundled name, 'system', or legacy 'vaporwave'). */
export const THEME_NAME_CONFIG_KEY: ConfigKey = 'display.theme';

/**
 * Read the configured theme name, normalized: 'vaporwave' maps to
 * 'goodvibes-neon' and an unset or unknown value maps to the default theme.
 */
export function resolveConfiguredThemeName(configManager: Pick<ConfigManager, 'get'>): string {
  try {
    return normalizeThemeName(configManager.get(THEME_NAME_CONFIG_KEY));
  } catch {
    return normalizeThemeName(undefined);
  }
}

/**
 * Apply a display.theme settings change: the theme switches now (every
 * registered palette rebuilds) and the caller's full-repaint hook runs. Called
 * by the settings-modal onSettingApplied hook (ui-openers) and the Agent
 * workspace settings surface.
 */
export function applyThemeNameSettingChange(
  value: unknown,
  requestFullRepaint?: () => void,
): { message: string } {
  const applied = setActiveThemeName(value);
  requestFullRepaint?.();
  return { message: `Theme: ${applied} (applied now)` };
}
