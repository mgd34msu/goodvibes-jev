// A scheduled workflow command gets the environment the exec path gives a
// command: variables read as credential-bearing are withheld, the rest and
// GV_SCHEDULE_NAME are passed.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleManager } from '../sdk/src/platform/tools/workflow/index.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings([['GV_SCHEDULE_TEST_TOKEN', { credential: true }]]);

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-schedule-env-'));
  process.env.GV_SCHEDULE_TEST_TOKEN = 'tok-should-not-leak';
  process.env.GV_SCHEDULE_TEST_PLAIN = 'plain-visible';
});
afterEach(() => {
  delete process.env.GV_SCHEDULE_TEST_TOKEN;
  delete process.env.GV_SCHEDULE_TEST_PLAIN;
  rmSync(dir, { recursive: true, force: true });
});

describe('scheduled workflow command environment', () => {
  test('credential-bearing variables are withheld; the rest and GV_SCHEDULE_NAME are passed', async () => {
    const out = join(dir, 'env.txt');
    const script = join(dir, 'dump.sh');
    writeFileSync(script, `env > ${out}\n`);
    const manager = new ScheduleManager();
    try {
      manager.add('nightly', '0.05s', `sh ${script}`);
      const deadline = Date.now() + 5_000;
      while (!existsSync(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      manager.remove('nightly');
    }
    const env = readFileSync(out, 'utf-8');
    expect(env).toContain('GV_SCHEDULE_NAME=nightly');
    expect(env).toContain('GV_SCHEDULE_TEST_PLAIN=plain-visible');
    expect(env).not.toContain('tok-should-not-leak');
  });
});
