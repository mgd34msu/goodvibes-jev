import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isolatedTestEnvironment } from '../helpers/isolated-test-environment.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** Real main entrypoint, with no inherited provider credentials, home state or external network. */
async function invoke(args: string[]) {
  const root = makeProjectTempDir('gv-tui-main-entry');
  const cwd = join(root, 'workspace'); mkdirSync(cwd);
  const env = isolatedTestEnvironment(process.env, join(root, 'isolated'));
  const child = Bun.spawn([
    process.execPath, '--no-env-file', '--preload', resolve(import.meta.dir, '../../../../../packages/engine/scripts/test-network-preload.ts'),
    resolve(import.meta.dir, '../../main.ts'), ...args,
  ], { cwd: resolve(import.meta.dir, '../../..'), env: { ...env, PATH: dirname(process.execPath), GOODVIBES_HOME: env.HOME, GOODVIBES_WORKING_DIR: cwd, GOODVIBES_DAEMON_HOME: join(root, 'daemon'), NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
}

describe('actual source entrypoint', () => {
  test('--help reaches CLI output before interactive startup', async () => {
    const result = await invoke(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('goodvibes');
    expect(result.stdout).toContain('--help');
    expect(result.stdout).not.toContain('starting…');
    expect(result.stderr).toBe('');
  }, 15_000);
  test('--version remains a clean standalone line', async () => {
    const result = await invoke(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toMatch(/goodvibes.*\d+\.\d+\.\d+/);
    expect(result.stderr).toBe('');
  }, 15_000);
});
