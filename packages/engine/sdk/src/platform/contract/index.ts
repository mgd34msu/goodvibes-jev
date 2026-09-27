/**
 * The contract runner (docs/design/contract-runner.md). Curated named exports,
 * the convention orchestration/index.ts uses.
 */
export {
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
  CheckResult,
  CheckTrigger,
  Contract,
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
  StatusChange,
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
export { CONTRACT_EVENT_SOURCE, contractEmitterContext, contractTraceId, emitContractEvent } from './events.js';
export type { QualityGate, QualityGateResult } from './gates.js';
export type { ClaimVerificationKind, ClaimVerificationResult } from './claims.js';
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
export { EXCLUDED_TOPOLOGY_REASON, PLAN_CHECK_SITES, readCriterionDispositions, runPlanChecks, unitShapeState } from './plan-checks.js';
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
