import type { ContractRunner } from '../contract/runner.js';
import { isTerminalContractStatus } from '../contract/types.js';
import type { ContractView } from '../contract/types.js';
import { hashState } from '@goodvibes-jev/judgment';
import { goalObligationSource } from '../contract/goal-obligation-proof.js';

function recordedReview(contract: ContractView, target: string) {
  const decision = contract.decisions.findLast(entry => entry.targetId === `${contract.id}.${target}`);
  if (!decision) return null;
  try {
    const receipt: unknown = JSON.parse(decision.reason);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
    const record = receipt as Record<string, unknown>;
    const ids = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string' && id.length > 0);
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const version = (value: unknown) => object(value) && typeof value.name === 'string' && value.name.length > 0
      && Number.isSafeInteger(value.version) && (value.version as number) > 0;
    const reading = (value: unknown) => object(value) && typeof value.probability === 'number' && Number.isFinite(value.probability)
      && value.probability >= 0 && value.probability <= 1 && typeof value.verdict === 'string' && typeof value.outcome === 'string';
    const policy = object(record.policy) ? record.policy : null;
    const wellFormed = typeof record.passed === 'boolean' && digest(record.outputDigest) && digest(record.stateHash)
      && ids(record.decisionIds) && policy !== null
      && (target === 'final-answer-review'
        ? record.schemaVersion === 2 && digest(record.evidenceDigest) && ids(record.fulfillmentDecisionIds)
          && version(policy.fulfillment) && version(policy.content) && ['high', 'critical'].includes(String(policy.stakes))
          && object(record.readings) && reading(record.readings.unfinished) && reading(record.readings.unsupported)
        : record.schemaVersion === 1 && version(policy) && digest(record.literalSourceDigest) && ids(record.sourceJudgmentDecisionIds)
          && reading(record.reading) && reading(record.sourceGoal));
    return { record, recordedDecisionId: decision.id, wellFormed,
      matchesSavedAnswer: wellFormed && typeof contract.answer === 'string' && record.outputDigest === hashState(contract.answer),
      ...(target === 'goal-obligations' ? { matchesOriginalScope: wellFormed && record.literalSourceDigest === hashState(goalObligationSource(contract)) } : {}),
      meaning: 'Exact saved native Jev receipt with host-computed bindings. A mismatched or rejected receipt is not acceptance. A matching passed receipt establishes review of that saved result under its recorded policy; it grants no current final-response permit.' };
  } catch { return null; }
}

/** Runtime observations from this session, including terminal work which the
 * active-contract list intentionally omits. These are scoped receipts, never a
 * permit to publish another answer or evidence about unrelated work. */
export function completedContractEvidence(runner: Pick<ContractRunner, 'list'>, sessionId: string) {
  return runner.list({ sessionId, includeTerminal: true, includeInputSnapshot: false })
    .filter(contract => contract.sessionId === sessionId && isTerminalContractStatus(contract.status))
    .map(contract => ({
      kind: 'host-completed-contract', id: contract.id, sessionId: contract.sessionId,
      projectRoot: contract.projectRoot, ask: contract.ask, goal: contract.goal,
      status: contract.status, completedAt: contract.completedAt ?? null,
      originalGoal: contract.originalSource?.goal ?? contract.nativeSource?.goal ?? contract.goal,
      originalCriteria: contract.originalSource?.criteria ?? contract.nativeSource?.criteria ?? null,
      criteria: contract.criteria.map(criterion => ({ id: criterion.id, text: criterion.text,
        quote: criterion.quote ?? null, disposition: criterion.disposition,
        dispositionReason: criterion.dispositionReason ?? null, status: criterion.status,
        reading: criterion.readings.at(-1) ?? null })),
      finalCheck: contract.checks.at(-1) ?? null,
      savedAnswerDigest: typeof contract.answer === 'string' ? hashState(contract.answer) : null,
      contentReview: recordedReview(contract, 'final-answer-review'),
      goalCoverage: recordedReview(contract, 'goal-obligations'),
      units: contract.units.map(unit => ({ id: unit.id, goal: unit.goal, status: unit.status,
        check: unit.checks.at(-1) ?? null })),
      answer: contract.answer ?? null, publication: contract.commit ?? null,
      error: contract.error ?? null, failureKind: contract.failureKind ?? null,
      meaning: 'Actual terminal runtime record for this identified contract and original scope. Its checks describe the saved work, not current final-response approval. A passed status alone does not establish unsupported new claims, current artifact contents, successful publication or unrelated work. Failed/cancelled checks and publication failures remain evidence. Compare the current response and original request with the exact recorded scope, checks, answer, publication and any later invalidating observations.',
    }));
}
