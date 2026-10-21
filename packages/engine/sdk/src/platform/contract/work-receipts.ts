import type { ContractView } from './types.js';
import { findCardNumberShapes } from '../security/card-shapes.js';
import { readPrivateReceiptArchives, verifyPrivateReceiptPreservation } from './private-read-receipts.js';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { ownerEvidenceIdentity } from './owner-evidence.js';

/** Observations can contain incidental card-shaped digit runs (for example
 * adjacent uid/gid/file-size columns). Never send those values to a planner
 * or change its action arguments; retain the exact execution record locally. */
function commandReceipt(command: NonNullable<ContractView['units'][number]['commandEvidence']>[number]) {
  const spans = findCardNumberShapes(command.head);
  if (spans.length === 0) return command;
  let head = command.head;
  for (const span of spans.toReversed()) head = head.slice(0, span.startIndex)
    + '[WITHHELD:card-shaped-number]' + head.slice(span.startIndex + span.length);
  return { ...command, head, headProjection: { withheldSpans: spans.length,
    meaning: 'Card-shaped number spans in this observational output are unavailable here. Markers do not establish their contents or equality. The complete execution receipt remains retained locally; this projection does not approve the command or any claim.' } };
}

/** Facts from the live host tree; these never approve the work receiving them. */
export function contractWorkReceipts(
  contract: Pick<ContractView, 'units'> & Partial<Pick<ContractView, 'id' | 'decisions' | 'groups' | 'projectRoot' | 'inputSnapshot'>>,
  options: { readonly excludeUnitId?: string; readonly readObservations?: boolean; readonly answerIds?: ReadonlySet<string>; readonly ownerEvidence?: JsonValue | undefined } = {},
) {
  const privateArchiveChecks = contract.id === undefined || contract.projectRoot === undefined ? [] : contract.units.flatMap(unit => {
    const checked = verifyPrivateReceiptPreservation({ ...contract, id: contract.id! }, unit, contract.projectRoot!);
    return checked ? [{ unitId: unit.id, gate: checked.gate, passed: checked.passed, output: checked.output,
      ...(checked.skipped === undefined ? {} : { skipped: checked.skipped }) }] : [];
  });
  return {
    contractId: contract.id,
    ...(options.ownerEvidence === undefined ? {} : { ownerPriorReads: options.ownerEvidence }),
    privateArtifacts: contract.id === undefined ? [] : readPrivateReceiptArchives({ ...contract, id: contract.id }),
    privateArchiveChecks,
    meaning: 'Host observations and prior check results, not approval of the current repair. Preserve completed work; missing primary text is not evidence that accepted work never happened.',
    planChecks: (contract.decisions ?? []).filter(decision => decision.action === 'plan-accepted' && decision.targetId === contract.id)
      .map(decision => ({ at: new Date(decision.at).toISOString(), reason: decision.reason, decisionIds: [...decision.decisionIds] })),
    groups: (contract.groups ?? []).map(group => ({ id: group.id, status: group.status,
      latestCheck: group.checks.length ? { id: group.checks.at(-1)!.id, result: group.checks.at(-1)!.result,
        decisionIds: [...group.checks.at(-1)!.decisionIds] } : null })),
    units: contract.units.filter(unit => unit.id !== options.excludeUnitId).map(unit => ({ id: unit.id, goal: unit.goal, status: unit.status,
      latestCheck: unit.checks.length ? { id: unit.checks.at(-1)!.id, result: unit.checks.at(-1)!.result,
        decisionIds: [...unit.checks.at(-1)!.decisionIds] } : null,
      ...(options.readObservations ? { readObservations: (unit.readEvidence ?? []).map(read => ({ path: read.path,
        returnedRanges: [...read.returnedRanges], returnedLines: read.returnedLines })), commands: (unit.commandEvidence ?? []).map(commandReceipt) } : {}),
      ...(unit.status === 'passed' && options.answerIds?.has(unit.id) ? { acceptedAnswer: unit.answer ?? '' } : {}),
    })),
  };
}

/** Timing and session-file bookkeeping do not change the actual work a
 * retained correction proposal addresses. Changed observations still do. */
export function workReceiptIdentity(work: ReturnType<typeof contractWorkReceipts>) {
  return { ...work,
    privateArchiveChecks: work.privateArchiveChecks.map(check => Object.fromEntries(Object.entries(check).filter(([key]) => key !== 'durationMs'))),
    ...(work.ownerPriorReads === undefined ? {} : { ownerPriorReads: ownerEvidenceIdentity(work.ownerPriorReads) }),
  };
}
