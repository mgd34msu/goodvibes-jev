/**
 * exec-credential-env-scrub.test.ts
 *
 * The exec env scrub: credential-bearing environment variables are withheld
 * from spawned tool processes, with the withheld NAMES (never values) reported
 * on the exec result. A per-command env override and a config allowlist both
 * re-admit a variable explicitly.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.ts';
import {
  readCredentialEnvName,
  resolveCredentialEnvScrub,
  scrubCredentialEnv,
} from '../sdk/src/platform/tools/exec/credential-env.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { EXEC_GATE_TABLE, useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings(EXEC_GATE_TABLE);

// Jev reads each variable NAME; these fakes stand in for it. Names no entry
// matches read as not a credential.
const CREDENTIAL = { credential: true } as const;
const readings = useToolReadings([
  ['"AWS_SECRET_ACCESS_KEY"', CREDENTIAL],
  ['"AWS_ACCESS_KEY_ID"', CREDENTIAL],
  ['"GITHUB_TOKEN"', CREDENTIAL],
  ['"NPM_TOKEN"', CREDENTIAL],
  ['"OPENAI_API_KEY"', CREDENTIAL],
  ['"DB_PASSWORD"', CREDENTIAL],
  ['"SCRUB_TEST_API_KEY"', CREDENTIAL],
]);

describe('scrubCredentialEnv', () => {
  test('withholds the names Jev reads as credentials, keeps the rest', async () => {
    const { env, withheld } = await scrubCredentialEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        AWS_REGION: 'us-east-1',
        AWS_SECRET_ACCESS_KEY: 'shh',
        AWS_ACCESS_KEY_ID: 'AKIA',
        GITHUB_TOKEN: 'ght',
        OPENAI_API_KEY: 'sk-x',
        DB_PASSWORD: 'pw',
      },
      resolveCredentialEnvScrub(),
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(withheld).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'GITHUB_TOKEN', 'OPENAI_API_KEY']);
  });

  test('only names are read, never values', async () => {
    await scrubCredentialEnv({ GITHUB_TOKEN: 'ght-value-1234', PATH: '/usr/bin' }, resolveCredentialEnvScrub());
    const sent = JSON.stringify(readings.requests.map((request) => request.state));
    expect(sent).toContain('GITHUB_TOKEN');
    expect(sent).not.toContain('ght-value-1234');
    expect(sent).not.toContain('/usr/bin');
  });

  test('allowlist re-admits a named var without reading it', async () => {
    const { env, withheld } = await scrubCredentialEnv(
      { GITHUB_TOKEN: 'ght', NPM_TOKEN: 'npm' },
      resolveCredentialEnvScrub({ allowlist: ['GITHUB_TOKEN'] }),
    );
    expect(env.GITHUB_TOKEN).toBe('ght');
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(withheld).toEqual(['NPM_TOKEN']);
    expect(JSON.stringify(readings.requests.map((request) => request.state))).not.toContain('GITHUB_TOKEN');
  });

  test('disabled passes env through untouched and reads nothing', async () => {
    const { env, withheld } = await scrubCredentialEnv({ GITHUB_TOKEN: 'ght' }, resolveCredentialEnvScrub({ enabled: false }));
    expect(env.GITHUB_TOKEN).toBe('ght');
    expect(withheld).toEqual([]);
    expect(readings.requests).toHaveLength(0);
  });

  test('each name is read once per process, case-insensitively', async () => {
    expect(await readCredentialEnvName('GITHUB_TOKEN')).toBe(true);
    expect(await readCredentialEnvName('github_token')).toBe(true);
    expect(await readCredentialEnvName('AWS_REGION')).toBe(false);
    expect(readings.requests).toHaveLength(2);
  });
});

describe('exec tool: env scrub end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-exec-scrub-'));

  test('a credential var in this process env is absent from the child and reported as withheld', async () => {
    process.env.SCRUB_TEST_API_KEY = 'super-secret';
    try {
      const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
      const result = await tool.execute({
        working_dir: root,
        commands: [{ cmd: 'echo "val=[${SCRUB_TEST_API_KEY}]"' }],
      });
      const output = JSON.parse(result.output ?? '{}') as { stdout?: string; withheld_env?: string[] };
      expect(output.stdout).toContain('val=[]');
      expect(output.stdout).not.toContain('super-secret');
      expect(output.withheld_env).toContain('SCRUB_TEST_API_KEY');
    } finally {
      delete process.env.SCRUB_TEST_API_KEY;
    }
  });

  test('a per-command env override re-admits the value and it is not listed as withheld', async () => {
    process.env.SCRUB_TEST_API_KEY = 'super-secret';
    try {
      const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
      const result = await tool.execute({
        working_dir: root,
        commands: [{ cmd: 'echo "val=[${SCRUB_TEST_API_KEY}]"', env: { SCRUB_TEST_API_KEY: 'explicit' } }],
      });
      const output = JSON.parse(result.output ?? '{}') as { stdout?: string; withheld_env?: string[] };
      expect(output.stdout).toContain('val=[explicit]');
      expect(output.withheld_env ?? []).not.toContain('SCRUB_TEST_API_KEY');
    } finally {
      delete process.env.SCRUB_TEST_API_KEY;
    }
  });

  test('withheld_env, when present, is a name-only list (never values)', async () => {
    const tool = createExecTool(new ProcessManager(), { overflowHandler: new OverflowHandler({ baseDir: root }) });
    const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo hi' }] });
    const output = JSON.parse(result.output ?? '{}') as { stdout?: string; withheld_env?: string[] };
    expect(output.stdout).toContain('hi');
    // The list (if any) carries variable NAMES only, no '=' value payloads.
    for (const name of output.withheld_env ?? []) expect(name).not.toContain('=');
  });

  test('scrub can be disabled per exec tool instance', async () => {
    process.env.SCRUB_TEST_API_KEY = 'super-secret';
    try {
      const tool = createExecTool(new ProcessManager(), {
        overflowHandler: new OverflowHandler({ baseDir: root }),
        credentialEnvScrub: { enabled: false },
      });
      const result = await tool.execute({ working_dir: root, commands: [{ cmd: 'echo "val=[${SCRUB_TEST_API_KEY}]"' }] });
      const output = JSON.parse(result.output ?? '{}') as { stdout?: string; withheld_env?: string[] };
      expect(output.stdout).toContain('val=[super-secret]');
      expect(output.withheld_env).toBeUndefined();
    } finally {
      delete process.env.SCRUB_TEST_API_KEY;
    }
  });
});
