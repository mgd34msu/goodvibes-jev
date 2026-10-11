/** Restrictive lifecycle checks for one memory operation, never permission. */
export interface MemoryOperationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

const capturedOperations = new WeakSet<MemoryOperationOptions>();

/** Retain the original callback and signal through every awaited boundary. */
export function captureMemoryOperation(options: MemoryOperationOptions = {}): MemoryOperationOptions {
  if (capturedOperations.has(options)) return options;
  const signal = options.signal, current = options.assertCurrent;
  const captured: MemoryOperationOptions = Object.freeze({
    signal,
    assertCurrent: () => {
      signal?.throwIfAborted();
      if (options.signal !== signal || options.assertCurrent !== current) {
        throw new Error('Memory operation lifecycle changed');
      }
      const result: unknown = current?.();
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => {});
        throw new TypeError('Memory operation currentness checks must be synchronous');
      }
      signal?.throwIfAborted();
    },
  });
  capturedOperations.add(captured);
  return captured;
}

export function assertMemoryOperationCurrent(operation: MemoryOperationOptions): void {
  operation.signal?.throwIfAborted();
  operation.assertCurrent?.();
  operation.signal?.throwIfAborted();
}

/** A noncooperative read cannot delay cancellation or publish its late result. */
export async function awaitMemoryOperation<T>(
  invoke: () => T | PromiseLike<T>,
  operation: MemoryOperationOptions,
): Promise<T> {
  assertMemoryOperationCurrent(operation);
  const signal = operation.signal;
  let onAbort: (() => void) | undefined;
  try {
    const pending = Promise.resolve(invoke());
    const cancelled = signal ? new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('Memory operation aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }) : undefined;
    const result = await (cancelled ? Promise.race([pending, cancelled]) : pending);
    assertMemoryOperationCurrent(operation);
    return result;
  } catch (error) {
    assertMemoryOperationCurrent(operation);
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
