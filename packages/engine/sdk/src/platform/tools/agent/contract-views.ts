/**
 * The agent tool's views of a contract (design 10.3): the contracts mode's
 * summary and the contract-history mode's decisions, checks and escalations, read from the
 * runner's ContractView. Summaries only select and count recorded fields.
 */
import type { ContractView } from '../../contract/types.js';

/** One runner decision, summarized for the contract-history mode. */
export function summarizeContractDecision(decision: ContractView['decisions'][number]) {
  return {
    at: decision.at,
    action: decision.action,
    targetId: decision.targetId,
    reason: decision.reason,
    ...(decision.route ? { model: decision.route.model } : {}),
  };
}

/** Every criterion the contract holds: its own, each group's and each unit's. */
function contractCriteria(contract: ContractView): readonly ContractView['criteria'][number][] {
  return [
    ...contract.criteria,
    ...contract.groups.flatMap((group) => group.criteria),
    ...contract.units.flatMap((unit) => unit.criteria),
  ];
}

/** The contracts mode's summary of one contract. */
export function summarizeContract(contract: ContractView) {
  const criteria = contractCriteria(contract);
  const judged = criteria.filter((criterion) => criterion.status !== 'unread');
  return {
    id: contract.id,
    status: contract.status,
    goal: contract.goal,
    ask: contract.ask,
    ownerAgentId: contract.ownerAgentId,
    units: contract.units.map((unit) => ({ id: unit.id, title: unit.title, status: unit.status })),
    criteriaMet: judged.filter((criterion) => criterion.status === 'met').length,
    criteriaJudged: judged.length,
    statusLine: contract.statusLine ?? null,
  };
}

/** A check's summary for the contract-history mode. */
export function summarizeCheck(check: ContractView['checks'][number]) {
  return {
    id: check.id,
    at: check.at,
    trigger: check.trigger,
    result: check.result,
    goal: check.goal.verdict,
    problems: check.problems ?? [],
  };
}

/** Every check the contract ran: the deliverable checks, each group's and each unit's, oldest first. */
export function contractChecks(contract: ContractView) {
  return [
    ...contract.checks,
    ...contract.groups.flatMap((group) => group.checks),
    ...contract.units.flatMap((unit) => unit.checks),
  ].sort((a, b) => a.at - b.at);
}

/** An escalation's summary for the contract-history mode. */
export function summarizeEscalation(escalation: ContractView['escalations'][number]) {
  return {
    id: escalation.id,
    at: escalation.at,
    scope: escalation.scope,
    targetId: escalation.targetId,
    reason: escalation.reason,
    question: escalation.question,
    resolved: escalation.resolvedAt !== undefined,
  };
}
