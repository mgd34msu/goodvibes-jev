/**
 * Wait for a policy reading without stranding a cancelled tool call. The
 * reading may ignore its signal, so the guard also races cancellation and
 * discards any late result. The original tool is never called after abort.
 */
export function executePolicyCheck<T>(check: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return Promise.resolve().then(check);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve().then(() => { signal.throwIfAborted(); return check(); }).then(
      (value) => finish(() => { if (signal.aborted) reject(signal.reason); else resolve(value); }),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
