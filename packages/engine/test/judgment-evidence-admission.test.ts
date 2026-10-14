import { describe, expect, test } from 'bun:test';
import { snapshotJudgmentEvidence, snapshotJudgmentInput } from '../sdk/src/platform/gate/judgment-input.ts';

describe('observational credential redaction tokens', () => {
  test.each([
    { password: '[REDACTED]' },
    { password: '<redacted>' },
    { password: '[REDACTED_TOKEN]' },
    { password: '[REDACTED_API_KEY]' },
    { password: '[REDACTED_GITLAB_TOKEN]' },
    { password: '[REDACTED_SLACK_TOKEN]' },
    { password: '[REDACTED_AWS_KEY]' },
    { password: '[REDACTED_PROFILE]' },
    { password: '[REDACTED_TEXT]' },
    { 'password=[REDACTED]': 'Public masked field' },
    { metadata: { publicationGuarantee: 'The provider committed the receipt. password=[REDACTED]' } },
    { metadata: 'password="[REDACTED]"' },
    { metadata: JSON.stringify({ password: '[REDACTED_GITHUB_TOKEN]' }) },
    { key: 'password', value: '[REDACTED]' },
  ])('preserves complete masked evidence but never authorizes the same action input %#', value => {
    expect(snapshotJudgmentEvidence(value)).toEqual(value);
    expect(() => snapshotJudgmentInput(value)).toThrow();
  });
  test.each([
    { password: '[REDACTED]synthetic-secret' },
    { 'password=[REDACTED]synthetic-secret': 'Private key must stay local' },
    { password: '[REDACTED_UNKNOWN_TOKEN]' },
    { metadata: 'password=[REDACTED] password=synthetic-secret' },
    { metadata: JSON.stringify({ password: 'synthetic-secret' }) },
    { metadata: { nested: { createdAt: 1791684509006 } } },
    { metadata: { cardNumber: '[REDACTED]' } },
    { name: 'cardNumber', value: '[REDACTED]' },
    { metadata: 'password=[REDACTED] 4111111111111111' },
    Object.defineProperty({ password: '[REDACTED]' }, 'hidden', { value: '4111111111111111' }),
  ])('still refuses actual credentials, card material and nonexact markers %#', value => {
    expect(() => snapshotJudgmentEvidence(value)).toThrow();
  });
  test('refuses accessors without invoking them', () => {
    let reads = 0;
    const value = Object.defineProperty({}, 'password', { get() { reads++; return '[REDACTED]'; } });
    expect(() => snapshotJudgmentEvidence(value)).toThrow(); expect(reads).toBe(0);
  });
});
