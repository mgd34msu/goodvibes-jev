import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Verdaccio hooks use patched Handlebars without losing template compatibility', () => {
  // Resolve through the real Verdaccio hooks dependency, in its Node runtime.
  const result = spawnSync('node', [fileURLToPath(new URL('./fixtures/dependency-handlebars-security.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 10_000,
  });
  expect({ status: result.status, error: result.error, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  expect(result.stdout).toContain('VERDACCIO_HANDLEBARS_SECURITY_AND_COMPATIBILITY_OK');
});
