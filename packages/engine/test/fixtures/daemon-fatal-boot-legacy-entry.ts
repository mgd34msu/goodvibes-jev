/** Log-only caller with no configured logger: the real ConfigManager must still
 * disclose malformed settings at ingestion, before this legacy catch runs.
 * Pinned daemon source ab6ce91f2fc646eb563686071393b69438a487e6.
 */
import { ConfigManager } from '../../sdk/src/platform/config/manager.ts';
import { resolveDaemonCliPaths } from '../../sdk/src/platform/daemon/cli-paths.ts';
import { flushActivityLogSync, logger } from '../../sdk/src/platform/utils/logger.ts';
import { summarizeError } from '../../sdk/src/platform/utils/error-display.ts';

async function main(): Promise<void> {
  const { workingDirectory, homeDirectory, daemonTierPath } = resolveDaemonCliPaths();
  new ConfigManager({ workingDir: workingDirectory, homeDir: homeDirectory,
    surfaceRoot: 'goodvibes', daemonTierPath });
}
void main().catch((error) => {
  logger.error('goodvibes daemon host failed', { error: summarizeError(error) });
  flushActivityLogSync();
  process.exit(1);
});
