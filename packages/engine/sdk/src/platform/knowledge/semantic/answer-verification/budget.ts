import { KnowledgeAnswerQualityHeldError as Held } from './types.js';
/** One end-to-end budget, including generation and judgment that ignore cancellation. */
export async function withAnswerVerificationBudget<T>(run: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
  requestedMs?: number, parent?: AbortSignal,
): Promise<T> {
  const timeoutMs = requestedMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Held('budget');
  if (parent?.aborted) throw new Held('aborted');
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let rejectStopped: (reason: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (reason: 'aborted' | 'budget') => { controller.abort(); rejectStopped(new Held(reason)); };
  const abort = () => stop('aborted');
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('budget'), timeoutMs);
  try { return await Promise.race([run(controller.signal, deadlineAt), stopped]); }
  finally { controller.abort(); clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}

export function assertAnswerVerificationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Held('aborted');
}
