import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ownedTestTmpRoot, registerTempDirForCleanup } from './temp-registry.ts';

/** Official child startup sets tmpdir before module loading or subprocesses. */
export const PROJECT_TEST_TMP_ROOT = tmpdir();
export function makeProjectTempDir(prefix: string): string {
  if (!prefix || prefix === '.' || prefix === '..' || /[\\/\0]/.test(prefix)) throw new Error('Test temp prefix must be a single nonempty path component');
  const root = ownedTestTmpRoot();
  const ceilings = process.env.GIT_CEILING_DIRECTORIES?.split(delimiter) ?? [];
  if (!ceilings.includes(root)) process.env.GIT_CEILING_DIRECTORIES = [...ceilings, root].join(delimiter);
  return registerTempDirForCleanup(mkdtempSync(join(root, `${prefix}-`)));
}
