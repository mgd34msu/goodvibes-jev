/** One home/tier resolution shared by command and explicit serving entrypoints. */
import { resolve } from 'node:path';
import { ConfigManager, daemonConfigPathForHome, resolveGoodVibesHomeOwnership } from '@goodvibes-jev/engine/sdk/platform/config';
import { runDaemonConfigMigration } from '../config/run-daemon-config-migration.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { DaemonCliFlags } from './types.js';

export function resolveDaemonCliOwnership(
  flags: Pick<DaemonCliFlags, 'daemonHome' | 'workingDir'>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  // Resolve flags without mutating the parent environment or process cwd.
  const homes = resolveGoodVibesHomeOwnership({
    ...env,
    ...(env.GOODVIBES_HOME?.trim() ? { GOODVIBES_HOME: resolve(cwd, env.GOODVIBES_HOME.trim()) } : {}),
    ...(flags.daemonHome !== undefined ? { GOODVIBES_DAEMON_HOME: resolve(cwd, flags.daemonHome) }
      : env.GOODVIBES_DAEMON_HOME?.trim() ? { GOODVIBES_DAEMON_HOME: resolve(cwd, env.GOODVIBES_DAEMON_HOME.trim()) } : {}),
  });
  const workingDirectory = resolve(cwd, flags.workingDir ?? env.GOODVIBES_WORKING_DIR ?? cwd);
  return { ...homes, workingDirectory };
}

export function createDaemonCliConfiguration(
  flags: Pick<DaemonCliFlags, 'daemonHome' | 'workingDir'>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const homes = resolveDaemonCliOwnership(flags, env, cwd);
  const { workingDirectory } = homes;
  runDaemonConfigMigration(homes.homeDirectory);
  const config = new ConfigManager({
    workingDir: workingDirectory, homeDir: homes.homeDirectory,
    surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    daemonTierPath: daemonConfigPathForHome(homes.daemonHomeDirectory),
  });
  return { ...homes, workingDirectory, config };
}
export type DaemonCliConfiguration = ReturnType<typeof createDaemonCliConfiguration>;
