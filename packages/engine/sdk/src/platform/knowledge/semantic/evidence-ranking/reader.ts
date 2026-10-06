import { createHash } from 'node:crypto';
import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson, type JsonValue, type JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../verification/projection.js';
import { answerEvidenceRelevance } from './battery.js';
import { EVIDENCE_RELEVANCE_LIMITS as LIMITS, KnowledgeEvidenceRelevanceHeldError as Held, type AnswerEvidenceRelevanceInput,
  type AnswerEvidenceRelevanceReading, type AnswerEvidenceRelevancePlan } from './types.js';
export * from './types.js';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function optionalText(value: unknown): boolean { return value === undefined || typeof value === 'string'; }
export function snapshotAnswerEvidenceRelevanceInput(input: AnswerEvidenceRelevanceInput): AnswerEvidenceRelevanceInput {
  assertJudgmentInput(input);
  if (!record(input) || Object.keys(input).some((key) => !['query', 'candidates', 'subjects'].includes(key))
    || typeof input.query !== 'string' || !Array.isArray(input.candidates)) throw new Held('malformed');
  if (input.candidates.length > LIMITS.candidates) throw new Held('budget');
  if (input.subjects !== undefined) {
    if (!Array.isArray(input.subjects)) throw new Held('malformed');
    if (input.subjects.length > LIMITS.subjects) throw new Held('budget');
    for (const subject of input.subjects) {
      if (!record(subject) || Object.keys(subject).some((key) => !['title', 'kind', 'summary', 'aliases', 'identity'].includes(key))
        || typeof subject.title !== 'string' || typeof subject.kind !== 'string'
        || !Array.isArray(subject.aliases) || subject.aliases.some((alias) => typeof alias !== 'string')
        || !optionalText(subject.summary)
        || (subject.identity !== undefined && (!record(subject.identity)
          || Object.keys(subject.identity).some((key) => !['manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'entityKind', 'subject', 'homeAssistant'].includes(key))))) throw new Held('malformed');
    }
  }
  const references = new Set<string>();
  for (const candidate of input.candidates) {
    if (!record(candidate) || Object.keys(candidate).some((key) => !['reference', 'kind', 'title', 'text', 'facts', 'sourceType', 'nodeKind', 'claimedProvenance'].includes(key))
      || typeof candidate.reference !== 'string' || !/^candidate-[1-9]\d*$/.test(candidate.reference) || references.has(candidate.reference)
      || (candidate.kind !== 'source' && candidate.kind !== 'node') || typeof candidate.title !== 'string' || typeof candidate.text !== 'string'
      || ![candidate.sourceType, candidate.nodeKind, candidate.claimedProvenance].every(optionalText)) throw new Held('malformed');
    references.add(candidate.reference);
    if (candidate.facts !== undefined) {
      if (!Array.isArray(candidate.facts)) throw new Held('malformed');
      if (candidate.facts.length > LIMITS.facts) throw new Held('budget');
      for (const fact of candidate.facts) {
        if (!record(fact) || Object.keys(fact).some((key) => !['title', 'kind', 'summary', 'value', 'evidence', 'details'].includes(key))
          || typeof fact.title !== 'string' || !optionalText(fact.kind) || !optionalText(fact.summary) || !optionalText(fact.evidence) || !optionalText(fact.details)
          || (fact.value !== undefined && fact.value !== null && typeof fact.value !== 'string' && typeof fact.value !== 'boolean'
            && !(typeof fact.value === 'number' && Number.isFinite(fact.value)))) throw new Held('malformed');
      }
    }
  }
  if (JSON.stringify(input).length > LIMITS.characters) throw new Held('budget');
  return freezeSupport(structuredClone(input));
}
function jsonState(value: object): Record<string, JsonValue> {
  const state = toJson(value);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Held('malformed');
  return freezeSupport(state);
}
function validatedPort(port: JudgmentPort, beforeAsk: () => void): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    beforeAsk();
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
/** Pure initial ranking. Callers retain access/serving filters and must revalidate their local record map before applying it. */
export async function prepareAnswerEvidenceRelevance(input: AnswerEvidenceRelevanceInput, options: {
  readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
} = {}): Promise<AnswerEvidenceRelevancePlan> {
  if (options.signal?.aborted) throw new Held('aborted');
  const snapshot = snapshotAnswerEvidenceRelevanceInput(input);
  const inputHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  if (!snapshot.query.trim() || !snapshot.candidates.length) return freezeSupport({ inputHash, accepted: [], rejected: [] });
  const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  const controller = new AbortController();
  let stoppedError: Held | undefined, rejectStopped: (error: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: Held) => { stoppedError ??= error; controller.abort(); rejectStopped(stoppedError); };
  const abort = () => stop(new Held('aborted'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
  const check = () => { if (stoppedError) throw stoppedError; if (options.signal?.aborted) throw new Held('aborted'); options.assertCurrent?.(); };
  const run = async () => {
    check(); const configuredPort = judgmentPort('engine.knowledge.answer-evidence-relevance');
    const configuredModel = configuredPort.model;
    const checkConfiguration = () => {
      if (judgmentPort('engine.knowledge.answer-evidence-relevance') !== configuredPort || configuredPort.model !== configuredModel) throw new Held('stale');
    };
    const port = validatedPort(configuredPort, () => { check(); checkConfiguration(); });
    const readings: AnswerEvidenceRelevanceReading[] = []; let next = 0;
    let model: string | undefined, requestedModel: string | undefined;
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, snapshot.candidates.length) }, async () => {
      while (next < snapshot.candidates.length) {
        check(); const index = next++; const candidate = snapshot.candidates[index]!;
        try {
          const read = await answerEvidenceRelevance.run(port, jsonState({ query: snapshot.query, candidate, ...(snapshot.subjects ? { subjects: snapshot.subjects } : {}) }),
            { signal: controller.signal, site: 'engine.knowledge.answer-evidence-relevance' });
          check(); checkConfiguration();
          if ((model !== undefined && read.result.model !== model) || (requestedModel !== undefined && read.result.requestedModel !== requestedModel)) throw new Held('stale');
          model = read.result.model; requestedModel = read.result.requestedModel;
          const useful = read.readings.useful;
          if (useful.outcome !== 'act' || useful.verdict === 'uncertain') throw new Held('unsettled');
          readings[index] = { reference: candidate.reference, probability: useful.probability, verdict: useful.verdict, outcome: 'act',
            ...(read.result.decisionId ? { decisionId: read.result.decisionId } : {}) };
          read.recordAction(`settled evidence relevance ${useful.verdict}; serving and write authority are separate`);
        } catch (error) { const failure = error instanceof Held ? error : new Held('unavailable'); stop(failure); throw failure; }
      }
    }));
    check(); checkConfiguration();
    const order = new Map(snapshot.candidates.map((candidate, index) => [candidate.reference, index]));
    return freezeSupport({ inputHash, model, requestedModel,
      accepted: readings.filter((reading) => reading.verdict === 'yes').sort((a, b) => b.probability - a.probability || order.get(a.reference)! - order.get(b.reference)!),
      rejected: readings.filter((reading) => reading.verdict === 'no'),
    });
  };
  try { return await Promise.race([run(), stopped]); }
  catch (error) { controller.abort(); throw error instanceof Held ? error : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : 'unavailable'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
