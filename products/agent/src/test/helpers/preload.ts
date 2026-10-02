/**
 * Test environment preload, loaded by bun:test via bunfig.toml [test].preload.
 *
 * Provides globals that are available in the full runtime but absent in the
 * bare bun:test runner, and owns the suite's temp-directory lifetime. Add only
 * what is genuinely missing; do NOT mock real platform APIs here.
 */

import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepCreatedProjectTempDirs } from './project-temp.ts';
import { sweepTrackedTempDirs } from './temp-registry.ts';

// Ensure fetch is available as a global (bun provides it; this is a no-op in
// most bun versions but guards against environments where it isn't set).
if (typeof globalThis.fetch === 'undefined') {
  // @ts-ignore, bun built-in, not in all type-def bundles
  globalThis.fetch = Bun.fetch;
}

// The real per-test cleanup mechanism for makeProjectTempDir (see that
// function's doc comment in project-temp.ts for why this must be registered
// exactly once, here, rather than lazily inside the helper itself). Preload
// runs before any test file is registered, so this attaches as a true
// global hook, confirmed empirically to fire after every test in every
// file, and to fire AFTER a test file's own local afterEach hooks
// (inner-to-outer, then this one last), which is what makes it safe to run
// the actual directory removal here.
afterEach(() => {
  sweepCreatedProjectTempDirs();
});

/**
 * ONE temp sandbox for the whole test process, removed when the run ends.
 *
 * The problem this solves: `bun test` does not run `process.on('exit', …)`
 * listeners at all, verified directly, an exit listener registered here never
 * fires under `bun test` while the same listener does fire under `bun run`,
 * both on normal termination and after an uncaught throw. Several helpers had
 * registered their cleanup that way, so it was dead code: a fully GREEN run of
 * the 321 temp-touching test files left 1,649 directories in the OS temp dir
 * and 60 under <repo>/.test-tmp.
 *
 * Rather than trusting 321 test files to each clean up after themselves, the OS
 * temp directory is redirected into a single per-process sandbox here, before
 * any test module is imported, and the whole sandbox is removed in a top-level
 * `afterAll`. `os.tmpdir()` re-reads process.env.TMPDIR on every call
 * (verified), so this captures every later `tmpdir()` call, including calls
 * made inside the SDK and other installed packages.
 *
 * ACCEPTED COST, recorded so the next person meets it here rather than
 * discovering it: the sandbox is emptied at the end of the run, not kept empty
 * during it. Whatever a test creates by calling `tmpdir()` directly and never
 * removes stays inside the sandbox until the `afterAll` below. Nothing survives
 * the run, the whole sandbox goes there, and a killed run is reclaimed by the
 * age-gated sweep, so the residual is BOUNDED, not necessarily small.
 *
 * The second, narrower mechanism cuts into that residual rather than replacing
 * this one: test files that were migrated onto `makeProjectTempDir` get their
 * directory removed after each individual test by the `afterEach` above. The
 * two are complementary and the sandbox stays the base, because it is the only
 * one that also captures `tmpdir()` calls made inside the SDK and other
 * installed packages, which no in-repo helper can see. If the residual ever
 * starts to matter, an inode ceiling on a busy host, a run that cannot
 * finish, measure it with a before/after count (see
 * GOODVIBES_TEST_KEEP_TMP_SANDBOX below), not by inspecting hooks: two earlier
 * attempts at this leak were declared fixed after reading cleanup code rather
 * than counting directories, and both were wrong.
 *
 * `afterAll` registered at preload top level is the hook bun actually runs:
 * once, after the last test file, whether the run passed or failed (all three
 * verified). Do NOT move this registration inside a function, a hook attached
 * lazily during a run does not reliably attach.
 */
const OUTER_TMPDIR = tmpdir();
const TEST_TMP_SANDBOX = mkdtempSync(join(OUTER_TMPDIR, 'gv-agent-test-run-'));
process.env['TMPDIR'] = TEST_TMP_SANDBOX;
process.env['TMP'] = TEST_TMP_SANDBOX;
process.env['TEMP'] = TEST_TMP_SANDBOX;

/** The per-run sandbox every `tmpdir()` call in this process resolves into. */
export function testTempSandbox(): string {
  return TEST_TMP_SANDBOX;
}

/** The temp directory this process inherited, before the redirect. */
export function outerTempDir(): string {
  return OUTER_TMPDIR;
}

function assertRedirect(): void {
  process.env['TMPDIR'] = TEST_TMP_SANDBOX;
  process.env['TMP'] = TEST_TMP_SANDBOX;
  process.env['TEMP'] = TEST_TMP_SANDBOX;
}

// Re-assert the redirect before every test. A test that snapshots and restores
// process.env wholesale would otherwise hand the rest of the run the real /tmp
// back, and everything created from that point on escapes the sandbox silently.
// Registered at preload top level, statically, a hook attached from inside an
// already-running hook does not scope to the test that triggered it.
beforeAll(assertRedirect);
beforeEach(assertRedirect);

