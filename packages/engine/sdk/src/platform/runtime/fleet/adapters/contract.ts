/**
 * Contract fleet adapters (docs/design/contract-runner.md section 8.3): the
 * contract tree as fleet nodes. A contract is a root node, each of its groups
 * a child of it, and each unit a child of its group; a best-of-N unit's
 * attempts are children of the unit. Agent nodes hang under the unit they
 * work (adapters/agent.ts parents them by `contractUnitId`), and the owner and
 * planner agents under the contract.
 *
 * Usage and cost on a contract, group or unit node are summed from the agent
 * nodes that did the work, each counted once, so a running unit shows live
 * numbers and nothing double-counts. The owner agent runs no model, so it is
 * never a member; its row adopts the contract's cost instead
 * (`repriceContractOwnerNode`).
 */
import { mergeCostSource, mergePricingAsOf } from '../../../orchestration/types.js';
import type { ContractGroupView, ContractUnitView, ContractView } from '../../../contract/types.js';
import type { CriterionStatus } from '../../../../events/contract.js';
import type {
  ProcessAttention,
  ProcessCheckSummary,
  ProcessNode,
  ProcessState,
  ProcessUsage,
} from '../types.js';

/** Contract node ids are namespaced to avoid colliding with agent and process ids. */
export function contractNodeId(contractId: string): string {
  return `contract:${contractId}`;
}

/** Group ids are unique only inside their contract (every contract has a g1), so the node id carries both. */
export function contractGroupNodeId(contractId: string, groupId: string): string {
  return `group:${contractId}:${groupId}`;
}

/** Unit ids are unique only inside their contract, so the node id carries both. */
export function contractUnitNodeId(contractId: string, unitId: string): string {
  return `unit:${contractId}:${unitId}`;
}

const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set(['done', 'failed', 'killed', 'interrupted']);

/** True when an agent node is still working (not finished, failed, killed or interrupted). */
export function isLiveNode(node: ProcessNode | undefined): node is ProcessNode {
  return node !== undefined && !TERMINAL_STATES.has(node.state);
}

// ── Usage and cost over member agents ─────────────────────────────────────────

