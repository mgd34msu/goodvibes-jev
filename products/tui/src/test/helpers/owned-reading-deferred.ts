import type { JudgmentPort } from '@goodvibes-jev/judgment';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  // Observe the original promise while leaving its settlement intact for callers.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
/** Each file owns all original callers and ignored-signal transports, even on assertion failure. */
export function createReadingDrain() {
  const stop: Array<() => void> = [];
  const gates: Array<ReturnType<typeof deferred<void>>> = [];
  const settled: Promise<unknown>[] = [];
  function own<T>(promise: Promise<T>): Promise<T> {
    settled.push(promise.then(value => ({ kind: 'completed', value }), error => ({ kind: 'failed', error })));
    return promise;
  }
  return {
    own,
    stopWith(callback: () => void) { stop.push(callback); },
    hold(base: JudgmentPort) {
      const started = deferred<void>(), release = deferred<void>();
      gates.push(started, release);
      const port: JudgmentPort = { model: base.model, ...(base.recorder ? { recorder: base.recorder } : {}), ask(request) {
        return own((async () => { started.resolve(); await release.promise; return base.ask(request); })());
      } };
      return { port, started: started.promise, release: () => release.resolve() };
    },
    async drain() {
      const failures: unknown[] = [];
      for (const callback of stop.splice(0)) { try { callback(); } catch (error) { failures.push(error); } }
      for (const gate of gates.splice(0)) gate.reject(new Error('Owned reading fixture retired.'));
      await Promise.all(settled.splice(0));
      if (failures.length) throw new AggregateError(failures, 'Owned reading cleanup failed.');
    },
  };
}
