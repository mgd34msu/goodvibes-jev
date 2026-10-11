import { toJSONSchema } from 'zod/v4';
import { nativeConversationContinuationMessageSchema } from '../workflow/work-ledger/native-continuation-context.js';
import { nativeSelectedDiffContextSchema } from '../workflow/work-ledger/native-diff-context.js';
/**
 * operator-contract-schemas-contracts.ts
 *
 * Contract schemas for the `contracts.*` operator methods
 * (docs/design/contract-runner.md 10.2): the contract tree as the runner's
 * `get` and `list` hand it out (`ContractView`, contract/types.ts), and each
 * method's input and output. The closed sets come from the contract event
 * vocabulary (events/contract.ts), the same lists the persisted tree and the
 * wire events use, so the three cannot drift apart.
 */
import {
  CHECK_RESULTS,
  CHECK_TRIGGERS,
  CLAIM_VERIFICATION_KINDS,
  CONTRACT_COMMIT_STATUSES,
  CONTRACT_DECISION_ACTIONS,
  CONTRACT_FAILURE_KINDS,
  CONTRACT_GROUP_STATUSES,
  CONTRACT_ORIGINS,
  CONTRACT_OUTCOMES,
  CONTRACT_STATUSES,
  CONTRACT_UNIT_STATUSES,
  CRITERION_DISPOSITIONS,
  CRITERION_ORIGINS,
  CRITERION_SEVERITIES,
  CRITERION_STATUSES,
  CRITERION_VERDICTS,
  ESCALATION_REASONS,
  ESCALATION_SCOPES,
  GROUP_KINDS,
  NUDGE_DELIVERIES,
  NUDGE_KINDS,
  OWNER_REPLY_ACTIONS,
  OWNER_REPLY_READINGS,
  QUALITY_ITEMS,
  UNIT_ROLES,
  YES_NO_VERDICTS,
} from '../../events/contract.js';
import type { Contract, ContractUnit } from '../contract/types.js';
import { BOOLEAN_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, arraySchema, objectSchema } from './method-catalog-shared.js';
import { STRING_LIST_SCHEMA, enumSchema, recordSchema } from './operator-contract-schemas-shared.js';
import {
  CONTRACT_COMPLETION_REPORT_SCHEMA,
  CONTRACT_DURABLE_ADMISSION_SCHEMA,
  CONTRACT_INPUT_SNAPSHOT_SCHEMA,
  CONTRACT_NATIVE_DECISIONS_SCHEMA,
  CONTRACT_NATIVE_PROGRESS_SCHEMA,
  CONTRACT_NATIVE_SOURCE_SCHEMA,
  CONTRACT_NATIVE_WAITING_SCHEMA,
} from './operator-contract-schemas-contract-inspection.js';

const OUTCOME_SCHEMA = enumSchema(CONTRACT_OUTCOMES);
const ISOLATION_INPUT_SCHEMA = enumSchema(['auto', 'worktree', 'shared']);

const USAGE_SCHEMA = objectSchema({
  inputTokens: NUMBER_SCHEMA,
  outputTokens: NUMBER_SCHEMA,
  cacheReadTokens: NUMBER_SCHEMA,
  cacheWriteTokens: NUMBER_SCHEMA,
  reasoningTokens: NUMBER_SCHEMA,
  llmCallCount: NUMBER_SCHEMA,
  turnCount: NUMBER_SCHEMA,
  toolCallCount: NUMBER_SCHEMA,
  costUsd: { anyOf: [NUMBER_SCHEMA, { type: 'null' }] },
  costState: enumSchema(['priced', 'unpriced', 'estimated']),
  costSource: enumSchema(['user', 'provider', 'catalog', 'mixed']),
  pricingAsOf: STRING_SCHEMA,
}, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'llmCallCount', 'turnCount', 'toolCallCount', 'costUsd', 'costState']);

const JUDGMENT_USAGE_SCHEMA = objectSchema({
  calls: NUMBER_SCHEMA,
  inputTokens: NUMBER_SCHEMA,
  outputTokens: NUMBER_SCHEMA,
}, ['calls', 'inputTokens', 'outputTokens']);

