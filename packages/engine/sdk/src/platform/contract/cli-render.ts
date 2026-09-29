/**
 * What the contract command line prints (docs/design/contract-runner.md 10.1):
 * one plain line per contract event, a contract's tree for `status <id>`, and
 * the table `status` and `list` print. Everything here is formatting of the
 * runner's own fields; nothing is read or decided.
 */
import type { ContractEvent, ContractShapeReading } from '../../events/contract.js';
import type { OwnerReplyOutcome } from './escalation.js';
import { describeIntake } from './intake-route.js';
import { isTerminalContractStatus, type ContractView, type CriterionView } from './types.js';

/** One line of free text: whitespace runs collapsed, cut at `max` characters. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

function shapeWord(reading: ContractShapeReading): string {
  return `${reading.verdict} (${reading.outcome})`;
}

function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join(', ');
}

/** The event's own text, without the contract id. Exhaustive over every contract event type. */
function describeEvent(event: ContractEvent): string {
  switch (event.type) {
    case 'CONTRACT_CREATED':
      return `created (origin ${event.origin}, session ${event.sessionId}): ${oneLine(event.ask)}`;
    case 'CONTRACT_STATUS_CHANGED':
      return `status ${event.from} -> ${event.to}`;
    case 'CONTRACT_SHAPED':
      return `shaped: forbids delegation ${shapeWord(event.forbidsDelegation)}, parallel agents ${shapeWord(event.requestsParallelAgents)}, `
        + `forbids writing ${shapeWord(event.forbidsWriting)}, attempts ${shapeWord(event.asksForAttempts)}`;
    case 'CONTRACT_PLANNED':
      return `${event.repair === 0 ? 'planned' : `plan repaired (repair ${event.repair})`}: ${oneLine(event.goal)}; `
        + `${event.groups.length} group(s), ${event.units.length} unit(s), ${event.criteria.length} contract criteria`;
    case 'CONTRACT_PLAN_CHECKED':
      return `plan check ${event.check}${event.targetId === undefined ? '' : ` of ${event.targetId}`}: `
        + (event.passed ? 'passed' : `${event.problems.length} problem(s): ${oneLine(event.problems.map((problem) => problem.message).join('; '))}`);
    case 'CONTRACT_GROUP_STATUS_CHANGED':
      return `group ${event.groupId} ${event.from} -> ${event.to}`;
    case 'CONTRACT_UNIT_STATUS_CHANGED':
      return `unit ${event.unitId} ${event.from} -> ${event.to}${event.agentId === undefined ? '' : ` (agent ${event.agentId})`}`;
    case 'CONTRACT_UNIT_SPAWNED':
      return `unit ${event.unitId} agent ${event.agentId} spawned (${event.purpose}) on ${event.route.model}`;
    case 'CONTRACT_CHECKED': {
      const met = event.criteria.filter((criterion) => criterion.verdict === 'met').length;
      const open = event.criteria.filter((criterion) => criterion.verdict !== 'met').map((criterion) => `${criterion.criterionId} ${criterion.verdict}`);
      return `check ${event.checkId} of ${event.scope} ${event.targetId} (${event.trigger}): ${event.result}; `
        + `${met}/${event.criteria.length} criteria met${open.length === 0 ? '' : ` (${open.join(', ')})`}`;
    }
    case 'CONTRACT_NUDGED':
      return `nudge ${event.nudgeId} to unit ${event.unitId} (${event.kinds.join(', ')}) by ${event.delivery}`;
    case 'CONTRACT_NUDGE_CONSUMED':
      return `unit ${event.unitId} took nudge ${event.nudgeId}`;
    case 'CONTRACT_CRITERION_REGRESSED':
      return `criterion ${event.criterionId} of unit ${event.unitId} regressed (met at ${event.metAtCheckId}, not at ${event.checkId})`;
    case 'CONTRACT_STALLED':
      return `${event.scope} ${event.targetId} stalled, routed ${event.route}: ${oneLine(event.reason)}`;
    case 'CONTRACT_FIX_PLANNED':
      return `fix round ${event.round} planned for ${event.scope} ${event.targetId}: group ${event.groupId}, units ${listOrNone(event.unitIds)}`;
    case 'CONTRACT_ESCALATED':
      return `asks the owner (${event.escalationId}, ${event.reason}, ${event.scope} ${event.targetId})`;
    case 'CONTRACT_OWNER_REPLIED':
      return `reply to ${event.escalationId} read as ${event.reading} (${event.outcome}): ${event.action}`;
    case 'CONTRACT_GATE_RESULT':
      return `gate ${event.gate} on ${event.targetId}: ${event.skipped ? 'skipped' : event.passed ? 'passed' : 'failed'} (${event.durationMs} ms)`;
    case 'CONTRACT_UNIT_SILENT':
      return `unit ${event.unitId} agent ${event.agentId} silent for ${Math.round(event.silentMs / 1000)} s: ${event.action}`;
    case 'CONTRACT_MERGE_CONFLICT':
      return `unit ${event.unitId} merge conflict on ${event.branch}: ${listOrNone(event.files)}`;
    case 'CONTRACT_ATTEMPTS_SELECTED':
      return `attempts of unit ${event.unitId}: ${event.chosen === null ? 'none chosen' : `chose ${event.chosen}`} (${event.outcome}) from ${listOrNone(event.candidateIds)}`;
    case 'CONTRACT_COMMITTED':
      return `commit ${event.status}${event.hash === undefined ? '' : ` ${event.hash}`}: ${oneLine(event.note)}`;
    case 'CONTRACT_PASSED':
      return `passed: ${event.criteriaMet}/${event.criteriaJudged} criteria met, ${event.excluded} excluded, ${event.nudges} nudge(s)`;
    case 'CONTRACT_FAILED':
      return `failed (${event.failureKind}): ${oneLine(event.reason, 400)}`;
    case 'CONTRACT_CANCELLED':
      return `cancelled: ${oneLine(event.reason)}; ${event.filesModified} file(s) modified`;
    case 'CONTRACT_SPAWN_GUARD_TRIGGERED':
      return `spawn refused for agent ${event.agentId} (depth ${event.depth}, ${event.activeAgents} active): ${oneLine(event.reason)}`;
  }
}