/** No entry idle for less than this is treated as abandoned. */
const STALE_PROJECT_TEMP_MS = 5 * 60 * 1000;
/** When this process started, so it can tell earlier residue from a live peer's work. */
const PROCESS_STARTED_AT = Date.now();

/**
 * Reclaim abandoned scratch trees under `<repo>/.test-tmp`, and ONLY abandoned
 * ones.
 *
 * This used to be `rmSync('<repo>/.test-tmp')`, on the premise (written down in
 * scripts/stale-tmp-sweep.ts) that the root "is exclusively owned by this
 * project's own test runs, so a full unconditional wipe is safe: there is
 * nothing else in there to lose". That premise holds for ONE test process at a
 * time. Two in the same checkout is an ordinary thing to do, run one file while
 * the suite runs, and then the first one to exit deleted the other's live
 * directories out from under it. What that looks like from inside the victim is
 * an ENOENT from `rename` in the middle of an atomic store write, in a test
 * about something else entirely; it was a one-in-four flake in the device
 * settings suite before it was traced here.
 *
 * So an entry is removed only when it both predates this process AND has been
 * idle longer than the grace window. A live peer's directories are newer or
 * being written, and survive. The cost is bounded and self-healing: an
 * unregistered tree this run created is left for the next sweep (or for
 * scripts/run-tests.ts, which still empties the root at a suite boundary where
 * no run of this project is in flight).
 */
function sweepStaleProjectTempEntries(): void {
  const root = join(process.cwd(), '.test-tmp');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // nothing there, nothing to do
  }
  const cutoff = Math.min(PROCESS_STARTED_AT, Date.now() - STALE_PROJECT_TEMP_MS);
  for (const name of entries) {
    const path = join(root, name);
    try {
      // mtime, not birthtime: a directory a peer is actively writing keeps a
      // fresh mtime on every child change, which is exactly the signal wanted.
      if (statSync(path).mtimeMs >= cutoff) continue;
    } catch {
      continue; // vanished between the listing and the stat
    }
    rmSync(path, { recursive: true, force: true });
  }
}

afterAll(() => {
  // Fail the run loudly if the redirect did not hold to the end. Without this,
  // a suite that lost TMPDIR partway through would still report a clean temp
  // directory, because the measurement only ever looks at the redirect target,
  // and everything that escaped went somewhere else entirely.
  const finalTmp = tmpdir();
  if (finalTmp !== TEST_TMP_SANDBOX) {
    throw new Error(
      `temp sandbox redirect was lost during the run: tmpdir() is ${finalTmp}, expected ${TEST_TMP_SANDBOX}. ` +
        'Anything created after the redirect was lost escaped cleanup.',
    );
  }
  // Directories deliberately created OUTSIDE the sandbox (under
  // <repo>/.test-tmp, so a test workspace sits inside this git checkout).
  const swept = sweepTrackedTempDirs();
  // Backstop for the same root: several test files build their scratch trees
  // directly under <repo>/.test-tmp without going through the registry, and
  // this reclaims those on a bare `bun test` rather than leaving them for a
  // later run.
  sweepStaleProjectTempEntries();
  if (process.env['GOODVIBES_TEST_KEEP_TMP_SANDBOX'] === '1') {
    // Diagnostic mode: leave the sandbox in place so the per-run residual can
    // be counted (how much the suite creates and never removes itself). The
    // sandbox is not removed, so this is for measurement runs only.
    console.log(
      `[preload] kept temp sandbox: ${TEST_TMP_SANDBOX} (${readdirSync(TEST_TMP_SANDBOX).length} entries; ${swept} tracked dirs swept)`,
    );
    return;
  }
  // Everything any test put in the OS temp dir, in one removal.
  rmSync(TEST_TMP_SANDBOX, { recursive: true, force: true });
});

/**
 * The test suite must never reach a REAL daemon.
 *
 * Config routing discovers a daemon by reading the daemon home: the operator
 * token to present, and the control-plane binding to dial. Left unset, that
 * resolves to `~/.goodvibes/daemon`, the developer's actual daemon, which is
 * usually running. A test run then does not just read the wrong settings, it
 * reaches a live process and can write to it. This is not hypothetical; it has
 * already happened once here.
 *
 * So the suite is pinned to a throwaway daemon home before any test module is
 * imported. The directory is deliberately left EMPTY: discovery finds no token
 * and no binding, concludes there is no daemon, and every daemon-owned path
 * takes its no-daemon branch. A test that genuinely wants a daemon must stand
 * one up itself and point this at it.
 *
 * An explicit value set by the caller still wins, so a harness that has already
 * arranged its own isolation is not overridden.
 */
if (!process.env['GOODVIBES_DAEMON_HOME']?.trim()) {
  // Built from tmpdir() AFTER the redirect above, so it lands inside the
  // per-run sandbox and goes away with it. Deliberately NOT one of the
  // per-test directories: it must survive every test in every file for the
  // whole run, not just the first test to touch it.
  process.env['GOODVIBES_DAEMON_HOME'] = mkdtempSync(join(tmpdir(), 'goodvibes-agent-test-daemon-home-'));
}
