/** Compiled canonical ConfigManager + fatal reporter fixture.
 * This isolates descriptor/logging behavior without bundling the whole product.
 * resolveDaemonCliPaths additionally exercises the engine's --daemon-home
 * isolation contract; surfaceRoot=goodvibes and output markers intentionally
 * differ from the pinned daemon fixture aea2b399f6aec7fc3a3a8831bfc2d1934c8b8090.
 * It is not an exact mirror of the current product CLI. The product's emitted
 * malformed-settings startup is separately exercised by
 * products/daemon/src/test/cli/startup-diagnostics-executable.test.ts.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../sdk/src/platform/config/manager.ts';
import { resolveDaemonCliPaths } from '../../sdk/src/platform/daemon/cli-paths.ts';
import { reportFatalBootFailure } from '../../sdk/src/platform/daemon/fatal-boot-report.ts';
import { configureActivityLogger } from '../../sdk/src/platform/utils/logger.ts';

async function main(): Promise<void> {
  const { workingDirectory, homeDirectory, daemonTierPath } = resolveDaemonCliPaths();
  configureActivityLogger(join(workingDirectory, '.goodvibes', 'logs'));
  const config = new ConfigManager({
    workingDir: workingDirectory,
    homeDir: homeDirectory,
    surfaceRoot: 'goodvibes',
    daemonTierPath,
  });
  // Proves the flag actually governs: which daemon tier answered, and what the
  // resolved value of a key planted only in the REAL home would be.
  process.stdout.write(`BOOTED daemonTierPath=${daemonTierPath} realHome=${homedir()}\n`);
  process.stdout.write(`RESOLVED controlPlane.port=${String(config.get('controlPlane.port'))}\n`);
  process.stdout.write(`QUARANTINE=${JSON.stringify(config.getIngestionQuarantine().map((n) => `${n.action}:${n.key}`))}\n`);
}

void main().catch((error) => {
  reportFatalBootFailure(error);
  process.exit(1);
});
