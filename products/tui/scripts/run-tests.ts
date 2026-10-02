import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { runOwnedTestChild } from '@goodvibes-jev/engine/toolchain/test-runner';
import { testFileCeilingMs, testFileStallMs } from './test-file-ceiling.ts';
import { filterTestFilesByPattern, parseChangedBase, parseTestPattern } from './test-pattern-rule.ts';
import { sweepStaleTestTmp, sweepStaleOsTmpEntries } from './stale-tmp-sweep.ts';
import { TEST_TEMP_MANIFEST_ENV, removeManifestedTempDirs } from './test-temp-manifest.ts';

const ROOT = process.cwd();
const INITIAL_PARENT_PID = process.ppid;
const SEARCH_ROOT = join(ROOT, 'src');
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;
// Shared root for all test-tmp artifacts.
const TEST_TMP_ROOT = join(ROOT, '.test-tmp');
// Runner-unique subdir: each concurrent runner owns only its own subtree.
// This prevents cross-process wipes when multiple bun test processes run in
// parallel (e.g., concurrent agent chains). Only this runner's subdir is
// created/deleted; sibling runners are never touched.
const RUNNER_DIR = join(TEST_TMP_ROOT, `run-${process.pid}`);

// Temp-directory containment and teardown for every child (see
// src/test/preload/temp-cleanup.ts). bunfig.toml declares the same preload, but
// bun resolves that path relative to the CURRENT WORKING DIRECTORY and skips it
// in silence when it does not resolve, running `bun test` from src/ loads no
// preload and reports nothing. Passing it here as an absolute path makes the
// runner's behaviour independent of where it was invoked from; loading it twice
// is a no-op because both specifiers resolve to the same module.
const TEMP_CLEANUP_PRELOAD = join(ROOT, 'src', 'test', 'preload', 'temp-cleanup.ts');

// `--changed[=<ref>]` (the `bun run test:changed` script passes
// --changed=origin/main): each per-file child gets bun's own --changed
// selection, so a file whose import graph touches nothing changed since <ref>
// (committed or not) runs zero tests and is reported as not affected. The file
// set, the per-file isolation and the temp containment are the full run's.
const CHANGED_BASE = parseChangedBase(process.argv.slice(2));

// Optional positional pattern filter (first non-flag argv token), e.g. the TUI's
// /test <pattern> passthrough. Matched as a substring against each test file's
// path relative to ROOT, so both a bare filename fragment ("diff-runtime") and a
// directory-scoped pattern ("src/test/input") work. Logic lives in
// test-pattern-rule.ts so it can be unit tested without running the full suite.
const PATTERN = parseTestPattern(process.argv.slice(2));

