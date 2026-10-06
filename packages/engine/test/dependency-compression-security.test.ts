import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Verdaccio compression releases native streams on disconnect and still serves gzip', () => {
  // Verdaccio runs on Node. Test its actual native zlib lifecycle in a bounded
  // child, without Bun's HTTP/zlib compatibility layer or shared global mocks.
  const result = spawnSync('node', [fileURLToPath(new URL('./fixtures/dependency-compression-release.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 10_000,
  });
  expect({ status: result.status, error: result.error, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  expect(result.stdout).toContain('GZIP_ROUNDTRIP_AND_ABORT_RELEASE_OK');
});
