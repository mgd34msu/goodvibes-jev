import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('a work-ledger host composes through the supported Bun package subpath', () => {
  const run = spawnSync(process.execPath, [join(import.meta.dir, 'fixtures/work-ledger-consumer.mjs')], {
    cwd: join(import.meta.dir, '..'), encoding: 'utf8', timeout: 30_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain('PASS work-ledger public consumer');
});