const ROUTE_SCHEMA = objectSchema({
  model: STRING_SCHEMA,
  provider: STRING_SCHEMA,
  fallbackModels: STRING_LIST_SCHEMA,
  routing: objectSchema({
    providerSelection: enumSchema(['inherit-current', 'concrete', 'synthetic']),
    providerFailurePolicy: enumSchema(['ordered-fallbacks', 'fail']),
    fallbackModels: STRING_LIST_SCHEMA,
  }, []),
  reasoningEffort: STRING_SCHEMA,
  reason: STRING_SCHEMA,
}, ['model', 'provider', 'reason']);

const TREE_BASELINE_SCHEMA = objectSchema({
  head: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
  dirty: recordSchema({ anyOf: [STRING_SCHEMA, { type: 'null' }] }),
}, ['head', 'dirty']);

const CRITERION_READING_SCHEMA = objectSchema({
  checkId: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
  probabilityUnmet: NUMBER_SCHEMA,
  verdict: enumSchema(CRITERION_VERDICTS),
  outcome: OUTCOME_SCHEMA,
  severity: enumSchema(CRITERION_SEVERITIES),
  decisionId: STRING_SCHEMA,
  severityDecisionId: STRING_SCHEMA,
}, ['checkId', 'at', 'probabilityUnmet', 'verdict', 'outcome']);

const CRITERION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  text: STRING_SCHEMA,
  origin: enumSchema(CRITERION_ORIGINS),
  quote: STRING_SCHEMA,
  serves: STRING_LIST_SCHEMA,
  disposition: enumSchema(CRITERION_DISPOSITIONS),
  dispositionReason: STRING_SCHEMA,
  status: enumSchema(CRITERION_STATUSES),
  readings: arraySchema(CRITERION_READING_SCHEMA),
}, ['id', 'text', 'origin', 'serves', 'disposition', 'status', 'readings']);

const GATE_RESULT_SCHEMA = objectSchema({
  gate: STRING_SCHEMA,
  passed: BOOLEAN_SCHEMA,
  output: STRING_SCHEMA,
  durationMs: NUMBER_SCHEMA,
  skipped: BOOLEAN_SCHEMA,
}, ['gate', 'passed', 'output', 'durationMs']);

const QUALITY_READING_SCHEMA = objectSchema({
  verdict: enumSchema(YES_NO_VERDICTS),
  outcome: OUTCOME_SCHEMA,
}, ['verdict', 'outcome']);

const CHECK_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
  trigger: enumSchema(CHECK_TRIGGERS),
  claims: objectSchema({ kind: enumSchema(CLAIM_VERIFICATION_KINDS), summary: STRING_SCHEMA }, ['kind', 'summary']),
  gates: arraySchema(GATE_RESULT_SCHEMA),
  goal: objectSchema({
    probabilityUnmet: NUMBER_SCHEMA,
    verdict: enumSchema(CRITERION_VERDICTS),
    outcome: OUTCOME_SCHEMA,
  }, ['probabilityUnmet', 'verdict', 'outcome']),
  quality: objectSchema(Object.fromEntries(QUALITY_ITEMS.map((item) => [item, QUALITY_READING_SCHEMA])), []),
  result: enumSchema(CHECK_RESULTS),
  problems: arraySchema(enumSchema(NUDGE_KINDS)),
  qualityProblems: arraySchema(enumSchema(QUALITY_ITEMS)),
  decisionIds: STRING_LIST_SCHEMA,
  evidenceDigest: STRING_SCHEMA,
}, ['id', 'at', 'trigger', 'goal', 'quality', 'result', 'decisionIds', 'evidenceDigest']);

const NUDGE_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  checkId: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
  kinds: arraySchema(enumSchema(NUDGE_KINDS)),
  criterionIds: STRING_LIST_SCHEMA,
  text: STRING_SCHEMA,
  delivery: enumSchema(NUDGE_DELIVERIES),
  agentId: STRING_SCHEMA,
  consumedAt: NUMBER_SCHEMA,
}, ['id', 'checkId', 'at', 'kinds', 'criterionIds', 'text', 'delivery', 'agentId']);

