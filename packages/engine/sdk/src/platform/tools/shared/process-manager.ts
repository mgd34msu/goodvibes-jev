import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import { resolveCredentialEnvScrub, scrubCredentialEnv, type ResolvedCredentialEnvScrub } from '../exec/credential-env.js';

/**
 * ProcessManager, tracks background processes for a single GoodVibes runtime.
 *
 * Extracted from tools/exec/index.ts so that other modules (UI, agent system,
 * live-tail) can query running processes without importing the exec tool.
 */

// ─── BackgroundProcess interface ──────────────────────────────────────────────

export interface BackgroundProcess {
  id: string;
  pid: number;
  cmd: string;
  startTime: number;
  /**
   * Output chunks collected so far. Appended AS THE PROCESS RUNS, not only at
   * exit, so `bg_output` on a still-running process returns what it has printed
   * up to now. This is also what supplies the output tail an on-exit trigger
   * payload carries.
   */
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  done: boolean;
  /**
   * Timestamp (ms since epoch) when SIGKILL was scheduled for termination.
   * Null if the process completed normally or SIGKILL was never scheduled.
   */
  killDeadline: number | null;
  completedAt?: number | undefined;
  /** POSIX signal name that terminated the process, or null if it exited. */
  signal?: string | null | undefined;
  /** True when the watchdog terminated the process at its timeout. */
  timedOut?: boolean | undefined;
}

const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
/**
 * How long to keep draining stdout/stderr AFTER the spawned process has exited.
 *
 * The pipe's write end is inherited by every descendant, so it reaches EOF only
 * once the LAST holder closes it. A command that leaves a child behind, which
 * is any `/bin/sh -c` whose shell did not exec-optimize into a single command,
 * keeps that write end open after the process we spawned is gone, and after a
 * timeout kill that reached only the shell. Waiting for EOF in that case means
 * waiting for the survivor, so the process is never reported finished at all.
 *
 * Exit is therefore what completes a process; this is only the window in which
 * output already in flight is still collected. Normal exits close their pipes
 * at once and never approach it, and output a process wrote before exiting is
 * already in the pipe buffer, so draining it costs microseconds, this bound
 * only decides how long a process whose pipe a survivor holds is delayed
 * before it is reported finished.
 */
const OUTPUT_DRAIN_GRACE_MS = 500;
const MAX_COMPLETED_PROCESSES = 100;
const COMPLETED_PROCESS_TTL_MS = 30 * 60 * 1000;

/** An admission check cannot promise to authorize a process after it exists. */
function assertSynchronousAdmission(check: (() => void) | undefined): void {
  const result: unknown = check?.();
  if (result === undefined) return;
  try { void Promise.resolve(result).catch(() => {}); } catch { /* Refuse below. */ }
  throw new Error('Process admission currentness must be synchronous and return void');
}

// ─── SpawnOptions ─────────────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Trusted per-invocation guard after all asynchronous preparation. */
  beforeSpawn?: (() => void) | undefined;
  /** Cancel admission, including pending credential resolution. Once spawned,
   * the process keeps its declared lifetime; this signal never kills it. */
  signal?: AbortSignal | undefined;
  /** Captured admission authority, rechecked after async preparation and immediately
   * before spawning. Never called to govern an already-running child. */
  assertCurrent?: (() => void) | undefined;
  /** Abort the process if it hasn't completed within this many ms. Default: 60000. */
  timeout_ms?: number | undefined;
  /** Grace period (ms) between SIGTERM and SIGKILL during termination. Default: 5000. */
  sigterm_grace_ms?: number | undefined;
  /**
   * Whether the timeout watchdog may terminate the process. Default: true.
   *
   * Set false for a process whose lifetime is not the caller's to end, a
   * browser, an editor, a long-running server. `timeout_ms` then bounds only
   * how long a caller waits, and the process keeps running until it is stopped
   * explicitly. Killing such a process on a routine timeout destroys a
   * user-facing application as the default outcome of a normal parameter.
   */
  kill_on_timeout?: boolean | undefined;
  /**
   * End this child when its runtime closes. Defaults to kill_on_timeout (true
   * when omitted), preserving separately owned browser/editor/server lifetimes.
   * Owned POSIX jobs also terminate residual same-group descendants when their
   * leader exits, before reporting done. Opt out for independently owned jobs.
   * Explicit stop still terminates and reaps a child regardless of this setting.
   * Windows owns only direct handles; descendants escaping the group are outside
   * this boundary on every platform.
   */
  kill_on_close?: boolean | undefined;
  /**
   * Credential-bearing env-var scrub applied to the inherited base environment
   * before spawning. Defaults to enabled with an empty allowlist, so a
   * background process is protected even when a caller does not thread config.
   */
  credentialEnvScrub?: ResolvedCredentialEnvScrub | undefined;
  /**
   * Child stdin. Defaults to 'ignore' (closed): a background process has
   * nobody at the keyboard, so a prompt must EOF rather than hang.
   */
  stdin?: 'ignore' | 'pipe' | undefined;
}

