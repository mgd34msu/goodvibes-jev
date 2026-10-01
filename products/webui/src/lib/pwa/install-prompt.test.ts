import { describe, expect, test } from 'bun:test';
import { isIos, resolveInstallAffordance } from './install-prompt';

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

describe('isIos', () => {
  test('true for iPhone/iPad/iPod, false for Android Chrome', () => {
    expect(isIos(IOS_SAFARI)).toBe(true);
    expect(isIos('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIos(CHROME_ANDROID)).toBe(false);
  });
});

describe('resolveInstallAffordance', () => {
  test('installed wins whenever running standalone', () => {
    expect(resolveInstallAffordance({ userAgent: CHROME_ANDROID, standalone: true, hasPromptEvent: true })).toBe('installed');
  });

  test('a captured Chromium prompt event shows the install button', () => {
    expect(resolveInstallAffordance({ userAgent: CHROME_ANDROID, standalone: false, hasPromptEvent: true })).toBe('prompt');
  });

  test('iOS (no prompt event ever) shows the Share-menu instructions', () => {
    expect(resolveInstallAffordance({ userAgent: IOS_SAFARI, standalone: false, hasPromptEvent: false })).toBe('ios-instructions');
  });

  test('a desktop browser with no prompt event shows nothing (menu-only)', () => {
    expect(resolveInstallAffordance({ userAgent: CHROME_ANDROID, standalone: false, hasPromptEvent: false })).toBe('none');
  });
});
