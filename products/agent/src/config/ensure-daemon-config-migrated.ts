/**
 * ensure-daemon-config-migrated.ts, run the one-time move of daemon-owned
 * keys into the daemon's own store before any ConfigManager is constructed.
 *
 * The migration itself lives in the SDK (`daemon-config-migration.ts`) so every
 * product performs the identical move; this wrapper exists to make it (a) safe
 * to call from a composition root and (b) impossible to bring the process down.
 * It is idempotent and its fast path is one file read plus one JSON parse, so
 * calling it at several entry points is correct rather than wasteful.
 */

import {
  describeDaemonConfigMigration,
  migrateDaemonOwnedConfig,
  type DaemonConfigMigrationResult,
} from '@goodvibes-jev/engine/sdk/platform/config';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

/**
 * Move daemon-owned settings into `~/.goodvibes/daemon/settings.json` if that
 * has not already completed. Returns the disclosure text the FIRST time values
 * actually move, and null otherwise, so a caller can print it once without
 * re-announcing on every launch.
 *
 * A failure never blocks startup: the daemon store simply stays as it was and
 * the surface stores keep their values, which is the pre-migration state and is
 * safe. It is logged with the marker path so it is diagnosable.
 */
export function ensureDaemonConfigMigrated(homeDir: string): string | null {
  let result: DaemonConfigMigrationResult;
  try {
    result = migrateDaemonOwnedConfig({ homeDir, primarySurface: 'tui' });
  } catch (error) {
    logger.warn('[config] daemon-owned config migration failed; settings were left where they are', {
      homeDir,
      error: summarizeError(error),
    });
    return null;
  }
  if (!result.migrated) return null;
  if (result.marker.moved.length === 0 && result.marker.discarded.length === 0) return null;
  return `${describeDaemonConfigMigration(result.marker)}\nMigration record: ${result.markerPath}`;
}