// Per-file worker pool size. The per-file process isolation (one bun test
// process per file, each with its own TMPDIR) is the point of this runner;
// running the files N at a time just stops paying 600+ sequential process
// startups (this took the CI test job past its budget). Override with
// --jobs N or GOODVIBES_TEST_JOBS; capped to keep peak memory sane.
const JOBS = (() => {
  const flagIdx = process.argv.indexOf('--jobs');
  if (flagIdx !== -1) {
    const n = Number(process.argv[flagIdx + 1]);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  const env = Number(process.env.GOODVIBES_TEST_JOBS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return Math.max(1, Math.min(8, availableParallelism() - 1));
})();

// Per-test ceiling. bun's built-in default is 5 000 ms, and that is an idle
// machine's number: this runner deliberately runs JOBS test files at once, many
// of them boot a real daemon, open a real socket, compile a sql.js WASM module,
// or shell out to git, work whose wall-clock cost is set by how busy the host
// is, not by what the test asserts. Measured on this project's own machine
// under a realistic concurrent load, src/test/state/memory-store.test.ts took
// 103.65 s for 38 tests and several daemon-backed files failed outright with
// "this test timed out after 5000ms" while the daemon was still coming up
// normally.
//
// This is a CEILING, not a delay: nothing waits it out, so a fast host finishes
// exactly as quickly as before and only a genuinely stuck test pays it. A test
// that needs a different budget still declares its own as the third argument to
// test(), which continues to win over this default.
const TIMEOUT_MS = (() => {
  const flagIdx = process.argv.indexOf('--timeout');
  if (flagIdx !== -1) {
    const n = Number(process.argv[flagIdx + 1]);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  const env = Number(process.env.GOODVIBES_TEST_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return 60_000;
})();

// Bun's per-test timeout cannot end a module-load or shutdown hang, where no
// test is running. Bound the complete file process as well, using the shared
// owner to terminate, reap and drain it before removing its scratch directory.
// Explicit long-test declarations are accounted for in test-file-ceiling.ts;
// GOODVIBES_TEST_FILE_TIMEOUT_MS can select a deliberate per-file cap.

// Age-based sweep at startup (see scripts/stale-tmp-sweep.ts): remove stale
// entries older than 1 h under .test-tmp, both leftover run-* runner subtrees
// AND makeProjectTempDir leftovers (<prefix>-<random>) that a signal-killed test
// process never cleaned. Ordinary runs no longer reach this sweep at all: the
// afterAll in src/test/preload/temp-cleanup.ts removes those directories when
// each test process finishes. Safe under concurrency: a live sibling's dirs were
// created moments ago and are never 1 h old.

// The end-to-end tests drive the BUILT binary (docs/testing-and-validation.md). They
// run from their own CI job after the build, through `bun run test:e2e`, never
// as part of this per-file source run.
const E2E_ROOT = join(SEARCH_ROOT, 'test', 'e2e');

function collectTests(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath === E2E_ROOT) continue;
      collectTests(fullPath, acc);
      continue;
    }
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      acc.push(fullPath);
    }
  }
}

const allTestFiles: string[] = [];
collectTests(SEARCH_ROOT, allTestFiles);
allTestFiles.sort((a, b) => a.localeCompare(b));
const testFiles = filterTestFilesByPattern(allTestFiles, ROOT, PATTERN);

// Sweep stale sibling entries (older than 1 h), then create this runner's own
// subdir. Sibling runners still in progress are untouched by the sweep.
sweepStaleTestTmp(TEST_TMP_ROOT);
// Also sweep the real OS temp dir for this project's own known mkdtemp
// prefixes (age-gated at 4 h, see scripts/stale-tmp-sweep.ts). This is a
// backstop for orphans that predate the makeProjectTempDir migration, or
// that came from an invocation path other than this one (a bare
// `bun test <file>` never goes through this file).
sweepStaleOsTmpEntries(tmpdir());
rmSync(RUNNER_DIR, { recursive: true, force: true });
mkdirSync(RUNNER_DIR, { recursive: true });

if (testFiles.length === 0) {
  console.error(PATTERN ? `No test files matched pattern: ${PATTERN}` : 'No test files found under src/');
  rmSync(RUNNER_DIR, { recursive: true, force: true });
  process.exit(1);
}

let passedFiles = 0;
let failedFiles = 0;
let unaffectedFiles = 0;
let interruptedSignal: NodeJS.Signals | undefined;
let parentDied = false;
let outputError: Error | undefined;
process.stdout.on('error', (error: Error) => {
  outputError = error;
  process.exitCode = 1;
});

function cancelled(): boolean {
  // Keep the original parent across files. A newly started child owner would
  // otherwise accept the orphan runner's new PPID as its own initial parent.
  if (process.ppid !== INITIAL_PARENT_PID) parentDied = true;
  return parentDied || interruptedSignal !== undefined;
}

