import { types as nodeTypes } from 'node:util';
import { captureJudgmentPort, judgmentPort, JudgmentAuthorityRetiredError, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { checkAnswers, toJson, type JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, retainOwnedJson, JudgmentInputError } from '../../../gate/judgment-input.js';
import { prepareJudgmentResult } from '../../../gate/judgment-result.js';
import { createRepairFactUsefulnessReader } from '../repair-usefulness/reader.js';
import { REPAIR_FACT_USEFULNESS_LIMITS as LIMITS } from '../repair-usefulness/types.js';
import { freezeSupport } from '../verification/projection.js';
import { repairFactScoring } from './battery.js';
import { KnowledgeRepairFactScoringHeldError as Held, type RepairFactScoringInput, type RepairFactScoringOptions, type RepairFactScoringReading } from './types.js';
export * from './types.js';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function checkedScore(answer: unknown) {
  if (!record(answer) || answer.type !== 'score' || typeof answer.score !== 'number' || !Number.isFinite(answer.score)
    || answer.score < 0 || answer.score > 4 || typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
    || answer.confidence < 0 || answer.confidence > 1 || !record(answer.probabilities)) throw new Held('malformed');
  const values: Record<string, number> = {};
  if (Object.keys(answer.probabilities).length !== 5) throw new Held('malformed');
  for (let level = 0; level < 5; level++) {
    const probability = answer.probabilities[String(level)];
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Held('malformed');
    values[String(level)] = probability;
  }
  if (Math.abs(Object.values(values).reduce((sum, value) => sum + value, 0) - 1) > 0.01 + Number.EPSILON * 20) throw new Held('malformed');
  return freezeSupport({ type: 'score' as const, score: answer.score, confidence: answer.confidence, probabilities: values,
    legend: Object.fromEntries(repairFactScoring.items.factTrust.question.criteria.map((text, level) => [String(level), text])) });
}

/** The complete fact batch settles before any score is exposed or persistence can begin. */
export async function prepareRepairFactScoring(inputs: readonly RepairFactScoringInput[], options: RepairFactScoringOptions = {}) {
  const { signal, assertCurrent: ownerCurrent, timeoutMs: configuredTimeout } = options;
  const timeoutMs = configuredTimeout ?? LIMITS.defaultTimeoutMs;
  // Reuse the canonical full fact/evidence privacy and lossless schema boundary.
  assertJudgmentInput(inputs);
  const sourceInputs = inputs.map(({ trustEvidence: _trust, ...input }) => input);
  const trustInputs = inputs.map(({ trustEvidence, ...input }) => ({ ...input, evidence: [trustEvidence] }));
  const boundary = createRepairFactUsefulnessReader({ signal });
  boundary.preflight(sourceInputs); boundary.preflight(trustInputs);
  if (inputs.some(input => JSON.stringify(input).length > LIMITS.characters)) throw new Held('budget');
  const originals = retainOwnedJson(inputs, nodeTypes.isProxy);
  const states = inputs.map(input => {
    const state = toJson(input);
    if (!record(state)) throw new Held('malformed');
    return { reference: input.reference, state: freezeSupport(state) };
  });
  let failed: Error | undefined, resultModel: string | undefined;
  const failure = (error: unknown): Error => error instanceof Held || error instanceof JudgmentInputError ? error
    : new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : error instanceof JudgmentAuthorityRetiredError ? 'stale' : 'unavailable');
  const assertOwnerCurrent = () => {
    if (failed) throw failed;
    if (signal?.aborted) throw new Held('aborted');
    if (options.signal !== signal || options.assertCurrent !== ownerCurrent || options.timeoutMs !== configuredTimeout) throw new Held('stale');
    try { originals.assertCurrent(); } catch { throw new Held('stale'); }
    const result: unknown = ownerCurrent?.();
    if (result !== undefined) { try { void Promise.resolve(result).catch(() => {}); } catch { /* Restriction only. */ } throw new Held('stale'); }
    if (options.signal !== signal || options.assertCurrent !== ownerCurrent || options.timeoutMs !== configuredTimeout || signal?.aborted) throw new Held('stale');
    try { originals.assertCurrent(); } catch { throw new Held('stale'); }
  };
  assertOwnerCurrent();
  if (!states.length) return Object.freeze({ readings: Object.freeze([]), assertCurrent: assertOwnerCurrent });
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > LIMITS.timeoutMs) throw new Held('budget');
  const bytes = states.reduce((sum, { state }) => sum + new TextEncoder().encode(JSON.stringify({ state, questions: repairFactScoring.items })).byteLength + 1_024, 0);
  if (states.length > LIMITS.requests || bytes > LIMITS.bytes) throw new Held('budget');
  const admission = prepareJudgmentResult({ factTrust: repairFactScoring.items.factTrust.question,
    sourceSupport: repairFactScoring.items.sourceSupport.question, subjectSupport: repairFactScoring.items.subjectSupport.question }, problem => new Held(problem));
  const controller = new AbortController();
  let stoppedError: Error | undefined, rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (error: Error) => { failed ??= error; stoppedError ??= error; controller.abort(); rejectStopped(stoppedError); };
  const abort = () => stop(new Held('aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Held('budget')), timeoutMs);
  try {
    const authority = captureJudgmentPort(repairFactScoring.name, { signal: controller.signal, assertCurrent: assertOwnerCurrent });
    const configured = judgmentPort(repairFactScoring.name), configuredModel = configured.model;
    if (typeof configuredModel !== 'string' || !configuredModel.trim()) throw new Held('malformed');
    const assertCurrent = () => {
      assertOwnerCurrent(); admission.assertCurrent();
      try { authority.assertCurrent(); if (judgmentPort(repairFactScoring.name) !== configured || configured.model !== configuredModel) throw new Held('stale'); }
      catch (error) { throw error instanceof Held ? error : new Held('stale'); }
    };
    const port: JudgmentPort = { model: configuredModel, ...(authority.port.recorder === undefined ? {} : { recorder: authority.port.recorder }),
      async ask(request) {
        assertCurrent(); const original = await authority.port.ask({ ...request, model: configuredModel }); assertCurrent();
        const result = admission.capture(original);
        if (!record(result) || !record(result.answers) || typeof result.model !== 'string' || !result.model.trim()
          || result.requestedModel !== configuredModel || resultModel !== undefined && result.model !== resultModel
          || result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim())) throw new Held('malformed');
        const answers = { factTrust: checkedScore(result.answers.factTrust), sourceSupport: checkedScore(result.answers.sourceSupport), subjectSupport: checkedScore(result.answers.subjectSupport) };
        try { checkAnswers(request.questions, answers); } catch { throw new Held('malformed'); }
        resultModel = result.model;
        return { ...result, answers: { ...result.answers, ...answers } };
      },
    };
    const readings: RepairFactScoringReading[] = []; let next = 0;
    const work = async () => {
      await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, states.length) }, async () => {
        while (next < states.length) {
          try {
            assertCurrent(); const index = next++, input = states[index]!;
            const result = await repairFactScoring.run(port, input.state, { signal: controller.signal, site: repairFactScoring.name });
            assertCurrent(); const { factTrust, sourceSupport, subjectSupport } = result.readings;
            if ([factTrust, sourceSupport, subjectSupport].some(reading => reading.outcome !== 'act')) throw new Held('uncertain');
            result.recordAction('settled exact fact trust, source support and all-subject attachment scores; separate support, activation and live publication guards remain required');
            assertCurrent(); readings[index] = freezeSupport({ reference: input.reference, trust: factTrust.normalized,
              sourceSupport: sourceSupport.normalized, subjectSupport: subjectSupport.normalized,
              model: result.result.model, requestedModel: result.result.requestedModel });
          } catch (error) { const held = failure(error); stop(held); throw held; }
        }
      }));
      assertCurrent(); return Object.freeze({ readings: freezeSupport(readings), assertCurrent });
    };
    return await Promise.race([work(), stopped]);
  } catch (error) { failed ??= failure(error); throw failed; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
