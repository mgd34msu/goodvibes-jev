/**
 * live-daemon-smoke-runner, runs the live smoke in a child process and removes
 * its scratch tree once that process is genuinely gone.
 *
 * WHY A PARENT PROCESS RATHER THAN MORE CLEANUP INSIDE THE SMOKE: the daemon the
 * smoke boots flushes its activity log (`workdir/.goodvibes/logs/activity.md`)
 * during process teardown, at a point that no in-process cleanup can reliably
 * come after. Every in-process attempt was measured, and every one of them left
 * the tree on disk:
 *
 *   1. rmSync in main()'s `finally`          -> leaked (3/3 runs)
 *   2. a settle loop after the last await    -> leaked (3/3 runs)
 *   3. a process.on('exit') handler          -> leaked (3/3 runs)
 *
 * The flush wins that race, and whether it wins was even sensitive to whether
 * stdout was a pipe, which is the definition of a fix that is not a fix. From a
 * PARENT, there is no race at all: the child has exited, so nothing is left that
 * could write. The smoke keeps its own cleanup for the case where it is run
 * directly (`bun run scripts/live-daemon-smoke.ts`), and the start-of-run sweep
 * remains the backstop for a run killed hard enough to take this parent with it.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runRootFor, sweepStaleRunRoots } from './test-temp-root';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SMOKE = join(SCRIPT_DIR, 'live-daemon-smoke.ts');

sweepStaleRunRoots(REPO_ROOT);

const result = spawnSync('bun', [SMOKE], { cwd: REPO_ROOT, stdio: 'inherit' });

// The child is gone by the time spawnSync returns, so this is the one removal
// that nothing can undo. Its run root is named for the child's pid.
const childPid = result.pid;
if (typeof childPid === 'number') {
  const root = runRootFor(childPid, REPO_ROOT);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
// And reap anything else abandoned, in case the child re-execed or the pid moved.
sweepStaleRunRoots(REPO_ROOT);

process.exit(result.status ?? 1);
