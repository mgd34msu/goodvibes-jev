import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('ordinary Node source ownership and real inert process-group controls', () => {
  const scripts = join(import.meta.dir, '../../../scripts');
  const result = spawnSync('node', ['--test', '--test-reporter=tap', join(scripts, 'native-execution-artifact.test.mjs'), join(scripts, 'native-execution-process.test.mjs')], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_OPTIONS: '' },
  });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0);
  expect(result.stdout).toContain('# fail 0'); expect(result.stderr).toBe('');
}, 35_000);
