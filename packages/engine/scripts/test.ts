import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { pumpTestOutput, runOwnedTestChild } from './owned-test-child.ts';
import { defaultTestArgs } from './test-discovery.ts';
import { partitionTestArgs } from './test-partitions.ts';
import { sweepStaleTmpDirs } from './stale-tmp-sweep.ts';
import {
  makeRunTmpDirName,
  retainRunTmpDir,
  RUN_TMP_PREFIX,
  RUNNER_ENV_FLAG,
  STALE_RUN_MS,
  testTmpEnv,
  TEST_TMP_ROOT,
  withRunTmpDir,
} from './test-run-tmp.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);

/**
 * Where this run's tests put their temp directories.
 *
 * The suite calls `mkdtempSync(join(tmpdir(), …))` in hundreds of places, and
 * the ones whose cleanup does not run, a test that throws before its
 * `afterEach`, a process killed mid-file, leave the directory behind in the
 * system temp dir, where nothing ever reclaims it. On a machine where /tmp is a
 * tmpfs that is a slow inode leak, and inodes are the resource that runs out
 * first: measured on this project's own host, ~74k leaked directories from
 * these suites had consumed all 1,048,576 tmpfs inodes, at which point every
 * subsequent test failed with ENOSPC no matter what it was asserting. That is
 * the worst kind of failure, because it looks like a defect in whichever test
 * happened to run next.
 *
 * The fix is a single per-run PARENT inside the system temp dir: this run's
 * leftovers are one directory, removed with the run, and an age-based sweep
 * (scripts/stale-tmp-sweep.ts, params in scripts/test-run-tmp.ts, shared with
 * scripts/leak-scan.ts, the other direct-`bun test` entry point) reclaims what
 * a signal-killed run could not remove itself. Thousands of unowned siblings
 * become one owned subtree.
 *
 * It deliberately does NOT live inside the checkout. `tmpdir()` is expected to
 * be somewhere no project rooted above it, and tests rely on that: pointing it
 * at `<repo>/.test-tmp` put a tsconfig.json above every temp directory, so
 * post-edit-diagnostics.test.ts's "returns [] when no TS project context is
 * detectable" case suddenly had one and reported 14 diagnostics where it
 * expected none. Anything rooted above the temp dir, tsconfig, .git,
 * package.json, an editorconfig, is a property tests are entitled to assume
 * absent.
 */
const RUN_TMP_DIR_NAME = makeRunTmpDirName();

function resolveTestArgs(): readonly string[] {
  return partitionTestArgs(SDK_ROOT, args) ?? (args.length > 0 ? args : defaultTestArgs(SDK_ROOT));
}

/**
 * Per-test ceiling. bun's built-in default is 5 000 ms, and that is an idle
 * machine's number: this suite boots real daemons, opens real sockets, shells
 * out to real `git`, and signs real crypto, work whose wall-clock cost is set
 * by how busy the host is, not by what the test asserts. Measured on this
 * project's own machine under a realistic concurrent load, the daemon-backed
 * spine files failed outright with "this test timed out after 5000ms" while the
 * daemon was still coming up perfectly normally, and one of them takes ~37 s in
 * total there.
 *
 * A CEILING, not a delay: nothing waits it out, so a fast host finishes exactly
 * as quickly as before and only a genuinely stuck test pays it. A test that
 * needs a different budget still declares its own as the third argument to
 * test(), which continues to win over this default.
 */
function resolveTimeoutMs(): number {
  const env = Number(process.env.GOODVIBES_TEST_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return 60_000;
}

/** True when the caller already passed an explicit --timeout, which wins. */
function hasExplicitTimeout(testArgs: readonly string[]): boolean {
  return testArgs.some((arg) => arg === '--timeout' || arg.startsWith('--timeout='));
}

/** Relay complete private logs without extending the shared execution deadline. */
export async function replayTestOwnerLogs(paths: readonly string[], deadlineAt: number, sink: Writable = process.stdout, signal?: AbortSignal): Promise<{ outputTruncated: boolean; stopReason: string | null }> {
  const abort = new AbortController();
  const onInterrupt = () => abort.abort(new Error('Owner-log replay was interrupted'));
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  for (const name of signals) process.on(name, onInterrupt);
  signal?.addEventListener('abort', onInterrupt, { once: true });
  if (signal?.aborted) onInterrupt();
  const remaining = deadlineAt - Date.now();
  const timer = setTimeout(() => abort.abort(new Error('The shared absolute deadline expired during owner-log replay')), Math.max(1, remaining));
  try {
    if (remaining <= 0 || abort.signal.aborted) return { outputTruncated: true, stopReason: 'The shared absolute deadline expired or replay was interrupted before owner-log replay' };
    for (let index = 0; index < paths.length; index++) {
      const header = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`[test-owner ${index + 1}/${paths.length}]\n`));
        controller.close();
      } });
      await pumpTestOutput(header, sink, { lastLine: null, lastFile: null }, abort.signal);
      await pumpTestOutput(Bun.file(paths[index]!).stream(), sink, { lastLine: null, lastFile: null }, abort.signal);
    }
    return { outputTruncated: false, stopReason: null };
  } catch {
    return { outputTruncated: true, stopReason: 'Owner-log replay failed or did not drain before the shared absolute deadline' };
  } finally {
    clearTimeout(timer);
    for (const name of signals) process.off(name, onInterrupt);
    signal?.removeEventListener('abort', onInterrupt);
  }
}

