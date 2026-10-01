import { BackendDispatchError } from './types.js';

function closedError(): BackendDispatchError {
  return new BackendDispatchError('Remote backend has been closed.', 'REMOTE_BACKEND_CLOSED');
}

/** Own asynchronous backend operations through teardown, including late lookups. */
export class BackendLifetime {
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | null = null;

  get signal(): AbortSignal { return this.controller.signal; }

  assertOpen(): void {
    if (this.signal.aborted) throw closedError();
  }

  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(async () => {
      this.assertOpen();
      try {
        const result = await operation(this.signal);
        this.assertOpen();
        return result;
      }
      catch (error) {
        if (this.signal.aborted) throw closedError();
        throw error;
      }
    });
    this.active.add(pending);
    void pending.then(() => { this.active.delete(pending); }, () => { this.active.delete(pending); });
    return pending;
  }

  /**
   * Race a lookup against closure without allowing its late result to resume
   * dispatch. Filesystem writes are not raced: run() must await those actual
   * operations so teardown cannot remove a directory before a write finishes.
   */
  waitFor<T>(lookup: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener('abort', onAbort);
        action();
      };
      const onAbort = () => { finish(() => { reject(closedError()); }); };
      this.signal.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve().then(() => {
        this.assertOpen();
        return lookup();
      }).then(
        (value) => { finish(() => { resolve(value); }); },
        (error: unknown) => { finish(() => { reject(error); }); },
      );
      if (this.signal.aborted) onAbort();
    });
  }

  close(cleanup: () => Promise<void>): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.active]);
      await cleanup();
    });
    this.controller.abort();
    return this.closing;
  }
}
