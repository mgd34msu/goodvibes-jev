import type { ContractRunner } from '../contract/runner.js';
import { isTerminalContractStatus } from '../contract/types.js';

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
      units: contract.units.map(unit => ({ id: unit.id, goal: unit.goal, status: unit.status,
        check: unit.checks.at(-1) ?? null })),
      answer: contract.answer ?? null, publication: contract.commit ?? null,
      error: contract.error ?? null, failureKind: contract.failureKind ?? null,
      meaning: 'Actual terminal runtime record for this identified contract and original scope. Its checks describe the saved work, not current final-response approval. A passed status alone does not establish unsupported new claims, current artifact contents, successful publication or unrelated work. Failed/cancelled checks and publication failures remain evidence. Compare the current response and original request with the exact recorded scope, checks, answer, publication and any later invalidating observations.',
    }));
}