/** Await delivery before returning or setting the runner's failing exit code. */
async function writeOutput(output: string): Promise<void> {
  if (outputError !== undefined) throw outputError;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      // The child owner has finished when we report a buffered file. Its
      // watchdog cannot bound this final downstream write, so give the report
      // the same five-second drain allowance rather than waiting indefinitely.
      timer = setTimeout(() => {
        outputError = new Error('TUI test report output did not drain within 5000ms; output may be truncated');
        reject(outputError);
      }, 5_000);
      process.stdout.write(output, (error) => error ? reject(error) : resolve());
    });
  } finally { clearTimeout(timer); }
}

/** bun's --changed selection ran nothing in this file: none of its imports changed. */
function isUnaffectedByChange(output: string): boolean {
  return CHANGED_BASE !== undefined && /^--changed: .*(nothing to run|no test files are affected)/m.test(output);
}

/**
 * Run one test file in its own bun process with an isolated TMPDIR
 * (identical isolation semantics to the previous sequential runner).
 * Output is buffered and printed on completion so parallel files never
 * interleave mid-line.
 */
async function runFile(testFile: string): Promise<void> {
  const rel = relative(ROOT, testFile);
  const stallMs = testFileStallMs(rel);
  // Unique per-file tmp subdir keeps TMPDIR-rooted artifacts isolated.
  // Scoped under RUNNER_DIR so concurrent runners never collide.
  const testTmpDir = join(
    RUNNER_DIR,
    rel.replace(/[^a-z0-9_.-]+/gi, '-'),
  );
  rmSync(testTmpDir, { recursive: true, force: true });
  mkdirSync(testTmpDir, { recursive: true });
  // Sits OUTSIDE testTmpDir so it survives that directory's removal. The child's
  // teardown writes the directories it owned here; see the finally below.
  const manifestPath = `${testTmpDir}.temp-manifest.json`;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const capture = (chunks: Buffer[]): Writable => new Writable({
    write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  // try/finally so the per-file tmp dir is removed on EVERY exit path, not just
  // a clean run or a non-zero test exit (both of which reach the end normally),
  // but also an exception thrown by Bun.spawn or the stdout/stderr reads. Under
  // these worktrees the project lives on /tmp, so a leaked per-file dir is a
  // leaked /tmp inode subtree; the finally keeps the leak from surviving a
  // crash-mid-file until the 1 h stale sweep.
  try {
    const bunArgs = ['--preload', TEMP_CLEANUP_PRELOAD, `--timeout=${TIMEOUT_MS}`];
    if (CHANGED_BASE !== undefined) bunArgs.push(CHANGED_BASE === '' ? '--changed' : `--changed=${CHANGED_BASE}`);
    bunArgs.push(testFile);
    const result = await runOwnedTestChild({
      argv: bunArgs,
      cwd: ROOT,
      expectedParentPid: INITIAL_PARENT_PID,
      ownProcessGroup: true,
      ceilingMs: testFileCeilingMs(rel, process.env.GOODVIBES_TEST_FILE_TIMEOUT_MS),
      ...(stallMs === undefined ? {} : { stallMs }),
      stdout: capture(stdout),
      stderr: capture(stderr),
      env: {
        ...process.env,
        TMPDIR: testTmpDir,
        TMP: testTmpDir,
        TEMP: testTmpDir,
      },
      fixtureEnv: {
        // TMPDIR is redirected *inside* this project's own repo, so a bare temp dir
        // created by a test sits under the project `.git` and git discovery walks up
        // and finds it, breaking any test that needs a genuinely non-git directory.
        // Fence discovery at TEST_TMP_ROOT (`.test-tmp`, an ancestor of both this
        // file's TMPDIR-scoped testTmpDir AND every makeProjectTempDir output,
        // which lives directly under TEST_TMP_ROOT rather than under testTmpDir)
        // so git stops before the project repo either way. (Set here in the
        // child's spawn env because Bun snapshots the environment at process
        // start, a later process.env mutation inside a test would not reach
        // GitService.isGitRepo's inherited Bun.spawnSync; this must be part of
        // the child's OWN startup environment.) Temp repos a test `git init`s
        // under this dir are unaffected: their own `.git` is found before
        // discovery reaches the ceiling.
        GIT_CEILING_DIRECTORIES: TEST_TMP_ROOT,
        // Where the child's teardown records the temp directories it owned, so
        // this process can finish removing them after the child has exited.
        [TEST_TEMP_MANIFEST_ENV]: manifestPath,
      },
    });

    if (result.stopped === 'parent-died') parentDied = true;
    const ok = !cancelled() && result.exitCode === 0 && result.stopped === null && !result.outputTruncated;
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    if (ok && isUnaffectedByChange(output)) {
      unaffectedFiles += 1;
      return;
    }
    const failure = ok ? '' : `  [FAIL: ${result.stopReason ?? (result.outputTruncated ? 'output drain truncated' : result.signalCode ?? `exit ${result.exitCode}`)}]`;
    await writeOutput(`\n==> ${rel}${failure}\n${output ? `${output}\n` : ''}`);

    if (ok) passedFiles += 1;
    else failedFiles += 1;
  } catch (error) {
    // One spawn/read failure must not abandon another worker's live process or
    // stop the remaining files. The shared owner has already reaped this child.
    failedFiles += 1;
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    await writeOutput(`\n==> ${rel}  [FAIL]\n${output ? `${output}\n` : ''}${String(error)}\n`);
  } finally {
    // Order matters: the child is gone by now, so nothing can recreate what we
    // remove. In-process teardown cannot make that guarantee, a few suites are
    // still writing when their last test ends and put a directory back moments
    // after it was deleted. Directories the child recorded but that live OUTSIDE
    // testTmpDir (makeProjectTempDir writes under <repo>/.test-tmp, which does
    // not follow TMPDIR) would otherwise wait for the 1 h stale sweep.
    removeManifestedTempDirs(manifestPath);
    rmSync(testTmpDir, { recursive: true, force: true });
  }
}

let nextFileIndex = 0;
async function worker(): Promise<void> {
  while (true) {
    if (cancelled()) return;
    const i = nextFileIndex++;
    if (i >= testFiles.length) return;
    await runFile(testFiles[i]!);
  }
}

const selection = [
  PATTERN ? `pattern: ${PATTERN}` : '',
  CHANGED_BASE !== undefined ? `changed since ${CHANGED_BASE || 'the working tree base'}` : '',
].filter(Boolean).join(', ');
const onInterrupt = (): void => { interruptedSignal = 'SIGINT'; };
const onTerminate = (): void => { interruptedSignal = 'SIGTERM'; };
const onHangup = (): void => { interruptedSignal = 'SIGHUP'; };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
process.on('SIGHUP', onHangup);
try {
  await writeOutput(`Running ${testFiles.length} test files with ${JOBS} parallel job${JOBS === 1 ? '' : 's'}${selection ? ` (${selection})` : ''}.\n`);
  // Even a failed output sink cannot release the run directory while another
  // worker still owns a child. Await every worker before propagating errors.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(JOBS, testFiles.length) }, () => worker()));
  for (const result of workers) if (result.status === 'rejected') throw result.reason;
} finally {
  // Remove this runner's own subdir on every exit path (including a worker
  // exception), so a crashed run never leaks its whole run-<pid> subtree.
  // Sibling runners are untouched.
  rmSync(RUNNER_DIR, { recursive: true, force: true });
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  process.off('SIGHUP', onHangup);
}

const unaffectedNote = CHANGED_BASE !== undefined ? `, not affected by the change: ${unaffectedFiles}` : '';
const interruption = parentDied ? 'parent-died' : interruptedSignal;
await writeOutput(`\nTest files: ${testFiles.length}, passed: ${passedFiles}, failed: ${failedFiles}${unaffectedNote}${interruption ? `, interrupted: ${interruption}` : ''}\n`);
process.exitCode = failedFiles === 0 && !cancelled() ? 0 : 1;
