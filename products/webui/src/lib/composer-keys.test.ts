import { describe, expect, test } from 'bun:test';
import { shouldSteerComposerKey, shouldSubmitComposerKey } from './composer-keys';

describe('composer key policy', () => {
  test('submits on plain Enter', () => {
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  test('keeps Shift Enter for newlines', () => {
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  test('does not submit during IME composition', () => {
    expect(shouldSubmitComposerKey({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: true },
    })).toBe(false);
  });
});

describe('shouldSteerComposerKey', () => {
  test('Ctrl+Enter steers', () => {
    expect(shouldSteerComposerKey({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe(true);
  });

  test('Cmd+Enter steers (mac)', () => {
    expect(shouldSteerComposerKey({ key: 'Enter', shiftKey: false, metaKey: true })).toBe(true);
  });

  test('plain Enter does NOT steer, it submits', () => {
    const plain = { key: 'Enter', shiftKey: false };
    expect(shouldSteerComposerKey(plain)).toBe(false);
    expect(shouldSubmitComposerKey(plain)).toBe(true);
  });

  test('Ctrl+Enter does NOT plain-submit. The two combos are mutually exclusive', () => {
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe(false);
  });

  test('Shift or IME composition never steers', () => {
    expect(shouldSteerComposerKey({ key: 'Enter', shiftKey: true, ctrlKey: true })).toBe(false);
    expect(shouldSteerComposerKey({ key: 'Enter', shiftKey: false, ctrlKey: true, nativeEvent: { isComposing: true } })).toBe(false);
  });
});
