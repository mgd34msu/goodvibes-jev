import type { ContractView } from './types.js';

/** Facts from the live host tree; these never approve the work receiving them. */
export function contractWorkReceipts(
  contract: Pick<ContractView, 'units'> & Partial<Pick<ContractView, 'id' | 'decisions' | 'groups'>>,
  options: { readonly excludeUnitId?: string; readonly readObservations?: boolean; readonly answerIds?: ReadonlySet<string> } = {},
) {
  return {
    contractId: contract.id,
    meaning: 'Host observations and prior check results, not approval of the current repair. Preserve completed work; missing primary text is not evidence that accepted work never happened.',
    planChecks: (contract.decisions ?? []).filter(decision => decision.action === 'plan-accepted' && decision.targetId === contract.id)
      .map(decision => ({ at: decision.at, reason: decision.reason, decisionIds: [...decision.decisionIds] })),
    groups: (contract.groups ?? []).map(group => ({ id: group.id, status: group.status,
      latestCheck: group.checks.length ? { id: group.checks.at(-1)!.id, result: group.checks.at(-1)!.result,
        decisionIds: [...group.checks.at(-1)!.decisionIds] } : null })),
    units: contract.units.filter(unit => unit.id !== options.excludeUnitId).map(unit => ({ id: unit.id, goal: unit.goal, status: unit.status,
      latestCheck: unit.checks.length ? { id: unit.checks.at(-1)!.id, result: unit.checks.at(-1)!.result,
        decisionIds: [...unit.checks.at(-1)!.decisionIds] } : null,
      ...(options.readObservations ? { readObservations: (unit.readEvidence ?? []).map(read => ({ path: read.path,
        returnedRanges: [...read.returnedRanges], returnedLines: read.returnedLines })), commands: unit.commandEvidence ?? [] } : {}),
      ...(unit.status === 'passed' && options.answerIds?.has(unit.id) ? { acceptedAnswer: unit.answer ?? '' } : {}),
    })),
  };
}
