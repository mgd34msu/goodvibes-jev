import { expect, test } from 'bun:test';
import { JEV_DECISION_BINDING_KEYS, JEV_DECISION_SCHEMA, type JevDecision, type JevDecisionBinding } from '@goodvibes-jev/judgment/decisions';
import { firstJsonSchemaFailure } from '../../transport-http/src/client-plumbing.js';
import type { CompletionReport } from '../../sdk/src/platform/agents/completion-report.js';
import type { DurableContractAdmission } from '../../sdk/src/platform/contract/durable-admission.js';
import type { ContractInputSnapshot } from '../../sdk/src/platform/contract/input-snapshot.js';
import type { NativeContractDecisionRecord, NativeContractDecisionState, NativeContractProgress, NativeContractTransportProgress } from '../../sdk/src/platform/contract/native-decisions.js';
import type { NativeContractSource } from '../../sdk/src/platform/contract/types.js';
import { captureNativeContractSource } from '../../sdk/src/platform/contract/native-source.js';
import {
  CONTRACT_COMPLETION_REPORT_SCHEMA,
  CONTRACT_DURABLE_ADMISSION_SCHEMA,
  CONTRACT_INPUT_SNAPSHOT_SCHEMA,
  CONTRACT_NATIVE_DECISION_RECORD_SCHEMA,
  CONTRACT_NATIVE_DECISIONS_SCHEMA,
  CONTRACT_NATIVE_PROGRESS_SCHEMA,
  CONTRACT_NATIVE_SOURCE_SCHEMA,
  CONTRACT_NATIVE_WAITING_SCHEMA,
} from '../../sdk/src/platform/control-plane/operator-contract-schemas-contract-inspection.js';

