/**
 * The contract runner's data model (docs/design/contract-runner.md section 2.3):
 * a contract, its groups and units, their criteria with every reading, checks,
 * nudges, escalations and decisions, and the status transition tables.
 *
 * A contract is the unit of work the runner owns. Jev judges every unit
 * against its criteria while the unit's sub-agent works, and the agent is
 * nudged until every criterion reads met; nothing else can pass a unit.
 *
 * The status strings and other closed sets are declared once in the event
 * vocabulary (events/contract.ts) and re-exported here, so the persisted tree
 * and the wire events cannot drift apart.
 */
import { randomBytes } from 'node:crypto';
import type { Outcome, ReplyReadingName } from '@goodvibes-jev/judgment';
import type {
  CheckResult,
  CheckTrigger,
  ClaimVerificationKind,
  ContractFailureKind,
  ContractGroupStatus,
  ContractOrigin,
  ContractShapeReading,
  ContractStatus,
  ContractUnitStatus,
  CriterionDisposition,
  CriterionOrigin,
  CriterionStatus,
  CriterionVerdict,
  EscalationReason,
  EscalationScope,
  GroupKind,
  NudgeDelivery,
  NudgeKind,
  QualityItem,
  UnitRole,
  YesNoVerdict,
} from '../../events/contract.js';
import type { BudgetCeiling, WorkItemUsage } from '../orchestration/types.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import type { AgentProviderRoutingPolicy } from '../tools/agent/schema.js';
import type { QualityGateResult } from './gates.js';

export type {
  CheckResult,
  CheckTrigger,
  ContractFailureKind,
  ContractOrigin,
  ContractStatus,
  CriterionDisposition,
  CriterionOrigin,
  CriterionStatus,
  CriterionVerdict,
  EscalationReason,
  EscalationScope,
  GroupKind,
  NudgeDelivery,
  NudgeKind,
  QualityItem,
  UnitRole,
  YesNoVerdict,
};
export {
  CONTRACT_FAILURE_KINDS,
  CONTRACT_GROUP_STATUSES,
  CONTRACT_ORIGINS,
  CONTRACT_STATUSES,
  CONTRACT_UNIT_STATUSES,
  QUALITY_ITEMS,
} from '../../events/contract.js';

export type GroupStatus = ContractGroupStatus;
export type UnitStatus = ContractUnitStatus;

/** The AgentManager surface the runner and the phase runner use (moved from the WRFC config module). */
export type AgentManagerLike = Pick<AgentManager, 'spawn' | 'getStatus' | 'list' | 'cancel' | 'listByCohort' | 'clear'>;

// ── Ids ────────────────────────────────────────────────────────────────────────

/** Schema version of a persisted contract; `deserializeContract` refuses a newer one. */
export const CURRENT_CONTRACT_SCHEMA_VERSION = 1;

/** `ctr-<8 hex>`. Also the store's file name, so it is checked before any path is built from it. */
export const CONTRACT_ID_PATTERN = /^ctr-[0-9a-f]{8}$/;

export function isContractId(value: unknown): value is string {
  return typeof value === 'string' && CONTRACT_ID_PATTERN.test(value);
}

/** A fresh contract id. */
export function newContractId(): string {
  return `ctr-${randomBytes(4).toString('hex')}`;
}

// ── Routing ────────────────────────────────────────────────────────────────────

/** The model a unit (or the planner) runs on, with the selector's reason (design 2.2). */
export interface UnitRoute {
  readonly model: string;
  readonly provider: string;
  readonly fallbackModels?: readonly string[] | undefined;
  readonly routing?: AgentProviderRoutingPolicy | undefined;
  readonly reasoningEffort?: AgentRecord['reasoningEffort'] | undefined;
  /** Recorded on the unit, copied to the agent record's routeReason, and carried by the spawned event. */
  readonly reason: string;
}

/** Picks the route for the planner, a unit, a fresh unit agent, or an integration unit. Required: there is no default model. */
export type ContractRouteSelector = (request: {
  readonly purpose: 'planner' | 'unit' | 'fresh-unit' | 'integration';
  readonly contract: ContractView;
  readonly unit?: ContractUnitView | undefined;
}) => Promise<UnitRoute>;

// ── Starting a contract ───────────────────────────────────────────────────────

