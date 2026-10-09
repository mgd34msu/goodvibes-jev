/** Optional authority to begin a delivery. Revocation cannot undo an accepted send. */
export interface DeliveryLifetime {
  readonly signal?: AbortSignal | undefined;
  /** Synchronous final authority check. Throw when this delivery is no longer current. */
  readonly assertCurrent?: (() => void) | undefined;
}

/** Call after all asynchronous preparation, immediately before each outbound side effect. */
export function assertDeliveryCurrent(lifetime: DeliveryLifetime): void {
  lifetime.signal?.throwIfAborted();
  lifetime.assertCurrent?.();
  // A currentness check may itself revoke the signal.
  lifetime.signal?.throwIfAborted();
}
