import { describe, expect, test } from 'bun:test';
import { categoryLabelForKey } from './config-redaction';
import { groupLabelForNamespace } from './settings-model';

describe('the voice settings group', () => {
  test('wake-word and local-engine keys share one group', () => {
    const voice = categoryLabelForKey('voice.wake.enabled');
    expect(categoryLabelForKey('voice.wake.threshold')).toBe(voice);
    expect(categoryLabelForKey('voice.wake.surfaces.webui')).toBe(voice);
    expect(categoryLabelForKey('voice.local.sttEngine')).toBe(voice);
    expect(groupLabelForNamespace('voice')).toBe(voice);
  });

  test('an unmapped namespace still falls back to Title Case, never a fabricated label', () => {
    expect(categoryLabelForKey('someNewDomain.key')).toBe('Some New Domain');
    expect(groupLabelForNamespace('someNewDomain')).toBe('Some New Domain');
  });
});
