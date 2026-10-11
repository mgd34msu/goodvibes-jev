import { captureJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import type { KnowledgeStore } from '../store.js';
import { KnowledgeRepairFactUsefulnessHeldError as Held } from '../semantic/repair-usefulness/types.js';

const queues = new WeakMap<KnowledgeStore, Map<string, Promise<void>>>();

/** Serialize only competing writers of one passport, retaining the requesting owner while queued. */
export function withDevicePageRefresh<T>(store: KnowledgeStore, key: string, signal: AbortSignal | undefined,
  requestState: () => string, operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
  const state = requestState();
  const installation = () => {
    try { return captureJudgmentPort('engine.knowledge.page-fact-quality'); }
    catch (error) { if (error instanceof JudgmentPortMissingError) return undefined; throw error; }
  };
  const owner = installation(), model = owner?.port.model;
  const assertRequest = () => {
    if (signal?.aborted) throw new Held('aborted');
    try { owner?.assertCurrent(); } catch { throw new Held('stale'); }
    const current = installation();
    if (requestState() !== state || owner?.signal.aborted || current?.identity !== owner?.identity || current?.port.model !== model) throw new Held('stale');
  };
  assertRequest();
  let queue = queues.get(store);
  if (!queue) { queue = new Map(); queues.set(store, queue); }
  const previous = queue.get(key) ?? Promise.resolve();
  const run = previous.then(async () => { assertRequest(); const result = await operation(assertRequest); assertRequest(); return result; });
  const tail = run.then(() => {}, () => {});
  queue.set(key, tail);
  void tail.then(() => { if (queue.get(key) === tail) queue.delete(key); });
  const stopped = signal && owner ? AbortSignal.any([signal, owner.signal]) : signal ?? owner?.signal;
  if (!stopped) return run;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Held(signal?.aborted ? 'aborted' : 'stale'));
    stopped.addEventListener('abort', abort, { once: true });
    run.then(resolve, reject).finally(() => stopped.removeEventListener('abort', abort));
    if (stopped.aborted) abort();
  });
}
