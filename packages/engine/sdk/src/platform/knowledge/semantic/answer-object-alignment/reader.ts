import { createHash } from 'node:crypto';
import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson, type JsonValue, type JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { snapshotNodeInput } from '../../activation/projection.js';
import { freezeSupport } from '../verification/projection.js';
import { answerIntegrationIntent, answerObjectAlignment } from './battery.js';
import { ANSWER_OBJECT_LIMITS as LIMITS, KnowledgeAnswerObjectAlignmentHeldError as Held,
  type AnswerObjectAlignmentInput, type AnswerObjectAlignmentPlan, type AnswerObjectReading, type AnswerObjectBoolean } from './types.js';
export * from './types.js';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Full protected-data preflight also runs synchronously before the answer's first evidence request. */
export function snapshotAnswerObjectInput(input: AnswerObjectAlignmentInput): AnswerObjectAlignmentInput {
  const snapshot = snapshotNodeInput(input);
  assertJudgmentInput(snapshot);
  if (!record(snapshot) || Object.keys(snapshot).some((key) => !['query', 'candidates'].includes(key))
    || typeof snapshot.query !== 'string' || !snapshot.query.trim() || !Array.isArray(snapshot.candidates)) throw new Held('malformed');
  if (snapshot.candidates.length > LIMITS.candidates) throw new Held('budget');
  const references = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (!record(candidate) || Object.keys(candidate).some((key) => !['reference', 'kind', 'title', 'summary', 'aliases', 'content', 'associations'].includes(key))
      || typeof candidate.reference !== 'string' || !/^object-[1-9]\d*$/.test(candidate.reference) || references.has(candidate.reference)
      || typeof candidate.title !== 'string' || typeof candidate.kind !== 'string'
      || (candidate.summary !== undefined && typeof candidate.summary !== 'string')
      || !Array.isArray(candidate.aliases) || candidate.aliases.some((alias) => typeof alias !== 'string')
      || !record(candidate.content) || !Array.isArray(candidate.associations)) throw new Held('malformed');
    references.add(candidate.reference);
    if (candidate.associations.length > LIMITS.associations) throw new Held('budget');
    for (const association of candidate.associations) {
      if (!record(association) || Object.keys(association).some((key) => !['origin', 'reference', 'relation'].includes(key))
        || !['caller-context', 'evidence', 'fact', 'graph'].includes(association.origin as string)
        || (association.reference !== undefined && (typeof association.reference !== 'string' || !/^(object|context)-[1-9]\d*$/.test(association.reference)))
        || (association.relation !== undefined && typeof association.relation !== 'string')) throw new Held('malformed');
    }
  }
  if (JSON.stringify(snapshot).length > LIMITS.characters) throw new Held('budget');
  return snapshot;
}
function jsonState(value: object): Record<string, JsonValue> {
  const state = toJson(value);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Held('malformed');
  return freezeSupport(state);
}
function validatedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const result = await port.ask(request);
    if (!result?.answers || typeof result.model !== 'string' || !result.model.trim()
      || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()
      || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    for (const name of Object.keys(request.questions)) {
      const answer: unknown = result.answers[name];
      if (!record(answer) || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)
        || answer.noul < 0 || answer.noul > 1) throw new Held('malformed');
    }
    return result;
  } };
}
function settled(reading: { readonly probability: number; readonly verdict: string; readonly outcome: string }): AnswerObjectBoolean {
  if (reading.outcome !== 'act' || (reading.verdict !== 'yes' && reading.verdict !== 'no')) throw new Held('uncertain');
  return { probability: reading.probability, verdict: reading.verdict, outcome: 'act' };
}
/** Read-only preparation. Access, identity/provenance and write guards remain the caller's responsibility. */
export async function readAnswerObjectAlignment(input: AnswerObjectAlignmentInput, options: {
  readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
} = {}): Promise<AnswerObjectAlignmentPlan> {
  if (options.signal?.aborted) throw new Held('aborted');
  const snapshot = snapshotAnswerObjectInput(input);
  const inputHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  options.assertCurrent?.();
  if (!snapshot.candidates.length) return freezeSupport({ inputHash, accepted: [], rejected: [] });
  const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  const controller = new AbortController();
  let stoppedError: Held | undefined, rejectStopped: (error: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: Held) => { stoppedError ??= error; controller.abort(); rejectStopped(stoppedError); };
  const abort = () => stop(new Held('aborted'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
  const check = () => {
    if (stoppedError) throw stoppedError;
    if (options.signal?.aborted) throw new Held('aborted');
    options.assertCurrent?.();
  };
  const run = async () => {
    check();
    const intentPort = judgmentPort('engine.knowledge.answer-integration-intent');
    const objectPort = judgmentPort('engine.knowledge.answer-object-alignment');
    const intentModel = intentPort.model, objectModel = objectPort.model;
    const checkConfiguration = () => {
      if (judgmentPort('engine.knowledge.answer-integration-intent') !== intentPort || intentPort.model !== intentModel
        || judgmentPort('engine.knowledge.answer-object-alignment') !== objectPort || objectPort.model !== objectModel) throw new Held('stale');
    };
    const intent = await answerIntegrationIntent.run(validatedPort(intentPort), jsonState(snapshot),
      { signal: controller.signal, site: 'engine.knowledge.answer-integration-intent' });
    check(); checkConfiguration();
    const integrationIntent = settled(intent.readings.integrationIntent);
    intent.recordAction(`settled integration intent ${integrationIntent.verdict}; no subject or write authority`);
    const readings: AnswerObjectReading[] = []; let next = 0;
    let model: string | undefined, requestedModel: string | undefined;
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, snapshot.candidates.length) }, async () => {
      while (next < snapshot.candidates.length) {
        check(); const index = next++; const candidate = snapshot.candidates[index]!;
        try {
          const read = await answerObjectAlignment.run(validatedPort(objectPort), jsonState({ query: snapshot.query, candidate, candidates: snapshot.candidates }),
            { signal: controller.signal, site: 'engine.knowledge.answer-object-alignment' });
          check(); checkConfiguration();
          if ((model !== undefined && read.result.model !== model) || (requestedModel !== undefined && read.result.requestedModel !== requestedModel)) throw new Held('stale');
          model = read.result.model; requestedModel = read.result.requestedModel;
          const concreteObject = settled(read.readings.concreteObject), integrationObject = settled(read.readings.integrationObject), aligned = settled(read.readings.aligned);
          const selected = concreteObject.verdict === 'yes' && aligned.verdict === 'yes'
            && (integrationObject.verdict === 'no' || integrationIntent.verdict === 'yes');
          readings[index] = { reference: candidate.reference, concreteObject, integrationObject, aligned, selected,
            ...(read.result.decisionId ? { decisionId: read.result.decisionId } : {}) };
          read.recordAction(`prepared linked-object ${selected ? 'selection' : 'rejection'}; original associations retained locally; no authorization`);
        } catch (error) { const failure = error instanceof Held ? error : new Held('unavailable'); stop(failure); throw failure; }
      }
    }));
    check(); checkConfiguration();
    const accepted = readings.filter((reading) => reading.selected);
    if (accepted.length > LIMITS.selected) throw new Held('budget');
    // Keep actual alignment probabilities. No old point scale or fixed kind ladder.
    const order = new Map(snapshot.candidates.map((candidate, index) => [candidate.reference, index]));
    accepted.sort((a, b) => b.aligned.probability - a.aligned.probability || order.get(a.reference)! - order.get(b.reference)!);
    return freezeSupport({ inputHash, integrationIntent, model, requestedModel, accepted, rejected: readings.filter((reading) => !reading.selected) });
  };
  try { return await Promise.race([run(), stopped]); }
  catch (error) { controller.abort(); throw error instanceof Held ? error : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : 'unavailable'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
