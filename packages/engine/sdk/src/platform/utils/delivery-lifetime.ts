import type { MutationPublication } from './file-mutation.js';

/** Optional restrictions on a delivery. Revocation cannot undo an accepted send. */
export interface DeliveryLifetime {
  readonly signal?: AbortSignal | undefined;
  /** Synchronous final authority check. Throw when this delivery is no longer current. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Native producers retain ownership only during the actual final dispatch. */
  readonly withPublication?: MutationPublication | undefined;
}

/** Preparation stays outside this boundary; only an actual dispatch belongs inside. */
export async function runDeliveryPublication<T>(lifetime: DeliveryLifetime, operation: (assertCurrent: () => void) => T | Promise<T>): Promise<T> {
  assertDeliveryCurrent(lifetime);
  const publication = lifetime.withPublication;
  if (!publication) return operation(() => assertDeliveryCurrent(lifetime));
  let active = true, started = false;
  let completed: { readonly value: T } | undefined;
  try {
    await publication(async assertCurrent => {
      if (!active || started) throw new Error('Delivery publication is not current.');
      started = true;
      const current = () => {
        if (!active) throw new Error('Delivery publication retired.');
        assertDeliveryCurrent({ signal: lifetime.signal, assertCurrent });
        assertDeliveryCurrent(lifetime);
      };
      current();
      const value = await operation(current);
      completed = { value };
      return value;
    });
    if (!completed) throw new Error('Delivery publication did not finish.');
    return completed.value;
  } catch (error) {
    // A completed transport result is factual. A later revocation cannot turn
    // that accepted dispatch into a failed attempt eligible for another send.
    if (completed) return completed.value;
    throw error;
  } finally { active = false; }
}

/** Call after all asynchronous preparation, immediately before each outbound side effect. */
export function assertDeliveryCurrent(lifetime: DeliveryLifetime): void {
  lifetime.signal?.throwIfAborted();
  const result: unknown = lifetime.assertCurrent?.();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error('Delivery ownership must be checked synchronously.');
  }
  // A currentness check may itself revoke the signal.
  lifetime.signal?.throwIfAborted();
}
