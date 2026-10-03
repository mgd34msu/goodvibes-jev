import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildNpmPublishAuthEnv } from '../../../scripts/npm-auth.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = makeProjectTempDir('goodvibes-agent-npm-auth');
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildNpmPublishAuthEnv', () => {
  test('creates a temporary npm userconfig from NPM_TOKEN', () => {
    withTempDir((tempRoot) => {
      const result = buildNpmPublishAuthEnv({
        env: { NPM_TOKEN: 'test-token' },
        registry: 'https://registry.npmjs.org',
        tempRoot,
      });

      expect(result.userconfigPath).toBe(`${tempRoot}/npmrc`);
      expect(result.env.NPM_CONFIG_USERCONFIG).toBe(result.userconfigPath ?? undefined);
      expect(readFileSync(result.userconfigPath ?? '', 'utf8')).toContain(
        '//registry.npmjs.org/:_authToken=test-token',
      );
      expect((statSync(result.userconfigPath ?? '').mode & 0o777).toString(8)).toBe('600');
    });
  });

  test('prefers NODE_AUTH_TOKEN and preserves an existing npm userconfig', () => {
    withTempDir((tempRoot) => {
      const existing = join(tempRoot, 'existing-npmrc');
      const result = buildNpmPublishAuthEnv({
        env: {
          NODE_AUTH_TOKEN: 'node-token',
          NPM_TOKEN: 'npm-token',
          NPM_CONFIG_USERCONFIG: existing,
        },
        registry: 'https://registry.npmjs.org',
        tempRoot,
      });

      expect(result.userconfigPath).toBeNull();
      expect(result.env.NPM_CONFIG_USERCONFIG).toBe(existing);
    });
  });

  test('leaves env unchanged when no token is exported', () => {
    withTempDir((tempRoot) => {
      const env = { PATH: '/usr/bin' };
      const result = buildNpmPublishAuthEnv({
        env,
        registry: 'https://registry.npmjs.org',
        tempRoot,
      });

      expect(result.userconfigPath).toBeNull();
      expect(result.env).toBe(env);
    });
  });
});
