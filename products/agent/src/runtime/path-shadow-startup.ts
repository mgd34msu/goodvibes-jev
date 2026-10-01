/**
 * path-shadow-startup.ts, the Agent's launch-time answer to "is this the
 * build you are actually reaching, and is it the current one".
 *
 * The check itself is the SDK's (platform/runtime reachability-check): it
 * scans PATH for an older copy shadowing this one, decides whether this
 * install is even reachable by name, compares against the newest release, and
 * turns all of that into lines. What lives here is the part only this product
 * can answer, its command name, its package name, and where the release
 * lookup comes from, plus the launch slot the lines are printed in.
 *
 * That slot is alongside the launch self-update and BEFORE the runtime
 * bootstrap or any terminal mode change, for the same reason the update
 * receipt uses it: if the build about to start is not the one the user
 * reaches, or is not the current release, that has to be the first thing said,
 * not a footnote after a session is already going.
 *
 * Every failure is swallowed. A reachability check must never block or crash
 * launch.
 */

import { announceReachability, boundedLatestRelease } from '@/runtime/index.ts';
import type { ReachabilityCheckInput } from '@/runtime/index.ts';
import { checkForUpdate } from '../input/commands/update-runtime.ts';
import type { UpdateFetchLike } from './update-check.ts';
import { VERSION } from '../version.ts';

/** The package a package-managed Agent install is upgraded through. */
export const AGENT_PACKAGE_NAME = '@pellux/goodvibes-agent';

/** The same release lookup /update uses, one source of truth for "latest". */
function resolveLatestRelease(): Promise<string | undefined> {
  return boundedLatestRelease(() =>
    checkForUpdate(fetch as UpdateFetchLike, VERSION).then((result) => result.latestTag));
}

/** The real host inputs for this process, in one place. */
export function agentReachabilityInput(): ReachabilityCheckInput {
  return {
    execPath: process.execPath,
    pathValue: process.env['PATH'],
    homeDir: process.env['HOME'] ?? '',
    runningVersion: VERSION,
    commandName: 'goodvibes-agent',
    packageName: AGENT_PACKAGE_NAME,
    resolveLatest: resolveLatestRelease,
  };
}

/**
 * Run the check at launch and print what it found.
 *
 * Returns the lines it printed so main() can re-surface them in-session; the
 * alternate screen wipes these stdout copies a moment later.
 */
export async function reachabilityAtLaunch(params: {
  readonly stdout: { write(chunk: string): unknown };
}): Promise<readonly string[]> {
  return announceReachability(agentReachabilityInput(), (line: string) => { params.stdout.write(`${line}\n`); });
}
