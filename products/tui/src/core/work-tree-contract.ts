/** Read-only projection of the public contract tree into the redesigned lane graph. */
import { contractTree, type ContractView, type ContractUnitView, type CriterionView } from '@goodvibes-jev/engine/sdk/platform/contract';
import { cellText, type BeadStatus, type BeadSummary } from '../renderer/lane-graph/bead.ts';

export function contractIsActive(contract: ContractView): boolean {
  return !['passed', 'failed', 'cancelled'].includes(contract.status);
}

/** Commit/application reporting is separate from the judged lifecycle verdict. */
export function contractCommitNote(contract: ContractView): string | undefined {
  const commit = contract.commit;
  if (!commit) return undefined;
  const label = commit.status === 'failed' ? 'commit failed' : commit.status === 'skipped' ? 'commit skipped' : commit.status;
  return cellText(`${label}${commit.hash ? ` ${commit.hash.slice(0, 12)}` : ''}${commit.note ? `: ${commit.note}` : ''}`).replace(/\s+/g, ' ');
}

export function contractStatusSummary(contract: ContractView): string {
  return [contract.status, contractCommitNote(contract)].filter(Boolean).join(' · ');
}

export interface ContractTreeRow {
  readonly id: string;
  readonly name: string;
  readonly arg: string;
  readonly status: BeadStatus;
  readonly summary: BeadSummary;
  readonly lines: readonly string[];
}

function statusMark(status: string): BeadStatus {
  if (status === 'passed') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'cancelled') return 'cancel';
  if (status === 'awaiting-owner') return 'wait';
  if (['pending', 'blocked', 'queued', 'held', 'held-merge'].includes(status)) return 'unknown';
  return 'run';
}

function tone(status: BeadStatus): BeadSummary['tone'] {
  return status === 'ok' ? 'good' : status === 'err' ? 'bad' : status === 'wait' || status === 'warn' ? 'warn' : 'faint';
}

function criteriaLines(criteria: readonly CriterionView[]): string[] {
  return criteria.map((criterion) => {
    const reading = criterion.readings.at(-1);
    const state = criterion.disposition === 'judged' ? reading?.verdict ?? criterion.status : criterion.disposition;
    return `${criterion.id} [${state}] ${criterion.text}${reading ? ` (${reading.outcome})` : ''}${criterion.dispositionReason ? ` · ${criterion.dispositionReason}` : ''}`;
  });
}

function checksLines(checks: ContractView['checks']): string[] {
  return checks.map((check) => `${check.id} · ${check.trigger} · ${check.result} · goal ${check.goal.verdict} (${check.goal.outcome})`);
}

function stateSummary(status: string, criteria: readonly CriterionView[]): BeadSummary {
  const judged = criteria.filter((criterion) => criterion.disposition === 'judged');
  const met = judged.filter((criterion) => (criterion.readings.at(-1)?.verdict ?? criterion.status) === 'met').length;
  return { text: `${status}${judged.length > 0 ? ` · ${met}/${judged.length} criteria met` : ''}`, tone: tone(statusMark(status)) };
}

