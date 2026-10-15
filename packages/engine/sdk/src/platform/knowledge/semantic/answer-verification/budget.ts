import { KnowledgeAnswerQualityHeldError as Held } from './types.js';
/** One end-to-end budget, including generation and judgment that ignore cancellation. */
export async function withAnswerVerificationBudget<T>(run: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
  requestedMs?: number, parent?: AbortSignal,
): Promise<T> {
  const timeoutMs = requestedMs ?? 0;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) throw new Held('budget');
  if (parent?.aborted) throw new Held('aborted');
  const controller = new AbortController();
  const deadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  let rejectStopped: (reason: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (reason: 'aborted' | 'budget') => { controller.abort(); rejectStopped(new Held(reason)); };
  const abort = () => stop('aborted');
  parent?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => stop('budget'), timeoutMs) : undefined;
  try { return await Promise.race([run(controller.signal, deadlineAt), stopped]); }
  finally { controller.abort(); clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}

export function assertAnswerVerificationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Held('aborted');
}
