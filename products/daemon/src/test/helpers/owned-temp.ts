import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Test fixtures belong to the guarded runner's per-run parent, removed after child exit. */
export function makeOwnedTempDir(prefix: string): string {
  if (process.env.GOODVIBES_SDK_TEST_RUNNER !== '1') {
    throw new Error('Run daemon fixture tests through the guarded test script.');
  }
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}
