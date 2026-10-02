/**
 * Run `bun test` as a child the calling script owns for its whole life.
 *
 * Shared by both direct-`bun test` entry points, `scripts/test.ts` and
 * `scripts/leak-scan.ts`, for the same reason they share `withRunTmpDir`:
 * this is one lifecycle, and a second copy of it is a second thing to forget.
 *
 * Both used to spawn synchronously (`execFileSync` / `spawnSync`). A
 * synchronous wait parks the parent inside a native call where no JavaScript
 * runs, so a signal handler cannot fire and the child is never told anything
 * when the parent is killed, a CI job timeout, a cancelled run, Ctrl-C. The
 * CI job that this module was written for ended with the runner's post-job
 * step reporting `Terminate orphan process: pid (2410) (bun)` and
 * `pid (2421) (bun)`: the runner script and its test child, both still alive
 * after the step that started them was gone.
 *
 * Owning the child means both halves:
 *   - a termination signal the parent receives is relayed to the child, and
 *   - the child is killed and reaped in a `finally`, on every path out of this
 *     function, including one where the caller's own cleanup throws.
 *
 * The temp-directory containment in `scripts/test-run-tmp.ts` does the
 * equivalent for directories. It does not and cannot do it for processes: it
 * never had a handle on one.
 *
 * ## What the relay could not cover, and what covers it now
 *
 * The relay above is correct whenever a signal is delivered. A GitHub Actions
 * job timeout does not deliver one: it kills the step's SHELL, so this parent
 * is reparented and keeps waiting, and the child keeps running underneath it.
 * That is why the orphan sweep still reported two live `bun` processes on a
 * later run of the same job, after the relay had already shipped. Three
 * additions close it, and none of them replaces the relay:
 *
 *   - a PARENT-DEATH WATCHDOG here: this process polls its own parent and gives
 *     up when it is gone, so a killed shell takes the runner with it;
 *   - the same watchdog inside the child (`scripts/test-child-watchdog.ts`),
 *     so a SIGKILLed runner, which can relay nothing, by definition, takes
 *     the suite with it;
 *   - a STALL CEILING and an overall CEILING, below, so a run that stops making
 *     progress says so, by name, instead of buying fifteen minutes of silence
 *     and then being killed by something that can only report a timeout.
 *
 * ## Why a stall is measured in tests started, not in output
 *
 * The wedge that motivated the ceiling produced NO output at all: bun's module
 * loader deadlocked between two test files, where no per-test timeout applies.
 * Output is not a liveness signal either way, a fully green local run prints
 * almost nothing for three minutes, so the child reports each test it starts
 * through a heartbeat file, and silence in THAT is what a stall means. The
 * child's last line of output is still captured, because in CI it is the name
 * of the file bun was working on, which is the first thing anyone reading the
 * failure wants.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

// From the env-names module, never from the watchdog itself: that one imports
// `bun:test` and registers a global `beforeEach`, and this runs in the PARENT.
import { HEARTBEAT_PATH_ENV, PARENT_PID_ENV } from './test-child-watchdog-env.ts';
import { sweepStaleTmpDirs } from './stale-tmp-sweep.ts';
import { isolatedTestEnvironment, NETWORK_VIOLATIONS_ENV } from './test-isolation.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD_WATCHDOG = resolve(__dirname, 'test-child-watchdog.ts');
const NETWORK_PRELOAD = resolve(__dirname, 'test-network-preload.ts');

/**
 * How long a run may go without a single test STARTING before this module ends
 * it and says so.
 *
 * A ceiling, not a budget: nothing waits it out, and a healthy run never
 * approaches it. Three minutes is comfortably longer than the slowest gap a
 * green run produces (the daemon-backed spine files take tens of seconds each,
 * on a loaded host) and comfortably shorter than the 15-minute CI job timeout,
 * which is the thing it has to beat. Override with `GOODVIBES_TEST_STALL_MS`;
 * set it to 0 to turn the stall ceiling off entirely.
 */
const DEFAULT_STALL_MS = 180_000;

/**
 * The whole run's ceiling, whatever it is doing.
 *
 * Twelve minutes, deliberately under the 15-minute job timeout so that a run
 * which overruns is ended HERE, with the last file bun named and the number of
 * tests it had started, rather than by a runner that can only report that the
 * operation was cancelled. Override with `GOODVIBES_TEST_CEILING_MS`; set it to
 * 0 for no overall ceiling.
 */
