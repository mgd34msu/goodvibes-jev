import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  DEFAULT_WEBUI_PREFERENCES,
  WEBUI_PREFERENCES_KEY,
  readWebUiPreferences,
  writeWebUiPreference,
} from './ui-preferences';

// ---------------------------------------------------------------------------
// localStorage mock helpers
// ---------------------------------------------------------------------------

function makeMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  };
}

let mockStorage = makeMockStorage();
const dispatchedEvents: CustomEvent[] = [];

function installWindowMock() {
  mockStorage = makeMockStorage();
  dispatchedEvents.length = 0;
  (globalThis as Record<string, unknown>).window = {
    localStorage: mockStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: CustomEvent) => { dispatchedEvents.push(e); },
  };
}

function removeWindowMock() {
  delete (globalThis as Record<string, unknown>).window;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// readWebUiPreferences, no storage (SSR-like)
// ---------------------------------------------------------------------------

describe('readWebUiPreferences: no window', () => {
  beforeEach(removeWindowMock);
  afterEach(removeWindowMock);

  test('returns defaults when window is undefined', () => {
    expect(readWebUiPreferences()).toEqual(DEFAULT_WEBUI_PREFERENCES);
  });
});

// ---------------------------------------------------------------------------
// readWebUiPreferences, with storage
// ---------------------------------------------------------------------------

describe('readWebUiPreferences: with storage', () => {
  beforeEach(installWindowMock);
  afterEach(removeWindowMock);

  test('returns defaults when storage is empty', () => {
    expect(readWebUiPreferences()).toEqual(DEFAULT_WEBUI_PREFERENCES);
  });

  test('returns stored value when codeBlockLineNumbers is true', () => {
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify({ codeBlockLineNumbers: true }));
    expect(readWebUiPreferences().codeBlockLineNumbers).toBe(true);
  });

  test('coerces stored truthy number to boolean true', () => {
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify({ codeBlockLineNumbers: 1 }));
    expect(readWebUiPreferences().codeBlockLineNumbers).toBe(true);
  });

  test('coerces stored 0 to boolean false', () => {
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify({ codeBlockLineNumbers: 0 }));
    expect(readWebUiPreferences().codeBlockLineNumbers).toBe(false);
  });

  test('merges partial stored object, filling missing keys with defaults', () => {
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify({}));
    expect(readWebUiPreferences()).toEqual(DEFAULT_WEBUI_PREFERENCES);
  });

  test('ignores unknown extra keys in stored object', () => {
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify({ codeBlockLineNumbers: true, unknownKey: 'x' }));
    const prefs = readWebUiPreferences();
    expect(prefs.codeBlockLineNumbers).toBe(true);
  });

  test('returns defaults on malformed JSON', () => {
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, 'not-valid-json{{{');
    expect(readWebUiPreferences()).toEqual(DEFAULT_WEBUI_PREFERENCES);
  });

  test('returns defaults on null stored value (key absent after removal)', () => {
    // getItem returns null when key missing, already covered by empty case above,
    // but explicit removal confirms the null-guard branch
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify({ codeBlockLineNumbers: true }));
    mockStorage.removeItem(WEBUI_PREFERENCES_KEY);
    expect(readWebUiPreferences()).toEqual(DEFAULT_WEBUI_PREFERENCES);
  });

  test('returns stored value when memoryProvenanceChipEnabled is true', () => {
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify({ memoryProvenanceChipEnabled: true }));
    expect(readWebUiPreferences().memoryProvenanceChipEnabled).toBe(true);
  });

  test('memoryProvenanceChipEnabled defaults to false when absent from a stored partial object', () => {
    mockStorage.setItem(WEBUI_PREFERENCES_KEY, JSON.stringify({ codeBlockLineNumbers: true }));
    expect(readWebUiPreferences().memoryProvenanceChipEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeWebUiPreference
// ---------------------------------------------------------------------------

describe('writeWebUiPreference: with storage', () => {
  beforeEach(installWindowMock);
  afterEach(removeWindowMock);

  test('returns updated preferences object', () => {
    const result = writeWebUiPreference('codeBlockLineNumbers', true);
    expect(result.codeBlockLineNumbers).toBe(true);
  });

  test('persists written value so subsequent read returns it', () => {
    writeWebUiPreference('codeBlockLineNumbers', true);
    expect(readWebUiPreferences().codeBlockLineNumbers).toBe(true);
  });

  test('dispatches a custom event with the updated preferences as detail', () => {
    writeWebUiPreference('codeBlockLineNumbers', true);
    expect(dispatchedEvents.length).toBe(1);
    expect((dispatchedEvents[0] as CustomEvent).detail.codeBlockLineNumbers).toBe(true);
  });

  test('overwrite: writing false after true reverts the preference', () => {
    writeWebUiPreference('codeBlockLineNumbers', true);
    writeWebUiPreference('codeBlockLineNumbers', false);
    expect(readWebUiPreferences().codeBlockLineNumbers).toBe(false);
  });

  test('dispatches one event per write call', () => {
    writeWebUiPreference('codeBlockLineNumbers', true);
    writeWebUiPreference('codeBlockLineNumbers', false);
    expect(dispatchedEvents.length).toBe(2);
  });

  test('writing memoryProvenanceChipEnabled persists independently of codeBlockLineNumbers', () => {
    writeWebUiPreference('memoryProvenanceChipEnabled', true);
    const prefs = readWebUiPreferences();
    expect(prefs.memoryProvenanceChipEnabled).toBe(true);
    expect(prefs.codeBlockLineNumbers).toBe(false);
  });
});

describe('writeWebUiPreference: no storage', () => {
  beforeEach(removeWindowMock);
  afterEach(removeWindowMock);

  test('returns merged preferences without throwing when window is absent', () => {
    const result = writeWebUiPreference('codeBlockLineNumbers', true);
    expect(result.codeBlockLineNumbers).toBe(true);
  });
});
