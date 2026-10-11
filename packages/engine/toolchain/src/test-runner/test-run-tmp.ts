/**
 * The per-run test temp root, shared by every entry point that shells out to
 * `bun test` directly: `scripts/test.ts` (the normal way to run the suite)
 * and `scripts/leak-scan.ts` (the same suite, with the timer-leak detector
 * preloaded). Both spawn `bun test` as a child process rather than importing
 * it, so this lives as data + a pure sweep call, no top-level side effects,
 * and each caller does its own `mkdirSync`/env wiring/cleanup around the
 * `bun test` invocation it owns.
 *
 * See scripts/test.ts's original comment (preserved there) for the full
 * incident this fixes: `mkdtempSync(join(tmpdir(), …))` in hundreds of test
 * files resolves `tmpdir()` to whatever `TMPDIR` is set to for the process,
 * so redirecting it here to one per-run parent directory turns thousands of
 * unowned leftover directories (from runs killed before their own cleanup
 * could run) into one directory this run owns and removes with itself, plus
 * an age-based sweep for whatever a signal-killed run could not remove.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const TEST_TMP_ROOT = tmpdir();
export const RUN_TMP_PREFIX = 'goodvibes-sdk-testrun-';
export const RETAIN_RUN_MARKER = '.keep-proof-output';
const activeRoots = new Map<string, { readonly dev: number; readonly ino: number; retained: boolean }>();

/** Retain only a root created by this process; propagate evidence to known run ancestors. */
export function retainRunTmpDir(root: string, reason: string): void {
  const owned = activeRoots.get(root);
  if (!owned) throw new Error('Cannot retain an unowned test root');
  // In-memory retention survives even a failed evidence-marker write.
  owned.retained = true;
  let first = true;
  for (let path = root; ; path = dirname(path)) {
    if (first || basename(path).startsWith(RUN_TMP_PREFIX)) {
      let record: { version?: number; pid?: number; dev?: number; ino?: number };
      try { record = JSON.parse(readFileSync(join(path, '.goodvibes-test-owner.json'), 'utf8')); }
      catch (error) { if (first) throw error; record = {}; }
      const stat = lstatSync(path);
      const active = activeRoots.get(path);
      const identityMatches = !active || (active.dev === stat.dev && active.ino === stat.ino);
      if (identityMatches && !stat.isSymbolicLink() && realpathSync(path) === path && record.version === 1 && record.dev === stat.dev && record.ino === stat.ino && Number.isSafeInteger(record.pid) && record.pid! > 0) {
        if (active) active.retained = true;
        writeFileSync(join(path, RETAIN_RUN_MARKER), reason + '\n');
      } else if (first) throw new Error('Cannot mark a replaced owned test root');
    }
    first = false;
    if (dirname(path) === path) break;
  }
}

/**
 * Age is necessary but never sufficient: sweep admission also requires a
 * matching ownership record and a dead owner. Unknown/live roots are retained. Generous on
 * purpose relative to how long a single `bun test` invocation of this suite
 * actually takes (well under an hour, per-test ceiling of 60s notwithstanding
 *, see scripts/test.ts's resolveTimeoutMs): several checkouts of this
 * repository, and other projects, are routinely under test on the same host
 * at the same time, and a run that is still legitimately in flight must never
 * be swept out from under itself.
 */
export const STALE_RUN_MS = 60 * 60 * 1000;

/** A fresh, collision-safe directory name for this run under TEST_TMP_ROOT. */
export function makeRunTmpDirName(): string {
  return `${RUN_TMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`;
}

/**
 * Create this run's parent directory under `tmpRoot`, hand it to `fn`, and
 * remove it afterwards.
 *
 * The removal is in a `finally`, so a suite that fails, or a callback that
 * throws before its own cleanup, still takes its temp tree with it. That is
 * the property that makes the containment hold on a RED run and not only a
 * green one, and it is what `test/test-tmp-containment.test.ts` drives.
 *
 * Both direct-`bun test` entry points (`scripts/test.ts`,
 * `scripts/leak-scan.ts`) call this rather than each keeping their own copy of
 * the mkdir/try/finally, so the guard test exercises the lifecycle those
 * scripts actually run instead of a re-implementation of it. Sweeping stale
 * siblings stays with the callers: that is per-tool policy (`prefix`,
 * `maxAgeMs`), not part of one run's lifecycle.
 */
export async function withRunTmpDir<T>(
  tmpRoot: string,
  fn: (runTmpDir: string) => T | Promise<T>,
  dirName: string = makeRunTmpDirName(),
): Promise<T> {
  if (basename(dirName) !== dirName || dirName === '.' || dirName === '..' || /[\\/\0]/.test(dirName)) throw new Error('Invalid owned test directory name');
  const runTmpDir = join(realpathSync(tmpRoot), dirName);
  mkdirSync(runTmpDir, { mode: 0o700 });
  const identity = lstatSync(runTmpDir);
  const ownership = { dev: identity.dev, ino: identity.ino, retained: false };
  activeRoots.set(runTmpDir, ownership);
  try {
    writeFileSync(join(runTmpDir, '.goodvibes-test-owner.json'), JSON.stringify({ version: 1, pid: process.pid, dev: identity.dev, ino: identity.ino }));
    return await fn(runTmpDir);
  } finally {
    try {
      const current = lstatSync(runTmpDir);
      if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(runTmpDir) !== resolve(runTmpDir)) throw new Error('Refusing cleanup of replaced owned test root');
      if (!ownership.retained && !existsSync(join(runTmpDir, RETAIN_RUN_MARKER))) rmSync(runTmpDir, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { activeRoots.delete(runTmpDir); }
  }
}

/** The env overrides that redirect `tmpdir()` for a spawned `bun test` child. */
export function testTmpEnv(runTmpDir: string): Readonly<Record<string, string>> {
  return { TMPDIR: runTmpDir, TMP: runTmpDir, TEMP: runTmpDir };
}

/**
 * Set in the child environment by every entry point that spawns `bun test`
 * with the redirection above (`scripts/test.ts`, `scripts/leak-scan.ts`).
 *
 * `test/test-tmp-containment.test.ts` reads it to assert the containment end
 * to end: when the suite is running under one of those runners, its
 * `tmpdir()` must already be a run parent. Without the flag that file cannot
 * tell a raw `bun test` (no containment, and none expected) from a runner
 * whose containment has been removed, both look like "TMPDIR is the system
 * temp dir", and the assertion would have to be skipped in the only case it
 * exists to catch.
 *
 * Deliberately NOT returned from `testTmpEnv()`. It is set as a sibling key
 * so that deleting the `...testTmpEnv(runTmpDir)` spread, the mutation that
 * removes the containment, leaves the flag behind and reddens the guard.
 * Folding it into that return value would make the guard go quiet on exactly
 * the change it is watching for.
 */
export const RUNNER_ENV_FLAG = 'GOODVIBES_SDK_TEST_RUNNER';
