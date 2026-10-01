import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';

/** A bounded semantic pass, including ports that ignore their AbortSignal. */
export async function withSupportBudget<T>(
  run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted) throw new KnowledgeGeneratedFactSupportHeldError('aborted');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new KnowledgeGeneratedFactSupportHeldError('budget');
  const controller = new AbortController();
  let rejectStop: (error: KnowledgeGeneratedFactSupportHeldError) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const stop = (reason: 'aborted' | 'budget') => {
    controller.abort(); rejectStop(new KnowledgeGeneratedFactSupportHeldError(reason));
  };
  const abort = () => stop('aborted');
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('budget'), timeoutMs);
  try {
    if (parent?.aborted) abort();
    return await Promise.race([run(controller.signal), stopped]);
  } finally {
    clearTimeout(timer); parent?.removeEventListener('abort', abort); controller.abort();
  }
}
