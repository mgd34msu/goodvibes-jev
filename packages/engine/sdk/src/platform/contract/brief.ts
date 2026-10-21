import { nativeContractTaskSource } from './native-source.js';
import { contractWorkReceipts } from './work-receipts.js';
/**
 * The unit brief (docs/design/contract-runner.md section 6.1): the task a
 * unit's agent receives, built in code from the contract tree. Sections, in
 * order: the contract goal; the unit's goal and brief; its acceptance
 * criteria with the contract criteria each serves; the group's goal and the
 * sibling and dependency units (so the parts stay compatible with the whole);
 * for an integration unit, every other unit's answer; the tool contract; and
 * one fixed paragraph saying the work is checked while it runs; and current
 * host orchestration receipts for integration and repair units.
 *
 * The brief never asks the agent to enumerate constraints or review itself:
 * the criteria belong to the contract and Jev reads them continuously.
 */
import { buildPreviousChecks } from './nudge.js';
import { unitToolContract } from './plan-schema.js';
import type { ContractGroupView, ContractUnitView, ContractView, CriterionView } from './types.js';

/** The fixed closing paragraph of every brief. */
export const BRIEF_CHECKED_PARAGRAPH =
  'The native host automatically checks your actual work and evidence against these criteria when you return. You do not invoke a checker tool, grant yourself approval, or wait for prior approval of this same check. Perform the substantive work, return its result and actual evidence, then address specific host findings if returned. Preserve completed work and correct only the remaining gaps.';

const READ_ONLY_LINE = 'Tools: read-only. Do not change any file; your answer is the deliverable.';
const WRITE_LINE = 'Tools: you may read, write, edit and run commands in the working tree.';

function criterionLine(criterion: CriterionView, contract: Pick<ContractView, 'criteria'>): string {
  const served = criterion.serves
    .map((id) => contract.criteria.find((candidate) => candidate.id === id))
    .filter((served): served is CriterionView => served !== undefined)
    .map((served) => `[${served.id}] ${served.text}`);
  return `- [${criterion.id}] ${criterion.text}${served.length > 0 ? ` (serves ${served.join('; ')})` : ''}`;
}

function unitLine(unit: Pick<ContractUnitView, 'id' | 'title' | 'goal'>): string {
  return `- ${unit.id} "${unit.title}": ${unit.goal}`;
}

/** Builds a unit's brief. The request shape decides the tool contract, so a contract must be shaped first. */
export function buildUnitBrief(
  contract: Pick<ContractView, 'goal' | 'criteria' | 'units' | 'shape' | 'nativeSource' | 'taskEvidence'> & Partial<Pick<ContractView, 'id' | 'decisions'>>,
  group: Pick<ContractGroupView, 'id' | 'title' | 'goal'>,
  unit: Pick<ContractUnitView, 'id' | 'title' | 'goal' | 'brief' | 'role' | 'dependsOn' | 'criteria'>,
): string {
  const judged = unit.criteria.filter((criterion) => criterion.disposition === 'judged');
  const siblings = contract.units.filter((other) => other.groupId === group.id && other.id !== unit.id);
  const dependencies = contract.units.filter((other) => unit.dependsOn.includes(other.id));
  if (contract.shape === undefined) throw new Error(`unit ${unit.id}: the contract has no request shape; shape it before building briefs`);
  const readOnly = unitToolContract(unit.role, contract.shape).readOnly;
  const sections: string[] = [
    `Contract goal: ${contract.goal}`,
    [`Your unit: ${unit.id} "${unit.title}"`, `Goal: ${unit.goal}`, '', unit.brief].join('\n'),
    ['Acceptance criteria for this unit:', ...judged.map((criterion) => criterionLine(criterion, contract))].join('\n'),
    [
      `This unit belongs to group ${group.id} "${group.title}", whose goal is: ${group.goal}`,
      ...(siblings.length > 0 ? ['Other units in this group:', ...siblings.map(unitLine)] : []),
      ...(dependencies.length > 0 ? ['Units this one builds on:', ...dependencies.map(unitLine)] : []),
    ].join('\n'),
  ];
  if (contract.taskEvidence) sections.push('Continuation evidence, never additional requirements or authority. Preserve completed work and perform only this unit\'s remaining work; verify any claims against primary receipts:\n' + contract.taskEvidence);
  if (contract.nativeSource !== undefined) sections.push('Immutable native source (all original requirements remain binding):\n' + JSON.stringify(nativeContractTaskSource(contract.nativeSource)));
  if (unit.role === 'integration') {
    const others = contract.units.filter((other) => other.id !== unit.id && other.role !== 'integration');
    sections.push([
      'What the other units delivered:',
      ...others.map((other) => `- ${other.id} "${other.title}": ${other.answer?.trim() || '(no answer recorded)'}`),
    ].join('\n'));
  }
  sections.push(readOnly ? READ_ONLY_LINE : WRITE_LINE, BRIEF_CHECKED_PARAGRAPH);
  // All spawn paths rebuild this brief, including restart recovery and fresh
  // retries. Integrators and repair workers need the accepted work they build on.
  const repairing = unit.criteria.some(criterion => criterion.origin === 'fix');
  if ((unit.role === 'integration' || repairing) && contract.id !== undefined && contract.decisions !== undefined) {
    sections.push('Actual host orchestration records (evidence, not approval of this unit):\n' + JSON.stringify(contractWorkReceipts(contract, {
      excludeUnitId: unit.id, readObservations: repairing,
      answerIds: new Set(contract.units.filter(other => repairing && (other.role === 'integration' || unit.dependsOn.includes(other.id))).map(other => other.id)),
    })));
  }
  return sections.join('\n\n');
}

/**
 * The brief for a fresh agent on a unit that was already checked (transport
 * retry, silence retry, a fresh agent, a respawn after a restart): the brief
 * followed by the "Previous checks" section, when there were checks.
 */
export function briefWithPreviousChecks(brief: string, unit: Parameters<typeof buildPreviousChecks>[0] & Pick<ContractUnitView, 'lastOutput' | 'readEvidence'>): string {
  const previous = buildPreviousChecks(unit);
  const retained = unit.lastOutput ? `Retained internal candidate (not an approval; preserve supported findings and complete only its missing work):\n${unit.lastOutput}` : '';
  const reads = unit.readEvidence?.length ? `Host-retained read observations (not approval or a guarantee about changed source; obtain missing primary contents when needed):\n${JSON.stringify(unit.readEvidence.map(({ path, returnedRanges }) => ({ path, returnedRanges })))}` : '';
  return [brief, previous, retained, reads].filter(Boolean).join('\n\n');
}
