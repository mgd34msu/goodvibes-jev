/**
 * Inspection-only schemas for the runner's native receipts, captured inputs and
 * completion reports. References and recorded decisions are provenance, never
 * current authority or executable continuations. Keep the actual source models
 * in contract/{types,native-decisions,durable-admission,input-snapshot}.ts and
 * agents/completion-report.ts aligned with this closed wire representation.
 */
import { JEV_DECISION_BINDING_KEYS, JEV_DECISION_SCHEMA } from '@goodvibes-jev/judgment/decisions';
import type { JudgmentAttempt } from '@goodvibes-jev/judgment';
import type { NativeContractStage } from '../contract/native-decisions.js';
import { CONTRACT_ORIGINS } from '../../events/contract.js';
import { BOOLEAN_SCHEMA, NUMBER_SCHEMA, STRING_SCHEMA, arraySchema, objectSchema } from './method-catalog-shared.js';
import { STRING_LIST_SCHEMA, enumSchema, recordSchema } from './operator-contract-schemas-shared.js';

const VERSION_ONE = { const: 1 };
const NONEMPTY_STRING = { type: 'string', minLength: 1 };
const NONBLANK_TEXT = { ...NONEMPTY_STRING, pattern: '\\S' };
// Native-source and durable references permit interior ASCII spaces. Jev's
// stricter reference grammar remains owned by JEV_DECISION_SCHEMA below.
const REFERENCE = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[!-~][ -~]{0,255}$' };
const COUNTER = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const VERSION_REF = objectSchema({ id: REFERENCE, revision: REFERENCE }, ['id', 'revision']);
const STAGES = ['shape', 'plan', 'evidence', 'stall', 'fix-plan', 'attempts'] as const satisfies readonly NativeContractStage[];
const ATTEMPT_OUTCOMES = ['answered', 'invalid-request', 'rejected', 'unavailable', 'aborted', 'invalid-response', 'unrecorded'] as const satisfies readonly JudgmentAttempt['outcome'][];

export const CONTRACT_NATIVE_SOURCE_SCHEMA = objectSchema({
  sourceId: REFERENCE,
  sourceRevision: REFERENCE,
  inputRevision: REFERENCE,
  criteriaId: REFERENCE,
  criteriaRevision: REFERENCE,
  goal: NONBLANK_TEXT,
  criteria: { ...arraySchema(NONBLANK_TEXT), minItems: 1 },
}, ['sourceId', 'sourceRevision', 'inputRevision', 'criteriaId', 'criteriaRevision', 'goal', 'criteria']);

export const CONTRACT_NATIVE_DECISION_RECORD_SCHEMA = objectSchema({
  schemaVersion: VERSION_ONE,
  stage: enumSchema(STAGES),
  targetId: STRING_SCHEMA,
  decision: JEV_DECISION_SCHEMA,
  operationRevision: STRING_SCHEMA,
}, ['schemaVersion', 'stage', 'targetId', 'decision', 'operationRevision']);

export const CONTRACT_NATIVE_DECISIONS_SCHEMA = objectSchema({
  schemaVersion: VERSION_ONE,
  history: arraySchema(CONTRACT_NATIVE_DECISION_RECORD_SCHEMA),
  pending: recordSchema(CONTRACT_NATIVE_DECISION_RECORD_SCHEMA),
  spent: recordSchema(COUNTER),
  plannerOutputs: recordSchema(STRING_SCHEMA),
  attemptChoices: recordSchema(STRING_SCHEMA),
  attemptedChoices: recordSchema(STRING_LIST_SCHEMA),
}, ['schemaVersion', 'history', 'pending', 'spent', 'plannerOutputs', 'attemptChoices', 'attemptedChoices']);

export const CONTRACT_NATIVE_PROGRESS_SCHEMA = objectSchema({
  schemaVersion: VERSION_ONE,
  state: enumSchema(['deciding', 'deferred', 'refused']),
  stage: STRING_SCHEMA,
  targetId: STRING_SCHEMA,
  until: VERSION_REF,
}, ['schemaVersion', 'state', 'stage', 'targetId']);

export const CONTRACT_NATIVE_WAITING_SCHEMA = objectSchema({
  schemaVersion: VERSION_ONE,
  requests: arraySchema(objectSchema({
    logicalRequestId: STRING_SCHEMA,
    attempt: objectSchema({
      attempt: COUNTER,
      endpointIndex: COUNTER,
      endpointKind: enumSchema(['hosted', 'local']),
      requestedModel: STRING_SCHEMA,
      latencyMs: NUMBER_SCHEMA,
      outcome: enumSchema(ATTEMPT_OUTCOMES),
      requestId: STRING_SCHEMA,
      status: NUMBER_SCHEMA,
    }, ['attempt', 'endpointIndex', 'endpointKind', 'requestedModel', 'latencyMs', 'outcome']),
    elapsedMs: NUMBER_SCHEMA,
    nextDelayMs: NUMBER_SCHEMA,
  }, ['logicalRequestId', 'attempt', 'elapsedMs', 'nextDelayMs'])),
}, ['schemaVersion', 'requests']);

const DURABLE_INPUT_SCHEMA = objectSchema({
  ask: NONEMPTY_STRING,
  sessionId: NONEMPTY_STRING,
  origin: enumSchema(CONTRACT_ORIGINS),
  projectRoot: NONEMPTY_STRING,
  nativeSource: CONTRACT_NATIVE_SOURCE_SCHEMA,
  proposedUnits: arraySchema(objectSchema({ task: STRING_SCHEMA, template: STRING_SCHEMA }, ['task'])),
  parentAgentId: STRING_SCHEMA,
  budget: objectSchema({ maxTokens: NUMBER_SCHEMA, maxCostUsd: NUMBER_SCHEMA }, []),
  isolation: enumSchema(['auto', 'worktree', 'shared']),
}, ['ask', 'sessionId', 'origin', 'projectRoot']);

