import { reportFatalBootFailure } from '@goodvibes-jev/engine/sdk/platform/daemon';

export type DaemonProcessExitCode = 0 | 1;
export type DaemonProcessSignal = 'SIGINT' | 'SIGTERM';

/** The host owns acquisition and the complete, awaitable resource drain. */
export interface DaemonProcessHost {
  start(): Promise<unknown>;
  close(): Promise<void>;
}

/** Structural seams keep tests from replacing global process state. */
export interface DaemonProcessTarget {
  on(signal: DaemonProcessSignal, listener: () => void): unknown;
  off(signal: DaemonProcessSignal, listener: () => void): unknown;
  exit(code: DaemonProcessExitCode): void;
}

export interface DaemonProcessTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface DaemonProcessOptions {
  /** One deadline for startup settlement and shutdown drainage; defaults to 15s. */
  readonly shutdownTimeoutMs?: number;
  readonly process?: DaemonProcessTarget;
  readonly timers?: DaemonProcessTimers;
}

export interface DaemonProcessHandle {
  /** Resolves undefined when shutdown wins before startup can be admitted. */
  readonly ready: Promise<unknown>;
  readonly finished: Promise<DaemonProcessExitCode>;
  /** Synchronously fences startup and returns the same promise on every call. */
  shutdown(): Promise<DaemonProcessExitCode>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const realTimers: DaemonProcessTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Install signal ownership before admitting any host work. No signal or failure
 * exits successfully until both startup and the host's full close have settled.
 * The referenced deadline also keeps an otherwise idle process alive while an
 * asynchronous drain is pending. This module deliberately has no CLI side effects.
 */
export function runDaemonProcess(
  createHost: () => DaemonProcessHost,
  options: DaemonProcessOptions = {},
): DaemonProcessHandle {
  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError('Daemon shutdown timeout must be a finite nonnegative supported timer duration');
  }
  const target = options.process ?? process;
  const timers = options.timers ?? realTimers;
  let host: DaemonProcessHost | undefined;
  let startupSettled = false;
  let startupFailed = false;
  let shutdownRequested = false;
  let closeStarted = false;
  let closeSettled = false;
  let closeFailed = false;
  let terminal = false;
  let deadline: unknown;
  let deadlineSet = false;
  let resolveFinished!: (code: DaemonProcessExitCode) => void;
  const finished = new Promise<DaemonProcessExitCode>((resolve) => { resolveFinished = resolve; });

  function finish(code: DaemonProcessExitCode): void {
    if (terminal) return;
    terminal = true;
    if (deadlineSet) {
      timers.clearTimeout(deadline);
      deadlineSet = false;
    }
    target.off('SIGINT', onSignal);
    target.off('SIGTERM', onSignal);
    resolveFinished(code);
    target.exit(code);
  }

  function finishIfDrained(): void {
    if (shutdownRequested && startupSettled && closeSettled) {
      finish(startupFailed || closeFailed ? 1 : 0);
    }
  }

  function closeHost(): void {
    if (terminal || closeStarted) return;
    if (!host) {
      // A failed factory has no returned owner. A pending factory still does.
      if (startupSettled) { closeSettled = true; finishIfDrained(); }
      return;
    }
    closeStarted = true;
    let closing: Promise<void>;
    try {
      // Invoke synchronously so the host's admission fence closes immediately.
      closing = host.close();
    } catch {
      closing = Promise.reject(new Error('Daemon shutdown failed'));
    }
    void Promise.resolve(closing).then(
      () => { closeSettled = true; finishIfDrained(); },
      () => {
        closeFailed = true;
        closeSettled = true;
        if (!terminal) reportFatalBootFailure('Daemon shutdown failed');
        finishIfDrained();
      },
    );
  }

  function shutdown(): Promise<DaemonProcessExitCode> {
    if (shutdownRequested || terminal) return finished;
    shutdownRequested = true;
    deadline = timers.setTimeout(() => {
      if (terminal) return;
      reportFatalBootFailure('Daemon shutdown deadline exceeded');
      finish(1);
    }, timeoutMs);
    deadlineSet = true;
    closeHost();
    return finished;
  }

  function onSignal(): void { void shutdown(); }
  target.on('SIGINT', onSignal);
  target.on('SIGTERM', onSignal);

  const ready = Promise.resolve().then(() => {
    host = createHost();
    if (shutdownRequested) {
      closeHost();
      return undefined;
    }
    return host.start();
  }).then(
    (value) => { startupSettled = true; finishIfDrained(); return value; },
    () => {
      startupFailed = true;
      startupSettled = true;
      if (!terminal) reportFatalBootFailure('Daemon startup failed');
      void shutdown();
      // shutdown may already be running when the factory fails.
      closeHost();
      finishIfDrained();
      throw new Error('Daemon startup failed');
    },
  );
  // A process runner must remain safe even when nobody awaits startup.
  void ready.catch(() => {});
  return { ready, finished, shutdown };
}
