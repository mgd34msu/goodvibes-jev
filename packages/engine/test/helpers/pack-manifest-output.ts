import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

// Match release-shared.ts packStage and tar-inspection budgets (THE47).
// A complete engine file listing exceeds the subprocess default 1 MiB.
const PACK_MANIFEST_MAX_BUFFER = 32 * 1024 * 1024;

export interface PackManifestCommandOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout: number;
}

/** Capture a fixture's complete npm pack JSON within a finite output budget. */
export function capturePackManifest(
  executable: string,
  args: readonly string[],
  options: PackManifestCommandOptions,
): SpawnSyncReturns<string> {
  return spawnSync(executable, [...args], { ...options, encoding: 'utf8', maxBuffer: PACK_MANIFEST_MAX_BUFFER });
}
