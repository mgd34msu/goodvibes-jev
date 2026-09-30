// Owned subprocess runner for the daemon's local/docker/ssh/cloud backends.
// Credential material is supplied by callers via files or env, never argv.

export interface RunOptions {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
