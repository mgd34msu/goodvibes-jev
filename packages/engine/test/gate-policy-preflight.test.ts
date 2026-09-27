// Ported from goodvibes-agent src/test/runtime/permissions/preflight.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  buildPolicyPreflightReview,
} from '../sdk/src/platform/runtime/permissions/index.ts';
import type { GoodVibesConfig } from '../sdk/src/platform/config/index.ts';

const baseConfig = {
  permissions: {
    mode: 'default',
    defaultMode: 'prompt',
    rules: [],
  },
} as unknown as Readonly<GoodVibesConfig>;

describe('buildPolicyPreflightReview', () => {
  test('returns pass when no risky conditions are present', () => {
    const review = buildPolicyPreflightReview({
      config: baseConfig,
      lintFindings: [],
      mcpServers: [],
    });

    expect(review.status).toBe('pass');
    expect(review.issueCount).toBe(0);
    expect(review.summary).toContain('No blocking or warning conditions detected');
  });

  test('blocks on allow-all policy mode and allow-all MCP trust', () => {
    const review = buildPolicyPreflightReview({
      config: {
        ...baseConfig,
        permissions: {
          ...baseConfig.permissions,
          mode: 'allow-all',
        },
      },
      lintFindings: [
        {
          severity: 'warn',
          message: 'broad host pattern',
          ruleId: 'net-all',
        },
      ],
      mcpServers: [
        {
          serverName: 'deploy',
          trustMode: 'allow-all',
          role: 'ops',
          allowedPaths: ['/srv/app'],
          allowedHosts: ['example.com'],
        },
      ],
    });

    expect(review.status).toBe('block');
    expect(review.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'runtime' }),
      expect.objectContaining({ source: 'mcp', serverName: 'deploy' }),
    ]));
  });

  test('warns for ask-on-risk MCP connections', () => {
    const review = buildPolicyPreflightReview({
      config: baseConfig,
      lintFindings: [],
      mcpServers: [
        {
          serverName: 'docs',
          trustMode: 'ask-on-risk',
          role: 'docs',
          allowedPaths: [],
          allowedHosts: ['docs.example.com'],
        },
      ],
    });

    expect(review.status).toBe('warn');
    expect(review.issueCount).toBe(1);
    expect(review.issues[0]?.message).toContain('requires approval for risky actions');
  });
});
