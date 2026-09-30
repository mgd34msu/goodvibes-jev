import type { ClusterClock, ClusterLogger } from './types.js';

/** Internal ownership boundary for a restartable, asynchronously acquired resource. */
export class ClusterOwnedLifecycle {
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private running = false;
  private dirty = false;

  constructor(
    private readonly acquire: (signal: AbortSignal) => Promise<void>,
    private readonly release: () => Promise<void>,
  ) {}

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('Cluster resource is stopping'));
    if (this.starting) return this.starting;
    if (this.running) return Promise.resolve();
    if (this.dirty) return Promise.reject(new Error('Cluster resource cleanup must be retried before starting'));
    const controller = new AbortController();
    this.controller = controller;
    this.dirty = true;
    // Defer callbacks until the promise is published, including for reentrant callers.
    this.starting = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        await this.acquire(controller.signal);
        controller.signal.throwIfAborted();
        this.running = true;
      } catch (error) {
        try {
          await this.release();
          this.dirty = false;
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Cluster startup and cleanup failed');
        }
        throw error;
      }
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.dirty) return Promise.resolve();
    this.controller?.abort(new Error('Cluster startup cancelled by stop'));
    const starting = this.starting;
    this.stopping = Promise.resolve().then(async () => {
      // The start caller owns its error. Stop still owns any partial acquisition.
      if (starting) await starting.catch(() => {});
      if (!this.dirty) return;
      this.running = false;
      await this.release();
      this.dirty = false;
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
}

/** Owns automatic timer callbacks through their asynchronous completion. */
export class ClusterPeriodicTasks {
  private readonly cancellations = new Set<() => void>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly clock: ClusterClock, private readonly logger: ClusterLogger) {}

  schedule(intervalMs: number, task: () => Promise<void>): void {
    let active = true;
    let cancel: () => void;
    const tick = (): void => {
      if (!active) return;
      const work = Promise.resolve().then(task).catch(() => {
        this.logger.warn('cluster: a periodic group task failed');
      }).finally(() => { this.pending.delete(work); });
      this.pending.add(work);
      cancel = this.clock.setTimer(tick, intervalMs);
    };
    cancel = this.clock.setTimer(tick, intervalMs);
    this.cancellations.add(() => { active = false; cancel(); });
  }

  async stop(): Promise<void> {
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    await Promise.allSettled(this.pending);
  }
}
