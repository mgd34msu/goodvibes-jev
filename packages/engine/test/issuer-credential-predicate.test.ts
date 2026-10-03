import { afterEach, describe, expect, test } from 'bun:test';
import {
  containsIssuerCredential,
  findCredentialCandidates,
  redactIssuerCredentials,
  registerAccountIdentityRedaction,
  registerProfileRedactionValues,
} from '@goodvibes-jev/engine/sdk/platform/utils';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

// Synthetic issuer-shaped fixtures; never real account material.
const FORMATS = [
  `ghp_${'a'.repeat(36)}`, `gho_${'b'.repeat(36)}`, `github_pat_${'c'.repeat(36)}`,
  `glpat-${'d'.repeat(20)}`, `xoxb-${'e'.repeat(24)}`, `xoxp-${'f'.repeat(24)}`,
  `AKIA${'A'.repeat(16)}`,
];

afterEach(() => {
  registerAccountIdentityRedaction(null);
  registerProfileRedactionValues(null);
});

describe('public issuer credential containment predicate', () => {
  test('matches every canonical issuer without consuming regex state', () => {
    for (const token of FORMATS) {
      for (let repeat = 0; repeat < 3; repeat++) {
        expect(containsIssuerCredential(`before ${token} after`)).toBe(true);
        expect(containsIssuerCredential('ordinary text')).toBe(false);
        expect(redactIssuerCredentials(token)).not.toContain(token);
        expect(containsIssuerCredential(token)).toBe(true);
      }
    }
  });

  test('preserves exact issuer boundaries, length and casing', () => {
    for (const text of ['', `ghp_${'a'.repeat(35)}`, `github_pat_${'a'.repeat(35)}`, `glpat-${'a'.repeat(19)}`, `xoxb-${'a'.repeat(23)}`, `AKIA${'A'.repeat(15)}`, `akia${'A'.repeat(16)}`, `AKIA${'A'.repeat(17)}`, `wordghp_${'a'.repeat(36)}`, '[REDACTED_GITHUB_TOKEN]']) {
      expect(containsIssuerCredential(text)).toBe(false);
    }
  });

  test('does not classify uncertain candidates, profile details or owner paths as issuer credentials', () => {
    registerProfileRedactionValues(() => ({ guarded: ['42 Synthetic Lane'], absolute: ['Al'] }));
    registerAccountIdentityRedaction(() => ({ homeDirectory: '/home/synthetic-owner', userName: 'synthetic-owner' }));
    expect(redactIssuerCredentials('Al at 42 Synthetic Lane')).not.toBe('Al at 42 Synthetic Lane');
    for (const text of ['Al at 42 Synthetic Lane', '/home/synthetic-owner/projects', 'key-rotation-policy-for-tenants', 'Bearer of bad news', `sk-${'a'.repeat(24)}`, 'goodvibes://secrets/key-rotation-policy-for-tenants']) {
      expect(containsIssuerCredential(text)).toBe(false);
    }
    expect(findCredentialCandidates('key-rotation-policy-for-tenants')).toHaveLength(1);
    expect(findCredentialCandidates('Bearer of bad news')).toHaveLength(1);
  });

  test('does not consult profile readers or require a judgment provider', () => {
    registerProfileRedactionValues(() => { throw new Error('profile reader must not run'); });
    registerAccountIdentityRedaction(() => { throw new Error('identity reader must not run'); });
    const previous = installJudgmentPort(undefined);
    try {
      expect(containsIssuerCredential(FORMATS[0]!)).toBe(true);
      expect(containsIssuerCredential('ordinary text')).toBe(false);
    } finally {
      installJudgmentPort(previous);
    }
  });
});