const DEFAULT_CEILING_MS = 720_000;

/** SGR colour sequences, stripped before a captured line is quoted back. */
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

/** How often the ceilings and the parent are checked. */
const POLL_MS = 1_000;

/**
 * How long a child gets to exit on SIGTERM before it is SIGKILLed.
 *
 * A ceiling that asks politely and then waits forever is not a ceiling. A test
 * file only has to install a SIGTERM handler, deliberately, or as part of
 * exercising some shutdown path, for the polite request to be ignored, and
 * this module would then be parked on `child.exited` reproducing the exact
 * silence it exists to end. Five seconds is enough for an honest shutdown.
 */
const KILL_GRACE_MS = 5_000;

/** Additional bounded drain time after the direct child has exited. */
const OUTPUT_DRAIN_GRACE_MS = 5_000;

/**
 * The heartbeat file lives under the REAL system temp dir, in a directory named
 * for this tool, and every run sweeps its own stale siblings before creating
 * one.
 *
 * It cannot live in the run temp tree: `scripts/test.ts` points the CHILD's
 * `tmpdir()` at that tree, and this file is written by the child and read by
 * the parent, which does not share it. So it gets the same treatment every
 * other direct-`os.tmpdir()` user in this repo gets, a signal kill skips the
 * `finally` that would have removed it, exactly as it skips an `afterAll`, and
 * an unreclaimed per-run directory is an inode leak on a tmpfs.
 *
 * An hour is far longer than any run, so a sibling that is genuinely still
 * going is never touched.
 */
const HEARTBEAT_PREFIX = 'goodvibes-test-heartbeat-';
const STALE_HEARTBEAT_MS = 60 * 60 * 1000;

/** Why this module ended a run itself, when it did. */
export type OwnedTestChildStop = 'stalled' | 'ceiling' | 'parent-died' | 'interrupted' | 'output-drain';

export interface OwnedTestChildResult {
  /** The child's exit code, or null when a signal ended it. */
  readonly exitCode: number | null;
  /** The signal that ended the child, if one did. */
  readonly signalCode: string | null;
  /** Set when this module ended the run rather than the child finishing. */
  readonly stopped: OwnedTestChildStop | null;
  /** A sentence naming what the run was doing when it was ended. */
  readonly stopReason: string | null;
  /** True only when undeliverable output was explicitly abandoned after its grace. */
  readonly outputTruncated: boolean;
}

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function perCallMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** `{ at, started }` from the child's heartbeat, or null before the first one. */
function readHeartbeat(path: string): { at: number; started: number } | null {
  try {
    const [at, started] = readFileSync(path, 'utf8').trim().split(/\s+/);
    const atMs = Number(at);
    if (!Number.isFinite(atMs)) return null;
    return { at: atMs, started: Number(started) || 0 };
  } catch {
    return null;
  }
}

function describeSeconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * Stream a child pipe to this process's own, remembering enough of it to name
 * what the run was doing if it has to be ended.
 */
