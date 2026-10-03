/**
 * Tracks actual asynchronous work, independently of outward status or abort.
 * Reservation happens before invoking the callback, so a synchronous event or
 * abort listener can re-enter join without overlooking work being admitted.
 */
export class OwnedWork {
  private readonly pending = new Set<Promise<void>>();

  /** True only once every admitted callback has actually settled. */
  get idle(): boolean { return this.pending.size === 0; }

  run<T>(callback: () => T | PromiseLike<T>): Promise<T> {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    this.pending.add(settled);
    const finish = (): void => {
      this.pending.delete(settled);
      release();
    };
    let result: Promise<T>;
    try {
      result = Promise.resolve(callback());
    } catch (error) {
      result = Promise.reject(error);
    }
    // Observe both paths without changing the result (or leaving an unhandled
    // finally-chain rejection). join is a cleanup barrier, not an error result.
    void result.then(finish, finish);
    return result;
  }

  /** Call after the owner has closed admission; includes work admitted by cleanup. */
  async join(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
