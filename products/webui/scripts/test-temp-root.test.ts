/**
 * test-temp-root.test.ts
 *
 * Two jobs, and the first one matters more:
 *
 * 1. PROVE THE REDIRECT IS LIVE. A preload that silently stopped running would
 *    put every temp directory back in the system temp dir with nothing to say
 *    so. The integration test below reads `os.tmpdir()` from inside a real test
 *    process and requires it to be this repo's `.test-tmp/run-<pid>`, so
 *    dropping the bunfig preload entry, renaming the file, or having it throw
 *    all fail here.
 *
 * 2. PROVE EACH CHECK CAN ANSWER NO. Every predicate below gets a case where
 *    the honest answer is "no", a sibling directory that merely shares a name
 *    prefix is not inside the base; a live pid is not stale; a non-run directory
 *    name yields no pid at all. A guard that only ever answers yes is not a guard.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUN_ROOT_PREFIX,
  TEST_TMP_DIRNAME,
  installTestTempRoot,
  isInsideTestTmp,
  isProcessAlive,
  pidFromRunRootName,
  runRootFor,
  selectStaleRunRoots,
  sweepStaleRunRoots,
  testTmpBase,
} from './test-temp-root';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('the temp redirect is actually in effect during this test run', () => {
  test('os.tmpdir() resolves inside the repo, not the system temp directory', () => {
    const actual = resolve(tmpdir());
    expect(isInsideTestTmp(actual, REPO_ROOT)).toBe(true);
    expect(actual).toBe(runRootFor(process.pid, REPO_ROOT));
  });

  test('a directory created the ordinary way lands inside the repo run root', () => {
    // The mkdtemp-under-tmpdir call below IS the subject of this test. The rule that
    // bans that shape (eslint.config.js) exists because it scatters scratch dirs across
    // the shared OS tmpfs, and the preload under test is exactly what makes that untrue
    // here, since tmpdir() now resolves to .test-tmp/run-<pid>. Rewriting it to
    // makeProjectTempDir would assert nothing: the expectation below would then hold by
    // construction, whether or not the redirect ran. If the redirect ever DOES break,
    // this line lands in the real tmpdir, the expectation fails, the finally removes it,
    // and 'temp-root-proof-' is in KNOWN_TEMP_PREFIXES so a killed run's copy is swept.
    // eslint-disable-next-line no-restricted-syntax -- the call under test; see above
    const dir = mkdtempSync(join(tmpdir(), 'temp-root-proof-'));
    try {
      expect(isInsideTestTmp(dir, REPO_ROOT)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the system temp directory is NOT where tests write (the state before this fix)', () => {
    // Without the preload this is exactly what os.tmpdir() would return, and the
    // assertion above would have passed against it. Naming it here keeps the
    // first test from being satisfiable by any path at all.
    expect(isInsideTestTmp('/tmp/anything', REPO_ROOT)).toBe(false);
  });

});

describe('isInsideTestTmp can answer NO', () => {
  test('the base itself and paths under it are inside', () => {
    expect(isInsideTestTmp(testTmpBase(REPO_ROOT), REPO_ROOT)).toBe(true);
    expect(isInsideTestTmp(join(testTmpBase(REPO_ROOT), 'run-1', 'deep', 'x'), REPO_ROOT)).toBe(true);
  });

  test('a sibling that merely shares the name PREFIX is not inside', () => {
    // The bug a naive startsWith() check would have: `.test-tmp-evil` is not
    // `.test-tmp`, and a sweep that believed otherwise would delete it.
    expect(isInsideTestTmp(join(REPO_ROOT, `${TEST_TMP_DIRNAME}-evil`), REPO_ROOT)).toBe(false);
  });

  test('the repo root, the parent directory, and the system temp are not inside', () => {
    expect(isInsideTestTmp(REPO_ROOT, REPO_ROOT)).toBe(false);
    expect(isInsideTestTmp(resolve(REPO_ROOT, '..'), REPO_ROOT)).toBe(false);
    expect(isInsideTestTmp('/tmp', REPO_ROOT)).toBe(false);
    expect(isInsideTestTmp('/', REPO_ROOT)).toBe(false);
  });
});

describe('pidFromRunRootName can answer NO', () => {
  test('reads the pid off a well-formed run root name', () => {
    expect(pidFromRunRootName(`${RUN_ROOT_PREFIX}4242`)).toBe(4242);
  });

  test('returns null for names that are not run roots', () => {
    for (const name of ['', 'run-', 'run-abc', 'run-12x', 'runs-12', 'other', '.gitkeep', 'run--1', 'run-0']) {
      expect(pidFromRunRootName(name)).toBeNull();
    }
  });
});

describe('isProcessAlive can answer NO', () => {
  test('this process is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('a process that does not exist is not alive', () => {
    const notFound = () => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    };
    expect(isProcessAlive(999_999_999, notFound)).toBe(false);
  });

  test('EPERM means alive-but-not-ours, never reapable', () => {
    const permissionDenied = () => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    };
    expect(isProcessAlive(1, permissionDenied)).toBe(true);
  });
});

describe('selectStaleRunRoots reaps the abandoned and spares the living', () => {
  test('a dead run root is selected', () => {
    expect(selectStaleRunRoots([`${RUN_ROOT_PREFIX}111`], () => false)).toEqual([`${RUN_ROOT_PREFIX}111`]);
  });

  test('a LIVE run root is never selected; including this run\'s own', () => {
    const mine = `${RUN_ROOT_PREFIX}${String(process.pid)}`;
    expect(selectStaleRunRoots([mine], (pid) => isProcessAlive(pid))).toEqual([]);
    expect(selectStaleRunRoots([`${RUN_ROOT_PREFIX}222`], () => true)).toEqual([]);
  });

  test('mixed input separates the two, and unrelated names are left alone', () => {
    const alive = new Set([200]);
    const selected = selectStaleRunRoots(
      [`${RUN_ROOT_PREFIX}100`, `${RUN_ROOT_PREFIX}200`, 'not-a-run-root', `${RUN_ROOT_PREFIX}300`],
      (pid) => alive.has(pid),
    );
    expect(selected).toEqual([`${RUN_ROOT_PREFIX}100`, `${RUN_ROOT_PREFIX}300`]);
  });

  test('nothing to reap yields nothing (no false positive on an empty base)', () => {
    expect(selectStaleRunRoots([], () => false)).toEqual([]);
  });
});

describe('sweepStaleRunRoots really deletes, against the real filesystem', () => {
  test('an abandoned root is removed and a live one survives', () => {
    const base = testTmpBase(REPO_ROOT);
    // A pid that cannot be running: pid 0 is never a user process, and the name
    // parser rejects it, so use a large one that the kernel reports as gone.
    const deadPid = 999_999_998;
    const deadRoot = runRootFor(deadPid, REPO_ROOT);
    const liveRoot = runRootFor(process.pid, REPO_ROOT);
    mkdirSync(join(deadRoot, 'leftover'), { recursive: true });
    expect(existsSync(deadRoot)).toBe(true);

    const removed = sweepStaleRunRoots(REPO_ROOT);

    expect(removed).toContain(`${RUN_ROOT_PREFIX}${String(deadPid)}`);
    expect(existsSync(deadRoot)).toBe(false);
    // The running suite's own scratch space must survive its own sweep.
    expect(existsSync(liveRoot)).toBe(true);
    expect(existsSync(base)).toBe(true);
  });
});

describe('installTestTempRoot', () => {
  test('creates the root and points all three temp variables at it', () => {
    const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      const root = installTestTempRoot(REPO_ROOT, process.pid);
      expect(existsSync(root)).toBe(true);
      expect(process.env.TMPDIR).toBe(root);
      expect(process.env.TMP).toBe(root);
      expect(process.env.TEMP).toBe(root);
    } finally {
      process.env.TMPDIR = before.TMPDIR;
      process.env.TMP = before.TMP;
      process.env.TEMP = before.TEMP;
    }
  });
});