/** One plain line for a contract event, led by its contract id. */
export function formatContractEvent(event: ContractEvent): string {
  return `[${event.contractId ?? 'contracts'}] ${describeEvent(event)}`;
}

/** The final JSON line a followed contract ends with under `--json`. */
export function finalJsonLine(contractId: string, contract: ContractView | null, status: string): string {
  return JSON.stringify({
    contractId,
    status,
    answer: contract?.answer ?? null,
    statusLine: contract?.statusLine ?? null,
  });
}

/** How an owner's reply was read, as the conversation says it. */
export function describeReply(contractId: string, outcome: OwnerReplyOutcome): string {
  return describeIntake({ kind: 'replied', contractId, outcome });
}

function criterionLine(criterion: CriterionView, indent: string): string {
  const latest = criterion.readings.at(-1);
  const verdict = criterion.disposition === 'judged'
    ? latest === undefined ? 'unread' : latest.verdict
    : criterion.disposition;
  return `${indent}${criterion.id} [${verdict}] ${oneLine(criterion.text)}`;
}

/** `status <id>`: the contract's goal, groups, units with status, each criterion's latest verdict, and its open escalations. */
export function renderContractTree(contract: ContractView): string[] {
  const lines = [
    `Contract ${contract.id}  ${contract.status}  (origin ${contract.origin}, session ${contract.sessionId}, ${contract.isolation}${contract.sessionMode === true ? ', session mode' : ''})`,
    `Ask: ${oneLine(contract.ask, 400)}`,
    `Goal: ${contract.goal.length === 0 ? '(not planned yet)' : oneLine(contract.goal, 400)}`,
  ];
  if (contract.criteria.length > 0) {
    lines.push('Criteria:');
    for (const criterion of contract.criteria) lines.push(criterionLine(criterion, '  '));
  }
  for (const group of contract.groups) {
    lines.push(`Group ${group.id} ${oneLine(group.title, 80)}  ${group.status}`);
    for (const criterion of group.criteria) lines.push(criterionLine(criterion, '    '));
    for (const unitId of group.unitIds) {
      const unit = contract.units.find((candidate) => candidate.id === unitId);
      if (unit === undefined) continue;
      lines.push(`  Unit ${unit.id} ${oneLine(unit.title, 80)}  ${unit.status}`);
      for (const criterion of unit.criteria) lines.push(criterionLine(criterion, '    '));
    }
  }
  const open = contract.escalations.filter((escalation) => escalation.resolvedAt === undefined);
  if (open.length > 0) {
    lines.push('Open questions:');
    for (const escalation of open) {
      lines.push(`  ${escalation.id} (${escalation.reason}, ${escalation.scope} ${escalation.targetId}):`);
      for (const line of escalation.question.split('\n')) lines.push(`    ${line}`);
    }
  }
  if (contract.statusLine !== undefined) lines.push(`Status: ${contract.statusLine}`);
  else if (contract.error !== undefined) lines.push(`Error: ${contract.error}`);
  return lines;
}

/** One row of the contracts table, as `--json` prints it. */
export interface ContractRow {
  readonly id: string;
  readonly status: string;
  readonly origin: string;
  readonly unitsPassed: number;
  readonly units: number;
  readonly createdAt: string;
  readonly ask: string;
}

export function contractRow(contract: ContractView): ContractRow {
  return {
    id: contract.id,
    status: contract.status,
    origin: contract.origin,
    unitsPassed: contract.units.filter((unit) => unit.status === 'passed').length,
    units: contract.units.length,
    createdAt: new Date(contract.createdAt).toISOString(),
    ask: oneLine(contract.ask, 60),
  };
}

/** Newest first. */
export function newestFirst(contracts: readonly ContractView[]): ContractView[] {
  return [...contracts].sort((a, b) => b.createdAt - a.createdAt);
}

/** The contracts table: id, status, units passed, origin, created, ask. */
export function renderContractTable(contracts: readonly ContractView[]): string[] {
  const rows = newestFirst(contracts).map(contractRow);
  const header = ['ID', 'STATUS', 'UNITS', 'ORIGIN', 'CREATED', 'ASK'];
  const cells = rows.map((row) => [row.id, row.status, `${row.unitsPassed}/${row.units}`, row.origin, row.createdAt.slice(0, 19).replace('T', ' '), row.ask]);
  const widths = header.map((title, column) => Math.max(title.length, ...cells.map((cell) => cell[column]!.length)));
  const format = (cell: readonly string[]): string => cell.map((value, column) => (column === cell.length - 1 ? value : value.padEnd(widths[column]!))).join('  ');
  return [format(header), ...cells.map(format)];
}

/** Whether a contract has not ended. */
export function isOpenContract(contract: ContractView): boolean {
  return !isTerminalContractStatus(contract.status);
}
