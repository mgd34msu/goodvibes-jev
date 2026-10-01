/**
 * Theme & density preference persistence.
 * Mirrors the pattern from src/lib/ui-preferences.ts:
 * read/write via localStorage, dispatch custom event for cross-tab sync.
 */

/**
 * Stored webui theme. 'dark' and 'light' are the slate themes, 'auto' follows the
 * OS color scheme live, 'neon' is the opt-in GoodVibes Neon theme (the previous
 * palette, kept whole). A stored value is always respected and never migrated.
 */
export type Theme = 'dark' | 'light' | 'auto' | 'neon';
export type ColorScheme = 'dark' | 'light';

export const THEMES: readonly Theme[] = ['dark', 'light', 'auto', 'neon'];

export function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light' || value === 'auto' || value === 'neon';
}

function osPrefersLight(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- matchMedia can be absent at runtime (tests, legacy engines)
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

/** The scheme a theme paints right now ('auto' resolves against the OS; Neon is dark). */
export function resolveColorScheme(theme: Theme): ColorScheme {
  if (theme === 'light') return 'light';
  if (theme === 'auto') return osPrefersLight() ? 'light' : 'dark';
  return 'dark';
}
export type Density = 'default' | 'compact';

export interface ThemePreferences {
  theme: Theme;
  density: Density;
}

export const THEME_PREFERENCES_KEY = 'goodvibes.webui.theme';
export const THEME_PREFERENCES_EVENT = 'goodvibes:webui-theme';

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  theme: 'dark',
  density: 'default',
};

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/**
 * Determine the initial theme: stored preference (any of the four, never
 * rewritten) > prefers-color-scheme at load > dark.
 */
export function resolveInitialTheme(): Theme {
  if (storageAvailable()) {
    try {
      const stored = window.localStorage.getItem(THEME_PREFERENCES_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<ThemePreferences>;
        if (isTheme(parsed.theme)) {
          return parsed.theme;
        }
      }
    } catch {
      // fall through
    }
    // No stored preference: respect OS signal
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- lib.dom types matchMedia as always-present, but it can be absent at runtime in non-DOM/test/legacy environments; the optional chain is a deliberate safety fallback
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
  }
  return 'dark';
}

export function readThemePreferences(): ThemePreferences {
  if (!storageAvailable()) return DEFAULT_THEME_PREFERENCES;
  try {
    const stored = window.localStorage.getItem(THEME_PREFERENCES_KEY);
    if (!stored) return DEFAULT_THEME_PREFERENCES;
    const parsed = JSON.parse(stored) as Partial<ThemePreferences>;
    return {
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_THEME_PREFERENCES.theme,
      density: parsed.density === 'compact' ? 'compact' : DEFAULT_THEME_PREFERENCES.density,
    };
  } catch {
    return DEFAULT_THEME_PREFERENCES;
  }
}

export function writeThemePreferences(next: ThemePreferences): ThemePreferences {
  if (storageAvailable()) {
    window.localStorage.setItem(THEME_PREFERENCES_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(THEME_PREFERENCES_EVENT, { detail: next }));
  }
  return next;
}

export function applyThemeToRoot(prefs: ThemePreferences): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', prefs.theme);
  if (prefs.density === 'compact') {
    root.setAttribute('data-density', 'compact');
  } else {
    root.removeAttribute('data-density');
  }
}