export function sumUsage(nodes: readonly ProcessNode[]): ProcessUsage | undefined {
  const contributors = nodes.filter((node) => node.usage !== undefined);
  if (contributors.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens: number | undefined;
  let llmCallCount = 0;
  let turnCount = 0;
  let toolCallCount = 0;
  for (const node of contributors) {
    const usage = node.usage!;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    if (usage.reasoningTokens !== undefined) reasoningTokens = (reasoningTokens ?? 0) + usage.reasoningTokens;
    llmCallCount += usage.llmCallCount;
    turnCount += usage.turnCount;
    toolCallCount += usage.toolCallCount;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, llmCallCount, turnCount, toolCallCount };
}

export interface AggregatedCost {
  readonly costUsd: number | null;
  readonly costState: ProcessNode['costState'];
  readonly costSource: ProcessNode['costSource'];
  readonly pricingAsOf: string | undefined;
}

/**
 * Member cost, honestly: every contributor priced gives 'priced'; none gives
 * null and 'unpriced'; a mix sums the priced ones and says 'estimated'.
 * Provenance folds through the shared merge rules (one source reports itself,
 * disagreement is 'mixed', the oldest as-of date wins).
 */
export function aggregateCost(members: readonly ProcessNode[]): AggregatedCost {
  const withUsage = members.filter((node) => node.usage !== undefined);
  const priced = withUsage.filter((node) => node.costState === 'priced' && typeof node.costUsd === 'number');
  if (priced.length === 0) return { costUsd: null, costState: 'unpriced', costSource: undefined, pricingAsOf: undefined };
  return {
    costUsd: priced.reduce((sum, node) => sum + (node.costUsd as number), 0),
    costState: priced.length === withUsage.length ? 'priced' : 'estimated',
    costSource: priced.reduce<ProcessNode['costSource']>((merged, node) => mergeCostSource(merged, node.costSource), undefined),
    pricingAsOf: priced.reduce<string | undefined>((merged, node) => mergePricingAsOf(merged, node.pricingAsOf), undefined),
  };
}

/** One distinct model gives that model; several give "N models"; none gives undefined. */
function modelDescriptor(members: readonly ProcessNode[]): string | undefined {
  const models = new Set<string>();
  for (const node of members) {
    if (typeof node.model === 'string' && node.model.length > 0) models.add(node.model);
  }
  if (models.size === 0) return undefined;
  if (models.size === 1) return [...models][0];
  return `${models.size} models`;
}

/** Earliest member start and, once the node is terminal, the latest member finish. */
function memberTimes(members: readonly ProcessNode[], terminal: boolean): { startedAt?: number | undefined; completedAt?: number | undefined } {
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  for (const node of members) {
    if (node.startedAt !== undefined && (startedAt === undefined || node.startedAt < startedAt)) startedAt = node.startedAt;
    if (node.completedAt !== undefined && (completedAt === undefined || node.completedAt > completedAt)) completedAt = node.completedAt;
  }
  return { startedAt, completedAt: terminal ? completedAt : undefined };
}

function costFields(cost: AggregatedCost): Pick<ProcessNode, 'costUsd' | 'costState' | 'costSource' | 'pricingAsOf'> {
  return {
    costUsd: cost.costUsd,
    costState: cost.costState,
    ...(cost.costSource !== undefined ? { costSource: cost.costSource } : {}),
    ...(cost.pricingAsOf !== undefined ? { pricingAsOf: cost.pricingAsOf } : {}),
  };
}

/**
 * Reprices a contract owner's agent node for display. The owner runs no model;
 * its usage is backfilled from the contract's agents when it finishes, so
 * pricing it with one model is wrong and leaving it unpriced while its units
 * priced fine is misleading. It adopts the contract node's summed cost and
 * model descriptor instead. Returns the same node when nothing applies (the
 * owner already priced, or the contract has no priced cost). The owner is
 * never a member of any sum, so adopting the total cannot double-count.
 */
export function repriceContractOwnerNode(ownerNode: ProcessNode, contractNode: ProcessNode): ProcessNode {
  if (ownerNode.costState !== 'unpriced') return ownerNode;
  if (contractNode.costUsd === null || contractNode.costUsd === undefined) return ownerNode;
  return {
    ...ownerNode,
    costUsd: contractNode.costUsd,
    costState: contractNode.costState,
    ...(contractNode.costSource !== undefined ? { costSource: contractNode.costSource } : {}),
    ...(contractNode.pricingAsOf !== undefined ? { pricingAsOf: contractNode.pricingAsOf } : {}),
    model: ownerNode.model ?? contractNode.model,
  };
}

// ── Check summary ─────────────────────────────────────────────────────────────

interface CriteriaSource {
  readonly criteria: ContractView['criteria'];
  readonly checks: ContractView['checks'];
}

/**
 * Each judged criterion's latest reading, for the fleet panel: its verdict
 * (unread until a check has read it), the outcome and severity of the latest
 * reading, how many are met, how many corrections were sent, and when the
 * target was last checked. Criteria excluded or met by the plan's structure
 * are never judged and are not listed. Undefined when there is nothing judged.
 */
export function deriveCheckSummary(source: CriteriaSource, nudges: number): ProcessCheckSummary | undefined {
  const judged = source.criteria.filter((criterion) => criterion.disposition === 'judged');
  if (judged.length === 0) return undefined;
  const criteria = judged.map((criterion) => {
    const latest = criterion.readings.at(-1);
    const verdict: CriterionStatus = criterion.status;
    return {
      id: criterion.id,
      text: criterion.text,
      verdict,
      ...(latest !== undefined ? { outcome: latest.outcome } : {}),
      ...(latest?.severity !== undefined ? { severity: latest.severity } : {}),
    };
  });
  const lastCheck = source.checks.at(-1);
  return {
    criteria,
    met: criteria.filter((criterion) => criterion.verdict === 'met').length,
    judged: criteria.length,
    nudges,
    ...(lastCheck !== undefined ? { lastCheckAt: lastCheck.at } : {}),
  };
}

/** Every unit of a contract, attempt units included. */
export function allContractUnits(contract: ContractView): readonly ContractUnitView[] {
  return contract.units.flatMap((unit) => [unit, ...(unit.attemptUnits ?? [])]);
}

function nudgeCount(units: readonly ContractUnitView[]): number {
  return units.reduce((sum, unit) => sum + unit.nudges.length, 0);
}

// ── Attention: open escalations ────────────────────────────────────────────────

/** The open escalation waiting on the owner for this target, when there is one. */
function openEscalationFor(contract: ContractView, scopes: readonly string[], targetId: string | undefined): ProcessAttention | undefined {
  const open = contract.escalations.find((escalation) => escalation.resolvedAt === undefined
    && scopes.includes(escalation.scope)
    && (targetId === undefined || escalation.targetId === targetId));
  if (open === undefined) return undefined;
  const detail = open.question.split('\n')[0] ?? open.question;
  return { reason: open.reason === 'attempts-undecided' ? 'pick' : 'input', detail };
}

// ── Nodes ──────────────────────────────────────────────────────────────────────

function contractState(contract: ContractView): ProcessState {
  switch (contract.status) {
    case 'passed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'killed';
    case 'queued':
      return 'queued';
    case 'awaiting-owner':
      return 'idle';
    default:
      return 'executing-tool';
  }
}

/**
 * ContractView to a root node. `memberNodes` are the agent nodes of every
 * agent the contract ran (planners and units), the owner excluded.
 */
export function adaptContract(contract: ContractView, memberNodes: readonly ProcessNode[], now: number): ProcessNode {
  const state = contractState(contract);
  const terminal = TERMINAL_STATES.has(state);
  const completedAt = contract.completedAt;
  const attention = openEscalationFor(contract, ['plan', 'deliverable', 'shape'], undefined);
  const check = deriveCheckSummary(contract, nudgeCount(allContractUnits(contract)));
  return {
    id: contractNodeId(contract.id),
    kind: 'contract',
    parentId: undefined,
    label: `contract ${contract.id}`,
    task: contract.ask,
    state,
    startedAt: contract.createdAt,
    completedAt,
    elapsedMs: Math.max(0, (completedAt ?? now) - contract.createdAt),
    usage: sumUsage(memberNodes),
    model: modelDescriptor(memberNodes),
    ...costFields(aggregateCost(memberNodes)),
    currentActivity: terminal ? undefined : { kind: 'phase', text: contract.status, at: contract.createdAt },
    // The contract coordinates units; it has no conversation of its own, so it
    // is never steerable (steer a unit). Kill cancels the contract.
    capabilities: { interruptible: false, killable: !terminal, pausable: false, resumable: false, steerable: false },
    ...(attention ? { needsAttention: attention } : {}),
    sessionRef: { sessionId: contract.sessionId, agentId: contract.ownerAgentId },
    ...(check ? { check } : {}),
    raw: contract,
  };
}

function groupState(group: ContractGroupView): ProcessState {
  switch (group.status) {
    case 'pending':
      return 'queued';
    case 'blocked':
      return 'stalled';
    case 'awaiting-owner':
      return 'idle';
    case 'passed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'killed';
    default:
      return 'executing-tool';
  }
}

/** ContractGroupView to a child of its contract. `memberNodes` are the agent nodes of its units. */
export function adaptContractGroup(group: ContractGroupView, contract: ContractView, memberNodes: readonly ProcessNode[], now: number): ProcessNode {
  const state = groupState(group);
  const terminal = TERMINAL_STATES.has(state);
  const units = allContractUnits(contract).filter((unit) => unit.groupId === group.id);
  const { startedAt, completedAt } = memberTimes(memberNodes, terminal);
  const attention = openEscalationFor(contract, ['group'], group.id);
  const check = deriveCheckSummary(group, nudgeCount(units));
  const liveAgents = memberNodes.some((node) => isLiveNode(node));
  return {
    id: contractGroupNodeId(contract.id, group.id),
    kind: 'contract-group',
    parentId: contractNodeId(contract.id),
    label: group.title,
    task: group.goal,
    state,
    startedAt,
    completedAt,
    elapsedMs: startedAt === undefined ? 0 : Math.max(0, (completedAt ?? now) - startedAt),
    usage: sumUsage(memberNodes),
    model: modelDescriptor(memberNodes),
    ...costFields(aggregateCost(memberNodes)),
    currentActivity: terminal ? undefined : { kind: 'phase', text: group.status, at: contract.createdAt },
    // Kill stops the group's working unit agents; steer goes to a unit.
    capabilities: { interruptible: false, killable: !terminal && liveAgents, pausable: false, resumable: false, steerable: false },
    ...(attention ? { needsAttention: attention } : {}),
    ...(check ? { check } : {}),
    raw: { contract, group },
  };
}

function unitState(unit: ContractUnitView, activeAgent: ProcessNode | undefined): ProcessState {
  switch (unit.status) {
    case 'pending':
      return 'queued';
    case 'blocked':
      return 'stalled';
    case 'awaiting-owner':
      return 'idle';
    case 'held-merge':
      // Passed and parked until it merges or is picked: done its work, not progressing on its own.
      return 'paused';
    case 'passed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'killed';
    case 'running':
    case 'nudged':
      // A working unit reads as its agent does (thinking, streaming, stalled...).
      return isLiveNode(activeAgent) ? activeAgent.state : 'executing-tool';
    default:
      return 'executing-tool';
  }
}

export interface ContractUnitAdaptOptions {
  /** The unit's active agent node, when it has one in this snapshot. */
  readonly activeAgent?: ProcessNode | undefined;
  /** Agent nodes of every agent that ever ran the unit (for a plan unit with attempts: its attempts' agents). */
  readonly memberNodes: readonly ProcessNode[];
  /** True when the registry has a message bus to deliver a steer. */
  readonly messageBusPresent: boolean;
  readonly now: number;
}

/**
 * ContractUnitView to a child of its group, or of its plan unit for a best-of-N
 * attempt. Interrupt, kill and steer go to its active agent while that agent is
 * working.
 */
export function adaptContractUnit(unit: ContractUnitView, contract: ContractView, opts: ContractUnitAdaptOptions): ProcessNode {
  const activeAgent = unit.activeAgentId !== undefined && isLiveNode(opts.activeAgent) ? opts.activeAgent : undefined;
  const state = unitState(unit, activeAgent);
  const terminal = TERMINAL_STATES.has(state);
  const { startedAt, completedAt } = memberTimes(opts.memberNodes, terminal);
  const attention = openEscalationFor(contract, ['unit'], unit.attemptOf ?? unit.id);
  const check = deriveCheckSummary(unit, unit.nudges.length);
  const planUnit = unit.attemptOf !== undefined ? contract.units.find((candidate) => candidate.id === unit.attemptOf) : undefined;
  const attempts = planUnit?.attemptUnits ?? [];
  return {
    id: contractUnitNodeId(contract.id, unit.id),
    kind: 'contract-unit',
    parentId: unit.attemptOf !== undefined
      ? contractUnitNodeId(contract.id, unit.attemptOf)
      : contractGroupNodeId(contract.id, unit.groupId),
    label: unit.title,
    task: unit.goal,
    state,
    startedAt,
    completedAt,
    elapsedMs: startedAt === undefined ? 0 : Math.max(0, (completedAt ?? opts.now) - startedAt),
    usage: sumUsage(opts.memberNodes),
    model: unit.route?.model ?? modelDescriptor(opts.memberNodes),
    provider: unit.route?.provider,
    ...costFields(aggregateCost(opts.memberNodes)),
    currentActivity: terminal ? undefined : { kind: 'phase', text: unit.status, at: contract.createdAt },
    capabilities: {
      interruptible: activeAgent !== undefined,
      killable: activeAgent !== undefined,
      pausable: false,
      resumable: false,
      steerable: activeAgent !== undefined && opts.messageBusPresent,
    },
    // An attempt's pick is one decision over the siblings: the flag rides the plan unit only.
    ...(attention && unit.attemptOf === undefined ? { needsAttention: attention } : {}),
    sessionRef: { sessionId: contract.sessionId, ...(activeAgent !== undefined ? { agentId: activeAgent.id } : {}) },
    ...(check ? { check } : {}),
    ...(planUnit !== undefined
      ? {
          attemptGroup: {
            groupId: planUnit.id,
            index: unit.attemptIndex ?? 0,
            total: attempts.length,
            held: unit.status === 'held-merge',
            // The attention above is read against the plan unit, so it is the group's pick.
            ready: attention?.reason === 'pick',
          },
        }
      : {}),
    raw: { contract, unit },
  };
}
