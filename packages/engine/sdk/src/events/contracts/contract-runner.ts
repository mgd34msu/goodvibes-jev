/**
 * Field contracts for the `contracts` runtime domain (the contract runner's
 * events, events/contract.ts). One spec per event type, keyed by the type so
 * the table is exhaustive: adding an event type without its spec is a
 * compile error.
 */
import {
  CHECK_RESULTS,
  CHECK_SCOPES,
  CHECK_TRIGGERS,
  CLAIM_VERIFICATION_KINDS,
  CONTRACT_COMMIT_STATUSES,
  CONTRACT_FAILURE_KINDS,
  CONTRACT_GROUP_STATUSES,
  CONTRACT_ORIGINS,
  CONTRACT_OUTCOMES,
  CONTRACT_STATUSES,
  CONTRACT_UNIT_STATUSES,
  CRITERION_DISPOSITIONS,
  CRITERION_ORIGINS,
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
  type ContractEventType,
} from '../contract.js';
import { validateEventFields, type ContractResult, type FieldSpec } from './shared.js';

const str = (key: string): FieldSpec => ({ key, kind: 'string' });
const optStr = (key: string): FieldSpec => ({ key, kind: 'string', optional: true });
const num = (key: string): FieldSpec => ({ key, kind: 'number' });
const bool = (key: string): FieldSpec => ({ key, kind: 'boolean' });
const strs = (key: string): FieldSpec => ({ key, kind: 'string[]' });
const oneOf = (key: string, values: readonly string[]): FieldSpec => ({ key, kind: 'enum', values });
const optOneOf = (key: string, values: readonly string[]): FieldSpec => ({ key, kind: 'enum', values, optional: true });

const SHAPE_READING: readonly FieldSpec[] = [oneOf('verdict', YES_NO_VERDICTS), num('probability'), oneOf('outcome', CONTRACT_OUTCOMES)];
const shape = (key: string): FieldSpec => ({ key, kind: 'object', fields: SHAPE_READING });

const PLANNED_CRITERION: readonly FieldSpec[] = [
  str('id'),
  str('text'),
  oneOf('origin', CRITERION_ORIGINS),
  optStr('quote'),
  strs('serves'),
  oneOf('disposition', CRITERION_DISPOSITIONS),
  optStr('dispositionReason'),
];
const PLANNED_GROUP: readonly FieldSpec[] = [str('id'), str('title'), oneOf('kind', GROUP_KINDS), strs('dependsOn'), strs('unitIds')];
const PLANNED_UNIT: readonly FieldSpec[] = [
  str('id'),
  str('groupId'),
  str('title'),
  oneOf('role', UNIT_ROLES),
  strs('dependsOn'),
  num('attempts'),
];
const PLAN_PROBLEM: readonly FieldSpec[] = [str('code'), optStr('targetId'), str('message')];
const CHECKED_CRITERION: readonly FieldSpec[] = [
  str('criterionId'),
  oneOf('verdict', CRITERION_VERDICTS),
  num('probabilityUnmet'),
  oneOf('outcome', CONTRACT_OUTCOMES),
];
const CHECKED_QUALITY: readonly FieldSpec[] = [oneOf('item', QUALITY_ITEMS), oneOf('verdict', YES_NO_VERDICTS), oneOf('outcome', CONTRACT_OUTCOMES)];
const CHECKED_GATE: readonly FieldSpec[] = [str('gate'), bool('passed'), bool('skipped')];
const ROUTE_SUMMARY: readonly FieldSpec[] = [str('model'), str('provider'), optStr('reasoningEffort'), str('reason')];

