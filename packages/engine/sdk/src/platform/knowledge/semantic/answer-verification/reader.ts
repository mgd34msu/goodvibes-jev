import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { toJson, type JudgmentPort, type YesNoReading, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../verification/projection.js';
import { answerCandidateQuality, answerEvidenceSufficiency, answerCandidatePreference } from './batteries.js';
import { KnowledgeAnswerQualityHeldError as Held, type AnswerCandidate, type AnswerQualityBoolean,
  type AnswerVerificationInput, type VerifiedAnswerSelection } from './types.js';
export * from './types.js';

export const ANSWER_VERIFICATION_LIMITS = Object.freeze({ evidence: 24, candidates: 2, characters: 160_000, candidateCharacters: 16_000, timeoutMs: 60_000 });
function jsonState(value: object): Record<string, JsonValue> {
  const state = toJson(value);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Held('malformed');
  return freezeSupport(state);
}
function booleanReading(reading: YesNoReading): AnswerQualityBoolean {
  if (reading.outcome !== 'act' || reading.verdict === 'uncertain') throw new Held('uncertain');
  return { verdict: reading.verdict, probability: reading.probability, outcome: 'act' };
}
function snapshotInput(input: AnswerVerificationInput): AnswerVerificationInput {
  assertJudgmentInput(input);
  if (typeof input.query !== 'string' || !input.query.trim() || !Array.isArray(input.evidence) || !Array.isArray(input.candidates)) throw new Held('malformed');
  if (input.evidence.length > ANSWER_VERIFICATION_LIMITS.evidence || input.candidates.length > 2) throw new Held('budget');
  const references = new Set<string>(), candidates = new Set<string>();
  for (const evidence of input.evidence) {
    if (!evidence || typeof evidence.reference !== 'string' || !/^evidence-[1-9]\d*$/.test(evidence.reference)
      || references.has(evidence.reference) || typeof evidence.text !== 'string'
      || (evidence.title !== undefined && typeof evidence.title !== 'string')) throw new Held('malformed');
    references.add(evidence.reference);
    for (const values of [evidence.facts, evidence.subjects]) if (values !== undefined) {
      if (!Array.isArray(values)) throw new Held('malformed');
      for (const value of values) if (typeof value !== 'string') throw new Held('malformed');
    }
  }
  for (const candidate of input.candidates) {
    if (!candidate || !['generated', 'rendered'].includes(candidate.id) || candidates.has(candidate.id)
      || typeof candidate.text !== 'string' || !candidate.text.trim()) throw new Held('malformed');
    if (candidate.text.length > ANSWER_VERIFICATION_LIMITS.candidateCharacters) throw new Held('budget');
    if (candidate.facts !== undefined) {
      if (!Array.isArray(candidate.facts)) throw new Held('malformed');
      for (const value of candidate.facts) if (typeof value !== 'string') throw new Held('malformed');
    }
    candidates.add(candidate.id);
    for (const match of [candidate.text, ...(candidate.facts ?? [])].join('\n').matchAll(/\[ref:[^\]]*(?:\]|$)/g)) {
      const reference = /^\[ref:(evidence-[1-9]\d*)\]$/.exec(match[0])?.[1];
      if (!reference || !references.has(reference)) throw new Held('malformed');
    }
  }
  const snapshot = { query: input.query, evidence: input.evidence.map(({ reference, title, text, facts, subjects }) => ({ reference, title, text, facts, subjects })),
    candidates: input.candidates.map(({ id, text, facts }) => ({ id, text, facts })) };
  if (JSON.stringify(snapshot).length > ANSWER_VERIFICATION_LIMITS.characters) throw new Held('budget');
  return freezeSupport(structuredClone(snapshot));
}
function validatedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    const result = await port.ask(request);
    if (!result?.answers || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    for (const [name, question] of Object.entries(request.questions)) {
      const value: unknown = result.answers[name];
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== question.type) throw new Held('malformed');
      if (question.type === 'noul') {
        if (!('noul' in value) || typeof value.noul !== 'number' || !Number.isFinite(value.noul) || value.noul < 0 || value.noul > 1) throw new Held('malformed');
      } else if (question.type === 'choice') {
        if (!('choice' in value) || typeof value.choice !== 'string' || !Object.hasOwn(question.criteria, value.choice)
          || !('confidence' in value) || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
          || !('probabilities' in value) || !value.probabilities || typeof value.probabilities !== 'object') throw new Held('malformed');
        const probabilities = value.probabilities as Record<string, unknown>;
        const scores = Object.keys(question.criteria).map((key) => probabilities[key]);
        if (scores.some((score) => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) throw new Held('malformed');
        if (Math.abs((scores as number[]).reduce((sum, score) => sum + score, 0) - 1) > 0.00001
          || Math.abs(Number(probabilities[value.choice]) - value.confidence) > 0.00001) throw new Held('malformed');
      }
    }
    return result;
  } };
}
/** Read-only, all-selected-candidate barrier. The caller owns fresh-state validation before gap writes. */
export async function verifyKnowledgeAnswer(input: AnswerVerificationInput,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<VerifiedAnswerSelection> {
  if (options.signal?.aborted) throw new Held('aborted');
  const snapshot = snapshotInput(input);
  if (!snapshot.evidence.some((row) => row.text.trim())) return freezeSupport({ confidence: 0, quality: { status: 'no-evidence', decisionIds: [] } });
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > ANSWER_VERIFICATION_LIMITS.timeoutMs) throw new Held('budget');
  const controller = new AbortController();
  let reason: 'aborted' | 'budget' | undefined;
  const abort = () => { reason ??= 'aborted'; controller.abort(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { reason ??= 'budget'; controller.abort(); }, timeoutMs);
  let stopRace = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new Held(reason ?? 'aborted'));
    controller.signal.addEventListener('abort', stop, { once: true });
    stopRace = () => controller.signal.removeEventListener('abort', stop);
  });
  const check = () => { if (controller.signal.aborted || options.signal?.aborted) throw new Held(reason ?? 'aborted'); };
  const run = async (): Promise<VerifiedAnswerSelection> => {
    check(); const port = validatedPort(judgmentPort('engine.knowledge.answer-quality'));
    const settings = { signal: controller.signal, site: 'engine.knowledge.answer-quality' };
    const evidencePromise = answerEvidenceSufficiency.run(port, jsonState({ query: snapshot.query, evidence: snapshot.evidence }), settings);
    const candidatePromises = snapshot.candidates.map(async (candidate) => ({ candidate,
      run: await answerCandidateQuality.run(port, jsonState({ query: snapshot.query, evidence: snapshot.evidence, candidate }), settings),
    }));
    const [evidenceRun, readings] = await Promise.all([evidencePromise, Promise.all(candidatePromises)]);
    check();
    const enough = booleanReading(evidenceRun.readings.enough);
    const decisions = [evidenceRun.result.decisionId, ...readings.map(({ run }) => run.result.decisionId)].filter((id): id is string => id !== undefined);
    const read = readings.map(({ candidate, run }) => {
      if (run.readings.fidelity.outcome !== 'act') throw new Held('uncertain');
      const complete = booleanReading(run.readings.complete);
      run.recordAction(`candidate ${candidate.id}: ${run.readings.fidelity.choice}; complete=${complete.verdict}; no write yet`);
      return { candidate, fidelity: run.readings.fidelity, complete };
    });
    evidenceRun.recordAction(`evidence sufficiency=${enough.verdict}; no repair write yet`);
    const supported = read.filter(({ fidelity }) => fidelity.choice === 'supported');
    const complete = supported.filter((candidate) => candidate.complete.verdict === 'yes');
    const eligible = complete.length ? complete : supported;
    if (!eligible.length) return freezeSupport({ confidence: 0, quality: { status: 'unsupported', evidenceSufficient: enough, decisionIds: decisions } });
    let selected = eligible[0]!;
    if (eligible.length > 1) {
      check();
      const preference = await answerCandidatePreference.run(port, jsonState({ query: snapshot.query,
        candidates: Object.fromEntries(eligible.map(({ candidate }) => [candidate.id, candidate.text])),
      }), settings);
      check();
      if (preference.readings.preferred.outcome !== 'act') throw new Held('uncertain');
      selected = eligible.find(({ candidate }) => candidate.id === preference.readings.preferred.choice)!;
      if (!selected) throw new Held('malformed');
      if (preference.result.decisionId) decisions.push(preference.result.decisionId);
      preference.recordAction(`selected verified candidate ${selected.candidate.id}; no write yet`);
    }
    return freezeSupport({ candidate: selected.candidate, confidence: Math.round(selected.fidelity.confidence * 100), quality: {
      status: selected.complete.verdict === 'yes' && enough.verdict === 'yes' ? 'verified' : 'partial',
      fidelity: { verdict: selected.fidelity.choice, probability: selected.fidelity.confidence, outcome: selected.fidelity.outcome },
      evidenceSufficient: enough, answerComplete: selected.complete, decisionIds: decisions,
    } });
  };
  try { return await Promise.race([run(), cancelled]); }
  catch (error) { controller.abort(); throw error instanceof Held ? error : new Held('unavailable'); }
  finally { clearTimeout(timer); stopRace(); options.signal?.removeEventListener('abort', abort); }
}
