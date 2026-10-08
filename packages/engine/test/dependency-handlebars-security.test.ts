import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Verdaccio uses patched Handlebars without breaking notification templates', () => {
  // Verdaccio runs on Node. Resolve its actual hooks dependency in an isolated
  // child so unrelated global mocks cannot replace the audited implementation.
  const result = spawnSync('node', [fileURLToPath(new URL('./fixtures/dependency-handlebars-security.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 10_000,
  });
  expect({ status: result.status, error: result.error, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  expect(result.stdout).toContain('HANDLEBARS_AST_AND_PROTOTYPE_GUARDS_OK');
});
