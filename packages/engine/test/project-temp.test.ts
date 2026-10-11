import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { makeProjectTempDir, PROJECT_TEST_TMP_ROOT } from './_helpers/project-temp.ts';
import { registeredTempDirs } from './_helpers/temp-registry.ts';

test('helper allocates unique registered directories inside the official private root', () => {
  const first = makeProjectTempDir('project'); const second = makeProjectTempDir('project');
  expect(first).not.toBe(second); expect(basename(first)).toStartWith('project-');
  expect(existsSync(first)).toBe(true); expect(dirname(first)).toBe(PROJECT_TEST_TMP_ROOT);
  expect(PROJECT_TEST_TMP_ROOT).toBe(process.env.GOODVIBES_TEST_OWNED_TMP_ROOT!);
  expect(registeredTempDirs()).toContain(first); expect(registeredTempDirs()).toContain(second);
  expect(existsSync(second)).toBe(true); expect(existsSync(PROJECT_TEST_TMP_ROOT)).toBe(true);
});
test('helper refuses escaping prefixes before allocation', () => {
  for (const value of ['', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', 'a\0b']) expect(() => makeProjectTempDir(value)).toThrow();
});
test('raw helper invocation refuses before creating cwd temp data', () => {
  const root = mkdtempSync(join(tmpdir(), 'raw-helper-proof-'));
  try {
    const helper = resolve(import.meta.dir, '_helpers/project-temp.ts');
    const env = { ...process.env }; delete env.GOODVIBES_TEST_OWNED_TMP_ROOT; delete env.GOODVIBES_SDK_TEST_RUNNER;
    const result = Bun.spawnSync([process.execPath, '-e', `import {makeProjectTempDir} from ${JSON.stringify(helper)};makeProjectTempDir('raw');`], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).not.toBe(0); expect(new TextDecoder().decode(result.stderr)).toContain('official test runner');
    expect(existsSync(join(root, '.test-tmp'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
