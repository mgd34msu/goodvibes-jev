import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { trackTempDir } from './temp-registry.ts';

const PROJECT_TMP_PARENT = join(process.cwd(), '.test-tmp');
let projectTmpRoot: {
  readonly path: string;
  readonly parent: string;
  readonly dev: number;
  readonly ino: number;
  readonly parentDev: number;
  readonly parentIno: number;
  readonly parentOwned: boolean;
} | undefined;

// Directories created by makeProjectTempDir since the last sweep (see
// sweepCreatedProjectTempDirs below). Directories created via
// makeLongLivedProjectTempDir are deliberately NEVER pushed here, they go to
// the shared temp registry instead, which is swept once at end of run.
const _createdDirs: string[] = [];

/** One checkout-contained root for this process, shared by creation and final cleanup. */
export function projectTestTmpRoot(): string {
  if (projectTmpRoot === undefined) {
    const parent = PROJECT_TMP_PARENT;
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const parentIdentity = lstatSync(parent);
    if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('Refusing a replaced Agent project test parent');
    const supplied = process.env.GOODVIBES_TEST_PROJECT_TMP_ROOT;
    let root: string;
    if (supplied) {
      root = resolve(supplied);
      const identity = lstatSync(root);
      const owner: unknown = JSON.parse(readFileSync(join(root, '.goodvibes-test-owner.json'), 'utf8'));
      if (dirname(root) !== realpathSync(parent) || !basename(root).startsWith('goodvibes-sdk-testrun-')
        || identity.isSymbolicLink() || realpathSync(root) !== root
        || !owner || typeof owner !== 'object' || !('version' in owner) || owner.version !== 1
        || !('pid' in owner) || owner.pid !== process.ppid
        || !('dev' in owner) || owner.dev !== identity.dev || !('ino' in owner) || owner.ino !== identity.ino) {
        throw new Error('Refusing an unowned Agent project test root');
      }
    } else root = mkdtempSync(join(parent, 'gv-agent-project-run-'));
    const identity = lstatSync(root);
    projectTmpRoot = { path: root, parent, dev: identity.dev, ino: identity.ino,
      parentDev: parentIdentity.dev, parentIno: parentIdentity.ino, parentOwned: Boolean(supplied) };
  }
  if (!assertProjectTestTmpCurrent()) throw new Error('The owned Agent project test root no longer exists');
  return projectTmpRoot.path;
}

/** Cleanup may touch only the originally captured physical root and parent. */
export function assertProjectTestTmpCurrent(): boolean {
  if (!projectTmpRoot) return false;
  const original = projectTmpRoot;
  const parent = lstatSync(original.parent);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== original.parentDev || parent.ino !== original.parentIno
    || realpathSync(original.parent) !== original.parent) throw new Error('Refusing cleanup through a replaced Agent project test parent');
  let current: Stats;
  try { current = lstatSync(original.path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('The owned Agent project test root no longer exists', { cause: error });
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino
    || realpathSync(original.path) !== original.path) throw new Error('Refusing cleanup of a replaced Agent project test root');
  return true;
}

/** The native parent removes its issued root only after complete child drainage. */
export function sweepProjectTestTmpRoot(): void {
  if (assertProjectTestTmpCurrent() && projectTmpRoot && !projectTmpRoot.parentOwned) rmSync(projectTmpRoot.path, { recursive: true, force: true });
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
  const dir = mkdtempSync(join(projectTestTmpRoot(), `${prefix}-`));
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
  return trackTempDir(mkdtempSync(join(projectTestTmpRoot(), `${prefix}-`)));
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
  if (assertProjectTestTmpCurrent()) removeAll(_createdDirs.splice(0));
  else _createdDirs.length = 0;
}
