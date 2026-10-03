import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { trackTempDir } from './temp-registry.ts';

const PROJECT_TEST_TMP_ROOT = join(process.cwd(), '.test-tmp');

// Directories created by makeProjectTempDir since the last sweep (see
// sweepCreatedProjectTempDirs below). Directories created via
// makeLongLivedProjectTempDir are deliberately NEVER pushed here, they go to
// the shared temp registry instead, which is swept once at end of run.
const _createdDirs: string[] = [];

function ensureProjectTestTmpRoot(): string {
  if (!existsSync(PROJECT_TEST_TMP_ROOT)) {
    mkdirSync(PROJECT_TEST_TMP_ROOT, { recursive: true });
  }
  return PROJECT_TEST_TMP_ROOT;
}

function removeAll(dirs: readonly string[]): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A directory already removed by its own test is not an error.
    }
  }
}

/**
 * A temp directory under `<repo>/.test-tmp` rather than the OS temp dir, for
 * tests whose workspace must sit inside this git checkout.
 *
 * Removed after the CURRENTLY RUNNING test finishes, by the global `afterEach`
 * in src/test/helpers/preload.ts (see sweepCreatedProjectTempDirs). Use this
 * for the common case: a directory created fresh per test (or per file) that
 * nothing else needs once that test/file is done, which is true of nearly
 * every call site in this repo.
 *
 * Do NOT use this for a directory meant to be created once and reused across
 * MANY tests or MANY files (a module-level memoized singleton, e.g. a
 * `let cached: string | null; if (cached) return cached;` pattern), the
 * per-test sweep would delete it out from under every later test that still
 * needs it. Use makeLongLivedProjectTempDir for that instead.
 *
 * Cleanup used to be a `process.on('exit', …)` handler, which `bun test` never
 * runs, so nothing was ever removed and a fully green run left every
 * directory behind.
 */
export function makeProjectTempDir(prefix: string): string {
  const dir = mkdtempSync(join(ensureProjectTestTmpRoot(), `${prefix}-`));
  _createdDirs.push(dir);
  return dir;
}

/**
 * Same as makeProjectTempDir, but for a directory deliberately meant to
 * outlive any single test, a module-level singleton created once (guarded
 * by the caller's own `if (cached) return cached`) and reused across many
 * tests, possibly across many test files sharing this cached module (e.g.
 * src/test/helpers/runtime-services.ts's getTestRoots()).
 *
 * Never swept by sweepCreatedProjectTempDirs, which would delete it out from
 * under every later test. Removal is registered with the shared temp registry
 * instead, which the test preload sweeps from a top-level `afterAll`, the one
 * hook bun actually runs, once, after the last test file, pass or fail.
 */
export function makeLongLivedProjectTempDir(prefix: string): string {
  return trackTempDir(mkdtempSync(join(ensureProjectTestTmpRoot(), `${prefix}-`)));
}

/**
 * Removes every directory created by makeProjectTempDir since the last call
 * to this function, then clears the tracking list.
 *
 * Wired to a single global `afterEach`, registered ONCE at the top level of
 * src/test/helpers/preload.ts (which runs before any test file is
 * registered, at Bun's preload phase), confirmed empirically that a hook
 * registered there fires after EVERY test in EVERY file, in this order:
 * a test file's own locally-registered afterEach hooks fire first
 * (inner-to-outer), and this global one fires last of all. That ordering is
 * exactly what makes this safe: by the time this runs for a given test, any
 * file-local cleanup logic that still needed the directory (writing a final
 * fixture, asserting on it, etc.) has already run.
 *
 * This is NOT registered lazily inside makeProjectTempDir itself, an
 * earlier version of this fix tried exactly that with `afterAll` and broke
 * a real test file (src/test/input/model-picker.test.ts, whose outer
 * describe's beforeEach calls makeProjectTempDir fresh for every one of its
 * ~115 tests): registering a lifecycle hook dynamically from deep inside an
 * already-executing beforeEach, many times over, across nested describes,
 * does not reliably scope to "this test" or "this file" the way registering
 * a single hook once, at module load time before any test runs, does.
 * Exporting one sweep function and calling it from exactly one place (the
 * preload's afterEach) avoids that whole class of bug.
 */
export function sweepCreatedProjectTempDirs(): void {
  removeAll(_createdDirs.splice(0));
}