/** The required and optional fields of every contract event, beside `type`. */
export const CONTRACT_EVENT_FIELD_SPECS: { readonly [T in ContractEventType]: readonly FieldSpec[] } = {
  CONTRACT_CREATED: [str('contractId'), str('sessionId'), oneOf('origin', CONTRACT_ORIGINS), str('ask'), str('ownerAgentId')],
  CONTRACT_STATUS_CHANGED: [str('contractId'), oneOf('from', CONTRACT_STATUSES), oneOf('to', CONTRACT_STATUSES)],
  CONTRACT_SHAPED: [
    str('contractId'),
    shape('forbidsDelegation'),
    shape('requestsParallelAgents'),
    shape('forbidsWriting'),
    shape('asksForAttempts'),
    strs('decisionIds'),
  ],
  CONTRACT_PLANNED: [
    str('contractId'),
    str('goal'),
    { key: 'criteria', kind: 'object[]', fields: PLANNED_CRITERION },
    { key: 'groups', kind: 'object[]', fields: PLANNED_GROUP },
    { key: 'units', kind: 'object[]', fields: PLANNED_UNIT },
    num('repair'),
  ],
  CONTRACT_PLAN_CHECKED: [
    str('contractId'),
    oneOf('check', PLAN_CHECKS),
    optStr('targetId'),
    bool('passed'),
    { key: 'problems', kind: 'object[]', fields: PLAN_PROBLEM },
    strs('decisionIds'),
  ],
  CONTRACT_GROUP_STATUS_CHANGED: [
    str('contractId'),
    str('groupId'),
    oneOf('from', CONTRACT_GROUP_STATUSES),
    oneOf('to', CONTRACT_GROUP_STATUSES),
  ],
  CONTRACT_UNIT_STATUS_CHANGED: [
    str('contractId'),
    str('groupId'),
    str('unitId'),
    oneOf('from', CONTRACT_UNIT_STATUSES),
    oneOf('to', CONTRACT_UNIT_STATUSES),
    optStr('agentId'),
  ],
  CONTRACT_UNIT_SPAWNED: [
    str('contractId'),
    str('unitId'),
    str('agentId'),
    { key: 'route', kind: 'object', fields: ROUTE_SUMMARY },
    oneOf('purpose', UNIT_SPAWN_PURPOSES),
  ],
  CONTRACT_CHECKED: [
    str('contractId'),
    oneOf('scope', CHECK_SCOPES),
    str('targetId'),
    str('checkId'),
    oneOf('trigger', CHECK_TRIGGERS),
    oneOf('result', CHECK_RESULTS),
    { key: 'criteria', kind: 'object[]', fields: CHECKED_CRITERION },
    { key: 'goal', kind: 'object', fields: [oneOf('verdict', CRITERION_VERDICTS), oneOf('outcome', CONTRACT_OUTCOMES)] },
    { key: 'quality', kind: 'object[]', fields: CHECKED_QUALITY },
    { key: 'gates', kind: 'object[]', fields: CHECKED_GATE },
    optOneOf('claims', CLAIM_VERIFICATION_KINDS),
    strs('decisionIds'),
  ],
  CONTRACT_NUDGED: [
    str('contractId'),
    str('unitId'),
    str('nudgeId'),
    str('checkId'),
    { key: 'kinds', kind: 'enum[]', values: NUDGE_KINDS },
    strs('criterionIds'),
    oneOf('delivery', NUDGE_DELIVERIES),
    str('agentId'),
  ],
  CONTRACT_NUDGE_CONSUMED: [str('contractId'), str('unitId'), str('nudgeId'), str('agentId'), { key: 'turn', kind: 'number', optional: true }],
  CONTRACT_CRITERION_REGRESSED: [str('contractId'), str('unitId'), str('criterionId'), str('metAtCheckId'), str('checkId')],
  CONTRACT_STALLED: [
    str('contractId'),
    oneOf('scope', CHECK_SCOPES),
    str('targetId'),
    oneOf('route', STALL_ROUTES),
    strs('unmetCriterionIds'),
    str('reason'),
    optStr('decisionId'),
  ],
  CONTRACT_FIX_PLANNED: [str('contractId'), oneOf('scope', CHECK_SCOPES), str('targetId'), str('groupId'), strs('unitIds'), num('round')],
  CONTRACT_ESCALATED: [
    str('contractId'),
    str('escalationId'),
    oneOf('scope', ESCALATION_SCOPES),
    str('targetId'),
    oneOf('reason', ESCALATION_REASONS),
    str('question'),
    strs('unmetCriterionIds'),
  ],
  CONTRACT_OWNER_REPLIED: [
    str('contractId'),
    str('escalationId'),
    oneOf('reading', OWNER_REPLY_READINGS),
    oneOf('outcome', CONTRACT_OUTCOMES),
    str('action'),
  ],
  CONTRACT_GATE_RESULT: [str('contractId'), str('targetId'), str('gate'), bool('passed'), bool('skipped'), num('durationMs')],
  CONTRACT_UNIT_SILENT: [str('contractId'), str('unitId'), str('agentId'), num('silentMs'), oneOf('action', UNIT_SILENCE_ACTIONS)],
  CONTRACT_MERGE_CONFLICT: [str('contractId'), str('unitId'), str('branch'), str('path'), strs('files')],
  CONTRACT_ATTEMPTS_SELECTED: [
    str('contractId'),
    str('unitId'),
    strs('candidateIds'),
    { key: 'chosen', kind: 'string|null' },
    oneOf('outcome', CONTRACT_OUTCOMES),
    optStr('decisionId'),
  ],
  CONTRACT_COMMITTED: [str('contractId'), oneOf('status', CONTRACT_COMMIT_STATUSES), optStr('hash'), str('note')],
  CONTRACT_PASSED: [str('contractId'), num('criteriaMet'), num('criteriaJudged'), num('excluded'), num('nudges')],
  CONTRACT_FAILED: [
    str('contractId'),
    str('reason'),
    oneOf('failureKind', CONTRACT_FAILURE_KINDS),
    bool('membersSettled'),
    { key: 'turnLimit', kind: 'number', optional: true },
    optOneOf('turnLimitSource', TURN_LIMIT_SOURCES),
  ],
  CONTRACT_CANCELLED: [str('contractId'), str('reason'), num('filesModified')],
  CONTRACT_SPAWN_GUARD_TRIGGERED: [optStr('contractId'), str('agentId'), num('depth'), num('activeAgents'), str('reason')],
};

/** One validator per contract event type, for the EVENT_VALIDATORS registry. */
export const CONTRACT_EVENT_VALIDATORS = Object.fromEntries(
  (Object.keys(CONTRACT_EVENT_FIELD_SPECS) as ContractEventType[]).map((type) => [
    type,
    (v: unknown): ContractResult => validateEventFields(type, v, CONTRACT_EVENT_FIELD_SPECS[type]),
  ]),
) as { readonly [T in ContractEventType]: (v: unknown) => ContractResult };