export interface StartContractInput {
  /** The person's words, verbatim; the authority every stated criterion traces to. */
  readonly ask: string;
  readonly sessionId: string;
  readonly origin: ContractOrigin;
  readonly projectRoot: string;
  /** Units proposed by an agent-tool batch or AgentInput.proposedUnits; the planner weighs them. */
  readonly proposedUnits?: readonly { readonly task: string; readonly template?: string | undefined }[] | undefined;
  /** The conversation agent that asked, when there is one. */
  readonly parentAgentId?: string | undefined;
  readonly budget?: BudgetCeiling | undefined;
  readonly isolation?: 'auto' | 'worktree' | 'shared' | undefined;
}

// ── Request shape (design 3.1) ────────────────────────────────────────────────

/** One request-shape question as it was read. */
export type ShapeReading = ContractShapeReading;

/** The four request-shape readings, keyed by the battery's question names, and the decision-log ids behind them. */
export interface RequestShape {
  readonly forbids_delegation: ShapeReading;
  readonly requests_parallel_agents: ShapeReading;
  readonly forbids_writing: ShapeReading;
  readonly asks_for_attempts: ShapeReading;
  readonly decisionIds: readonly string[];
}

// ── Criteria and readings ─────────────────────────────────────────────────────

export const CRITERION_SEVERITIES = ['critical', 'major', 'minor'] as const;
export type CriterionSeverity = (typeof CRITERION_SEVERITIES)[number];

export interface CriterionReading {
  readonly checkId: string;
  readonly at: number;
  /** The judge's yes/no probability, where yes means the criterion fails. */
  readonly probabilityUnmet: number;
  readonly verdict: CriterionVerdict;
  readonly outcome: Outcome;
  readonly severity?: CriterionSeverity | undefined;
  readonly decisionId: string | undefined;
}

export interface Criterion {
  readonly id: string;
  text: string;
  readonly origin: CriterionOrigin;
  /** 'stated' only: the user's words, verbatim. */
  readonly quote?: string | undefined;
  /** Ids of the criteria this one serves; empty for 'stated'. */
  readonly serves: readonly string[];
  /** 'excluded' only for topology-only criteria the plan cannot satisfy; 'met-by-structure' when the plan's shape meets it. */
  disposition: CriterionDisposition;
  dispositionReason?: string | undefined;
  status: CriterionStatus;
  /** Every reading, oldest first. */
  readings: CriterionReading[];
}

// ── Checks and nudges ─────────────────────────────────────────────────────────

export interface UnitCheck {
  /** `${unitId}.k${n}` for a unit; the group or contract id in place of the unit id for group and deliverable checks. */
  readonly id: string;
  readonly at: number;
  readonly trigger: CheckTrigger;
  readonly claims?: { readonly kind: ClaimVerificationKind; readonly summary: string } | undefined;
  readonly gates?: readonly QualityGateResult[] | undefined;
  readonly goal: { readonly probabilityUnmet: number; readonly verdict: CriterionVerdict; readonly outcome: Outcome };
  readonly quality: Readonly<Record<QualityItem, { readonly verdict: YesNoVerdict; readonly outcome: Outcome }>>;
  readonly result: CheckResult;
  /**
   * Every problem kind the check found, whatever its result (a turn-end check
   * records problems it does not nudge on). Progress, stall and the unsettled
   * count read this history.
   */
  readonly problems?: readonly NudgeKind[] | undefined;
  /** The quality items read as problems. */
  readonly qualityProblems?: readonly QualityItem[] | undefined;
  readonly decisionIds: readonly string[];
  /** hashState of the evidence (the judgment foundation's decision log). */
  readonly evidenceDigest: string;
}

export interface Nudge {
  readonly id: string;
  readonly checkId: string;
  readonly at: number;
  readonly kinds: readonly NudgeKind[];
  readonly criterionIds: readonly string[];
  readonly text: string;
  readonly delivery: NudgeDelivery;
  readonly agentId: string;
  consumedAt?: number | undefined;
}

// ── The tree ──────────────────────────────────────────────────────────────────

export interface ContractUnit {
  readonly id: string;
  readonly groupId: string;
  title: string;
  goal: string;
  brief: string;
  readonly role: UnitRole;
  readonly dependsOn: readonly string[];
  readonly files: readonly string[];
  /** 1 unless best-of-N. */
  readonly attempts: number;
  criteria: Criterion[];
  status: UnitStatus;
  /** Every agent that ever ran this unit. */
  agentIds: string[];
  activeAgentId?: string | undefined;
  route?: UnitRoute | undefined;
  checks: UnitCheck[];
  nudges: Nudge[];
  fixRounds: number;
  freshAgents: number;
  transportRetries: number;
  touchedPaths: string[];
  /** Shared mode only: the tree the unit's diff is measured against. */
  baseline?: { readonly head: string | null; readonly dirty: Readonly<Record<string, string | null>> } | undefined;
  usage: WorkItemUsage;
  /** The unit's completion summary. */
  answer?: string | undefined;
  failureReason?: string | undefined;
}