/** Stable IDs use public group/unit/escalation IDs, so replanning cannot move an open body to another item. */
export function projectContractTree(contract: ContractView): ContractTreeRow[] {
  const rows: ContractTreeRow[] = [{
    id: `contract:${contract.id}`,
    name: 'contract',
    arg: contract.goal || contract.ask,
    status: statusMark(contract.status),
    summary: { text: contractStatusSummary(contract), tone: contract.commit?.status === 'failed' ? 'warn' : tone(statusMark(contract.status)) },
    lines: [
      `Contract ${contract.id} · ${contract.status}`,
      `Ask: ${contract.ask}`,
      `Tree: ${contractTree(contract)}`,
      ...(contract.branch ? [`Branch: ${contract.branch}`] : []),
      ...criteriaLines(contract.criteria), ...checksLines(contract.checks),
      ...(contract.statusLine ? [contract.statusLine] : []),
      ...(contract.error ? [contract.error] : []),
      ...(contract.answer ? [contract.answer] : []),
      ...contract.decisions.map((decision) => `${decision.id} · ${decision.action} · ${decision.targetId}: ${decision.reason}`),
    ],
  }];
  const shown = new Set<string>();
  const addUnit = (unit: ContractUnitView, parent?: string): void => {
    if (shown.has(unit.id)) return;
    shown.add(unit.id);
    rows.push({
      id: `unit:${unit.id}`,
      name: parent ? 'attempt' : 'unit',
      arg: `${unit.id} · ${unit.title}`,
      status: statusMark(unit.status),
      summary: stateSummary(unit.status, unit.criteria),
      lines: [
        `${parent ? `Attempt of ${parent}` : `Group ${unit.groupId}`} · ${unit.role}`,
        unit.goal, unit.brief,
        ...(unit.dependsOn.length ? [`Depends on: ${unit.dependsOn.join(', ')}`] : []),
        ...(unit.agentIds.length ? [`Agents: ${unit.agentIds.join(', ')}`] : []),
        ...(unit.activeAgentId ? [`Active agent: ${unit.activeAgentId}`] : []),
        ...criteriaLines(unit.criteria), ...checksLines(unit.checks),
        ...unit.nudges.map((nudge) => `${nudge.id} · ${nudge.delivery}${nudge.consumedAt === undefined ? '' : ' · consumed'}: ${nudge.text}`),
        ...(unit.failureReason ? [unit.failureReason] : []),
        ...(unit.answer ? [unit.answer] : unit.lastOutput ? [unit.lastOutput] : []),
        ...(unit.attemptSelection ? [`Selection: ${unit.attemptSelection.outcome} · picked ${unit.attemptSelection.pickedId ?? 'none'} · ${unit.attemptSelection.reasons}`] : []),
      ].filter(Boolean),
    });
    for (const attempt of unit.attemptUnits ?? []) addUnit(attempt, unit.id);
  };
  for (const group of contract.groups) {
    rows.push({
      id: `group:${group.id}`, name: 'group', arg: `${group.id} · ${group.title}`,
      status: statusMark(group.status), summary: stateSummary(group.status, group.criteria),
      lines: [group.goal, ...(group.dependsOn.length ? [`Depends on: ${group.dependsOn.join(', ')}`] : []),
        ...criteriaLines(group.criteria), ...checksLines(group.checks),
        ...(group.repairs ? [`Repair: ${group.repairs.scope} ${group.repairs.targetId} · ${group.repairs.criterionIds.join(', ')}`] : [])].filter(Boolean),
    });
    for (const unitId of group.unitIds) {
      const unit = contract.units.find((candidate) => candidate.id === unitId);
      if (unit) addUnit(unit);
    }
  }
  for (const unit of contract.units) addUnit(unit);
  for (const escalation of contract.escalations) {
    const open = escalation.resolvedAt === undefined;
    rows.push({
      id: `escalation:${escalation.id}`, name: open ? 'owner question' : 'owner reply',
      arg: escalation.question, status: open ? 'wait' : 'unknown',
      summary: { text: open ? 'awaiting owner' : escalation.reply ? `${escalation.reply.reading} · ${escalation.reply.outcome}` : 'resolved', tone: open ? 'warn' : 'faint' },
      lines: [`${escalation.id} · ${escalation.scope} ${escalation.targetId} · ${escalation.reason}`, escalation.question,
        ...(escalation.unmetCriterionIds.length ? [`Criteria: ${escalation.unmetCriterionIds.join(', ')}`] : []),
        ...(escalation.reply ? [escalation.reply.text] : [])],
    });
  }
  const note = contractCommitNote(contract);
  if (note) rows.push({
    id: `commit:${contract.id}`, name: 'commit', arg: contract.commit!.note,
    status: contract.commit!.status === 'failed' ? 'warn' : contract.commit!.status === 'skipped' ? 'unknown' : 'ok',
    summary: { text: contract.commit!.status, tone: contract.commit!.status === 'failed' ? 'warn' : contract.commit!.status === 'skipped' ? 'faint' : 'good' },
    lines: [note, `Contract lifecycle: ${contract.status}`],
  });
  return rows;
}