// ─── ExecCommandResult subset (for command handler return values) ─────────────

export interface BgCommandResult {
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  process_id?: string | undefined;
  pid?: number | undefined;
}

/** Trusted adapter for an execution boundary which owns its own child/IO.
 * Raw output stays behind its asynchronous authority check, never in sync reads.
 */
export interface OwnedBoundaryExecution {
  readonly owner: object;
  readonly cmd: string;
  readonly includeReadyOutput?: boolean | undefined;
  readonly started: Promise<{ readonly pid: number }>;
  readonly completion: Promise<BgCommandResult & { readonly timed_out?: boolean | undefined; readonly cancelled?: boolean | undefined }>;
  readonly readOutput: () => Promise<BgCommandResult & { readonly denied?: boolean | undefined; readonly cancelled?: boolean | undefined; readonly timed_out?: boolean | undefined }>;
  readonly stop: () => Promise<void>;
}

interface ManagedProcessShutdown {
  readonly killOnClose: boolean;
  stopRequested: boolean;
  stop(): Promise<void>;
  detach(): void;
}

// ─── ProcessManager ───────────────────────────────────────────────────────────

export class ProcessManager {
  private _counter = 0;
  private readonly _boundaryExecutions = new Map<string, OwnedBoundaryExecution>();
  private _processes = new Map<string, BackgroundProcess>();
  private readonly _shutdowns = new Map<string, ManagedProcessShutdown>();
  private readonly _launches = new Set<Promise<BgCommandResult>>();
  private _closed = false;
  private _closing: Promise<void> | undefined;

  // ─── Private helpers ────────────────────────────────────────────────────────