export interface ContractGroup {
  readonly id: string;
  title: string;
  goal: string;
  readonly kind: GroupKind;
  readonly repairs?: {
    readonly scope: 'unit' | 'group' | 'deliverable';
    readonly targetId: string;
    readonly criterionIds: readonly string[];
  } | undefined;
  readonly dependsOn: readonly string[];
  criteria: Criterion[];
  unitIds: string[];
  status: GroupStatus;
  checks: UnitCheck[];
  fixRounds: number;
  usage: WorkItemUsage;
}

export interface Escalation {
  readonly id: string;
  readonly at: number;
  readonly scope: EscalationScope;
  readonly targetId: string;
  readonly reason: EscalationReason;
  /** Built in code (design 6.3). */
  readonly question: string;
  readonly unmetCriterionIds: readonly string[];
  resolvedAt?: number | undefined;
  reply?: {
    readonly text: string;
    readonly reading: ReplyReadingName;
    readonly outcome: Outcome;
    readonly decisionId: string | undefined;
  } | undefined;
}

export const CONTRACT_DECISION_ACTIONS = [
  'created', 'queued', 'shaped', 'planned', 'plan-repaired', 'plan-accepted', 'spawned', 'checked',
  'nudged', 'woke', 'regressed', 'stalled', 'fix-planned', 'fresh-agent', 'escalated',
  'owner-replied', 'transport-retry', 'silence-retry', 'attempts-selected', 'group-passed',
  'committed', 'passed', 'failed', 'cancelled', 'resumed', 'reaped',
] as const;
export type ContractDecisionAction = (typeof CONTRACT_DECISION_ACTIONS)[number];

/** One runner decision, with the decision-log ids of the Jev readings behind it. */
export interface ContractDecision {
  readonly id: string;
  readonly at: number;
  readonly action: ContractDecisionAction;
  readonly targetId: string;
  readonly reason: string;
  readonly decisionIds: readonly string[];
  readonly route?: UnitRoute | undefined;
}

export interface JudgmentUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Contract {
  readonly id: string;
  /** CURRENT_CONTRACT_SCHEMA_VERSION when written. */
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly origin: ContractOrigin;
  readonly ask: string;
  readonly ownerAgentId: string;
  readonly parentAgentId?: string | undefined;
  readonly projectRoot: string;
  readonly isolation: 'worktree' | 'shared';
  /** Worktree mode: `contract/<short>`. */
  readonly branch?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly baseBranch?: string | undefined;
  goal: string;
  /** Contract-level criteria; every one has origin 'stated' or 'owner'. */
  criteria: Criterion[];
  groups: ContractGroup[];
  units: ContractUnit[];
  shape?: RequestShape | undefined;
  status: ContractStatus;
  /** Deliverable checks. */
  checks: UnitCheck[];
  fixRounds: number;
  escalations: Escalation[];
  decisions: ContractDecision[];
  usage: WorkItemUsage;
  judgmentUsage: JudgmentUsage;
  plannerAgentIds: string[];
  answer?: string | undefined;
  statusLine?: string | undefined;
  commit?: { readonly status: 'committed' | 'applied' | 'skipped' | 'failed'; readonly hash?: string | undefined; readonly note: string } | undefined;
  failureKind?: ContractFailureKind | undefined;
  error?: string | undefined;
  readonly createdAt: number;
  completedAt?: number | undefined;
}

// ── Read-only views ───────────────────────────────────────────────────────────