const binding: JevDecisionBinding = { sourceId: 'source', inputRevision: 'input-1', actionId: 'action', actionRevision: '1', authorityId: 'host', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' };
const source: NativeContractSource = { sourceId: binding.sourceId, sourceRevision: '1', inputRevision: binding.inputRevision, criteriaId: 'criteria', criteriaRevision: '1', goal: 'Preserve the complete original goal', criteria: ['Keep the first criterion', 'Keep the second criterion'] };
const common = { schemaVersion: 1, decisionId: 'decision-1', binding, judgmentDecisionIds: ['recorded-1'], evidence: [{ id: 'evidence-1', revision: '1' }], summary: 'Recorded semantic result, without replay authority' } as const;
const decisions: readonly JevDecision[] = [
  { ...common, outcome: 'act' },
  { ...common, outcome: 'revise', next: { id: 'repair-plan', revision: '1', kind: 'revise-action' } },
  { ...common, outcome: 'defer', until: { id: 'external-evidence', revision: '1' } },
  { ...common, outcome: 'reject' },
];
function record(decision: JevDecision): NativeContractDecisionRecord {
  return { schemaVersion: 1, stage: 'plan', targetId: 'ctr-12345678', decision, operationRevision: 'operation-1' };
}
const nativeState: NativeContractDecisionState = {
  schemaVersion: 1,
  history: decisions.map(record),
  pending: { 'plan:ctr-12345678': record(decisions[2]!) },
  spent: { planner: 3 },
  plannerOutputs: { planner: 'Retained exact planner output' },
  attemptChoices: { unit: 'candidate-2' },
  attemptedChoices: { unit: ['candidate-1', 'candidate-2'] },
};
const reports: readonly CompletionReport[] = [
  { version: 1, archetype: 'engineer', summary: 'Implemented', gatheredContext: ['Source'], plannedActions: ['Edit parser'], appliedChanges: ['Parser changed'], filesCreated: [], filesModified: ['parser.ts'], filesDeleted: [], decisions: [{ what: 'Keep parser', why: 'Preserve behavior' }], issues: [], uncertainties: [] },
  { version: 1, archetype: 'tester', summary: 'Tested', testsWritten: ['Parser regression'], testsPassed: 3, testsFailed: 0, coverage: { lines: 90, branches: 80, functions: 100 }, failures: [] },
  { version: 1, archetype: 'researcher', summary: 'Researched', result: 'Complete findings' },
];
function valid(schema: Record<string, unknown>, value: unknown): void {
  expect(firstJsonSchemaFailure(schema, JSON.parse(JSON.stringify(value)))).toBeUndefined();
}
function invalid(schema: Record<string, unknown>, value: unknown): void {
  expect(firstJsonSchemaFailure(schema, JSON.parse(JSON.stringify(value)))).toBeDefined();
}

test('native source preserves complete long Unicode text, ordered duplicates, and closed reference fields', () => {
  const exact = { ...source, goal: '  Goal 📚\n' + 'long original text '.repeat(4000), criteria: ['  Criterion α\n', '  Criterion α\n'] };
  valid(CONTRACT_NATIVE_SOURCE_SCHEMA, exact);
  expect(captureNativeContractSource(exact)).toEqual(exact);
  valid(CONTRACT_NATIVE_SOURCE_SCHEMA, { ...source, criteria: [exact.goal] });
  for (const whitespace of [' ', '\t\r\n', '\u00a0\uFEFF\u2028', ' '.repeat(60_000)]) {
    for (const mutation of [{ goal: whitespace }, { criteria: [whitespace] }]) {
      const empty = { ...source, ...mutation };
      expect(() => captureNativeContractSource(empty)).toThrow('Invalid native contract source');
      invalid(CONTRACT_NATIVE_SOURCE_SCHEMA, empty);
    }
  }
  for (const mutation of [{ criteria: [] }, { criteria: [42] }, { sourceRevision: 1 }, { sourceId: '' }, { goal: '' }, { fabricatedAuthority: true }]) {
    invalid(CONTRACT_NATIVE_SOURCE_SCHEMA, { ...source, ...mutation });
  }
});

test('native receipts reuse the canonical schema and retain every semantic variant and provenance field', () => {
  const properties = CONTRACT_NATIVE_DECISION_RECORD_SCHEMA.properties as Record<string, unknown>;
  expect(properties['decision']).toBe(JEV_DECISION_SCHEMA);
  expect(Object.keys(binding)).toEqual([...JEV_DECISION_BINDING_KEYS]);
  valid(CONTRACT_NATIVE_DECISIONS_SCHEMA, nativeState);
  for (const decision of decisions) valid(CONTRACT_NATIVE_DECISION_RECORD_SCHEMA, record(decision));
  for (const kind of ['reconsider', 'gather-evidence', 'revise-action'] as const) {
    valid(CONTRACT_NATIVE_DECISION_RECORD_SCHEMA, record({ ...common, outcome: 'revise', next: { id: 'registered-next', revision: '1', kind } }));
  }
  for (const decision of [
    { ...common, outcome: 'approve' },
    { ...common, outcome: 'act', evidence: [] },
    { ...common, outcome: 'act', until: { id: 'evidence', revision: '1' } },
    { ...common, outcome: 'revise' },
    { ...common, outcome: 'revise', next: { id: 'repair', revision: '1', kind: 'execute-code' } },
    { ...common, outcome: 'defer', until: { id: 'evidence' } },
    { ...common, outcome: 'reject', judgmentDecisionIds: [] },
    { ...common, outcome: 'act', binding: { ...binding, authorityRevision: 2 } },
    { ...common, outcome: 'act', execute: true },
  ]) invalid(CONTRACT_NATIVE_DECISION_RECORD_SCHEMA, { ...record(decisions[0]!), decision });
  invalid(CONTRACT_NATIVE_DECISION_RECORD_SCHEMA, { ...record(decisions[0]!), stage: 'approval' });
  invalid(CONTRACT_NATIVE_DECISIONS_SCHEMA, { ...nativeState, schemaVersion: 2 });
});

test('native dictionaries validate their entries, counters, choices, and closed receipt records', () => {
  for (const mutation of [
    { pending: { plan: { ...record(decisions[2]!), decision: { ...common, outcome: 'defer' } } } },
    { pending: { plan: { ...record(decisions[2]!), fabricatedAuthority: true } } },
    { spent: { planner: '3' } },
    { spent: { planner: -1 } },
    { spent: { planner: 1.5 } },
    { plannerOutputs: { planner: { output: 'Wrong shape' } } },
    { attemptChoices: { unit: 1 } },
    { attemptedChoices: { unit: [1] } },
    { attemptedChoices: { unit: 'candidate-1' } },
  ]) invalid(CONTRACT_NATIVE_DECISIONS_SCHEMA, { ...nativeState, ...mutation });
});

test('progress and credential-free shared transport waiting have distinct closed shapes', () => {
  const progress: NativeContractProgress = { schemaVersion: 1, state: 'deferred', stage: 'plan', targetId: 'contract', until: { id: 'external-evidence', revision: '1' } };
  const waiting: NativeContractTransportProgress = { schemaVersion: 1, requests: [{ logicalRequestId: 'request-1', attempt: { attempt: 2, endpointIndex: 0, endpointKind: 'local', requestedModel: 'jev-test', latencyMs: 100, outcome: 'unavailable', requestId: 'wire-2', status: 503 }, elapsedMs: 1200, nextDelayMs: 1000 }] };
  valid(CONTRACT_NATIVE_PROGRESS_SCHEMA, progress);
  valid(CONTRACT_NATIVE_WAITING_SCHEMA, waiting);
  for (const state of ['deciding', 'refused']) valid(CONTRACT_NATIVE_PROGRESS_SCHEMA, { ...progress, state });
  invalid(CONTRACT_NATIVE_PROGRESS_SCHEMA, { ...progress, state: 'approved' });
  invalid(CONTRACT_NATIVE_PROGRESS_SCHEMA, { ...progress, until: { id: 'evidence', revision: 1 } });
  invalid(CONTRACT_NATIVE_WAITING_SCHEMA, { ...waiting, schemaVersion: 2 });
  invalid(CONTRACT_NATIVE_WAITING_SCHEMA, { ...waiting, requests: [{ ...waiting.requests[0], nextDelayMs: '1000' }] });
  invalid(CONTRACT_NATIVE_WAITING_SCHEMA, { ...waiting, requests: [{ ...waiting.requests[0], attempt: { ...waiting.requests[0]!.attempt, apiKey: 'must-not-be-inspected' } }] });
});

test('durable v1/v2 admission records preserve typed input and versioned placement', () => {
  const admission: DurableContractAdmission = { schemaVersion: 1, key: { workId: 'work-1', criteriaId: source.criteriaId, criteriaRevision: source.criteriaRevision, attemptId: 'attempt-1' }, binding, input: { ask: 'Display request', sessionId: 'session-1', origin: 'turn', projectRoot: '/project', nativeSource: source, proposedUnits: [{ task: 'Exact task', template: 'engineer' }], parentAgentId: 'parent', budget: { maxTokens: 10000, maxCostUsd: 5 }, isolation: 'auto' }, contractId: 'ctr-12345678', ownerAgentId: 'owner', payloadRevision: 'payload-1' };
  valid(CONTRACT_DURABLE_ADMISSION_SCHEMA, admission);
  const versionTwo = { ...admission, schemaVersion: 2, execution: { isolation: 'worktree', branch: 'contract/12345678', worktreePath: '/project/.goodvibes/.worktrees/contract/12345678', baseBranch: 'main' } };
  valid(CONTRACT_DURABLE_ADMISSION_SCHEMA, versionTwo);
  valid(CONTRACT_DURABLE_ADMISSION_SCHEMA, { ...versionTwo, execution: { isolation: 'shared' } });
  for (const mutation of [{ schemaVersion: 3 }, { schemaVersion: 2 }, { execution: { isolation: 'shared' } }, { input: { ...admission.input, nativeSource: { ...source, criteria: [] } } }, { input: { ...admission.input, budget: { maxTokens: '10000' } } }, { binding: { ...binding, guessedPermission: true } }]) {
    invalid(CONTRACT_DURABLE_ADMISSION_SCHEMA, { ...admission, ...mutation });
  }
  invalid(CONTRACT_DURABLE_ADMISSION_SCHEMA, { ...versionTwo, execution: { isolation: 'worktree' } });
  invalid(CONTRACT_DURABLE_ADMISSION_SCHEMA, { ...versionTwo, execution: { isolation: 'shared', worktreePath: '/project' } });
});

test('captured input receipt includes file, symlink and missing provenance without executable authority', () => {
  const snapshot: ContractInputSnapshot = { version: 1, id: 'snapshot-1', sourceRoot: '/project', sourceIdentity: 'source-identity', gitIdentity: 'git-identity', ownerHead: 'head', ownerRef: 'main', indexFingerprint: 'index', inputTree: 'tree', inputCommit: 'commit', capturedAt: 100, dirty: true, exclusions: ['.git', '.goodvibes'], files: [{ path: 'parser.ts', kind: 'file', mode: '100755', oid: 'blob', digest: 'digest', identity: 'file-identity' }, { path: 'link.ts', kind: 'symlink', mode: '120000', oid: 'link-blob', digest: 'link-digest', identity: 'link-identity' }, { path: 'deleted.ts', kind: 'missing', mode: '0' }] };
  valid(CONTRACT_INPUT_SNAPSHOT_SCHEMA, snapshot);
  invalid(CONTRACT_INPUT_SNAPSHOT_SCHEMA, { ...snapshot, version: 2 });
  invalid(CONTRACT_INPUT_SNAPSHOT_SCHEMA, { ...snapshot, files: [{ path: 'parser.ts', kind: 'file', mode: '777' }] });
  invalid(CONTRACT_INPUT_SNAPSHOT_SCHEMA, { ...snapshot, files: [{ ...snapshot.files[0], readPermission: true }] });
});

test('partial persisted reports preserve recognized optional fields for every archetype', () => {
  for (const archetype of ['engineer', 'tester', 'researcher']) {
    valid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype });
    valid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype, summary: 'Historical partial report', filesCreated: ['src/csv.ts'], filesModified: [] });
    invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype, filesCreated: [42] });
    invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype, fabricatedClaim: true });
  }
  valid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype: 'tester', testsPassed: 2 });
  invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype: 'tester', testsPassed: '2' });
  valid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype: 'engineer', decisions: [{ what: 'Retain partial fields', why: 'Historical parser behavior' }] });
  invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype: 'engineer', decisions: [{ what: 1, why: 'Wrong type' }] });
});

test('known completion-report variants preserve full claims and reject malformed reports', () => {
  for (const report of reports) {
    valid(CONTRACT_COMPLETION_REPORT_SCHEMA, report);
    invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { ...report, version: 2 });
    invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { ...report, unknownClaim: true });
  }
  invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { ...reports[0], filesModified: [2] });
  invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { ...reports[1], coverage: { lines: '90', branches: 80, functions: 100 } });
  invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { version: 1, archetype: 'engineer', summary: 'Missing engineer claims', result: 'Not an engineer report' });
  invalid(CONTRACT_COMPLETION_REPORT_SCHEMA, { ...reports[2], result: { summary: 'Wrong shape' } });
});
