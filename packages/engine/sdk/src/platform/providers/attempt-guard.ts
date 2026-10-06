/** Preserve a host-denied attempt across transport error normalization and retry adapters. */
import type { ChatRequest } from './interface.js';

export class ProviderAttemptDeniedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Provider attempt denied', { cause });
    this.name = 'ProviderAttemptDeniedError';
  }
}

/** The final fence after asynchronous preparation; denial is never a transport failure. */
export async function revalidateProviderAttempt(beforeAttempt: NonNullable<ChatRequest['beforeAttempt']>): Promise<void> {
  try { await beforeAttempt(); }
  catch (error) { throw error instanceof ProviderAttemptDeniedError ? error : new ProviderAttemptDeniedError(error); }
}