const ATTEMPT_SELECTION_SCHEMA = objectSchema({
  engineGroupId: STRING_SCHEMA,
  candidateIds: STRING_LIST_SCHEMA,
  proposedId: STRING_SCHEMA,
  outcome: OUTCOME_SCHEMA,
  reasons: STRING_SCHEMA,
  decisionId: STRING_SCHEMA,
  pickedId: STRING_SCHEMA,
}, ['engineGroupId', 'candidateIds', 'outcome', 'reasons']);

const UNIT_PROPERTIES: Record<string, Record<string, unknown>> = {
  id: STRING_SCHEMA,
  groupId: STRING_SCHEMA,
  title: STRING_SCHEMA,
  goal: STRING_SCHEMA,
  brief: STRING_SCHEMA,
  role: enumSchema(UNIT_ROLES),
  dependsOn: STRING_LIST_SCHEMA,
  files: STRING_LIST_SCHEMA,
  attempts: NUMBER_SCHEMA,
  criteria: arraySchema(CRITERION_SCHEMA),
  status: enumSchema(CONTRACT_UNIT_STATUSES),
  agentIds: STRING_LIST_SCHEMA,
  activeAgentId: STRING_SCHEMA,
  route: ROUTE_SCHEMA,
  checks: arraySchema(CHECK_SCHEMA),
  nudges: arraySchema(NUDGE_SCHEMA),
  fixRounds: NUMBER_SCHEMA,
  freshAgents: NUMBER_SCHEMA,
  transportRetries: NUMBER_SCHEMA,
  touchedPaths: STRING_LIST_SCHEMA,
  baseline: TREE_BASELINE_SCHEMA,
  usage: USAGE_SCHEMA,
  answer: STRING_SCHEMA,
  lastOutput: STRING_SCHEMA,
  lastReport: CONTRACT_COMPLETION_REPORT_SCHEMA,
  failureReason: STRING_SCHEMA,
  attemptOf: STRING_SCHEMA,
  attemptIndex: NUMBER_SCHEMA,
  attemptSelection: ATTEMPT_SELECTION_SCHEMA,
} satisfies Record<Exclude<keyof ContractUnit, 'attemptUnits'>, Record<string, unknown>>;
const UNIT_REQUIRED = [
  'id', 'groupId', 'title', 'goal', 'brief', 'role', 'dependsOn', 'files', 'attempts', 'criteria', 'status',
  'agentIds', 'checks', 'nudges', 'fixRounds', 'freshAgents', 'transportRetries', 'touchedPaths', 'usage',
];
/** An attempt unit of a best-of-N unit: a unit that carries no attempts of its own. */
const ATTEMPT_UNIT_SCHEMA = objectSchema(UNIT_PROPERTIES, UNIT_REQUIRED);
const UNIT_SCHEMA = objectSchema({ ...UNIT_PROPERTIES, attemptUnits: arraySchema(ATTEMPT_UNIT_SCHEMA) }, UNIT_REQUIRED);

const GROUP_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  title: STRING_SCHEMA,
  goal: STRING_SCHEMA,
  kind: enumSchema(GROUP_KINDS),
  repairs: objectSchema({
    scope: enumSchema(['unit', 'group', 'deliverable']),
    targetId: STRING_SCHEMA,
    criterionIds: STRING_LIST_SCHEMA,
  }, ['scope', 'targetId', 'criterionIds']),
  dependsOn: STRING_LIST_SCHEMA,
  criteria: arraySchema(CRITERION_SCHEMA),
  unitIds: STRING_LIST_SCHEMA,
  status: enumSchema(CONTRACT_GROUP_STATUSES),
  checks: arraySchema(CHECK_SCHEMA),
  fixRounds: NUMBER_SCHEMA,
  baseline: TREE_BASELINE_SCHEMA,
  usage: USAGE_SCHEMA,
}, ['id', 'title', 'goal', 'kind', 'dependsOn', 'criteria', 'unitIds', 'status', 'checks', 'fixRounds', 'usage']);

const ESCALATION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
  scope: enumSchema(ESCALATION_SCOPES),
  targetId: STRING_SCHEMA,
  reason: enumSchema(ESCALATION_REASONS),
  question: STRING_SCHEMA,
  unmetCriterionIds: STRING_LIST_SCHEMA,
  decisionIds: STRING_LIST_SCHEMA,
  resolvedAt: NUMBER_SCHEMA,
  reply: objectSchema({
    text: STRING_SCHEMA,
    reading: enumSchema(OWNER_REPLY_READINGS),
    outcome: OUTCOME_SCHEMA,
    decisionId: STRING_SCHEMA,
  }, ['text', 'reading', 'outcome']),
}, ['id', 'at', 'scope', 'targetId', 'reason', 'question', 'unmetCriterionIds']);

