import { describe, expect, test } from 'bun:test';
import { settingLabelForKey } from './setting-label';

describe('settingLabelForKey', () => {
  test('camelCase last segment reads as sentence-case words', () => {
    expect(settingLabelForKey('provider.systemPromptFile')).toBe('System prompt file');
    expect(settingLabelForKey('display.collapseThreshold')).toBe('Collapse threshold');
  });

  test('a generic last segment borrows the one before it', () => {
    expect(settingLabelForKey('surfaces.slack.enabled')).toBe('Slack enabled');
    expect(settingLabelForKey('voice.local.sttBinary')).toBe('STT binary');
  });

  test('acronyms keep their case', () => {
    expect(settingLabelForKey('memory.budgetMb')).toBe('Budget MB');
    expect(settingLabelForKey('web.publicBaseUrl')).toBe('Public base URL');
  });

  test('a two-segment key with a generic last segment keeps just that segment', () => {
    expect(settingLabelForKey('danger.mode')).toBe('Mode');
  });
});
