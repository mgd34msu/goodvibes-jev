import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment/decisions';

/** Do not hide a thenable from the foundation's synchronous authority contract. */
export function assertSynchronousCurrent(check?: () => void): void {
  const result: unknown = check?.();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error('Daemon reading authority checks must be synchronous');
  }
}

/** Bind transmission, retention and late results to the daemon caller's live source. */
export function daemonReadingPort(site: string, assertCurrent: () => void, signal?: AbortSignal): JudgmentPort {
  assertSynchronousCurrent(assertCurrent);
  const base = judgmentPort(site);
  const current = () => {
    signal?.throwIfAborted();
    assertSynchronousCurrent(assertCurrent);
    if (judgmentPort(site) !== base) throw new Error('Daemon judgment route changed');
  };
  return {
    get model() { current(); return base.model; },
    ...(base.recorder ? { recorder: {
      recordReadings: (id, readings) => { current(); base.recorder!.recordReadings(id, readings); },
      recordAction: (id, action) => { current(); base.recorder!.recordAction(id, action); },
    } satisfies NonNullable<JudgmentPort['recorder']> } : {}),
    async ask(request) {
      current();
      const result = await interruptReading(base.ask({ ...request,
        ...(signal === undefined ? {} : { signal }),
        beforeAttempt: () => { assertSynchronousCurrent(request.beforeAttempt); current(); },
        assertLogCurrent: () => { assertSynchronousCurrent(request.assertLogCurrent); current(); },
      }), signal);
      current();
      return result;
    },
  };
}

/** An injected provider cannot keep daemon shutdown waiting by ignoring cancellation. */
async function interruptReading<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}
