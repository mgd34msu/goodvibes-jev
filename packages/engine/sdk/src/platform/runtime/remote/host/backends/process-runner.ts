// Owned subprocess runner for the daemon's local/docker/ssh/cloud backends.
// Credential material is supplied by callers via files or env, never argv.
import { readdir, readFile } from 'node:fs/promises';

export interface RunOptions {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Join all I/O and the owned POSIX group, including on normal leader exit. */
  ownedProcessGroup?: boolean;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class OwnedProcessGroupUnsupportedError extends Error {
  readonly code = 'OWNED_PROCESS_GROUP_UNSUPPORTED';
  constructor(platform: string) {
    super(`Owned process-group cleanup is unavailable on ${platform}; command was not started.`);
    this.name = 'OwnedProcessGroupUnsupportedError';
  }
}

interface BunSubprocessLike {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly stdin: { write(chunk: string): void; end(): void | Promise<void> } | null;
  readonly exited: Promise<number>;
  kill(signal?: number | string): void;
}

interface BunSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: 'pipe' | 'ignore';
  stdout: 'pipe';
  stderr: 'pipe';
  detached?: boolean;
}

type BunSpawn = (cmd: string[], options: BunSpawnOptions) => BunSubprocessLike;

function getBunSpawn(): BunSpawn {
  const globalBun = (globalThis as { Bun?: { spawn?: unknown } }).Bun;
  if (!globalBun || typeof globalBun.spawn !== 'function') {
    throw new Error('Bun.spawn is unavailable in this runtime.');
  }
  return globalBun.spawn as unknown as BunSpawn;
}

interface CapturedStream {
  readonly result: Promise<string>;
  readonly text: string;
  cancel(): void;
}

function captureStream(stream: ReadableStream<Uint8Array> | null): CapturedStream {
  if (!stream) return { result: Promise.resolve(''), text: '', cancel() {} };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let cancelled = false;
  const result = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      if (cancelled) return text;
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    result,
    get text() { return text; },
    cancel() {
      cancelled = true;
      // Cancelling resolves pending reads even if an inherited pipe remains
      // open. Do not await an arbitrary underlying stream's cancel callback.
      void reader.cancel().catch(() => {});
    },
  };
}

function stopOwnedProcess(child: BunSubprocessLike): void {
  // Bun's detached POSIX child is its own process-group leader. Stop that
  // group, including descendants retaining its pipes, even if the leader has
  // already exited. Children that deliberately create a new session escape
  // this group; this is process ownership, not a security sandbox.
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  // Windows retains the previous direct-child kill behavior. The stream
  // deadline below still prevents inherited handles from holding the caller.
  try { child.kill('SIGKILL'); } catch {}
}