export async function pumpTestOutput(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: Writable,
  seen: { lastLine: string | null; lastFile: string | null },
  signal?: AbortSignal,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let pending = '';
  let sourceEnded = false;
  let onSinkError!: (error: Error) => void;
  const sinkFailed = new Promise<never>((_resolve, reject) => { onSinkError = reject; });
  const onAbort = (): void => onSinkError(signal?.reason instanceof Error ? signal.reason : new Error('test output drain aborted'));
  sink.on('error', onSinkError);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (true) {
      // An error can arrive while either the source or the sink is idle. Race
      // both waits so a destroyed sink cannot leave the runner parked forever.
      const { done, value: chunk } = await Promise.race([reader.read(), sinkFailed]);
      if (done) { sourceEnded = true; break; }
      // Pipe exhaustion is not downstream delivery: throwing on a failed child
      // can otherwise discard the final buffered diagnostics in this process.
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          sink.write(chunk, (error) => error ? reject(error) : resolve());
        }),
        sinkFailed,
      ]);
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.replace(ANSI_SGR, '').trim();
        if (text === '') continue;
        seen.lastLine = text;
        // bun opens each file with a header, before loading it. Keep that
        // context available to the existing stall and overall ceilings.
        const header = /^(?:::group::)?([\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(text);
        if (header) seen.lastFile = header[1] as string;
      }
    }
  } finally {
    const cancellation = reader.cancel().catch(() => undefined);
    // An abort/failure must not wait forever for an underlying cancel hook.
    // Request cancellation and release the lock; the owning runner still stops
    // and reaps its child. A normally exhausted source has already reached EOF.
    if (sourceEnded) await cancellation;
    reader.releaseLock();
    sink.off('error', onSinkError);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function runOwnedTestChild(options: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  /** Deliberately supplied fixture values, after inherited credentials have been removed. */
  readonly fixtureEnv?: Readonly<Record<string, string | undefined>>;
  /** Per-call ceiling; cannot extend an enabled environment/default ceiling. */
  readonly ceilingMs?: number;
  /** Declared long-test allowance; an explicitly configured stall ceiling still wins. */
  readonly stallMs?: number;
  /** SIGTERM/interruption escalation grace; defaults to 5 seconds. */
  readonly killGraceMs?: number;
  /** Additional output-drain grace after child exit; defaults to 5 seconds. */
  readonly outputDrainGraceMs?: number;
  /** Caller-owned output sinks remain open after this run. */
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  /** Opt in to a dedicated POSIX group, including non-detached descendants. */
  readonly ownProcessGroup?: boolean;
  /** Preserve the owner captured before a worker is dispatched. */
  readonly expectedParentPid?: number;
}): Promise<OwnedTestChildResult> {
  const initialPpid = perCallMs('expectedParentPid', options.expectedParentPid, process.ppid);
  if (options.ownProcessGroup && process.platform === 'win32') throw new Error('ownProcessGroup requires POSIX process-group support');
  const ownProcessGroup = options.ownProcessGroup ?? false;
  const enclosingStallMs = positiveEnvMs('GOODVIBES_TEST_STALL_MS', DEFAULT_STALL_MS);
  const requestedStallMs = perCallMs('stallMs', options.stallMs, enclosingStallMs);
  const hasExplicitStall = Boolean(process.env.GOODVIBES_TEST_STALL_MS);
  const stallMs = hasExplicitStall && enclosingStallMs > 0 ? Math.min(requestedStallMs, enclosingStallMs) : requestedStallMs;
  const enclosingCeilingMs = positiveEnvMs('GOODVIBES_TEST_CEILING_MS', DEFAULT_CEILING_MS);
  const requestedCeilingMs = perCallMs('ceilingMs', options.ceilingMs, enclosingCeilingMs);
  const ceilingMs = enclosingCeilingMs > 0 ? Math.min(requestedCeilingMs, enclosingCeilingMs) : requestedCeilingMs;
  const ceilingSource = options.ceilingMs !== undefined && (enclosingCeilingMs <= 0 || requestedCeilingMs < enclosingCeilingMs)
    ? 'per-call file ceiling'
    : process.env.GOODVIBES_TEST_CEILING_MS ? 'GOODVIBES_TEST_CEILING_MS' : 'default overall ceiling';
  const stallSource = hasExplicitStall && enclosingStallMs > 0 && enclosingStallMs <= requestedStallMs
    ? 'GOODVIBES_TEST_STALL_MS'
    : options.stallMs !== undefined ? 'per-call declared-test stall allowance' : 'default stall ceiling';
  const killGraceMs = perCallMs('killGraceMs', options.killGraceMs, KILL_GRACE_MS);
  const outputDrainGraceMs = perCallMs('outputDrainGraceMs', options.outputDrainGraceMs, OUTPUT_DRAIN_GRACE_MS);
  for (const [name, value] of [['killGraceMs', killGraceMs], ['outputDrainGraceMs', outputDrainGraceMs]] as const) {
    if (value > 2_147_483_647) throw new Error(`${name} must not exceed 2147483647ms`);
  }
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  sweepStaleTmpDirs(tmpdir(), HEARTBEAT_PREFIX, STALE_HEARTBEAT_MS);
  const heartbeatDir = mkdtempSync(join(tmpdir(), HEARTBEAT_PREFIX));
  const heartbeatPath = join(heartbeatDir, 'progress');
  const violationsPath = join(heartbeatDir, 'network-violations');
  const startedAt = Date.now();

  const child = (() => {
    try {
      const childEnv = isolatedTestEnvironment(options.env, join(heartbeatDir, 'isolated'), options.fixtureEnv);
      return Bun.spawn(['bun', '--no-env-file', 'test', '--preload', NETWORK_PRELOAD, '--preload', CHILD_WATCHDOG, ...options.argv], {
        cwd: options.cwd,
        detached: ownProcessGroup,
        stdin: 'inherit',
        // Piped rather than inherited, so this process can see what the suite last
        // said and quote it back if it has to end the run. Every byte is written
        // straight through unchanged; the capture is a copy, not a filter.
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          // A pipe costs the child its colour, because bun colours for a terminal
          // and there is no longer one on the other end. Handing it FORCE_COLOR
          // back when THIS process has a terminal keeps an interactive run looking
          // exactly as it did, and leaves a CI log, which never had one, alone.
          ...(process.stdout.isTTY && options.env.FORCE_COLOR === undefined
            ? { FORCE_COLOR: '1' }
            : {}),
          ...childEnv,
          [NETWORK_VIOLATIONS_ENV]: violationsPath,
          [PARENT_PID_ENV]: String(process.pid),
          [HEARTBEAT_PATH_ENV]: heartbeatPath,
        },
      });
    } catch (error) {
      rmSync(heartbeatDir, { recursive: true, force: true });
      throw error;
    }
  })();

  const relay = (signal: NodeJS.Signals) => (): void => {
    stop('interrupted', `test runner received ${signal}; ending its owned suite`, signal);
  };
  const onInterrupt = relay('SIGINT');
  const onTerminate = relay('SIGTERM');
  const onHangup = relay('SIGHUP');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.on('SIGHUP', onHangup);

  const seen: { lastLine: string | null; lastFile: string | null } = { lastLine: null, lastFile: null };
  const outputAbort = new AbortController();
  let outputAbortReason: Error | null = null;
  let stopped: OwnedTestChildStop | null = null;
  let stopReason: string | null = null;
  let outputTruncated = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let childHasExited = false;
  let groupTeardown: Promise<void> | null = null;
  let signallingError: unknown;
  let rejectSignalling!: (error: unknown) => void;
  const signallingFailed = new Promise<never>((_resolve, reject) => { rejectSignalling = reject; });
  const diagnostics: Promise<void>[] = [];
  const report = (message: string): Promise<void> => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(message));
      controller.close();
    } });
    const written = pumpTestOutput(stream, stderr, { lastLine: null, lastFile: null }, outputAbort.signal);
    diagnostics.push(written);
    // The run awaits all diagnostic writes below; a callback may finish before
    // that await is reached, so retain the failure without an unhandled rejection.
    void written.catch(() => undefined);
    return written;
  };
  const pumps = [
    pumpTestOutput(child.stdout as ReadableStream<Uint8Array> | undefined, stdout, seen, outputAbort.signal),
    pumpTestOutput(child.stderr as ReadableStream<Uint8Array> | undefined, stderr, seen, outputAbort.signal),
  ];
  const ignoreOwnedAbort = (error: unknown): void => {
    if (error !== outputAbortReason) throw error;
  };
  const outputDone = Promise.all(pumps).catch(ignoreOwnedAbort);

  const signalOwned = (signal: NodeJS.Signals): void => {
    try {
      if (ownProcessGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) { signallingError ??= error; rejectSignalling(error); }
    }
  };
  const groupExists = (): boolean => {
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) { signallingError ??= error; rejectSignalling(error); }
      return false;
    }
  };
  const beginGroupTeardown = (signal: NodeJS.Signals): Promise<void> => {
    if (groupTeardown) return groupTeardown;
    signalOwned(signal);
    groupTeardown = (async () => {
      const deadline = Date.now() + killGraceMs;
      while (groupExists()) {
        if (Date.now() >= deadline) {
          void report(`goodvibes: the owned process group still exists ${killGraceMs}ms after ${signal}; sending SIGKILL\n`);
          signalOwned('SIGKILL');
          return;
        }
        await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    })();
    return groupTeardown;
  };
  const childExited = child.exited.then(async (exitCode) => {
    childHasExited = true;
    if (escalation !== null) clearTimeout(escalation);
    // Teardown is independent of EOF: descendants may close/ignore stdio and
    // still need their declared grace. Never signal an inherited process group.
    if (ownProcessGroup) await beginGroupTeardown('SIGTERM');
    drainTimer = setTimeout(() => {
      outputTruncated = true;
      stopped ??= 'output-drain';
      const reason = `test output was truncated: drain did not finish within ${outputDrainGraceMs}ms after child exit${ownProcessGroup ? ' and owned-group teardown' : ''}`;
      stopReason = stopReason ? `${stopReason}; ${reason}` : reason;
      outputAbortReason = new Error(reason);
      outputAbort.abort(outputAbortReason);
    }, outputDrainGraceMs);
    return exitCode;
  });
  const stop = (kind: OwnedTestChildStop, reason: string, signal: NodeJS.Signals = 'SIGTERM'): void => {
    if (stopped !== null || childHasExited) return;
    stopped = kind;
    stopReason = reason;
    void report(`\ngoodvibes: ${reason}\n`);
    if (ownProcessGroup) { void beginGroupTeardown(signal); return; }
    signalOwned(signal);
    escalation = setTimeout(() => {
      void report(`goodvibes: the suite did not exit ${killGraceMs}ms after ${signal}; killing it\n`);
      signalOwned('SIGKILL');
    }, killGraceMs);
    escalation.unref?.();
  };

  const watchdog = setInterval(() => {
    if (childHasExited) return;
    const now = Date.now();
    const beat = readHeartbeat(heartbeatPath);
    const progress = beat === null
      ? 'no test has started yet'
      : `${beat.started} tests started, the last of them ${describeSeconds(now - beat.at)} ago`;
    const where = seen.lastFile !== null
      ? `the last file bun named was ${seen.lastFile}`
      : seen.lastLine !== null
        ? `the last line it printed was ${JSON.stringify(seen.lastLine.slice(0, 160))}`
        : 'it has printed nothing at all';

    if (process.ppid !== initialPpid) {
      stop(
        'parent-died',
        `the process that started this runner (pid ${initialPpid}) is gone, ending the suite `
        + `rather than outliving it (${progress}; ${where})`,
      );
      return;
    }
    const idleSince = beat?.at ?? startedAt;
    if (stallMs > 0 && now - idleSince >= stallMs) {
      stop(
        'stalled',
        `no test has started for ${describeSeconds(now - idleSince)} `
        + `(ceiling ${describeSeconds(stallMs)}, ${stallSource}), ${progress}; ${where}. `
        + `A suite that stops starting tests is stuck, not slow; ending it here so the reason is `
        + `on the record instead of a job timeout fifteen minutes from now.`,
      );
      return;
    }
    if (ceilingMs > 0 && now - startedAt >= ceilingMs) {
      stop(
        'ceiling',
        `the suite has run for ${describeSeconds(now - startedAt)}, past its ceiling of `
        + `${describeSeconds(ceilingMs)} (${ceilingSource}), ${progress}; ${where}`,
      );
    }
  }, POLL_MS);

  try {
    // A broken output sink is a failed run too. Observe it while the child is
    // alive, so finally can stop and reap the child rather than leave it blocked.
    let [exitCode] = await Promise.race([Promise.all([childExited, outputDone]), signallingFailed]);
    // Every source of diagnostics has now quiesced: child/group teardown is
    // complete, and stop() ignores a reaped child. Do not snapshot the result
    // until late watchdog and teardown reports have also drained.
    clearInterval(watchdog);
    if (escalation !== null) clearTimeout(escalation);
    await Promise.all(diagnostics).catch(ignoreOwnedAbort);
    let violations = '';
    try { violations = readFileSync(violationsPath, 'utf8'); } catch { /* no blocked requests */ }
    if (violations.length > 0) {
      await report(`\ngoodvibes: unexpected external test I/O was blocked:\n${violations}`).catch(ignoreOwnedAbort);
      if (exitCode === 0) exitCode = 1;
    }
    if (outputTruncated && exitCode === 0) exitCode = 1;
    return { exitCode, signalCode: child.signalCode, stopped, stopReason, outputTruncated };
  } finally {
    if (ownProcessGroup) await beginGroupTeardown('SIGTERM');
    signalOwned('SIGKILL');
    // Reaped, not merely signalled: returning while the child is still dying
    // would let the caller's temp-tree removal race its last writes.
    await childExited.catch(() => undefined);
    await Promise.allSettled([...pumps, ...diagnostics]);
    // Keep the existing ceilings alive until both child and pipes are done.
    clearInterval(watchdog);
    if (escalation !== null) clearTimeout(escalation);
    if (drainTimer !== null) clearTimeout(drainTimer);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('SIGHUP', onHangup);
    rmSync(heartbeatDir, { recursive: true, force: true });
    if (signallingError !== undefined) throw signallingError;
  }
}
