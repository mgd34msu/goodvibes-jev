/** A fresh bounded sweep, never a cache of read grants. Drain every started
 * check before returning so a failed/cancelled sweep cannot outlive its caller.
 */
export async function checkCapturedInputsInBatches<T>(
  inputs: readonly T[],
  check: (input: T, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < inputs.length; offset += 8) {
    signal?.throwIfAborted();
    const batch = new AbortController();
    const combined = signal ? AbortSignal.any([signal, batch.signal]) : batch.signal;
    const settled = await Promise.allSettled(inputs.slice(offset, offset + 8).map(async (input) => {
      try { combined.throwIfAborted(); await check(input, combined); }
      catch (error) { batch.abort(error); throw error; }
    }));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    signal?.throwIfAborted();
  }
}