  private newId(): string {
    // Handles are opaque. Encode generated decimal digits injectively so a
    // timestamp cannot resemble card material at the unchanged privacy floor.
    return `bg_${++this._counter}_${Date.now()}`.replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit)));
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Spawn a background process and start collecting its output.
   *
   * @param cmd  Shell command to run via /bin/sh -c.
   * @param cwd  Working directory (undefined = inherit).
   * @param env  Extra env vars merged with the current process env.
   * @param opts Timeout and SIGKILL grace configuration.
   *
   * @returns A BgCommandResult with the process_id and pid, or rejects if
   *          the binary is missing (ENOENT) or exec permission is denied (EACCES).
   */
  async spawn(
    cmd: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    return this.launch(['/bin/sh', '-c', cmd], cmd, cwd, env, opts);
  }

  /**
   * Spawn a background process from argv, with NO shell in between.
   *
   * Same tracking, credential-env scrub, live output collection and timeout
   * watchdog as `spawn`, the only difference is that nothing is handed to
   * /bin/sh, so no argument can be reinterpreted as a shell metacharacter.
   * On-exit triggers use this: their command is pre-registered and
   * digest-pinned, and keeping it argv-shaped means the pin covers exactly
   * what runs.
   */
  async spawnArgv(
    command: string,
    args: readonly string[],
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    return this.launch([command, ...args], [command, ...args].join(' '), cwd, env, opts);
  }

  private launch(
    argv: readonly string[], cmd: string, cwd: string | undefined,
    env: Record<string, string> | undefined, opts?: SpawnOptions,
  ): Promise<BgCommandResult> {
    if (this._closed) return Promise.reject(new Error('ProcessManager is closed'));
    const signal = opts?.signal;
    const assertCurrent = opts?.assertCurrent;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<BgCommandResult>((resolve, reject) => {
      let spawned = false;
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        action();
      };
      const onAbort = (): void => { if (!spawned) finish(() => reject(signal?.reason)); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      const launch = this.launchProcess(argv, cmd, cwd, env, opts, signal, assertCurrent, () => {
        spawned = true;
        signal?.removeEventListener('abort', onAbort);
      });
      // Retain the underlying admission until shared credential reads settle,
      // even if its caller cancelled. close() still drains this work.
      this._launches.add(launch);
      void launch.then(
        (result) => { this._launches.delete(launch); finish(() => resolve(result)); },
        (error: unknown) => { this._launches.delete(launch); finish(() => reject(error)); },
      );
    });
  }

  /**
   * Stop admission, terminate/reap owned children and drain output. Previously
   * admitted credential resolutions drain concurrently; shared reads are not
   * cancelled, and close does not resolve before they settle.
   */
  close(): Promise<void> {
    if (this._closing) return this._closing;
    this._closed = true;
    this._closing = Promise.resolve().then(async () => {
      // No launch may spawn after the closed check, so drain its credential
      // resolution concurrently instead of delaying existing-child termination.
      const launches = Promise.allSettled(this._launches);
      const results = await Promise.allSettled([...this._shutdowns.values()].map((owner) => {
        if (owner.killOnClose || owner.stopRequested) return owner.stop();
        // Keep reading output and observing exit for the external owner:
        // closing its pipes could SIGPIPE a child whose lifetime we do not own.
        owner.detach();
        return Promise.resolve();
      }));
      await launches;
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Background process shutdown failed');
    });
    return this._closing;
  }

  private async launchProcess(
    argv: readonly string[],
    cmd: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    opts?: SpawnOptions,
    admissionSignal?: AbortSignal,
    assertAdmissionCurrent?: () => void,
    onSpawned?: () => void,
  ): Promise<BgCommandResult> {
    admissionSignal?.throwIfAborted(); assertSynchronousAdmission(assertAdmissionCurrent);
    admissionSignal?.throwIfAborted();
    const timeoutMs = opts?.timeout_ms ?? 60_000;
    const sigtermGraceMs = opts?.sigterm_grace_ms ?? 5_000;
    assertTimerRange('timeout_ms', timeoutMs);
    assertTimerRange('sigterm_grace_ms', sigtermGraceMs);
    const killOnTimeout = opts?.kill_on_timeout ?? true;
    const killOnClose = opts?.kill_on_close ?? killOnTimeout;
    // Only runtime-owned commands receive an isolated POSIX session/group.
    // Never send a group signal for a borrowed lifetime or the caller's group.
    const ownsGroup = killOnClose && process.platform !== 'win32';

    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    // Scrub credential-bearing vars out of the inherited base env before merging
    // the caller-supplied env (an explicit opt-in) on top. Without this, the
    // background spawn would re-introduce every secret from process.env that the
    // foreground scrub already removed.
    const scrub = opts?.credentialEnvScrub ?? resolveCredentialEnvScrub();
    assertSynchronousAdmission(assertAdmissionCurrent); admissionSignal?.throwIfAborted();
    const scrubbedBase = (await scrubCredentialEnv(cleanEnv, scrub)).env;
    assertSynchronousAdmission(assertAdmissionCurrent);
    if (this._closed) throw new Error('ProcessManager is closed');
    admissionSignal?.throwIfAborted();
    const mergedEnv = { ...scrubbedBase, ...env };

    const id = this.newId();
    const entry: BackgroundProcess = {
      id,
      pid: 0,
      cmd,
      startTime: Date.now(),
      stdout: [],
      stderr: [],
      exitCode: null,
      done: false,
      killDeadline: null,
    };
    this.pruneCompletedProcesses();
    this._processes.set(id, entry);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      const spawnArgv = [...argv];
      const spawnOptions = {
        ...(cwd !== undefined ? { cwd } : {}),
        env: mergedEnv,
        detached: ownsGroup,
        // Closed by default. An unattended command that stops to ask for a
        // password gets EOF and fails instead of blocking forever.
        stdin: opts?.stdin ?? 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      } as Parameters<typeof Bun.spawn>[1];
      // Caller-owned env/options can have accessors. Recheck after reading
      // them, at the final boundary before an actual process is created.
      assertSynchronousAdmission(assertAdmissionCurrent);
      if (this._closed) throw new Error('ProcessManager is closed');
      admissionSignal?.throwIfAborted();
      assertSynchronousAdmission(opts?.beforeSpawn);
      // The one-shot claim can synchronously revoke or close its owner. Repeat
      // only currentness, then finish on owned state immediately before spawn.
      assertSynchronousAdmission(assertAdmissionCurrent);
      if (this._closed) throw new Error('ProcessManager is closed');
      admissionSignal?.throwIfAborted();
      proc = Bun.spawn(spawnArgv, spawnOptions);
      onSpawned?.();
    } catch (spawnErr: unknown) {
      // Surface ENOENT / EACCES immediately, callers should not retry these
      this._processes.delete(id);
      throw spawnErr;
    }

    entry.pid = proc.pid;

    // Async collection with timeout escalation, SIGTERM then SIGKILL
    // Cast stdout/stderr to ReadableStream, Bun guarantees these are ReadableStream
    // when stdout/stderr is set to 'pipe', but the return type is a union.
    const drain = new AbortController();
    const streams = Promise.all([
      readProcessStream(proc.stdout as ReadableStream<Uint8Array>, entry.stdout, drain.signal),
      readProcessStream(proc.stderr as ReadableStream<Uint8Array>, entry.stderr, drain.signal),
    ]).catch((error: unknown) => {
      // A cancelled or broken pipe ends collection early; the exit code still
      // decides the outcome, so this is reported rather than thrown.
      logger.debug('Background process output collection ended early', {
        processId: id,
        error: summarizeError(error),
      });
    });
    let groupStopping: Promise<void> | undefined;
    const stopOwnedGroup = (): Promise<void> => {
      if (!groupStopping) {
        if (ownedGroupExists(proc.pid)) entry.killDeadline = Date.now() + sigtermGraceMs;
        groupStopping = terminateOwnedGroup(proc.pid, sigtermGraceMs);
      }
      return groupStopping;
    };
    const collectionPromise = (async () => {
      const exitCode = await proc.exited;
      // A runtime-owned job does not transfer its descendants when its shell
      // exits. Clean its fresh group now rather than caching a reusable PGID
      // until an arbitrarily later runtime close.
      if (ownsGroup) await stopOwnedGroup();
      // The process we spawned is gone. Collect whatever its pipes still hold,
      // but never block completion on them: a surviving descendant holds the
      // same write end, so EOF may never come. Cancelling the readers releases
      // them instead of leaving a task pending on a pipe nobody will close.
      await settleWithin(streams, OUTPUT_DRAIN_GRACE_MS);
      drain.abort();
      await streams;
      entry.exitCode = exitCode;
      // Bun reports the terminating signal on the handle; capture it so a
      // caller can tell "exited 1" from "killed by SIGKILL", which an on-exit
      // trigger payload has to distinguish.
      entry.signal = readSignalCode(proc);
      entry.done = true;
      entry.completedAt = Date.now();
      this.pruneCompletedProcesses();
    })();

    let stopping: Promise<void> | undefined;
    const owner: ManagedProcessShutdown = {
      killOnClose,
      stopRequested: false,
      stop: () => {
        if (stopping) return stopping;
        owner.stopRequested = true;
        clearTimeout(timeoutHandle);
        stopping = (async () => {
          if (ownsGroup) {
            await stopOwnedGroup();
          } else if (proc.exitCode === null) {
            killTrackedProcess(proc, 'SIGTERM', id);
            entry.killDeadline = Date.now() + sigtermGraceMs;
            await settleWithin(proc.exited, sigtermGraceMs);
            if (proc.exitCode === null) {
              logger.warn('Background process did not exit after SIGTERM, killing', { processId: id, pid: entry.pid, cmd, timeoutMs, signal: 'SIGKILL' });
              killTrackedProcess(proc, 'SIGKILL', id);
            }
          }
          await collectionPromise;
          this._shutdowns.delete(id);
        })();
        return stopping;
      },
      detach: () => { clearTimeout(timeoutHandle); },
    };
    this._shutdowns.set(id, owner);

    // Timeout opt-outs preserve externally owned lifetimes. Explicit stop and
    // runtime close share one termination sequence, including escalation/reap.
    const timeoutHandle = setTimeout(() => {
      if (entry.done) return;
      entry.timedOut = true;
      if (!killOnTimeout) {
        logger.info('Background process passed its timeout and was left running', { processId: id, pid: entry.pid, cmd, timeoutMs });
        return;
      }
      logger.warn('Background process timed out, terminating', { processId: id, pid: entry.pid, cmd, timeoutMs, signal: 'SIGTERM', sigtermGraceMs });
      void owner.stop().catch((error: unknown) => {
        logger.warn('Background process termination failed', { processId: id, error: summarizeError(error) });
      });
    }, timeoutMs);
    timeoutHandle.unref?.();

    // Reject the spawn promise if the process errors immediately (ENOENT/EACCES
    // on the child process level), the outer try/catch handles Bun.spawn throws;
    // this handles async failures surfaced via proc.exited rejecting.
    void collectionPromise.catch((error) => {
      logger.warn('Background process output collection failed', { processId: id, error: summarizeError(error) });
      clearTimeout(timeoutHandle);
      drain.abort();
      entry.done = !ownsGroup;
      if (entry.done) entry.completedAt = Date.now();
      this.pruneCompletedProcesses();
    });

    // Clear the timeout watchdog once the process completes naturally
    void collectionPromise
      .then(() => {
        clearTimeout(timeoutHandle);
        // Explicit termination may still be returning from its shared drain.
        if (!stopping) this._shutdowns.delete(id);
      })
      .catch((error) => {
        logger.debug('Background process timeout cleanup after failed collection', {
          processId: id,
          error: summarizeError(error),
        });
        clearTimeout(timeoutHandle);
        if (!ownsGroup) this._shutdowns.delete(id);
      });

    return {
      cmd,
      exit_code: null,
      stdout: '',
      stderr: '',
      success: true,
      process_id: id,
      pid: proc.pid,
    };
  }

  /** Adopt an already-contained owned execution without spawning a host process. */
  async trackOwnedBoundary(execution: OwnedBoundaryExecution): Promise<BgCommandResult> {
    if (this._closed) { await execution.stop(); throw new Error('ProcessManager is closed'); }
    const id = `bg_owned_${this.newId().slice(3)}`;
    const entry: BackgroundProcess = {
      id, pid: 0, cmd: execution.cmd, startTime: Date.now(), stdout: [], stderr: [],
      exitCode: null, done: false, killDeadline: null,
    };
    this._processes.set(id, entry);
    this._boundaryExecutions.set(id, execution);
    const shutdown: ManagedProcessShutdown = {
      killOnClose: true, stopRequested: false,
      stop: async () => {
        shutdown.stopRequested = true;
        try { await execution.stop(); await execution.completion; }
        finally { this._shutdowns.delete(id); }
      },
      detach: () => {}, // Boundary lifetimes are never detached from this runtime.
    };
    this._shutdowns.set(id, shutdown);
    void execution.completion.then((result) => {
      entry.exitCode = result.exit_code;
      entry.timedOut = result.timed_out;
      entry.signal = result.cancelled || result.timed_out || (result.exit_code === null && !result.success) ? 'SIGKILL' : null;
      entry.done = true;
      entry.completedAt = Date.now();
      this._shutdowns.delete(id);
      if (!this._processes.has(id)) this._boundaryExecutions.delete(id);
      this.pruneCompletedProcesses();
    }, () => {
      entry.exitCode = null; entry.signal = 'SIGKILL'; entry.done = true; entry.completedAt = Date.now();
      this._shutdowns.delete(id);
      if (!this._processes.has(id)) this._boundaryExecutions.delete(id);
      this.pruneCompletedProcesses();
    });
    const admission = (async (): Promise<BgCommandResult> => {
      try {
        const readiness = await Promise.race([
          execution.started.then((started) => ({ kind: 'started' as const, started })),
          execution.completion.then((completed) => ({ kind: 'completed' as const, completed })),
        ]);
        if (readiness.kind === 'started') entry.pid = readiness.started.pid;
        if (this._closed) throw new Error('ProcessManager is closed');
        const observed = await execution.readOutput();
        if (readiness.kind === 'completed') {
          this._processes.delete(id); this._boundaryExecutions.delete(id);
          return observed;
        }
        const started = readiness.started;
        if (observed.denied || observed.cancelled || observed.timed_out) {
          await shutdown.stop();
          this._processes.delete(id); this._boundaryExecutions.delete(id);
          return observed;
        }
        return { cmd: execution.cmd, exit_code: null, stdout: execution.includeReadyOutput ? observed.stdout : '', stderr: execution.includeReadyOutput ? observed.stderr : '', success: true, process_id: id, pid: started.pid };
      } catch (error) {
        try { await shutdown.stop(); }
        finally { this._processes.delete(id); this._boundaryExecutions.delete(id); }
        throw error;
      }
    })();
    this._launches.add(admission);
    try { return await admission; } finally { this._launches.delete(admission); }
  }

  /** Await only this authority's active executions before its result is judged. */
  async waitOwnedBoundaries(owner: object, signal?: AbortSignal): Promise<void> {
    while (true) {
      const active = [...this._boundaryExecutions].filter(([id, item]) => item.owner === owner && this._shutdowns.has(id));
      if (active.length === 0) return;
      await executePolicyCheck(() => Promise.all(active.map(([, item]) => item.completion)), signal);
    }
  }

  /** Cancel and reap only this authority before terminal events/view disposal. */
  async stopOwnedBoundaries(owner: object): Promise<void> {
    const active = [...this._boundaryExecutions].filter(([id, item]) => item.owner === owner && this._shutdowns.has(id));
    const results = await Promise.allSettled(active.map(([, item]) => item.stop()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Captured execution shutdown failed');
  }

  /** Authority-scoped bg_* access. Another captured caller cannot inspect/stop it. */
  async handleOwnedBoundaryCommand(cmd: string, owner: object): Promise<BgCommandResult | null> {
    this.pruneCompletedProcesses();
    const match = cmd.match(/^bg_(status|output|stop)\s+(\S+)$/);
    if (cmd.trim() === 'bg_list') {
      const ids = new Set([...this._boundaryExecutions].filter(([, item]) => item.owner === owner).map(([id]) => id));
      for (const id of ids) await this._boundaryExecutions.get(id)?.readOutput();
      return { cmd, exit_code: 0, stdout: JSON.stringify([...this._processes.values()].filter((entry) => ids.has(entry.id)).map((entry) => ({ id: entry.id, pid: entry.pid, cmd: entry.cmd, status: describeProcessStatus(entry), done: entry.done }))), stderr: '', success: true };
    }
    if (!match) return null;
    const id = match[2]!;
    const execution = this._boundaryExecutions.get(id);
    if (!execution || execution.owner !== owner || !this._processes.has(id))
      return { cmd, exit_code: 1, stdout: '', stderr: 'Unknown process in this execution authority', success: false };
    if (match[1] === 'stop') {
      await execution.stop();
      this._processes.delete(id); this._boundaryExecutions.delete(id);
      return { cmd, exit_code: 0, stdout: `Stopped ${id}`, stderr: '', success: true };
    }
    const output = await execution.readOutput();
    if (match[1] === 'output') return { ...output, cmd };
    const entry = this._processes.get(id);
    if (!entry) return { cmd, exit_code: 1, stdout: '', stderr: 'Unknown process in this execution authority', success: false };
    return { cmd, exit_code: 0, stdout: JSON.stringify({ id, pid: entry.pid, cmd: entry.cmd,
      status: describeProcessStatus(entry), exit_code: entry.exitCode, signal: entry.signal ?? null,
      timed_out: entry.timedOut === true, duration_ms: (entry.completedAt ?? Date.now()) - entry.startTime }), stderr: '', success: true };
  }

  /** Get the status record for a background process, or undefined if not found. */
  getStatus(id: string): BackgroundProcess | undefined {
    this.pruneCompletedProcesses();
    return this._processes.get(id);
  }

  /** Get the accumulated stdout/stderr for a background process. */
  getOutput(id: string): { stdout: string; stderr: string } | undefined {
    this.pruneCompletedProcesses();
    const entry = this._processes.get(id);
    if (!entry) return undefined;
    return {
      stdout: entry.stdout.join(''),
      stderr: entry.stderr.join(''),
    };
  }

  /**
   * Stop a background process by ID.
   * Returns true if termination was requested, false if unknown. The visible
   * record is removed immediately; close() still drains its owned termination.
   */
  stop(id: string): boolean {
    const entry = this._processes.get(id);
    if (!entry) return false;

    const owner = this._shutdowns.get(id);
    if (owner) void owner.stop().catch((error: unknown) => {
      logger.warn('Background process stop failed', { processId: id, error: summarizeError(error) });
    });
    // Preserve bg_stop's immediate record removal, but retain the owned handle
    // until exit/output collection completes so close() can still drain it.
    this._processes.delete(id);
    // A pending boundary remains discoverable to its owner's settlement drain.
    if (!this._shutdowns.has(id)) this._boundaryExecutions.delete(id);
    return true;
  }

  /** Runtime cleanup can distinguish retained boundaries without exposing their owner token. */
  hasBoundaryOwner(id: string): boolean { return this._boundaryExecutions.has(id); }

  /** List tracked processes with authoritative completion and display status. */
  list(): Array<{ id: string; pid: number; cmd: string; status: string; done: boolean }> {
    this.pruneCompletedProcesses();
    return Array.from(this._processes.values()).map((e) => ({
      id: e.id,
      pid: e.pid,
      cmd: e.cmd,
      status: describeProcessStatus(e),
      done: e.done,
    }));
  }

  /**
   * Handle bg_status / bg_output / bg_stop / bg_list special commands.
   * Returns a BgCommandResult if the command was handled, null otherwise.
   */
  handleCommand(cmd: string): BgCommandResult | null {
    this.pruneCompletedProcesses();
    const boundaryMatch = cmd.match(/^bg_(?:status|output|stop)\s+(\S+)$/);
    if (boundaryMatch && this._boundaryExecutions.has(boundaryMatch[1]!))
      return { cmd, exit_code: 1, stdout: '', stderr: 'This process requires its captured execution authority', success: false };
    // bg_status <id>
    const statusMatch = cmd.match(/^bg_status\s+(\S+)$/);
    if (statusMatch) {
      const entry = this._processes.get(statusMatch[1]!);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${statusMatch[1]!}`, success: false };
      }
      const status = describeProcessStatus(entry);
      return {
        cmd,
        exit_code: 0,
        stdout: JSON.stringify({
          id: entry.id,
          pid: entry.pid,
          cmd: entry.cmd,
          status,
          exit_code: entry.exitCode,
          signal: entry.signal ?? null,
          timed_out: entry.timedOut === true,
          duration_ms: (entry.completedAt ?? Date.now()) - entry.startTime,
        }),
        stderr: '',
        success: true,
      };
    }

    // bg_output <id>
    const outputMatch = cmd.match(/^bg_output\s+(\S+)$/);
    if (outputMatch) {
      const entry = this._processes.get(outputMatch[1]!);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${outputMatch[1]!}`, success: false };
      }
      return {
        cmd,
        exit_code: 0,
        stdout: entry.stdout.join(''),
        stderr: entry.stderr.join(''),
        success: true,
      };
    }

    // bg_stop <id>
    const stopMatch = cmd.match(/^bg_stop\s+(\S+)$/);
    if (stopMatch) {
      const found = this.stop(stopMatch[1]!);
      if (!found) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${stopMatch[1]!}`, success: false };
      }
      return { cmd, exit_code: 0, stdout: `Stopped ${stopMatch[1]!}`, stderr: '', success: true };
    }

    // bg_list
    if (cmd.trim() === 'bg_list') {
      return { cmd, exit_code: 0, stdout: JSON.stringify(this.list().filter((entry) => !this._boundaryExecutions.has(entry.id))), stderr: '', success: true };
    }

    return null;
  }

  private pruneCompletedProcesses(now = Date.now()): void {
    const completed = [...this._processes.values()]
      .filter((entry) => entry.done)
      .sort((a, b) => (b.completedAt ?? b.startTime) - (a.completedAt ?? a.startTime));
    for (let i = 0; i < completed.length; i++) {
      const entry = completed[i]!;
      const completedAt = entry.completedAt ?? entry.startTime;
      if (now - completedAt <= COMPLETED_PROCESS_TTL_MS && i < MAX_COMPLETED_PROCESSES) continue;
      this._processes.delete(entry.id);
      this._boundaryExecutions.delete(entry.id);
    }
  }
}

/**
 * One status line that never claims success it cannot prove: a timed-out or
 * signalled process reads as such rather than as "done (exit null)".
 */
export function describeProcessStatus(entry: BackgroundProcess): string {
  if (!entry.done) return 'running';
  if (entry.timedOut === true) return `timed out (signal ${entry.signal ?? 'SIGKILL'})`;
  if (entry.signal) return `killed by ${entry.signal}`;
  return `done (exit ${entry.exitCode})`;
}

/**
 * Reads the terminating signal off a finished Bun subprocess handle without
 * asserting a shape the runtime does not guarantee.
 */
function readSignalCode(proc: ReturnType<typeof Bun.spawn>): string | null {
  const candidate = (proc as unknown as { signalCode?: unknown }).signalCode;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function killTrackedProcess(proc: ReturnType<typeof Bun.spawn>, signal: Parameters<ReturnType<typeof Bun.spawn>['kill']>[0], id: string): void {
  try {
    proc.kill(signal);
  } catch (error) {
    logger.debug('Background process kill failed; process may already be exited', {
      processId: id,
      signal,
      error: summarizeError(error),
    });
  }
}

/**
 * Drains a child stream into `sink` as chunks arrive.
 *
 * The defect this replaces: the previous implementation accumulated the whole
 * stream into a local string and returned it only when the stream closed, and
 * the caller pushed that single string into `entry.stdout` after `proc.exited`
 * resolved. Until the process ended, `entry.stdout` was empty, so `bg_output`
 * on a running process reported nothing, which is exactly the case a person
 * runs it in. Pushing each decoded chunk into the live array as it is read
 * makes `bg_output` reflect the process's output up to that moment, and gives
 * an on-exit trigger a real output tail to put in its payload.
 *
 * The byte cap is unchanged and is still enforced across the whole stream; the
 * truncation notice is appended once, at the point the cap is first crossed.
 */
async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  sink: string[],
  cancelSignal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let truncated = false;

  // Abort releases the read loop for a pipe whose write end a surviving
  // descendant still holds; without it the pending read outlives the process.
  const onAbort = (): void => {
    void reader.cancel().catch(() => {
      /* the stream is already gone; nothing to release */
    });
  };
  if (cancelSignal?.aborted === true) onAbort();
  else cancelSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_PROCESS_OUTPUT_BYTES - total;
      if (remaining > 0) {
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        const decoded = decoder.decode(chunk, { stream: true });
        if (decoded.length > 0) sink.push(decoded);
        total += chunk.byteLength;
      }
      if (value.byteLength > remaining && !truncated) {
        truncated = true;
        sink.push(`\n[goodvibes: output truncated after ${MAX_PROCESS_OUTPUT_BYTES} bytes]\n`);
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) sink.push(tail);
  } finally {
    cancelSignal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}



/** A bounded observation window whose timer never outlives the observed work. */
async function settleWithin(work: Promise<unknown>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); })]);
  } finally { clearTimeout(timer); }
}

/** Groups are reachable only for children this manager spawned with detached:true. */
function ownedGroupExists(pid: number): boolean {
  assertOwnedGroupId(pid);
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalOwnedGroup(pid: number, signal: NodeJS.Signals): void {
  assertOwnedGroupId(pid);
  try { process.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForOwnedGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (ownedGroupExists(pid)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
  }
  return true;
}

async function terminateOwnedGroup(pid: number, graceMs: number): Promise<void> {
  if (!ownedGroupExists(pid)) return;
  signalOwnedGroup(pid, 'SIGTERM');
  if (await waitForOwnedGroupExit(pid, graceMs)) return;
  logger.warn('Background process group did not exit after SIGTERM, killing', { groupId: pid, signal: 'SIGKILL' });
  signalOwnedGroup(pid, 'SIGKILL');
  // Reap the direct child through its collection promise; orphan descendants
  // are reaped by the OS. Do not claim shutdown if the owned group stays live.
  if (!await waitForOwnedGroupExit(pid, 5_000)) throw new Error(`Owned process group ${pid} remains observable after SIGKILL; cannot verify release`);
}

function assertOwnedGroupId(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid owned process group');
}

function assertTimerRange(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be a finite number from 0 to 2147483647 milliseconds`);
  }
}
