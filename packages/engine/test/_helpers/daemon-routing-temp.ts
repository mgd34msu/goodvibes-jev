import { rmSync } from 'node:fs';
import { makeProjectTempDir } from './project-temp.ts';

/** Only the temporary-directory helper needed by the hoisted storage/resolver tests. */
export function makeTmpWorkingDir(): { dir: string; cleanup: () => void } {
  const dir = makeProjectTempDir('daemon-channel-routing');
  return { dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}
