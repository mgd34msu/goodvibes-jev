// Ported from goodvibes-agent src/test/runtime/permissions/policy-lint.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  lintPolicyConfig,
  type PermissionsConfig,
} from '../sdk/src/platform/runtime/permissions/index.ts';

describe('lintPolicyConfig', () => {
  test('flags duplicate rule ids and broad rules', () => {
    const config: PermissionsConfig = {
      mode: 'custom',
      rules: [
        {
          id: 'dup',
          type: 'prefix',
          origin: 'user',
          effect: 'allow',
          toolPattern: '*',
        },
        {
          id: 'dup',
          type: 'path-scope',
          origin: 'user',
          effect: 'allow',
          toolPattern: ['write'],
          pathPatterns: ['/**'],
        },
        {
          id: 'net',
          type: 'network-scope',
          origin: 'managed',
          effect: 'allow',
          toolPattern: ['fetch'],
          hostPatterns: ['*'],
        },
      ],
    };

    const findings = lintPolicyConfig(config);
    expect(findings.map((f) => f.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('Duplicate policy rule id'),
      expect.stringContaining('overly broad path pattern'),
      expect.stringContaining('overly broad host pattern'),
    ]));
  });
});
