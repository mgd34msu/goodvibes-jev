import { useEffect, useState } from 'react';

export const WEBUI_PREFERENCES_KEY = 'goodvibes.webui.preferences';
export const WEBUI_PREFERENCES_EVENT = 'goodvibes:webui-preferences';

export interface WebUiPreferences {
  codeBlockLineNumbers: boolean;
  /**
   * Memory provenance chip (owner-ruled, default OFF): when true, a chat turn
   * that used memories shows a small chip with drill-in listing the injection
   * records (MemoryProvenanceChip.tsx, memory-provenance.ts). Off by default,
   * nothing renders until the owner opts in.
   */
  memoryProvenanceChipEnabled: boolean;
}

export const DEFAULT_WEBUI_PREFERENCES: WebUiPreferences = {
  codeBlockLineNumbers: false,
  memoryProvenanceChipEnabled: false,
};

type PreferenceKey = keyof WebUiPreferences;

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readWebUiPreferences(): WebUiPreferences {
  if (!storageAvailable()) return DEFAULT_WEBUI_PREFERENCES;
  try {
    const stored = window.localStorage.getItem(WEBUI_PREFERENCES_KEY);
    if (!stored) return DEFAULT_WEBUI_PREFERENCES;
    const parsed = JSON.parse(stored) as Partial<WebUiPreferences>;
    return {
      ...DEFAULT_WEBUI_PREFERENCES,
      ...parsed,
      codeBlockLineNumbers: Boolean(parsed.codeBlockLineNumbers),
      memoryProvenanceChipEnabled: Boolean(parsed.memoryProvenanceChipEnabled),
    };
  } catch {
    return DEFAULT_WEBUI_PREFERENCES;
  }
}

export function writeWebUiPreference<Key extends PreferenceKey>(key: Key, value: WebUiPreferences[Key]): WebUiPreferences {
  const next = { ...readWebUiPreferences(), [key]: value };
  if (storageAvailable()) {
    window.localStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(WEBUI_PREFERENCES_EVENT, { detail: next }));
  }
  return next;
}

export function useWebUiPreferences() {
  const [preferences, setPreferences] = useState<WebUiPreferences>(() => readWebUiPreferences());

  useEffect(() => {
    function refresh() {
      setPreferences(readWebUiPreferences());
    }

    window.addEventListener('storage', refresh);
    window.addEventListener(WEBUI_PREFERENCES_EVENT, refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener(WEBUI_PREFERENCES_EVENT, refresh);
    };
  }, []);

  return [preferences, writeWebUiPreference] as const;
}
