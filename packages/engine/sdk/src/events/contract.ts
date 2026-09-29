/**
 * ContractEvent, the `contracts` runtime domain: every lifecycle event of the
 * contract runner (docs/design/contract-runner.md section 8.1).
 *
 * This module is the wire vocabulary. It is self-contained, as every module
 * under events/ is, so a consumer of the events subpath needs nothing else to
 * read a contract event. The status unions and the other closed string sets
 * are declared here once, as const arrays, so the runtime validators and the
 * contract data model (platform/contract/types.ts) share one list.
 */

/** Contract lifecycle status. */
export const CONTRACT_STATUSES = [
  'queued',
  'shaping',
  'planning',
  'checking-plan',
  'running',
  'judging',
  'fixing',
  'committing',
  'awaiting-owner',
  'passed',
  'failed',
  'cancelled',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** Status of one group of units. */
export const CONTRACT_GROUP_STATUSES = [
  'pending',
  'blocked',
  'running',
  'judging',
  'fixing',
  'awaiting-owner',
  'passed',
  'failed',
  'cancelled',
] as const;
export type ContractGroupStatus = (typeof CONTRACT_GROUP_STATUSES)[number];

/** Status of one unit of work. */
export const CONTRACT_UNIT_STATUSES = [
  'pending',
  'blocked',
  'running',
  'checking',
  'held',
  'nudged',
  'fixing',
  'awaiting-owner',
  'held-merge',
  'passed',
  'failed',
  'cancelled',
] as const;
export type ContractUnitStatus = (typeof CONTRACT_UNIT_STATUSES)[number];

/** Why a contract failed, or (owner-rejected) why it was cancelled. */
export const CONTRACT_FAILURE_KINDS = [
  'transport',
  'max_turns',
  'planning',
  'budget',
  'owner-rejected',
  'judgment-unavailable',
  'zombie',
  'other',
] as const;
export type ContractFailureKind = (typeof CONTRACT_FAILURE_KINDS)[number];

/** Where the work that started a contract came from. */
export const CONTRACT_ORIGINS = ['turn', 'agent-tool', 'cli', 'hosted', 'external', 'proposal'] as const;
export type ContractOrigin = (typeof CONTRACT_ORIGINS)[number];

/**
 * The part an agent plays in a contract: the owner record parents wait on, a
 * unit's sub-agent, or the read-only planner. Carried on the agent record and
 * on the `agents` domain events as `contractRole`.
 */
export const CONTRACT_AGENT_ROLES = ['owner', 'unit', 'planner'] as const;
export type ContractAgentRole = (typeof CONTRACT_AGENT_ROLES)[number];

/** What code does with a reading: act, confirm with the owner, or escalate. Same strings as the judgment foundation's Outcome. */
export const CONTRACT_OUTCOMES = ['act', 'confirm', 'escalate'] as const;
export type ContractOutcome = (typeof CONTRACT_OUTCOMES)[number];

export const CRITERION_ORIGINS = ['stated', 'derived', 'integration', 'fix', 'owner'] as const;
export type CriterionOrigin = (typeof CRITERION_ORIGINS)[number];

export const CRITERION_DISPOSITIONS = ['judged', 'excluded', 'met-by-structure'] as const;
export type CriterionDisposition = (typeof CRITERION_DISPOSITIONS)[number];

export const CRITERION_STATUSES = ['unread', 'met', 'unmet', 'unshown'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/** A criterion's verdict from one check. */
export const CRITERION_VERDICTS = ['met', 'unmet', 'unshown'] as const;
export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number];

/** A yes/no reading's verdict, as the judgment foundation reports it. */
export const YES_NO_VERDICTS = ['yes', 'no', 'uncertain'] as const;
export type YesNoVerdict = (typeof YES_NO_VERDICTS)[number];

export const CHECK_TRIGGERS = ['turn-end', 'completion', 'agent-failed', 'fix-passed', 'resume', 'owner-amend'] as const;
export type CheckTrigger = (typeof CHECK_TRIGGERS)[number];

export const CHECK_RESULTS = ['pass', 'nudge', 'await-owner', 'stall', 'recorded'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const CHECK_SCOPES = ['unit', 'group', 'deliverable'] as const;
export type CheckScope = (typeof CHECK_SCOPES)[number];

/** The quality battery's items (design 4.4). */
export const QUALITY_ITEMS = [
  'placeholder',
  'tests_weakened',
  'breaks_existing',
  'out_of_scope',
  'hidden_failure',
  'unsupported_claims',
] as const;
export type QualityItem = (typeof QUALITY_ITEMS)[number];

/** Claim verification result kinds (moved from the engineer claim check). */
export const CLAIM_VERIFICATION_KINDS = [
  'files_verified',
  'git_corroborated',
  'verified_empty',
  'unverifiable_no_claims',
  'unverified',
] as const;
export type ClaimVerificationKind = (typeof CLAIM_VERIFICATION_KINDS)[number];

export const NUDGE_KINDS = ['unmet', 'unshown', 'regression', 'quality', 'gate', 'claims'] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

export const NUDGE_DELIVERIES = ['hold', 'bus', 'wake'] as const;
export type NudgeDelivery = (typeof NUDGE_DELIVERIES)[number];

export const ESCALATION_SCOPES = ['plan', 'unit', 'group', 'deliverable', 'shape'] as const;
export type EscalationScope = (typeof ESCALATION_SCOPES)[number];

export const ESCALATION_REASONS = [
  'plan-unresolved',
  'stalled',
  'unsettled',
  'fix-rounds-exhausted',
  'writing-unclear',
  'attempts-undecided',
  'owner-decision-needed',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** The readings an owner's reply can have (the reply pattern's defaults). */
export const OWNER_REPLY_READINGS = ['approve', 'reject', 'amend', 'unclear'] as const;
export type OwnerReplyReading = (typeof OWNER_REPLY_READINGS)[number];

/** What the runner did with an owner's reply (the action of CONTRACT_OWNER_REPLIED). */
export const OWNER_REPLY_ACTIONS = ['approved', 'amended', 'stopped', 'asked-again', 'refused'] as const;
export type OwnerReplyAction = (typeof OWNER_REPLY_ACTIONS)[number];

export const STALL_ROUTES = ['split', 'fresh', 'owner'] as const;
export type StallRoute = (typeof STALL_ROUTES)[number];

/** The plan checks reported by CONTRACT_PLAN_CHECKED: the code checks, then each Jev check. */
export const PLAN_CHECKS = ['structure', 'criterion-trace', 'plan-coverage', 'criterion-shape', 'unit-shape'] as const;
export type PlanCheck = (typeof PLAN_CHECKS)[number];

export const UNIT_SPAWN_PURPOSES = ['unit', 'fresh-unit', 'transport-retry', 'silence-retry', 'resume'] as const;
export type UnitSpawnPurpose = (typeof UNIT_SPAWN_PURPOSES)[number];

export const CONTRACT_COMMIT_STATUSES = ['committed', 'applied', 'skipped', 'failed'] as const;
export type ContractCommitStatus = (typeof CONTRACT_COMMIT_STATUSES)[number];

export const UNIT_ROLES = ['implement', 'research', 'design', 'integration'] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];

export const GROUP_KINDS = ['work', 'fix', 'integration'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const UNIT_SILENCE_ACTIONS = ['retried', 'failed'] as const;
export type UnitSilenceAction = (typeof UNIT_SILENCE_ACTIONS)[number];

/** How much an unmet criterion matters, read by the unmet-severity battery. */
export const CRITERION_SEVERITIES = ['critical', 'major', 'minor'] as const;
export type CriterionSeverity = (typeof CRITERION_SEVERITIES)[number];

/** What a contract decision records the runner did. */
export const CONTRACT_DECISION_ACTIONS = [
  'created', 'queued', 'shaped', 'planned', 'plan-repaired', 'plan-accepted', 'spawned', 'checked',
  'nudged', 'woke', 'regressed', 'stalled', 'fix-planned', 'fresh-agent', 'escalated',
  'owner-replied', 'transport-retry', 'silence-retry', 'attempts-selected', 'attempts-reduced', 'group-passed',
  'committed', 'passed', 'failed', 'cancelled', 'resumed', 'reaped',
] as const;
export type ContractDecisionAction = (typeof CONTRACT_DECISION_ACTIONS)[number];

/** Which input set a unit agent's turn ceiling, carried on a max_turns failure. */
export const TURN_LIMIT_SOURCES = ['default', 'spawn-override', 'policy-bound'] as const;
export type TurnLimitSource = (typeof TURN_LIMIT_SOURCES)[number];

/** One question of the request-shape battery, as it was read. */
export interface ContractShapeReading {
  readonly verdict: YesNoVerdict;
  /** The probability that the answer is yes. */
  readonly probability: number;
  readonly outcome: ContractOutcome;
}

/** A criterion as the plan states it, carried by CONTRACT_PLANNED. Readings are not carried: at plan time there are none. */
export interface ContractPlannedCriterion {
  readonly id: string;
  readonly text: string;
  readonly origin: CriterionOrigin;
  readonly quote?: string | undefined;
  readonly serves: readonly string[];
  readonly disposition: CriterionDisposition;
  readonly dispositionReason?: string | undefined;
}

export interface ContractPlannedGroup {
  readonly id: string;
  readonly title: string;
  readonly kind: GroupKind;
  readonly dependsOn: readonly string[];
  readonly unitIds: readonly string[];
}

export interface ContractPlannedUnit {
  readonly id: string;
  readonly groupId: string;
  readonly title: string;
  readonly role: UnitRole;
  readonly dependsOn: readonly string[];
  readonly attempts: number;
}

export interface ContractPlanProblem {
  readonly code: string;
  readonly targetId?: string | undefined;
  readonly message: string;
}

export interface ContractCheckedCriterion {
  readonly criterionId: string;
  readonly verdict: CriterionVerdict;
  readonly probabilityUnmet: number;
  readonly outcome: ContractOutcome;
}

export interface ContractCheckedQuality {
  readonly item: QualityItem;
  readonly verdict: YesNoVerdict;
  readonly outcome: ContractOutcome;
}

export interface ContractCheckedGate {
  readonly gate: string;
  readonly passed: boolean;
  readonly skipped: boolean;
}

export interface ContractUnitRouteSummary {
  readonly model: string;
  readonly provider: string;
  readonly reasoningEffort?: string | undefined;
  readonly reason: string;
}

export type ContractEvent =
  | { type: 'CONTRACT_CREATED'; contractId: string; sessionId: string; origin: ContractOrigin; ask: string; ownerAgentId: string }
  | { type: 'CONTRACT_STATUS_CHANGED'; contractId: string; from: ContractStatus; to: ContractStatus }
  | {
      type: 'CONTRACT_SHAPED';
      contractId: string;
      forbidsDelegation: ContractShapeReading;
      requestsParallelAgents: ContractShapeReading;
      forbidsWriting: ContractShapeReading;
      asksForAttempts: ContractShapeReading;
      decisionIds: readonly string[];
    }
  | {
      type: 'CONTRACT_PLANNED';
      contractId: string;
      goal: string;
      criteria: readonly ContractPlannedCriterion[];
      groups: readonly ContractPlannedGroup[];
      units: readonly ContractPlannedUnit[];
      /** 0 for the first plan, n for the nth repair. */
      repair: number;
    }
  | {
      type: 'CONTRACT_PLAN_CHECKED';
      contractId: string;
      check: PlanCheck;
      targetId?: string | undefined;
      passed: boolean;
      problems: readonly ContractPlanProblem[];
      decisionIds: readonly string[];
    }
  | { type: 'CONTRACT_GROUP_STATUS_CHANGED'; contractId: string; groupId: string; from: ContractGroupStatus; to: ContractGroupStatus }
  | {
      type: 'CONTRACT_UNIT_STATUS_CHANGED';
      contractId: string;
      groupId: string;
      unitId: string;
      from: ContractUnitStatus;
      to: ContractUnitStatus;
      agentId?: string | undefined;
    }
  | { type: 'CONTRACT_UNIT_SPAWNED'; contractId: string; unitId: string; agentId: string; route: ContractUnitRouteSummary; purpose: UnitSpawnPurpose }
  | {
      type: 'CONTRACT_CHECKED';
      contractId: string;
      scope: CheckScope;
      targetId: string;
      checkId: string;
      trigger: CheckTrigger;
      result: CheckResult;
      criteria: readonly ContractCheckedCriterion[];
      goal: { readonly verdict: CriterionVerdict; readonly outcome: ContractOutcome };
      quality: readonly ContractCheckedQuality[];
      gates: readonly ContractCheckedGate[];
      claims?: ClaimVerificationKind | undefined;
      decisionIds: readonly string[];
    }
  | {
      type: 'CONTRACT_NUDGED';
      contractId: string;
      unitId: string;
      nudgeId: string;
      checkId: string;
      kinds: readonly NudgeKind[];
      criterionIds: readonly string[];
      delivery: NudgeDelivery;
      agentId: string;
    }
  | { type: 'CONTRACT_NUDGE_CONSUMED'; contractId: string; unitId: string; nudgeId: string; agentId: string; turn?: number | undefined }
  | { type: 'CONTRACT_CRITERION_REGRESSED'; contractId: string; unitId: string; criterionId: string; metAtCheckId: string; checkId: string }
  | {
      type: 'CONTRACT_STALLED';
      contractId: string;
      scope: CheckScope;
      targetId: string;
      route: StallRoute;
      unmetCriterionIds: readonly string[];
      reason: string;
      decisionId?: string | undefined;
    }
  | { type: 'CONTRACT_FIX_PLANNED'; contractId: string; scope: CheckScope; targetId: string; groupId: string; unitIds: readonly string[]; round: number }
  | {
      type: 'CONTRACT_ESCALATED';
      contractId: string;
      escalationId: string;
      scope: EscalationScope;
      targetId: string;
      reason: EscalationReason;
      question: string;
      unmetCriterionIds: readonly string[];
    }
  | { type: 'CONTRACT_OWNER_REPLIED'; contractId: string; escalationId: string; reading: OwnerReplyReading; outcome: ContractOutcome; action: string }
  | { type: 'CONTRACT_GATE_RESULT'; contractId: string; targetId: string; gate: string; passed: boolean; skipped: boolean; durationMs: number }
  | { type: 'CONTRACT_UNIT_SILENT'; contractId: string; unitId: string; agentId: string; silentMs: number; action: UnitSilenceAction }
  | { type: 'CONTRACT_MERGE_CONFLICT'; contractId: string; unitId: string; branch: string; path: string; files: readonly string[] }
  | {
      type: 'CONTRACT_ATTEMPTS_SELECTED';
      contractId: string;
      unitId: string;
      candidateIds: readonly string[];
      chosen: string | null;
      outcome: ContractOutcome;
      decisionId?: string | undefined;
    }
  | { type: 'CONTRACT_COMMITTED'; contractId: string; status: ContractCommitStatus; hash?: string | undefined; note: string }
  | { type: 'CONTRACT_PASSED'; contractId: string; criteriaMet: number; criteriaJudged: number; excluded: number; nudges: number }
  | {
      type: 'CONTRACT_FAILED';
      contractId: string;
      reason: string;
      failureKind: ContractFailureKind;
      /** True when every member agent (owner, planner, units) was already terminal when the outcome was emitted. */
      membersSettled: boolean;
      turnLimit?: number | undefined;
      turnLimitSource?: TurnLimitSource | undefined;
    }
  | { type: 'CONTRACT_CANCELLED'; contractId: string; reason: string; filesModified: number }
  | {
      type: 'CONTRACT_SPAWN_GUARD_TRIGGERED';
      /** Absent when the refused spawn belongs to no contract (the conversation-level recursion guard). */
      contractId?: string | undefined;
      agentId: string;
      depth: number;
      activeAgents: number;
      reason: string;
    };

export type ContractEventType = ContractEvent['type'];

/** Every contract event type, in the order section 8.1 lists them. */
export const CONTRACT_EVENT_TYPES = [
  'CONTRACT_CREATED',
  'CONTRACT_STATUS_CHANGED',
  'CONTRACT_SHAPED',
  'CONTRACT_PLANNED',
  'CONTRACT_PLAN_CHECKED',
  'CONTRACT_GROUP_STATUS_CHANGED',
  'CONTRACT_UNIT_STATUS_CHANGED',
  'CONTRACT_UNIT_SPAWNED',
  'CONTRACT_CHECKED',
  'CONTRACT_NUDGED',
  'CONTRACT_NUDGE_CONSUMED',
  'CONTRACT_CRITERION_REGRESSED',
  'CONTRACT_STALLED',
  'CONTRACT_FIX_PLANNED',
  'CONTRACT_ESCALATED',
  'CONTRACT_OWNER_REPLIED',
  'CONTRACT_GATE_RESULT',
  'CONTRACT_UNIT_SILENT',
  'CONTRACT_MERGE_CONFLICT',
  'CONTRACT_ATTEMPTS_SELECTED',
  'CONTRACT_COMMITTED',
  'CONTRACT_PASSED',
  'CONTRACT_FAILED',
  'CONTRACT_CANCELLED',
  'CONTRACT_SPAWN_GUARD_TRIGGERED',
] as const satisfies readonly ContractEventType[];

/** Compile-time proof that CONTRACT_EVENT_TYPES names every member of the union. */
type MissingContractEventType = Exclude<ContractEventType, (typeof CONTRACT_EVENT_TYPES)[number]>;
const everyContractEventTypeListed: MissingContractEventType extends never ? true : never = true;
void everyContractEventTypeListed;
