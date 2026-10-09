import { describe, expect, test } from 'bun:test';
import { resolveInstallAffordance } from './install-prompt';

describe('resolveInstallAffordance', () => {
  test('installed and captured prompt facts take precedence over a reading', () => {
    expect(resolveInstallAffordance({ platform: 'ios-share-menu', standalone: true, hasPromptEvent: true })).toBe('installed');
    expect(resolveInstallAffordance({ platform: 'ios-share-menu', standalone: false, hasPromptEvent: true })).toBe('prompt');
  });
  test('only an acted iOS reading shows Share-menu instructions', () => {
    expect(resolveInstallAffordance({ platform: 'ios-share-menu', standalone: false, hasPromptEvent: false })).toBe('ios-instructions');
    expect(resolveInstallAffordance({ platform: 'other', standalone: false, hasPromptEvent: false })).toBe('none');
    expect(resolveInstallAffordance({ standalone: false, hasPromptEvent: false })).toBe('none');
  });
});
