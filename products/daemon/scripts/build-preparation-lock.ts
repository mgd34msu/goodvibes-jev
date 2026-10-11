/** One private checkout mutex for explicit native artifact readers and version writers. */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { acquireCrossProcessLock } from '@goodvibes-jev/engine/sdk/platform/workspace';

export function buildPreparationLockPath(root: string): string {
  return join(realpathSync(root), '.tmp', 'build-preparation.lock');
}

export async function withBuildPreparationLock<T>(root: string, operation: () => T | Promise<T>, timeoutMs = 30 * 60 * 1000): Promise<T> {
  const release = await acquireCrossProcessLock(buildPreparationLockPath(root), {
    strictOwnership: true, totalTimeoutMs: timeoutMs,
  });
  try { return await operation(); }
  finally { release(); }
}
