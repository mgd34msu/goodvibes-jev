import { createHash } from 'node:crypto';
import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { JudgmentInputError } from '../../../gate/judgment-input.js';
import { withAnswerVerificationBudget } from '../answer-verification/budget.js';
import { KnowledgeAnswerQualityHeldError } from '../answer-verification/types.js';
import { freezeSupport } from '../verification/projection.js';
import { prepareAnswerEvidenceRelevance, snapshotAnswerEvidenceRelevanceInput } from './reader.js';
import { EVIDENCE_RELEVANCE_LIMITS as LIMITS, KnowledgeEvidenceRelevanceHeldError as Held,
  type AnswerEvidenceCandidate, type AnswerEvidenceRelevanceInput, type AnswerEvidenceRelevancePlan,
  type AnswerEvidenceRelevanceReading } from './types.js';

/** Inspect container descriptors without invoking caller-controlled getters or
 * copying an entire corpus through a single-candidate privacy/transport limit.
 */
function envelope(input: AnswerEvidenceRelevanceInput) {
  const own = (value: unknown, array: boolean): PropertyDescriptorMap => {
    if (!value || typeof value !== 'object' || Array.isArray(value) !== array
      || (array ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      || Object.getOwnPropertySymbols(value).length) throw new JudgmentInputError('unsupported-input');
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.values(fields).some((field) => !('value' in field) || typeof field.value === 'function')) throw new JudgmentInputError('unsupported-input');
    return fields;
  };
  const fields = own(input, false);
  if (Object.keys(fields).some((key) => !['query', 'candidates', 'subjects'].includes(key))) throw new Held('malformed');
  const values = own(fields.candidates?.value, true);
  if (Object.keys(values).some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) throw new Held('malformed');
  const length: unknown = values.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new Held('malformed');
  const head = snapshotAnswerEvidenceRelevanceInput({ query: fields.query?.value as string, candidates: [],
    ...(fields.subjects ? { subjects: fields.subjects.value as AnswerEvidenceRelevanceInput['subjects'] } : {}) });
  return { head, values, length };
}

/** Whole candidates only. Every candidate is protected and validated before the
 * first dispatch, including candidates in later batches. The existing 100-row
 * and 160k limits apply to each reader input, never to a silently truncated corpus.
 */
function prepareBatches(input: AnswerEvidenceRelevanceInput) {
  const { head, values, length } = envelope(input);
  const baseCharacters = JSON.stringify(head).length;
  const batches: AnswerEvidenceRelevanceInput[] = [];
  const ordinals = new Map<string, number>();
  const hash = createHash('sha256').update(JSON.stringify(head));
  let candidates: AnswerEvidenceCandidate[] = [], characters = baseCharacters;
  const flush = () => { if (candidates.length) batches.push(freezeSupport({ ...head, candidates })); candidates = []; characters = baseCharacters; };
  for (let index = 0; index < length; index++) {
    if (!values[String(index)]) throw new JudgmentInputError('unsupported-input');
    const one = snapshotAnswerEvidenceRelevanceInput({ ...head, candidates: [values[String(index)]!.value as AnswerEvidenceCandidate] });
    const candidate = one.candidates[0]!;
    if (ordinals.has(candidate.reference)) throw new Held('malformed');
    ordinals.set(candidate.reference, index);
    const text = JSON.stringify(candidate);
    hash.update('\0').update(text);
    const nextCharacters = characters + text.length + (candidates.length ? 1 : 0);
    if (candidates.length === LIMITS.candidates || nextCharacters > LIMITS.characters) flush();
    characters += text.length + (candidates.length ? 1 : 0);
    candidates.push(candidate);
  }
  flush();
  return { batches, ordinals, inputHash: hash.digest('hex'), query: head.query };
}

/** Reuses the same reading and transport. Its actual requests contain one
 * candidate, query and subjects, never batch peers: batching cannot alter the
 * question, and same-model probabilities retain one stable global ordering.
 */
export async function prepareAnswerEvidenceRelevanceBatches(input: AnswerEvidenceRelevanceInput, options: {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
} = {}): Promise<AnswerEvidenceRelevancePlan> {
  try {
    return await withAnswerVerificationBudget(async (signal, deadlineAt) => {
      const prepared = prepareBatches(input);
      const active = () => {
        if (signal.aborted) throw new Held('aborted');
        if (Date.now() >= deadlineAt) throw new Held('budget');
        options.assertCurrent?.();
      };
      active();
      if (!prepared.query.trim() || !prepared.batches.length) return freezeSupport({ inputHash: prepared.inputHash, accepted: [], rejected: [] });
      const configured = judgmentPort('engine.knowledge.answer-evidence-relevance'), configuredModel = configured.model;
      const check = () => {
        active();
        if (judgmentPort('engine.knowledge.answer-evidence-relevance') !== configured || configured.model !== configuredModel) throw new Held('stale');
      };
      const accepted: AnswerEvidenceRelevanceReading[] = [], rejected: AnswerEvidenceRelevanceReading[] = [];
      let model: string | undefined, requestedModel: string | undefined;
      for (const batch of prepared.batches) {
        check();
        const plan = await prepareAnswerEvidenceRelevance(batch, { signal, timeoutMs: Math.max(1, deadlineAt - Date.now()), assertCurrent: check });
        check();
        if ((model !== undefined && model !== plan.model) || (requestedModel !== undefined && requestedModel !== plan.requestedModel)) throw new Held('stale');
        model = plan.model; requestedModel = plan.requestedModel;
        accepted.push(...plan.accepted); rejected.push(...plan.rejected);
      }
      check();
      accepted.sort((a, b) => b.probability - a.probability || prepared.ordinals.get(a.reference)! - prepared.ordinals.get(b.reference)!);
      rejected.sort((a, b) => prepared.ordinals.get(a.reference)! - prepared.ordinals.get(b.reference)!);
      return freezeSupport({ inputHash: prepared.inputHash, model, requestedModel, accepted, rejected });
    }, options.timeoutMs ?? LIMITS.defaultTimeoutMs, options.signal);
  } catch (error) {
    if (error instanceof Held || error instanceof JudgmentInputError) throw error;
    if (error instanceof KnowledgeAnswerQualityHeldError && (error.reason === 'budget' || error.reason === 'aborted')) throw new Held(error.reason);
    throw new Held(error instanceof JudgmentPortMissingError ? 'unconfigured' : 'unavailable');
  }
}