/** Resolve every child selection inside the single workspace/build lease. */
export async function runTests(resolvePlans: () => readonly (readonly string[])[] = () => [resolveTestArgs()], projectTmpParent?: string): Promise<void> {
  const expectedParentPid = process.ppid;
  await withWorkspaceLock('test', async () => {
    const plans = resolvePlans();
    if (plans.length === 0 || plans.some(plan => plan.length === 0)) throw new Error('Test child plans must be nonempty');
    sweepStaleTmpDirs(TEST_TMP_ROOT, RUN_TMP_PREFIX, STALE_RUN_MS);
    if (projectTmpParent) {
      mkdirSync(projectTmpParent, { recursive: true });
      sweepStaleTmpDirs(projectTmpParent, RUN_TMP_PREFIX, STALE_RUN_MS);
    }
    await withRunTmpDir(TEST_TMP_ROOT, async (runTmpDir) => {
      const interrupted = new AbortController();
      const onInterrupt = () => interrupted.abort(new Error('The shared test runner was interrupted'));
      const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
      for (const name of signals) process.on(name, onInterrupt);
      try {
        const configuredCeiling = Number(process.env.GOODVIBES_TEST_CEILING_MS);
        const ceilingMs = Number.isFinite(configuredCeiling) && configuredCeiling > 0
          ? Math.min(720_000, Math.floor(configuredCeiling)) : 720_000;
        const deadlineAt = Date.now() + ceilingMs;
        const runPlan = async (testArgs: readonly string[], index: number) => {
          const timeoutArgs = hasExplicitTimeout(testArgs) ? [] : [`--timeout=${resolveTimeoutMs()}`];
          const output = plans.length > 1 ? createWriteStream(join(runTmpDir, `owner-${index + 1}.log`)) : undefined;
          try {
            const execute = (projectTmpRoot?: string) => {
              if (interrupted.signal.aborted) throw new Error('Test dispatch was interrupted before this child could start');
              return runOwnedTestChild({
                ownProcessGroup: process.platform !== 'win32',
                expectedParentPid,
                ...(output ? { deadlineAt, stdout: output, stderr: output } : {}),
                argv: [...timeoutArgs, ...testArgs],
                cwd: SDK_ROOT,
                ...(projectTmpRoot ? { fixtureEnv: { GOODVIBES_TEST_PROJECT_TMP_ROOT: projectTmpRoot } } : {}),
                env: {
                  ...process.env,
                  ...testTmpEnv(runTmpDir),
                  // Keep the runner flag independent of the temporary environment.
                  [RUNNER_ENV_FLAG]: '1',
                },
              });
            };
            return projectTmpParent ? await withRunTmpDir(projectTmpParent, async projectRoot => {
              try { return await execute(projectRoot); }
              catch (error) { retainRunTmpDir(projectRoot, 'Owned test lifecycle did not establish complete child settlement'); throw error; }
            }) : await execute();
          } finally {
            if (output) { output.end(); await finished(output); }
          }
        };
        const results = await Promise.allSettled(plans.map(runPlan));
        let replay: { outputTruncated: boolean; stopReason: string | null } = { outputTruncated: false, stopReason: null };
        if (plans.length > 1) {
          replay = await replayTestOwnerLogs(plans.map((_, index) => join(runTmpDir, `owner-${index + 1}.log`)), deadlineAt, process.stdout, interrupted.signal);
          const failed = replay.outputTruncated || interrupted.signal.aborted || results.some(result => result.status === 'rejected'
            || result.value.exitCode !== 0 || result.value.stopped !== null || result.value.outputTruncated);
          writeFileSync(join(runTmpDir, 'owner-results.json'), JSON.stringify({ plans, deadlineAt, replay, results: results.map(result => result.status === 'fulfilled'
            ? result : { status: 'rejected', reason: 'Owned child lifecycle failed before settlement could be established' }) }, null, 2) + '\n');
          if (failed) {
            retainRunTmpDir(runTmpDir, 'Complete owner logs and failure/output-truncation manifest');
            process.stderr.write(`goodvibes: test owner evidence retained at ${runTmpDir}\n`);
          }
        }
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
          const { exitCode, signalCode, stopped, stopReason, outputTruncated } = result.value;
          if (stopped !== null) throw new Error(`bun test ended by the ${stopped} ceiling: ${stopReason ?? 'no reason recorded'}`);
          if (outputTruncated) throw new Error('bun test output did not completely drain');
          if (exitCode !== 0) throw new Error(`bun test ${signalCode ? `killed by ${signalCode}` : `exited with code ${exitCode}`}`);
        }
        if (replay.outputTruncated) throw new Error(`bun test outputTruncated: ${replay.stopReason}`);
        if (interrupted.signal.aborted) throw new Error('bun test was interrupted');
      } finally { for (const name of signals) process.off(name, onInterrupt); }
    }, RUN_TMP_DIR_NAME);
  });
}

if (import.meta.main) await runTests();
