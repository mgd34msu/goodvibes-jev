import { spawn } from 'node:child_process';

/** Accepted means the manager accepted a job, never that its replacement is healthy. */
export interface ServiceHandoverOutcome {
  readonly status: 'accepted' | 'failed' | 'unsupported' | 'unknown';
  readonly detail?: string | undefined;
}

/** A runner must observe command completion, and release its child on abort. */
export type ServiceCommandRunner = (
  argv: readonly string[],
  signal: AbortSignal,
) => Promise<ServiceHandoverOutcome>;

/** Own both spawn errors (including asynchronous ENOENT) and command completion. */
export function createServiceCommandRunner(spawnChild: typeof spawn = spawn): ServiceCommandRunner {
  return (argv, signal) => new Promise((resolve) => {
    if (signal.aborted) { resolve({ status: 'unknown', detail: 'command cancelled' }); return; }
    let child: ReturnType<typeof spawn>;
    let settled = false;
    const finish = (outcome: ServiceHandoverOutcome): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(outcome);
    };
    const abort = (): void => {
      // This is the short-lived manager client, not the service/job it enqueued.
      try { child.kill('SIGKILL'); } catch { /* The child may already have exited. */ }
      finish({ status: 'unknown', detail: 'command cancelled before completion was observed' });
    };
    try {
      child = spawnChild(argv[0]!, argv.slice(1), { stdio: 'ignore' });
      child.once('error', (error) => finish({ status: 'failed', detail: error.message }));
      child.once('close', (code, terminationSignal) => finish(code === 0
        ? { status: 'accepted' }
        : code === null
          ? { status: 'unknown', detail: `command terminated (${terminationSignal ?? 'no exit status'})` }
          : { status: 'failed', detail: `command exited ${code}` }));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    } catch (error) {
      finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

export const runServiceCommand: ServiceCommandRunner = createServiceCommandRunner();

/** Bound even an injected runner that ignores cancellation; own late rejections. */
export function observeServiceCommand(
  runner: ServiceCommandRunner,
  argv: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ServiceHandoverOutcome> {
  if (signal?.aborted) return Promise.resolve({ status: 'unknown', detail: 'handover cancelled' });
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ServiceHandoverOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => {
      finish({ status: 'unknown', detail: 'handover cancelled' });
      controller.abort();
    };
    const timer = setTimeout(() => {
      finish({ status: 'unknown', detail: `command timed out after ${timeoutMs}ms` });
      controller.abort();
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    // Promise.resolve alone would not catch a synchronous runner throw.
    Promise.resolve().then(() => {
      if (controller.signal.aborted) return { status: 'unknown' as const, detail: 'handover cancelled' };
      return runner(argv, controller.signal);
    }).then((result) => finish(result ?? { status: 'unknown', detail: 'command returned no outcome' }),
      (error: unknown) => finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) }));
  });
}