/** Whether the entire owned group has stopped executing (not just its leader). */
async function ownedGroupStopped(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    // A permission/probe failure does not prove that the group stopped.
    return false;
  }
  if (process.platform !== 'linux') return false;

  // Orphaned grandchildren can remain zombies until their new parent reaps
  // them. They cannot execute or retain descriptors. /proc lets Linux prove
  // that a group has no live members without claiming we reaped non-children.
  try {
    const entries = await readdir('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return false;
      }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X') return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function joinOwnedGroup(child: BunSubprocessLike, stopping: () => boolean): Promise<void> {
  // Bun supplies a pid for every successfully spawned child. If an adapter
  // cannot supply one, group ownership cannot be proved: remain pending.
  for (;;) {
    if (stopping()) stopOwnedProcess(child);
    if (typeof child.pid === 'number' && child.pid > 0 && await ownedGroupStopped(child.pid)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Strict opt-in ownership for scoped hooks. Cancellation requests shutdown;
 * only real process/I/O settlement completes the invocation. No timeout race
 * discards stdin or stream work. Deliberate new-session escape is not contained.
 */
async function runOwnedProcess(options: RunOptions): Promise<RunResult> {
  if (process.platform === 'win32') {
    throw new OwnedProcessGroupUnsupportedError('Windows');
  }
  const child = getBunSpawn()(options.args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options.env ?? {}) },
    stdin: options.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let interrupted: 'abort' | 'timeout' | undefined;
  const stop = () => stopOwnedProcess(child);
  const onAbort = () => {
    interrupted ??= 'abort';
    stop();
  };
  const timer = setTimeout(() => {
    interrupted ??= 'timeout';
    stop();
  }, options.timeoutMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  // A leader's normal exit is not a reason to kill valid descendants. Join
  // their group below, under the same cancellation/deadline as the leader.
  const exit = child.exited;
  const operations: Promise<unknown>[] = [exit];
  let failed = false;
  let result: [string, string, number, void];
  try {
    const stdout = captureStream(child.stdout);
    operations.push(stdout.result);
    const stderr = captureStream(child.stderr);
    operations.push(stderr.result);
    const input = (async () => {
      if (options.stdin !== undefined && child.stdin) {
        child.stdin.write(options.stdin);
        await child.stdin.end();
      }
    })();
    operations.push(input);
    result = await Promise.all([stdout.result, stderr.result, exit, input]);
  } catch (error) {
    failed = true;
    stop();
    throw error;
  } finally {
    // Attach handlers and join every admitted operation, even if another one
    // failed first. An uncooperative I/O adapter honestly keeps us pending.
    await Promise.allSettled(operations);
    await joinOwnedGroup(child, () => failed || interrupted !== undefined);
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
  if (interrupted === 'abort') throw new DOMException('Process execution aborted.', 'AbortError');
  const [stdout, stderr, exitCode] = result;
  return { stdout, stderr, exitCode, timedOut: interrupted === 'timeout' };
}

/**
 * Capture a command's output/status. Nonzero command exits are returned; spawn
 * and I/O failures reject. The deadline covers stdin, exit and output draining.
 * On failure/timeout the owned child is stopped and its exit is awaited; POSIX
 * also stops the owned process group. Normal completion leaves intentional
 * background work unchanged. This does not contain arbitrary child programs.
 */
export async function runProcess(options: RunOptions): Promise<RunResult> {
  if (options.args.length === 0) {
    throw new Error('runProcess requires at least one argument (the executable).');
  }
  if (options.signal?.aborted) throw new DOMException('Process execution aborted.', 'AbortError');
  if (options.ownedProcessGroup) return runOwnedProcess(options);
  const spawn = getBunSpawn();
  const child = spawn(options.args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options.env ?? {}) },
    stdin: options.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<{ kind: 'timeout' | 'abort' }>((resolve) => {
    timer = setTimeout(() => { resolve({ kind: 'timeout' }); }, options.timeoutMs);
    onAbort = () => { resolve({ kind: 'abort' }); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  let stdout: CapturedStream | undefined;
  let stderr: CapturedStream | undefined;
  try {
    if (options.signal?.aborted) throw new DOMException('Process execution aborted.', 'AbortError');
    stdout = captureStream(child.stdout);
    stderr = captureStream(child.stderr);
    const input = (async () => {
      if (options.stdin !== undefined && child.stdin) {
        child.stdin.write(options.stdin);
        await child.stdin.end();
      }
    })();
    // Attach handlers to every operation before racing the deadline. A late
    // stdin rejection after timeout must not become an unhandled rejection.
    const complete = Promise.all([stdout.result, stderr.result, child.exited, input]);
    const outcome = await Promise.race([complete.then((value) => ({ kind: 'complete' as const, value })), interrupted]);
    if (outcome.kind === 'complete') {
      const [out, err, exitCode] = outcome.value;
      return { stdout: out, stderr: err, exitCode: typeof exitCode === 'number' ? exitCode : -1, timedOut: false };
    }

    if (outcome.kind === 'abort') throw new DOMException('Process execution aborted.', 'AbortError');
    stopOwnedProcess(child);
    stdout.cancel();
    stderr.cancel();
    const exitCode = await child.exited;
    await Promise.allSettled([stdout.result, stderr.result]);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: typeof exitCode === 'number' ? exitCode : -1,
      timedOut: true,
    };
  } catch (error) {
    stopOwnedProcess(child);
    stdout?.cancel();
    stderr?.cancel();
    await Promise.allSettled([child.exited, stdout?.result, stderr?.result]);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}