const DURABLE_ADMISSION_PROPERTIES = {
  key: objectSchema({ workId: REFERENCE, criteriaId: REFERENCE, criteriaRevision: REFERENCE, attemptId: REFERENCE }, ['workId', 'criteriaId', 'criteriaRevision', 'attemptId']),
  binding: objectSchema(Object.fromEntries(JEV_DECISION_BINDING_KEYS.map(key => [key, REFERENCE])), [...JEV_DECISION_BINDING_KEYS]),
  input: DURABLE_INPUT_SCHEMA,
  contractId: STRING_SCHEMA,
  ownerAgentId: NONEMPTY_STRING,
  payloadRevision: STRING_SCHEMA,
};
const DURABLE_ADMISSION_REQUIRED = ['schemaVersion', ...Object.keys(DURABLE_ADMISSION_PROPERTIES)];
const DURABLE_EXECUTION_SCHEMA = {
  oneOf: [
    objectSchema({ isolation: { const: 'shared' } }, ['isolation']),
    objectSchema({ isolation: { const: 'worktree' }, branch: STRING_SCHEMA, worktreePath: STRING_SCHEMA, baseBranch: NONEMPTY_STRING }, ['isolation', 'branch', 'worktreePath', 'baseBranch']),
  ],
};
/** Historical v1 is inspectable; only v2 records carry pinned execution placement. */
export const CONTRACT_DURABLE_ADMISSION_SCHEMA = {
  oneOf: [
    objectSchema({ schemaVersion: VERSION_ONE, ...DURABLE_ADMISSION_PROPERTIES }, DURABLE_ADMISSION_REQUIRED),
    objectSchema({ schemaVersion: { const: 2 }, ...DURABLE_ADMISSION_PROPERTIES, execution: DURABLE_EXECUTION_SCHEMA }, [...DURABLE_ADMISSION_REQUIRED, 'execution']),
  ],
};

export const CONTRACT_INPUT_SNAPSHOT_SCHEMA = objectSchema({
  version: VERSION_ONE,
  id: STRING_SCHEMA,
  sourceRoot: STRING_SCHEMA,
  sourceIdentity: STRING_SCHEMA,
  gitIdentity: STRING_SCHEMA,
  ownerHead: STRING_SCHEMA,
  ownerRef: STRING_SCHEMA,
  indexFingerprint: STRING_SCHEMA,
  inputTree: STRING_SCHEMA,
  inputCommit: STRING_SCHEMA,
  capturedAt: NUMBER_SCHEMA,
  dirty: BOOLEAN_SCHEMA,
  exclusions: STRING_LIST_SCHEMA,
  files: arraySchema(objectSchema({
    path: STRING_SCHEMA,
    kind: enumSchema(['file', 'symlink', 'missing']),
    mode: enumSchema(['100644', '100755', '120000', '0']),
    oid: STRING_SCHEMA,
    digest: STRING_SCHEMA,
    identity: STRING_SCHEMA,
  }, ['path', 'kind', 'mode'])),
}, ['version', 'id', 'sourceRoot', 'sourceIdentity', 'gitIdentity', 'ownerHead', 'ownerRef', 'indexFingerprint', 'inputTree', 'inputCommit', 'capturedAt', 'dirty', 'exclusions', 'files']);

// parseCompletionReport historically persists partial reports, and the runner
// reads file claims for every archetype (claims.ts). Inspect that stored data
// without inventing missing arrays or imposing the richer authoring interfaces.
// Recognized fields remain typed and unknown fields remain closed.
const REPORT_BASE = {
  version: VERSION_ONE,
  summary: STRING_SCHEMA,
  filesCreated: STRING_LIST_SCHEMA,
  filesModified: STRING_LIST_SCHEMA,
  filesDeleted: STRING_LIST_SCHEMA,
};
const REPORT_REQUIRED = ['version', 'archetype'];
export const CONTRACT_COMPLETION_REPORT_SCHEMA = {
  oneOf: [
    objectSchema({
      ...REPORT_BASE,
      archetype: { const: 'engineer' },
      gatheredContext: STRING_LIST_SCHEMA,
      plannedActions: STRING_LIST_SCHEMA,
      appliedChanges: STRING_LIST_SCHEMA,
      decisions: arraySchema(objectSchema({ what: STRING_SCHEMA, why: STRING_SCHEMA }, ['what', 'why'])),
      issues: STRING_LIST_SCHEMA,
      uncertainties: STRING_LIST_SCHEMA,
    }, REPORT_REQUIRED),
    objectSchema({
      ...REPORT_BASE,
      archetype: { const: 'tester' },
      testsWritten: STRING_LIST_SCHEMA,
      testsPassed: NUMBER_SCHEMA,
      testsFailed: NUMBER_SCHEMA,
      coverage: objectSchema({ lines: NUMBER_SCHEMA, branches: NUMBER_SCHEMA, functions: NUMBER_SCHEMA }, ['lines', 'branches', 'functions']),
      failures: arraySchema(objectSchema({ test: STRING_SCHEMA, error: STRING_SCHEMA }, ['test', 'error'])),
    }, REPORT_REQUIRED),
    objectSchema({
      ...REPORT_BASE,
      archetype: { type: 'string', not: { enum: ['engineer', 'tester'] } },
      result: STRING_SCHEMA,
    }, REPORT_REQUIRED),
  ],
};
