/**
 * Event type and guard exports for @pellux/goodvibes-sdk/events.
 *
 * Validation helpers:
 * - `isRuntimeEventDomain(value)`, typeguard for the 28 domain names.
 * - `isKnownEventType(value)`, typeguard for the full discriminant union of event types.
 * - `registeredEventTypes()`, enumerates all known event-type strings.
 * - `validateKnownEvent(envelope)`, runtime-validates an envelope's payload against the contract registry.
 */
export type { SessionEvent, SessionEventType } from './session.js';
export type { TurnEvent, TurnEventType, TurnInputOrigin, TurnStopReason, PartialToolCall } from './turn.js';
export type { ProviderEvent, ProviderEventType } from './providers.js';
export type { ToolEvent, ToolEventType, ToolResultSummary } from './tools.js';
export type { TaskEvent, TaskEventType } from './tasks.js';
export type { AgentEvent, AgentEventType, AgentTaskContract, AgentUsage } from './agents.js';
export type {
  CheckResult,
  CheckScope,
  CheckTrigger,
  ClaimVerificationKind,
  ContractAgentRole,
  ContractCheckedCriterion,
  ContractCheckedGate,
  ContractCheckedQuality,
  ContractCommitStatus,
  ContractEvent,
  ContractEventType,
  ContractFailureKind,
  ContractGroupStatus,
  ContractOrigin,
  ContractOutcome,
  ContractPlannedCriterion,
  ContractPlannedGroup,
  ContractPlannedUnit,
  ContractPlanProblem,
  ContractShapeReading,
  ContractStatus,
  ContractUnitRouteSummary,
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
  OwnerReplyReading,
  PlanCheck,
  QualityItem,
  StallRoute,
  TurnLimitSource,
  UnitRole,
  UnitSilenceAction,
  UnitSpawnPurpose,
  YesNoVerdict,
} from './contract.js';
export {
  CHECK_RESULTS,
  CHECK_SCOPES,
  CHECK_TRIGGERS,
  CLAIM_VERIFICATION_KINDS,
  CONTRACT_AGENT_ROLES,
  CONTRACT_COMMIT_STATUSES,
  CONTRACT_EVENT_TYPES,
  CONTRACT_FAILURE_KINDS,
  CONTRACT_GROUP_STATUSES,
  CONTRACT_ORIGINS,
  CONTRACT_OUTCOMES,
  CONTRACT_STATUSES,
  CONTRACT_UNIT_STATUSES,
  CRITERION_DISPOSITIONS,
  CRITERION_ORIGINS,
  CRITERION_STATUSES,
  CRITERION_VERDICTS,
  ESCALATION_REASONS,
  ESCALATION_SCOPES,
  GROUP_KINDS,
  NUDGE_DELIVERIES,
  NUDGE_KINDS,
  OWNER_REPLY_READINGS,
  PLAN_CHECKS,
  QUALITY_ITEMS,
  STALL_ROUTES,
  TURN_LIMIT_SOURCES,
  UNIT_ROLES,
  UNIT_SILENCE_ACTIONS,
  UNIT_SPAWN_PURPOSES,
  YES_NO_VERDICTS,
} from './contract.js';
export type { CommunicationEvent, CommunicationEventType, CommunicationKind, CommunicationScope } from './communication.js';
export type {
  ExecutionStrategy,
  PlannerDecision,
  PlannerEvent,
  PlannerEventType,
  StrategyCandidate,
  WorkPlanEventBase,
  WorkPlanSnapshotEventRecord,
  WorkPlanTaskEventRecord,
  WorkPlanTaskStatus,
} from './planner.js';
export type { GateBoundaryCheckRecord, GateEvent, GateEventType } from './gate.js';
export { GATE_EVENT_TYPES } from './gate.js';
export type { PluginEvent, PluginEventType } from './plugins.js';
export type { McpEvent, McpEventType, McpServerRole, McpTrustMode, QuarantineReason } from './mcp.js';
export type { TransportEvent, TransportEventType } from './transport.js';
export type { CompactionEvent, CompactionEventType } from './compaction.js';
export type { GoodVibesUIEvent, GoodVibesUIEventType } from './ui.js';
export type { OpsEvent, OpsEventType, OpsInterventionReason } from './ops.js';
export { RUNTIME_EVENT_DOMAINS, isRuntimeEventDomain } from './domain-map.js';
export type {
  AnyRuntimeEvent,
  DomainEventMap,
  RuntimeEventDomain,
  RuntimeEventPayload,
  RuntimeEventRecord,
} from './domain-map.js';
export type {
  AutomationEvent,
  AutomationEventType,
  AutomationExecutionMode,
  AutomationRunOutcome,
  AutomationScheduleKind,
} from './automation.js';
export { AUTOMATION_RUN_OUTCOMES, AUTOMATION_SCHEDULE_KINDS } from './automation.js';
export type { RouteEvent, RouteEventType, RouteSurfaceKind, RouteTargetKind } from './routes.js';
export { ROUTE_SURFACE_KINDS, ROUTE_TARGET_KINDS } from './routes.js';
export type {
  ControlPlaneClientKind,
  ControlPlaneEvent,
  ControlPlaneEventType,
  ControlPlanePrincipalKind,
  ControlPlaneTransportKind,
} from './control-plane.js';
export {
  CONTROL_PLANE_CLIENT_KINDS,
  CONTROL_PLANE_PRINCIPAL_KINDS,
  CONTROL_PLANE_TRANSPORT_KINDS,
} from './control-plane.js';
export type { DeliveryEvent, DeliveryEventType, DeliveryKind } from './deliveries.js';
export { DELIVERY_KINDS } from './deliveries.js';
export type { WatcherEvent, WatcherEventType, WatcherSourceKind } from './watchers.js';
export { WATCHER_SOURCE_KINDS } from './watchers.js';
export type { SurfaceEvent, SurfaceEventType, SurfaceKind } from './surfaces.js';
export { SURFACE_KINDS } from './surfaces.js';
export type { KnowledgeEvent, KnowledgeEventType } from './knowledge.js';
export type { ForensicsEvent, ForensicsEventType } from './forensics.js';
export type { SecurityEvent, SecurityEventType } from './security.js';
export type { WorkspaceEvent, WorkspaceEventType } from './workspace.js';
export {
  CONTRACT_EVENT_FIELD_SPECS,
  CONTRACT_EVENT_VALIDATORS,
  GATE_EVENT_FIELD_SPECS,
  GATE_EVENT_VALIDATORS,
  isKnownEventType,
  registeredEventTypes,
  validateKnownEvent,
} from './contracts.js';
export type {
  ContractResult,
  EventEnvelopeShape,
  FieldKind,
  FieldSpec,
} from './contracts.js';
