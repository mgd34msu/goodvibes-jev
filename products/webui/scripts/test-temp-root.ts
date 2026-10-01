/**
 * test-temp-root, give the test run its own temp directory inside the repo,
 * and reap what earlier runs left behind.
 *
 * THE PROBLEM: nothing in this repo pointed the test run's temp directory
 * anywhere, so `os.tmpdir()` resolved to the system temp dir. Every directory a
 * test creates there is invisible to the repo, ignored by .gitignore, and swept
 * by nobody. Today's suite happens to clean up after itself on a green run
 * (measured, see test-temp-root.test.ts), but two things were still true:
 * a run that is KILLED (Ctrl-C, a CI timeout) leaves its directories in the
 * system temp forever, and the next test to reach for `os.tmpdir()` inherits the
 * same unswept ground.
 *
 * WHAT THIS DOES, and deliberately does not do:
 *   - Points TMPDIR/TMP/TEMP at `<repo>/.test-tmp/run-<pid>` (gitignored) before
 *     any test module is evaluated, so `os.tmpdir()` and every child process
 *     spawned by a test land inside the repo instead of the system temp.
 *   - Sweeps `.test-tmp/run-*` roots whose owning process is GONE. That is the
 *     recovery path for a killed run, and it is why this file does not try to
 *     delete the current run's root on the way out: under `bun test --isolate`
 *     every test FILE re-runs this preload in the SAME process, so an `afterAll`
 *     here fires once per file, deleting the run root there would pull the
 *     ground out from under the files still to come. Liveness, checked at
 *     startup, reaps exactly the abandoned roots and never a live sibling run.
 *
 * Wired as the FIRST entry of bunfig.toml's [test] preload, so it runs before
 * src/test-setup.ts and before any test module.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The gitignored directory every run root lives under. */
export const TEST_TMP_DIRNAME = '.test-tmp';

/** Run roots are named so the owning process id can be read back off the name. */
export const RUN_ROOT_PREFIX = 'run-';

export function testTmpBase(repoRoot: string = REPO_ROOT): string {
  return join(repoRoot, TEST_TMP_DIRNAME);
}

export function runRootFor(pid: number, repoRoot: string = REPO_ROOT): string {
  return join(testTmpBase(repoRoot), `${RUN_ROOT_PREFIX}${String(pid)}`);
}

/**
 * Is `candidate` genuinely inside the repo's test temp base?
 *
 * Written as a path-boundary check rather than a `startsWith` on the raw string:
 * `<repo>/.test-tmp-something` starts with `<repo>/.test-tmp` but is NOT inside
 * it, and a check that accepted it would accept most of the filesystem the
 * moment someone renamed the base.
 */
export function isInsideTestTmp(candidate: string, repoRoot: string = REPO_ROOT): boolean {
  const base = testTmpBase(repoRoot);
  const normalized = resolve(candidate);
  return normalized === base || normalized.startsWith(base + sep);
}

/** The pid encoded in a run-root directory NAME, or null if the name isn't one. */
export function pidFromRunRootName(name: string): number | null {
  if (!name.startsWith(RUN_ROOT_PREFIX)) return null;
  const digits = name.slice(RUN_ROOT_PREFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const pid = Number(digits);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Is this process id still running? `process.kill(pid, 0)` sends no signal; it
 * only asks the kernel. EPERM means the process exists but belongs to someone
 * else, still alive, and still not ours to reap.
 */
export function isProcessAlive(pid: number, kill: (p: number, signal: 0) => void = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Which run roots should be reaped: the ones whose owning process is gone.
 * A live run's root, including this run's own, is never returned, so two test
 * runs in the same worktree cannot delete each other's scratch space.
 */
export function selectStaleRunRoots(
  entryNames: readonly string[],
  isAlive: (pid: number) => boolean = (pid) => isProcessAlive(pid),
): string[] {
  const stale: string[] = [];
  for (const name of entryNames) {
    const pid = pidFromRunRootName(name);
    if (pid === null) continue;
    if (isAlive(pid)) continue;
    stale.push(name);
  }
  return stale.sort();
}

/** Delete the abandoned run roots. Returns the names actually removed. */
export function sweepStaleRunRoots(repoRoot: string = REPO_ROOT): string[] {
  const base = testTmpBase(repoRoot);
  if (!existsSync(base)) return [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  const stale = selectStaleRunRoots(entries);
  const removed: string[] = [];
  for (const name of stale) {
    const target = join(base, name);
    // Belt and braces: never hand rmSync a path that is not under the base.
    if (!isInsideTestTmp(target, repoRoot)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // A root another process is actively tearing down is not this run's problem.
    }
  }
  return removed;
}

/**
 * Create this run's root and point the temp environment variables at it.
 * Returns the root. Safe to call repeatedly (bun re-evaluates the preload per
 * test file within a run).
 */
export function installTestTempRoot(repoRoot: string = REPO_ROOT, pid: number = process.pid): string {
  const root = runRootFor(pid, repoRoot);
  mkdirSync(root, { recursive: true });
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  return root;
}

/**
 * NO TOP-LEVEL SIDE EFFECTS IN THIS FILE, ON PURPOSE.
 *
 * The sweep and the redirect live in scripts/test-temp-preload.ts, which is what
 * bunfig.toml preloads. They used to run here, on import, and that made
 * test-temp-root.test.ts's "os.tmpdir() is inside the repo" assertion
 * unfalsifiable: the test imports this module, the import performed the
 * redirect, and the assertion passed even with the preload entry deleted from
 * bunfig.toml. Verified by deleting that entry and watching the test still pass.
 * Keeping this module effect-free is what makes that assertion able to fail.
 */
