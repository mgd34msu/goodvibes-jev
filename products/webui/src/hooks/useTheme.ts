import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  type Density,
  type Theme,
  type ThemePreferences,
  THEME_PREFERENCES_EVENT,
  applyThemeToRoot,
  readThemePreferences,
  resolveColorScheme,
  resolveInitialTheme,
  writeThemePreferences,
} from '../lib/theme';

// ─────────────────────────────────────────
export interface UseThemeResult {
  theme: Theme;
  density: Density;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  toggleTheme: () => void;
}

// ─────────────────────────────────────────
const ThemeContext = createContext<UseThemeResult | null>(null);

// ─────────────────────────────────────────
export function useTheme(): UseThemeResult {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}

// ─────────────────────────────────────────
export interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [prefs, setPrefs] = useState<ThemePreferences>(() => {
    // On initial render, use stored preference but resolve initial theme
    // from OS if no stored pref exists.
    const stored = readThemePreferences();
    const initialTheme = resolveInitialTheme();
    return { ...stored, theme: initialTheme };
  });

  // Apply data-theme / data-density to document root on mount and on change
  useEffect(() => {
    applyThemeToRoot(prefs);
  }, [prefs]);

  // Cross-tab / cross-component sync
  useEffect(() => {
    function handleChange() {
      const updated = readThemePreferences();
      setPrefs(updated);
    }
    window.addEventListener('storage', handleChange);
    window.addEventListener(THEME_PREFERENCES_EVENT, handleChange);
    return () => {
      window.removeEventListener('storage', handleChange);
      window.removeEventListener(THEME_PREFERENCES_EVENT, handleChange);
    };
  }, []);

  const setTheme = useCallback((theme: Theme) => {
    const next: ThemePreferences = { ...prefs, theme };
    setPrefs(next);
    writeThemePreferences(next);
  }, [prefs]);

  const setDensity = useCallback((density: Density) => {
    const next: ThemePreferences = { ...prefs, density };
    setPrefs(next);
    writeThemePreferences(next);
  }, [prefs]);

  // Toggle flips the scheme on screen: Auto resolves against the OS first, and
  // GoodVibes Neon counts as dark (so it toggles to light).
  const toggleTheme = useCallback(() => {
    setTheme(resolveColorScheme(prefs.theme) === 'dark' ? 'light' : 'dark');
  }, [prefs.theme, setTheme]);

  const value: UseThemeResult = {
    theme: prefs.theme,
    density: prefs.density,
    setTheme,
    setDensity,
    toggleTheme,
  };

  return createElement(ThemeContext.Provider, { value }, children);
}
