import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';

const expiredBudgets = new WeakSet<object>();
const hasExpiredBudget = expiredBudgets.has.bind(expiredBudgets);
const markExpiredBudget = expiredBudgets.add.bind(expiredBudgets);

/** Only this operation's native timer can establish an expired support budget. */
export function isOwnedSupportBudgetExpiry(error: unknown): boolean {
  return error !== null && typeof error === 'object' && hasExpiredBudget(error);
}

/** A bounded semantic pass, including ports that ignore their AbortSignal. */
export async function withSupportBudget<T>(
  run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted) throw new KnowledgeGeneratedFactSupportHeldError('aborted');
  if ((!Number.isFinite(timeoutMs) && timeoutMs !== Infinity) || timeoutMs < 0 || (Number.isFinite(timeoutMs) && timeoutMs > 2_147_483_647)) throw new KnowledgeGeneratedFactSupportHeldError('budget');
  const controller = new AbortController();
  let rejectStop: (error: KnowledgeGeneratedFactSupportHeldError) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const stop = (reason: 'aborted' | 'budget') => {
    const error = new KnowledgeGeneratedFactSupportHeldError(reason);
    if (reason === 'budget') markExpiredBudget(error);
    // Settle the owned cause before cooperative abort handlers can substitute
    // their generic cancellation error for the timer that stopped the pass.
    rejectStop(error); controller.abort();
  };
  const abort = () => stop('aborted');
  parent?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs > 0 && Number.isFinite(timeoutMs) ? setTimeout(() => stop('budget'), timeoutMs) : undefined;
  try {
    if (parent?.aborted) abort();
    return await Promise.race([run(controller.signal), stopped]);
  } finally {
    clearTimeout(timer); parent?.removeEventListener('abort', abort); controller.abort();
  }
}