const DECISION_SCHEMA = objectSchema({
  id: STRING_SCHEMA,
  at: NUMBER_SCHEMA,
  action: enumSchema(CONTRACT_DECISION_ACTIONS),
  targetId: STRING_SCHEMA,
  reason: STRING_SCHEMA,
  decisionIds: STRING_LIST_SCHEMA,
  route: ROUTE_SCHEMA,
}, ['id', 'at', 'action', 'targetId', 'reason', 'decisionIds']);

const SHAPE_READING_SCHEMA = objectSchema({
  verdict: enumSchema(YES_NO_VERDICTS),
  probability: NUMBER_SCHEMA,
  outcome: OUTCOME_SCHEMA,
}, ['verdict', 'probability', 'outcome']);

const PROPOSED_UNIT_SCHEMA = objectSchema({ task: STRING_SCHEMA, template: STRING_SCHEMA }, ['task']);

const DRAFT_PLAN_SCHEMA = objectSchema({
  goal: STRING_SCHEMA,
  units: arraySchema(objectSchema({
    id: STRING_SCHEMA,
    title: STRING_SCHEMA,
    brief: STRING_SCHEMA,
    dependsOn: STRING_LIST_SCHEMA,
    files: STRING_LIST_SCHEMA,
    attempts: NUMBER_SCHEMA,
  }, ['id', 'title', 'brief', 'dependsOn'])),
}, ['goal', 'units']);

/** One contract with its whole tree: what `contracts.get` returns and `contracts.list` lists. */
export const CONTRACT_VIEW_SCHEMA = objectSchema({
  originalSource: objectSchema({ goal: STRING_SCHEMA, criteria: STRING_LIST_SCHEMA, conversationContext: arraySchema(toJSONSchema(nativeConversationContinuationMessageSchema)), selectedDiffContext: toJSONSchema(nativeSelectedDiffContextSchema) }, ['goal', 'criteria']),
  taskEvidence: STRING_SCHEMA,
  nativeSource: CONTRACT_NATIVE_SOURCE_SCHEMA,
  nativeDecisions: CONTRACT_NATIVE_DECISIONS_SCHEMA,
  nativeProgress: CONTRACT_NATIVE_PROGRESS_SCHEMA,
  nativeWaiting: CONTRACT_NATIVE_WAITING_SCHEMA,
  durableAdmission: CONTRACT_DURABLE_ADMISSION_SCHEMA,
  durableLaunchState: enumSchema(['prepared', 'launch-claimed']),
  inputSnapshot: CONTRACT_INPUT_SNAPSHOT_SCHEMA,
  id: STRING_SCHEMA,
  schemaVersion: NUMBER_SCHEMA,
  sessionId: STRING_SCHEMA,
  origin: enumSchema(CONTRACT_ORIGINS),
  ask: STRING_SCHEMA,
  ownerAgentId: STRING_SCHEMA,
  parentAgentId: STRING_SCHEMA,
  projectRoot: STRING_SCHEMA,
  isolation: enumSchema(['worktree', 'shared']),
  branch: STRING_SCHEMA,
  worktreePath: STRING_SCHEMA,
  baseBranch: STRING_SCHEMA,
  baseline: TREE_BASELINE_SCHEMA,
  sessionMode: BOOLEAN_SCHEMA,
  proposedUnits: arraySchema(PROPOSED_UNIT_SCHEMA),
  draftPlan: DRAFT_PLAN_SCHEMA,
  budget: objectSchema({ maxTokens: NUMBER_SCHEMA, maxCostUsd: NUMBER_SCHEMA }, []),
  goal: STRING_SCHEMA,
  criteria: arraySchema(CRITERION_SCHEMA),
  groups: arraySchema(GROUP_SCHEMA),
  units: arraySchema(UNIT_SCHEMA),
  shape: objectSchema({
    forbids_delegation: SHAPE_READING_SCHEMA,
    requests_parallel_agents: SHAPE_READING_SCHEMA,
    forbids_writing: SHAPE_READING_SCHEMA,
    asks_for_attempts: SHAPE_READING_SCHEMA,
    decisionIds: STRING_LIST_SCHEMA,
  }, ['forbids_delegation', 'requests_parallel_agents', 'forbids_writing', 'asks_for_attempts', 'decisionIds']),
  status: enumSchema(CONTRACT_STATUSES),
  statusBeforeOwner: enumSchema(CONTRACT_STATUSES),
  resumeFrom: enumSchema(CONTRACT_STATUSES),
  checks: arraySchema(CHECK_SCHEMA),
  fixRounds: NUMBER_SCHEMA,
  escalations: arraySchema(ESCALATION_SCHEMA),
  decisions: arraySchema(DECISION_SCHEMA),
  usage: USAGE_SCHEMA,
  judgmentUsage: JUDGMENT_USAGE_SCHEMA,
  plannerAgentIds: STRING_LIST_SCHEMA,
  answer: STRING_SCHEMA,
  statusLine: STRING_SCHEMA,
  commit: objectSchema({ status: enumSchema(CONTRACT_COMMIT_STATUSES), hash: STRING_SCHEMA, note: STRING_SCHEMA }, ['status', 'note']),
  failureKind: enumSchema(CONTRACT_FAILURE_KINDS),
  error: STRING_SCHEMA,
  createdAt: NUMBER_SCHEMA,
  completedAt: NUMBER_SCHEMA,
} satisfies Record<keyof Contract, Record<string, unknown>>, [
  'id', 'schemaVersion', 'sessionId', 'origin', 'ask', 'ownerAgentId', 'projectRoot', 'isolation', 'goal', 'criteria',
  'groups', 'units', 'status', 'checks', 'fixRounds', 'escalations', 'decisions', 'usage', 'judgmentUsage',
  'plannerAgentIds', 'createdAt',
]);

