/**
 * The contract runner (docs/design/contract-runner.md). Curated named exports,
 * the convention orchestration/index.ts uses.
 */
export {
  CONTRACT_AGENT_ROLES,
  CONTRACT_DECISION_ACTIONS,
  CONTRACT_FAILURE_KINDS,
  CONTRACT_GROUP_STATUSES,
  CONTRACT_ID_PATTERN,
  CONTRACT_ORIGINS,
  CONTRACT_STATUSES,
  CONTRACT_TRANSITIONS,
  CONTRACT_UNIT_STATUSES,
  CRITERION_SEVERITIES,
  CURRENT_CONTRACT_SCHEMA_VERSION,
  GROUP_TRANSITIONS,
  IllegalContractTransitionError,
  QUALITY_ITEMS,
  UNIT_TRANSITIONS,
  isContractId,
  isTerminalContractStatus,
  isTerminalGroupStatus,
  isTerminalUnitStatus,
  newContractId,
  transitionContract,
  transitionGroup,
  transitionUnit,
} from './types.js';
export type {
  AgentManagerLike,
  AttemptSelectionRecord,
  CheckResult,
  CheckTrigger,
  Contract,
  ContractAgentRole,
  ContractDecision,
  ContractDecisionAction,
  ContractFailureKind,
  ContractGroup,
  ContractGroupView,
  ContractOrigin,
  ContractRouteSelector,
  ContractStatus,
  ContractUnit,
  ContractUnitView,
  ContractView,
  Criterion,
  CriterionDisposition,
  CriterionOrigin,
  CriterionReading,
  CriterionSeverity,
  CriterionStatus,
  CriterionVerdict,
  CriterionView,
  DeepReadonly,
  DraftedPlan,
  DraftedUnit,
  Escalation,
  EscalationReason,
  EscalationScope,
  GroupKind,
  GroupStatus,
  JudgmentUsage,
  Nudge,
  NudgeDelivery,
  NudgeKind,
  QualityItem,
  RequestShape,
  ShapeReading,
  StartContractInput,
  StartFromPlanInput,
  StatusChange,
  TreeBaseline,
  UnitCheck,
  UnitRole,
  UnitRoute,
  UnitStatus,
  YesNoVerdict,
} from './types.js';
export {
  CONTRACT_CONFIG_DEFAULTS,
  getContractAcceptanceStakes,
  getContractAutoCommit,
  getContractCommitScope,
  getContractDefaultAttempts,
  getContractEvidenceNudgeLimit,
  getContractGateTimeoutMs,
  getContractGates,
  getContractHeartbeatTimeoutMs,
  getContractIsolation,
  getContractMaxActiveContracts,
  getContractMaxFixRounds,
  getContractMaxNudgesPerUnit,
  getContractMaxParallelUnits,
  getContractMaxUnits,
  getContractMidRunChecks,
  getContractNudgeTtlMs,
  getContractPlanRepairLimit,
  getContractStallLimit,
  getContractTransportRetryDelayMs,
  getContractTransportRetryLimit,
  getEnabledContractGates,
  readContractConfig,
} from './config.js';
export type {
  ContractAcceptanceStakes,
  ContractCommitScope,
  ContractConfig,
  ContractConfigReader,
  ContractIsolationSetting,
} from './config.js';
export {
  CONTRACT_QUARANTINE_MAX_AGE_MS,
  ContractStore,
  MAX_CONTRACT_QUARANTINE_FILES,
  MAX_TERMINAL_CONTRACT_FILES,
  TERMINAL_CONTRACT_MAX_AGE_MS,
  contractPath,
  contractsDir,
  deserializeContract,
  readContractSnapshot,
  serializeContract,
} from './store.js';
export type { ContractReapSummary, ContractSnapshot, ContractSnapshotRejection, ContractStoreOptions } from './store.js';
export { CHANGING_TOOLS, createUnitCheckLoop, queueSessionNudge } from './agent-hooks.js';
export type { ContractAgentHooks, ContractHoldOutcome, ContractSessionHooks, UnitCheckEscalations, UnitCheckLoop, UnitCheckLoopDeps } from './agent-hooks.js';
// Running contracts (sections 2.2, 4, 6.1, 7.3 and 7.4).
export { AGENT_MANAGER_SESSION_ID, createContractRunner, filesModified, resolveIsolation } from './runner.js';
export type { ContractRunner, ContractRunnerDeps, StartedContract } from './runner.js';
// Resume and zombie reaping at startup (section 7.2).
export { createContractResume, findZombieCause, resumeStatus, resumeStepOf } from './resume.js';
export type { ContractResume, ContractResumeDeps, ResumeReport, ResumeStep } from './resume.js';
// Correction and finishing (sections 5 and 6).
export { createContractSteps } from './steps.js';
export type { ContractSteps, ContractStepsWithReplies, StepContext } from './steps.js';
export { SESSION_NO_DELEGATION_NOTE, STALL_ROUTE_SITE, checkSummaries, createCorrection } from './correction.js';
export type { Correction, TargetFinding } from './correction.js';
export { buildFixGroup, buildFixPlannerPrompt, buildFixPlannerRequest, buildFreshGroup, validateFixPlan } from './fix-plan.js';
export type { FixBrief, FixScope } from './fix-plan.js';
export { COMPLETION_SITES, buildContractCommitMessage, contractTree, createCompletion } from './completion.js';
export type { Completion } from './completion.js';
export {
  AMENDMENT_FAILED_LINE,
  APPROVAL_REFUSED_LINE,
  ASK_AGAIN_LINE,
  NAME_AN_ATTEMPT_LINE,
  OWNER_PICK_SITE,
  OWNER_REPLY_SITE,
  PLAN_UNRUNNABLE_LINE,
  REASON_SENTENCES,
  buildAttemptsQuestion,
  buildEscalationQuestion,
  createEscalations,
  standingCriteria,
  targetCriteria,
} from './escalation.js';
export type { EscalationInput, Escalations, OwnerReplyAction, OwnerReplyOutcome, Rejudge } from './escalation.js';
export { amendTarget, buildAmendmentPrompt, buildAmendmentRequest, parseAmendment } from './amendment.js';
export type { AmendmentOutcome } from './amendment.js';
export { CONTRACT_PASSED_WITHOUT_OUTPUT, answerUnit, describeCommitOutcome, describeContractOutcome, renderContractAnswer } from './answer.js';
export {
  CONTRACT_TASK_STATUS,
  CONTRACT_WORK_PLAN_SOURCE,
  UNIT_TASK_STATUS,
  completePlanItemsForUnit,
  contractTaskId,
  createContractPlanSync,
  unitTaskId,
} from './plan-sync.js';
export type { ContractPlanSync, ContractPlanSyncDeps, ExecutionPlans, WorkPlanService } from './plan-sync.js';
export { ContractRun, failureFromError, isAbortError } from './run-context.js';
export type { InFlightCheck, RunControl, RunEnv, SessionTurnState, SpawnPurpose, UnitRuntime } from './run-context.js';
export { createGroupRunner, engineItem, takeBaseline } from './group-runner.js';
export type { ContractEngineInput, GroupRunner, GroupRunnerDeps, GroupSteps } from './group-runner.js';
export {
  ATTEMPT_ANSWER_CAP_CHARS,
  BEST_OF_N_SITE,
  acceptAttempt,
  attemptUnitsFor,
  createContractAttemptJudge,
  createSelectAttemptJudge,
  describeSelection,
  readBestOfN,
  selectAttempts,
  selectionCandidates,
  taskContext,
  unitSelectionContext,
} from './best-of-n.js';
export type { AttemptCandidateSource, AttemptJudgeContext, AttemptSelectionDeps, AttemptSteps } from './best-of-n.js';
export { acquireSharedTree, groupWorkstreamInput, phaseCapacity, remainingBudget, sharedTreeWaiters, unitPhases, unitTemplate, unitWorkItem } from './workstreams.js';
export { BRIEF_CHECKED_PARAGRAPH, briefWithPreviousChecks, buildUnitBrief } from './brief.js';
export { addJudgmentUsage, agentsUsage, contractAgentIds, mergeAll, ownerRecordUsage, rollUpContractUsage } from './usage.js';
export type { AgentLookup, PriceUsageFn, UsagePricing } from './usage.js';
export { createUnitWatchdog, watchdogIntervalMs } from './watchdog.js';
export type { UnitWatchdog, UnitWatchdogDeps, WatchedAgent } from './watchdog.js';
export { TRANSPORT_RETRY_SITE, createUnitFailureHandling } from './unit-failures.js';
export type { UnitFailureDeps, UnitFailureHandling } from './unit-failures.js';
export { CONTRACT_EVENT_SOURCE, contractEmitterContext, contractTraceId, emitContractEvent } from './events.js';
export { executeGateCommand, failedGates, getSkippedGateReason, loadPackageScripts, runContractGates } from './gates.js';
export type { QualityGate, QualityGateResult, RunContractGatesOptions } from './gates.js';
export { parseUnitCompletionReport, verifyUnitClaims } from './claims.js';
export type { ClaimVerificationKind, ClaimVerificationResult, UnitCompletionReport } from './claims.js';
export {
  COMMAND_HEAD_LINES,
  DIFF_FILE_CAP_CHARS,
  EVIDENCE_TOKEN_BUDGET,
  GATE_OUTPUT_CAP_CHARS,
  MAX_COMMANDS,
  OUTPUT_CAP_CHARS,
  collectChanges,
  collectUnitEvidence,
  commandsFromTurns,
  evidenceTokens,
  judgeEvidence,
  judgeState,
  qualityState,
  trimEvidence,
  writtenPaths,
} from './evidence.js';
export type { CheckState, ContractTurnRecord, EvidenceCommand, FileChange, RawUnitEvidence, UnitEvidence, UnitEvidenceSources } from './evidence.js';
export {
  CHECK_SITES,
  applySeverities,
  applyUnitCheck,
  checkSettings,
  criterionVerdict,
  meteredPort,
  qualityVerdict,
  readUnmetSeverities,
  runUnitCheck,
  unitMustWrite,
} from './check.js';
export type { CheckNudge, CheckSettings, DecidedCheck, DiscardedCheck, QualityVerdict, SeverityReading, UnitCheckInput, UnitCheckOutcome } from './check.js';
export {
  consecutiveUnsettledChecks,
  describeStall,
  detectStall,
  findRegressions,
  madeProgress,
  regressionCounts,
  standingOf,
} from './progress.js';
export type { CheckStanding, Regression, StallLimits, StallReason } from './progress.js';
export {
  CONTRACT_RUNNER_AGENT_ID,
  QUALITY_EVIDENCE_SENTENCES,
  QUALITY_PROBLEM_SENTENCES,
  buildNudge,
  buildPreviousChecks,
  checkNumberOf,
  createNudge,
  dispatchNudge,
  latestSeverity,
  nudgeDeliveryFor,
} from './nudge.js';
export type { NudgeDispatch, NudgeFindings, NudgeTargetState, NudgeTransport } from './nudge.js';
export { UNIT_JUDGES, UNIT_JUDGE_BANDS, unitJudgeDecision } from './batteries/unit-judge.js';
export { MID_RUN_QUALITY_ITEMS, UNIT_QUALITY_BAND, unitQuality } from './batteries/unit-quality.js';
export { unmetSeverity } from './batteries/unmet-severity.js';
export { STALL_ROUTE_OPTIONS, stallRoute } from './batteries/stall-route.js';
export { GROUP_JUDGES, groupJudgeDecision } from './batteries/group-judge.js';
export { DELIVERABLE_JUDGES, deliverableJudgeDecision } from './batteries/deliverable-judge.js';
export { ownerReply } from './batteries/owner-reply.js';
export { ownerPick } from './batteries/owner-pick.js';
export { BEST_OF_N_FIT_INSTRUCTIONS, BEST_OF_N_INSTRUCTIONS, bestOfN } from './batteries/best-of-n.js';
// Planning (section 3).
export {
  delegationForbidden,
  readRequestShape,
  requestShape,
  saysNoAtAct,
  saysYesAtAct,
  writingUnclear,
} from './batteries/request-shape.js';
export { criterionTrace, traceClaim } from './batteries/criterion-trace.js';
export { planCoverage } from './batteries/plan-coverage.js';
export { criterionShape } from './batteries/criterion-shape.js';
export { UNIT_SHAPE_ROLES, VERIFICATION_ROLES, unitShape } from './batteries/unit-shape.js';
export type { UnitShapeRole } from './batteries/unit-shape.js';
export {
  PLAN_PROBLEM_CODES,
  UNRUNNABLE_PLAN_PROBLEMS,
  effectiveAttempts,
  findParallelGroup,
  isUnitRole,
  lastFencedBlock,
  parseContractPlan,
  planUnits,
  renderContractPlan,
  unitToolContract,
  validateContractPlan,
} from './plan-schema.js';
export type {
  ContractPlan,
  ParsedContractPlan,
  PlanLimits,
  PlanProblem,
  PlanProblemCode,
  PlannedDerivedCriterion,
  PlannedGroup,
  PlannedStatedCriterion,
  PlannedUnit,
  UnitToolContract,
} from './plan-schema.js';
export { EXCLUDED_TOPOLOGY_REASON, PLAN_CHECK_SITES, readCriterionDispositions, runPlanChecks, runUnitShapeChecks, unitShapeState } from './plan-checks.js';
export type { CriterionDispositionRuling, JevPlanCheck, PlanCheckOptions, PlanCheckReport, PlanCheckUsage, PlanVerdict } from './plan-checks.js';
export {
  acceptEscalatedPlan,
  buildContractPlannerPrompt,
  buildContractPlannerRequest,
  buildPlanEscalationQuestion,
  buildPlanTree,
  buildWritingEscalationQuestion,
  defaultRepositoryMap,
  planContract,
  readPlannerBounds,
  shapeContract,
  withOwnerWritingDecision,
} from './planner.js';
export type { ContractPlannerDeps, EscalatedPlanOutcome, PlanContractInput, PlannerRequestInput, PlanningOutcome, ShapeOutcome } from './planner.js';
export { registry as contractJudgmentRegistry } from './judgment-registry.js';
// Entry points (section 10): turn intake, drafted plans, the fleet verbs, the route selector, the external seam.
export { createContractIntake, describeIntake, openEscalation, toolResultStartedContract } from './intake-route.js';
export type { ContractIntake, ContractIntakeDeps, TurnIntakeOutcome } from './intake-route.js';
export { REQUEST_ROUTE_SITE, requestRoute } from './batteries/request-route.js';
export { checkDraftFidelity, draftSection, numberDraft } from './draft-plan.js';
export { createContractFleetControls, qualifyId, splitQualifiedId } from './fleet-controls.js';
export type { ContractConflictItem, ContractFleetControls, ContractFleetControlsDeps } from './fleet-controls.js';
export { createRoutePlannerContractSelector } from './route.js';
export { ContractExternalWorkBridge } from './external.js';
export type {
  ContractExternalWorkAdapter,
  ContractExternalWorkHandle,
  ContractExternalWorkRequest,
  ContractExternalWorkResult,
  ContractExternalWorkSnapshot,
  ContractExternalWorkStatus,
} from './external.js';
