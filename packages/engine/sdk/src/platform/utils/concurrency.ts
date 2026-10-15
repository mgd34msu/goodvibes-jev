export { sleep } from '../knowledge/cooperative.js';

/** Run async work with a fixed concurrency cap while preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  async function runWorker(): Promise<void> {
    for (;;) {
      if (failed) return;
      const index = nextIndex++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index]!, index); }
      catch (error) { failed = true; throw error; }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker(),
  );
  const settled = await Promise.allSettled(workers);
  const error = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (error) throw error.reason;
  return results;
}
