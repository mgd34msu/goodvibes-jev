/** Constructed by the owned timer, never inferred from an error message or name. */
export class KnowledgeRepairBudgetError extends Error {
  override readonly name = 'KnowledgeRepairBudgetError';
  constructor() { super('Semantic gap repair exhausted its run budget.'); }
}

/** One owned timer cancels cooperative repairers and bounds uncooperative ones. */
export async function runWithRepairBudget<T>(work: (signal: AbortSignal) => Promise<T>, remainingMs: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let rejectStop: (error: unknown) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const stop = (error: unknown) => { rejectStop(error); controller.abort(error); };
  const abort = () => stop(parent?.reason ?? new DOMException('Repair cancelled', 'AbortError'));
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new KnowledgeRepairBudgetError()), Math.max(1, remainingMs));
  timer.unref?.();
  try {
    if (parent?.aborted) { abort(); return await stopped; }
    return await Promise.race([stopped, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}
