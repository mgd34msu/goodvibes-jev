import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import type { JsonValue, JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { freezeSupport } from '../semantic/verification/projection.js';
import { nodeServingWithoutReview } from './battery.js';
import { KnowledgeNodeActivationHeldError as Held, NODE_ACTIVATION_LIMITS as LIMITS,
  type KnowledgeNodeActivationOptions, type NodeActivationReading } from './types.js';

function checkedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const frozen = Object.freeze({ ...request, state: freezeSupport(structuredClone(request.state)),
      questions: freezeSupport(structuredClone(request.questions)), ...(request.context ? { context: freezeSupport(structuredClone(request.context)) } : {}) });
    const result = await port.ask(frozen);
    const answer = result?.answers?.serve;
    if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1
      || typeof result.model !== 'string' || !result.model.trim() || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()
      || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    return result;
  } };
}
/** One bounded pass. Preflight ALL selected inputs before obtaining a port or sending any request. */
export async function readNodeActivations(inputs: readonly { readonly state: Record<string, JsonValue>; readonly reason?: 'missing-evidence' | 'foreign-space' }[], options: KnowledgeNodeActivationOptions = {}): Promise<readonly NodeActivationReading[]> {
  if (options.signal?.aborted) throw new Held('aborted');
  inputs.forEach(({ state }) => assertJudgmentInput(state));
  if (inputs.length > LIMITS.nodes) throw new Held('budget');
  const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  const snapshots = freezeSupport(structuredClone(inputs));
  const questions = Object.fromEntries(Object.entries(nodeServingWithoutReview.items).map(([name, item]) => [name, item.question]));
  const requestBytes = snapshots.reduce((sum, { state }) => sum + new TextEncoder().encode(JSON.stringify({ state, questions })).byteLength + 1_024, 0);
  if (requestBytes > LIMITS.bytes) throw new Held('budget');
  if (!snapshots.length) return [];
  const controller = new AbortController();
  let failure: Held | undefined, rejectStop: (error: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const stop = (error: Held) => { failure ??= error; controller.abort(); rejectStop(failure); };
  const abort = () => stop(new Held('aborted'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
  const check = () => { if (failure) throw failure; if (options.signal?.aborted) throw new Held('aborted'); };
  async function run(): Promise<readonly NodeActivationReading[]> {
    check();
    let port: JudgmentPort | undefined;
    let unavailable: 'unconfigured' | 'unavailable' | undefined;
    if (snapshots.some((input) => !input.reason)) {
      try { port = checkedPort(judgmentPort(nodeServingWithoutReview.name)); }
      catch (error) { unavailable = error instanceof JudgmentPortMissingError ? 'unconfigured' : 'unavailable'; }
    }
    const readings: NodeActivationReading[] = []; let next = 0;
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, snapshots.length) }, async () => {
      while (next < snapshots.length) {
        check(); const index = next++, input = snapshots[index]!;
        if (input.reason || unavailable) { readings[index] = { outcome: 'pending-review', reason: input.reason ?? unavailable }; continue; }
        try {
          const read = await nodeServingWithoutReview.run(port!, input.state, { signal: controller.signal, site: nodeServingWithoutReview.name });
          check(); const reading = read.readings.serve;
          const accepted = reading.outcome === 'act' && reading.verdict === 'yes';
          readings[index] = { outcome: accepted ? 'accepted' : 'pending-review',
            ...(!accepted ? { reason: reading.outcome === 'act' && reading.verdict === 'no' ? 'no' as const : 'uncertain' as const } : {}),
            probability: reading.probability, decisionId: read.result.decisionId, model: read.result.model, requestedModel: read.result.requestedModel };
          read.recordAction(accepted ? 'prepared automatic serving judgment; exact write guard still required; no operator authority or taint removal'
            : 'held for review; no serving authority');
        } catch (error) {
          check(); readings[index] = { outcome: 'pending-review', reason: error instanceof Held ? error.reason : 'unavailable' };
        }
      }
    }));
    check(); return freezeSupport(readings);
  }
  try { return await Promise.race([run(), stopped]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort(); }
}
