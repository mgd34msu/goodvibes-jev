// Ported from goodvibes-agent src/test/runtime/permissions/policy-lint.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  lintPolicyConfig,
  type PermissionsConfig,
} from '../sdk/src/platform/runtime/permissions/index.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';

describe('lintPolicyConfig', () => {
  // Pattern breadth is read by Jev (engine.gate.policy-breadth); the first
  // matching entry answers, and every other pattern reads as scoped.
  useGateReadings([
    ['"pattern":"/**"', { broad_path: true }],
    ['"pattern":"/home/**"', { broad_path: true }],
    ['"pattern":"*.org"', { broad_host: true }],
    ['"pattern":"*"', { broad_host: true }],
  ]);

  test('flags duplicate rule ids and broad rules', async () => {
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

    const findings = await lintPolicyConfig(config);
    expect(findings.map((f) => f.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('Duplicate policy rule id'),
      expect.stringContaining('overly broad path pattern'),
      expect.stringContaining('overly broad host pattern'),
    ]));
  });

  test('breadth is read, not spelled: /home/** and *.org are flagged, a project tree and one org are not', async () => {
    const findings = await lintPolicyConfig({ mode: 'custom', rules: [
      { id: 'home', type: 'path-scope', origin: 'user', effect: 'allow', toolPattern: ['write'], pathPatterns: ['/home/**'] },
      { id: 'project', type: 'path-scope', origin: 'user', effect: 'allow', toolPattern: ['write'], pathPatterns: ['/home/dana/shop-api/**'] },
      { id: 'tld', type: 'network-scope', origin: 'user', effect: 'allow', toolPattern: ['fetch'], hostPatterns: ['*.org'] },
      { id: 'corp', type: 'network-scope', origin: 'user', effect: 'deny', toolPattern: ['fetch'], hostPatterns: ['*.acme-corp.com'] },
    ] });
    expect(findings.map((f) => f.ruleId).sort()).toEqual(['home', 'tld']);
    expect(findings.every((f) => f.severity === 'error')).toBe(true);
  });
});