/** Readonly all the way down: what `get`, `list` and events hand out. */
export type DeepReadonly<T> = T extends readonly (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type ContractView = DeepReadonly<Contract>;
export type ContractGroupView = DeepReadonly<ContractGroup>;
export type ContractUnitView = DeepReadonly<ContractUnit>;
export type CriterionView = DeepReadonly<Criterion>;

// ── Status transitions ────────────────────────────────────────────────────────

/**
 * Legal contract status moves. Every non-terminal status may fail (a judgment
 * outage, a zombie, a planning failure) or be cancelled. `queued` is both the
 * wait for an active-contract slot and where a resumed contract waits when the
 * cap is full, so a resumed contract leaves it for the step it was on.
 */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  queued: ['shaping', 'planning', 'running', 'judging', 'fixing', 'committing', 'failed', 'cancelled'],
  shaping: ['planning', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  planning: ['checking-plan', 'queued', 'failed', 'cancelled'],
  'checking-plan': ['planning', 'running', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  running: ['judging', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  judging: ['committing', 'fixing', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  fixing: ['judging', 'awaiting-owner', 'queued', 'failed', 'cancelled'],
  committing: ['passed', 'queued', 'failed', 'cancelled'],
  'awaiting-owner': ['planning', 'running', 'judging', 'fixing', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

/** Legal group status moves. A group with no criteria passes without a group check (running to passed). */
export const GROUP_TRANSITIONS: Readonly<Record<GroupStatus, readonly GroupStatus[]>> = {
  pending: ['blocked', 'running', 'failed', 'cancelled'],
  blocked: ['pending', 'running', 'failed', 'cancelled'],
  running: ['judging', 'passed', 'awaiting-owner', 'failed', 'cancelled'],
  judging: ['passed', 'fixing', 'awaiting-owner', 'failed', 'cancelled'],
  fixing: ['judging', 'awaiting-owner', 'failed', 'cancelled'],
  'awaiting-owner': ['running', 'judging', 'fixing', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

/**
 * Legal unit status moves. `passed` is reachable only from a check (checking
 * or held), from a best-of-N selection (held-merge), or from the owner
 * confirming unshown readings (awaiting-owner); the runner, not this table,
 * enforces that no criterion reads unmet at that moment. `pending` is where a
 * requeued unit (transport retry, silence retry, fresh agent) waits for its
 * next agent.
 */
export const UNIT_TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  pending: ['blocked', 'running', 'failed', 'cancelled'],
  blocked: ['pending', 'running', 'failed', 'cancelled'],
  running: ['checking', 'held', 'pending', 'failed', 'cancelled'],
  checking: ['running', 'held', 'nudged', 'passed', 'fixing', 'awaiting-owner', 'pending', 'failed', 'cancelled'],
  held: ['nudged', 'passed', 'held-merge', 'fixing', 'awaiting-owner', 'pending', 'failed', 'cancelled'],
  nudged: ['running', 'checking', 'held', 'pending', 'failed', 'cancelled'],
  fixing: ['checking', 'awaiting-owner', 'failed', 'cancelled'],
  'awaiting-owner': ['checking', 'passed', 'fixing', 'pending', 'failed', 'cancelled'],
  'held-merge': ['passed', 'fixing', 'awaiting-owner', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalContractStatus(status: ContractStatus): boolean {
  return CONTRACT_TRANSITIONS[status].length === 0;
}

export function isTerminalGroupStatus(status: GroupStatus): boolean {
  return GROUP_TRANSITIONS[status].length === 0;
}

export function isTerminalUnitStatus(status: UnitStatus): boolean {
  return UNIT_TRANSITIONS[status].length === 0;
}

/** Thrown for a status move its transition table does not allow. */
export class IllegalContractTransitionError extends Error {
  constructor(
    readonly subject: 'contract' | 'group' | 'unit',
    readonly subjectId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${subject} transition: ${from} -> ${to} for ${subject} ${subjectId}`);
    this.name = 'IllegalContractTransitionError';
  }
}

/** A status move that happened, for the caller to emit. */
export interface StatusChange<S extends string> {
  readonly from: S;
  readonly to: S;
}

function move<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  subject: 'contract' | 'group' | 'unit',
  target: { readonly id: string; status: S },
  to: S,
): StatusChange<S> {
  const from = target.status;
  if (!table[from].includes(to)) throw new IllegalContractTransitionError(subject, target.id, from, to);
  target.status = to;
  return { from, to };
}

/** Moves a contract to `to`, or throws IllegalContractTransitionError. */
export function transitionContract(contract: Contract, to: ContractStatus): StatusChange<ContractStatus> {
  return move(CONTRACT_TRANSITIONS, 'contract', contract, to);
}

/** Moves a group to `to`, or throws IllegalContractTransitionError. */
export function transitionGroup(group: ContractGroup, to: GroupStatus): StatusChange<GroupStatus> {
  return move(GROUP_TRANSITIONS, 'group', group, to);
}

/** Moves a unit to `to`, or throws IllegalContractTransitionError. */
export function transitionUnit(unit: ContractUnit, to: UnitStatus): StatusChange<UnitStatus> {
  return move(UNIT_TRANSITIONS, 'unit', unit, to);
}
