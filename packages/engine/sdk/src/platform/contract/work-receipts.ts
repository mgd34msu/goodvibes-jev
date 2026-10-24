import type { ContractView } from './types.js';
import { findCardNumberShapes } from '../security/card-shapes.js';
import { readPrivateReceiptArchives, verifyPrivateReceiptPreservation } from './private-read-receipts.js';
import { hashState, type JsonValue } from '@goodvibes-jev/judgment';
import { ownerEvidenceIdentity } from './owner-evidence.js';
import { commandObservation } from './command-observation.js';
import { currentFileObservations } from './current-file-observations.js';
import { compareJsonReadReferences, compareReadReferences } from './read-reference-comparison.js';
import { acceptedResearchIds } from './accepted-research.js';
import { compactReviewInventory, reviewInventoryObservation } from './review-inventory.js';

/** The same actual source accounting used by native acceptance and recovery. */
export function contractSourceScope(contract: Pick<ContractView, 'units'> & Partial<Pick<ContractView, 'criteria'>>, cwd: string,
  ownerEvidence?: JsonValue, contexts = (contract.criteria ?? []).map(criterion => ({ field: `criterion ${criterion.id}`, text: criterion.text }))) {
  const ownerReads = ownerEvidence && typeof ownerEvidence === 'object' && !Array.isArray(ownerEvidence)
    && Array.isArray(ownerEvidence['sourceReads']) ? ownerEvidence['sourceReads'].flatMap(read =>
      read && typeof read === 'object' && !Array.isArray(read) && typeof read['path'] === 'string'
        && Array.isArray(read['returnedRanges']) && read['returnedRanges'].every(range => typeof range === 'string')
        ? [{ path: read['path'], returnedRanges: read['returnedRanges'] as string[] }] : []) : [];
  const passed = contract.units.filter(unit => unit.status === 'passed');
  const observations: { source: string; reads: readonly { path: string; returnedRanges: readonly string[] }[] }[] = [
    ...passed.map(unit => ({ source: `passed unit ${unit.id}`, reads: unit.readEvidence ?? [] })),
    { source: 'qualified original-owner observations', reads: ownerReads }];
  const references = [...new Map(passed.flatMap(unit => unit.readEvidence ?? [])
    .filter(read => read.contentKind === 'declared-reference' && read.returnedContent !== undefined && read.path.toLowerCase().endsWith('.json'))
    .map(read => [JSON.stringify([read.path, hashState(read.returnedContent!)]), read])).values()];
  const referenceOperations = currentFileObservations(cwd, references.map(read => read.path));
  return { referenceOperations,
    sourceJsonReferenceComparisons: compareJsonReadReferences(references, referenceOperations, observations),
    sourceReferenceComparisons: compareReadReferences(contexts, observations.flatMap(source => source.reads), observations),
    meaning: 'Actual current native-host calculations over complete retained JSON reference bytes matching their current file identities and qualified returned observations. These results are provided directly, independently of assistant assertions or integrator execution logs. They establish literal interval arithmetic and attribution only, not requirement interpretation, substantive assessment, worker script execution or native approval. Earlier context that lacked these data does not invalidate the current observed results.' };
}

/** Observations can contain incidental card-shaped digit runs (for example
 * adjacent uid/gid/file-size columns). Never send those values to a planner
 * or change its action arguments; retain the exact execution record locally. */
function commandReceipt(command: NonNullable<ContractView['units'][number]['commandEvidence']>[number]) {
  const observed = commandObservation(command);
  const spans = findCardNumberShapes(observed.head);
  const stderr = 'stderr' in observed && typeof observed.stderr === 'string' ? observed.stderr : undefined;
  const errorSpans = stderr === undefined ? [] : findCardNumberShapes(stderr);
  if (spans.length + errorSpans.length === 0) return observed;
  const redact = (value: string, found: ReturnType<typeof findCardNumberShapes>) => {
    for (const span of found.toReversed()) value = value.slice(0, span.startIndex)
      + '[WITHHELD:card-shaped-number]' + value.slice(span.startIndex + span.length);
    return value;
  };
  return { ...observed, head: redact(observed.head, spans), ...(stderr === undefined ? {} : { stderr: redact(stderr, errorSpans) }), headProjection: { withheldSpans: spans.length + errorSpans.length,
    meaning: 'Card-shaped number spans in this observational output are unavailable here. Markers do not establish their contents or equality. The complete execution receipt remains retained locally; this projection does not approve the command or any claim.' } };
}

/** Facts from the live host tree; these never approve the work receiving them. */
export function contractWorkReceipts(
  contract: Pick<ContractView, 'units'> & Partial<Pick<ContractView, 'id' | 'decisions' | 'groups' | 'projectRoot' | 'worktreePath' | 'inputSnapshot' | 'criteria' | 'reviewInventory' | 'reviewExclusions'>>,
  options: { readonly excludeUnitId?: string; readonly readObservations?: boolean; readonly answerIds?: ReadonlySet<string>; readonly ownerEvidence?: JsonValue | undefined } = {},
) {
  const cwd = contract.worktreePath ?? contract.projectRoot;
  const researchIds = options.readObservations ? acceptedResearchIds(contract) : new Set<string>();
  const privateArchiveChecks = contract.id === undefined || contract.projectRoot === undefined ? [] : contract.units.flatMap(unit => {
    const checked = verifyPrivateReceiptPreservation({ ...contract, id: contract.id! }, unit, contract.projectRoot!);
    return checked ? [{ unitId: unit.id, gate: checked.gate, passed: checked.passed, output: checked.output,
      ...(checked.skipped === undefined ? {} : { skipped: checked.skipped }) }] : [];
  });
  return {
    contractId: contract.id,
    ...(contract.reviewInventory && contract.projectRoot ? { reviewInventory: compactReviewInventory(reviewInventoryObservation({ ...contract, projectRoot: contract.projectRoot })!) } : {}),
    ...(options.readObservations && cwd ? { sourceScope: contractSourceScope(contract, cwd, options.ownerEvidence) } : {}),
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
      dependsOn: [...unit.dependsOn],
      criteria: unit.criteria.map(criterion => ({ id: criterion.id, text: criterion.text, serves: [...criterion.serves], verdict: criterion.status,
        ...(criterion.contribution ? { contribution: { ...criterion.contribution } } : {}) })),
      latestCheck: unit.checks.length ? { id: unit.checks.at(-1)!.id, result: unit.checks.at(-1)!.result,
        evidenceDigest: unit.checks.at(-1)!.evidenceDigest, decisionIds: [...unit.checks.at(-1)!.decisionIds] } : null,
      ...(options.readObservations ? { readObservations: (unit.readEvidence ?? []).map(read => ({ path: read.path,
        returnedRanges: [...read.returnedRanges], returnedLines: read.returnedLines })), commands: (unit.commandEvidence ?? []).map(commandReceipt) } : {}),
      ...(unit.status === 'passed' ? { acceptedAnswerDigest: hashState(unit.answer ?? ''),
        acceptedAnswerSource: { storage: 'native-contract-store', contractId: contract.id, unitId: unit.id, field: 'answer' } } : {}),
      ...(unit.status === 'passed' && (options.answerIds?.has(unit.id) || researchIds.has(unit.id)) ? { acceptedAnswer: unit.answer ?? '' } : {}),
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