export const CONTRACTS_LIST_INPUT_SCHEMA = objectSchema({ sessionId: STRING_SCHEMA, includeTerminal: BOOLEAN_SCHEMA }, []);
export const CONTRACTS_LIST_OUTPUT_SCHEMA = objectSchema({ contracts: arraySchema(CONTRACT_VIEW_SCHEMA) }, ['contracts']);

export const CONTRACTS_GET_INPUT_SCHEMA = objectSchema({ contractId: STRING_SCHEMA }, ['contractId']);
export const CONTRACTS_GET_OUTPUT_SCHEMA = CONTRACT_VIEW_SCHEMA;

export const CONTRACTS_START_INPUT_SCHEMA = objectSchema({
  ask: STRING_SCHEMA,
  sessionId: STRING_SCHEMA,
  workspaceRoot: STRING_SCHEMA,
  isolation: ISOLATION_INPUT_SCHEMA,
}, ['ask']);
export const CONTRACTS_START_OUTPUT_SCHEMA = objectSchema({
  contract: CONTRACT_VIEW_SCHEMA,
  ownerAgentId: STRING_SCHEMA,
}, ['contract', 'ownerAgentId']);

export const CONTRACTS_CANCEL_INPUT_SCHEMA = objectSchema({ contractId: STRING_SCHEMA, reason: STRING_SCHEMA }, ['contractId']);
export const CONTRACTS_CANCEL_OUTPUT_SCHEMA = objectSchema({ cancelled: BOOLEAN_SCHEMA }, ['cancelled']);

export const CONTRACTS_REPLY_INPUT_SCHEMA = objectSchema({
  contractId: STRING_SCHEMA,
  escalationId: STRING_SCHEMA,
  text: STRING_SCHEMA,
}, ['contractId', 'escalationId', 'text']);
/** OwnerReplyOutcome (contract/escalation.ts). */
export const CONTRACTS_REPLY_OUTPUT_SCHEMA = objectSchema({
  escalationId: STRING_SCHEMA,
  reading: enumSchema(OWNER_REPLY_READINGS),
  outcome: OUTCOME_SCHEMA,
  action: enumSchema(OWNER_REPLY_ACTIONS),
  nextEscalationId: STRING_SCHEMA,
}, ['escalationId', 'reading', 'outcome', 'action']);
