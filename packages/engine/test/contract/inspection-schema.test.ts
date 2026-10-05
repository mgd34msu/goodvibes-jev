/** Real runner records must survive the complete GET/LIST REST path and its closed inspection schemas. */
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts/generated/foundation-client-types';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import {
  createSystemOnePort, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type EntryType, type Questions,
} from '@goodvibes-jev/judgment';
import type { EngineerReport } from '../../sdk/src/platform/agents/completion-report.js';
import {
  CONTRACTS_GET_OUTPUT_SCHEMA, CONTRACTS_LIST_OUTPUT_SCHEMA,
} from '../../sdk/src/platform/control-plane/operator-contract-schemas-contracts.js';
import { GatewayMethodCatalog } from '../../sdk/src/platform/control-plane/method-catalog.js';
import { registerContractGatewayMethods } from '../../sdk/src/platform/control-plane/routes/contracts.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../../sdk/src/platform/daemon/control-plane.js';
import { dispatchDaemonApiRoutes } from '../../daemon-sdk/src/index.js';
import type { DaemonApiRouteHandlers, GatewayRestVerbInvocation } from '../../daemon-sdk/src/context.js';
import {
  createContractOperatorService, type NativeContractSource,
} from '../../sdk/src/platform/contract/index.js';
import { makeHarness, oneUnitPlan, startContract, runnerPort, waitFor, type Harness } from './runner-support.js';

type ContractInspection = OperatorMethodOutput<'contracts.get'>;

const source: NativeContractSource = {
  sourceId: 'native-work', sourceRevision: '1', inputRevision: 'input-1',
  criteriaId: 'native-criteria', criteriaRevision: '1',
  goal: ' Deliver the exact parser.\nPreserve Unicode ☃ and trailing space. ',
  criteria: ['The parser preserves all documented input forms'],
};
const identity = { authorityId: 'host', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' };

function nativePlan() {
  return {
    ...oneUnitPlan(1), goal: source.goal,
    criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }],
  };
}

/** Optional consumer fixtures come from real HTTP JSON. The TEST prefix survives guarded test isolation. */
function exportFixture(label: string, get: unknown, list: unknown): void {
  const directory = process.env['GOODVIBES_TEST_CONTRACT_INSPECTION_FIXTURE_DIR'];
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${label}-get.json`), `${JSON.stringify(get, null, 2)}\n`);
  writeFileSync(join(directory, `${label}-list.json`), `${JSON.stringify(list, null, 2)}\n`);
}

/** Wire reports can be partial even though the richer authoring model requires all claims. */
function assertContractInspection(value: unknown): asserts value is ContractInspection {
  expect(firstJsonSchemaFailure(CONTRACTS_GET_OUTPUT_SCHEMA, value)).toBeUndefined();
}

async function inspectOverHttp(h: Harness, id: string, label: string): Promise<ContractInspection> {
  const service = createContractOperatorService({ runner: h.runner, workingDirectory: h.root });
  const catalog = new GatewayMethodCatalog();
  registerContractGatewayMethods(catalog, service);
  // The invocation path reads only gatewayMethods from the daemon context.
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);
  // The router delegates these two GET routes solely to invokeGatewayRestVerb.
  const handlers = {
    invokeGatewayRestVerb: async ({ methodId, req, params }: GatewayRestVerbInvocation) => {
      const query: Record<string, unknown> = { ...params };
      for (const [key, value] of new URL(req.url).searchParams) query[key] = value;
      const result = await helper.invokeGatewayMethodCall({
        authToken: 'fixture-token', methodId, query, body: { ...params },
        context: { scopes: ['read:fleet'], admin: false },
      });
      return Response.json(result.body, { status: result.status });
    },
  } as unknown as DaemonApiRouteHandlers;
  const get = await dispatchDaemonApiRoutes(new Request(`http://daemon.invalid/api/contracts/${id}`), handlers);
  const list = await dispatchDaemonApiRoutes(new Request('http://daemon.invalid/api/contracts?includeTerminal=true'), handlers);
  if (get === null || list === null) throw new Error('Contract inspection REST routes were not dispatched');
  expect(get.status).toBe(200);
  expect(list.status).toBe(200);
  const serialized: unknown = await get.json();
  const serializedList: unknown = await list.json();
  const expected: unknown = JSON.parse(JSON.stringify(h.runner.get(id)));
  // Compare the complete response before validation: no adapter may hide drift by dropping fields.
  expect(serialized).toEqual(expected);
  expect(serializedList).toEqual({ contracts: [expected] });
  assertContractInspection(serialized);
  expect(firstJsonSchemaFailure(CONTRACTS_LIST_OUTPUT_SCHEMA, serializedList)).toBeUndefined();
  exportFixture(label, serialized, serializedList);
  // Return the validated wire type, not the more restrictive authoring model.
  return serialized;
}

function rejectsInspection(value: unknown): void {
  expect(firstJsonSchemaFailure(CONTRACTS_GET_OUTPUT_SCHEMA, value)).toBeDefined();
  expect(firstJsonSchemaFailure(CONTRACTS_LIST_OUTPUT_SCHEMA, { contracts: [value] })).toBeDefined();
}

async function clean(h: Harness, id: string): Promise<void> {
  try {
    h.runner.cancel(id, 'Inspection test complete');
    await h.runner.join(id);
  } finally {
    h.dispose();
  }
}

test('ordinary worktree inspection preserves captured input and the runner-parsed completion report', async () => {
  const report: EngineerReport = {
    version: 1, archetype: 'engineer', summary: 'Implemented the CSV parser',
    gatheredContext: ['Read the parser requirements'], plannedActions: ['Add the parser'],
    appliedChanges: ['Added src/csv.ts'], filesCreated: ['src/csv.ts'], filesModified: [], filesDeleted: [],
    decisions: [{ what: 'Preserve every input form', why: 'Required by the parser contract' }],
    issues: [], uncertainties: [],
  };
  const output = ['Parser complete.', '```json', JSON.stringify(report), '```'].join('\n');
  const h = makeHarness({
    plan: oneUnitPlan(1),
    scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parseCsv = (text: string) => text.split(",");\n' }, text: output }] },
  });
  const id = startContract(h, { isolation: 'worktree' }).contract.id;
  try {
    await h.runner.join(id);
    const record = await inspectOverHttp(h, id, 'ordinary-completed-worktree');
    expect(record.status).toBe('passed');
    expect(record.isolation).toBe('worktree');
    expect(record.inputSnapshot).toMatchObject({ version: 1, sourceRoot: h.root });
    expect(record.inputSnapshot?.files.some(file => file.path === 'README.md')).toBe(true);
    expect(record.units[0]?.lastReport).toEqual(report);
    expect(record.units[0]?.lastOutput).toBe(output);
    expect(record.units[0]?.checks.length).toBeGreaterThan(0);
    expect(record.nativeSource).toBeUndefined();
    rejectsInspection({ ...record, unexpectedField: true });
    rejectsInspection({ ...record, inputSnapshot: { ...record.inputSnapshot, version: 99 } });
    rejectsInspection({ ...record, inputSnapshot: { ...record.inputSnapshot, files: [{ path: 'README.md', kind: 'directory', mode: '100644' }] } });
    rejectsInspection({ ...record, units: record.units.map(unit => ({ ...unit, lastReport: { ...report, summary: 123 } })) });
    rejectsInspection({ ...record, units: record.units.map(unit => ({ ...unit, lastReport: { ...report, unexpectedField: true } })) });
  } finally {
    await clean(h, id);
  }
}, 25_000);

test.each([
  ['engineer', `Wrote the parser. ${'detail '.repeat(4_000)}`],
  ['researcher', 'Recorded file claims on a generic report.'],
])('partial %s reports survive the real parser, runner, store, and GET/LIST inspection', async (archetype, summary) => {
  // The existing parser accepts these historical partial reports. Do not fill
  // absent fields merely to make the wire schema agree with the authoring type.
  const report = { version: 1, archetype, summary, filesCreated: ['src/csv.ts'], filesModified: [], filesDeleted: [] } satisfies NonNullable<ContractInspection['units'][number]['lastReport']>;
  const output = ['Finished.', '```json', JSON.stringify(report), '```'].join('\n');
  const h = makeHarness({
    plan: oneUnitPlan(1),
    scripts: { u1: () => [{ files: { 'src/csv.ts': 'export const parse = 1;\n' }, text: output }] },
  });
  const id = startContract(h, { isolation: 'worktree' }).contract.id;
  try {
    await h.runner.join(id);
    const record = await inspectOverHttp(h, id, `partial-${archetype}-report-worktree`);
    expect(record.status).toBe('passed');
    const unit = record.units[0]!;
    expect(unit.lastReport).toEqual(report);
    expect(unit.checks.find(check => check.trigger === 'completion')?.claims?.kind).toBe('files_verified');
    expect(Object.hasOwn(unit.lastReport!, 'gatheredContext')).toBe(false);
    if (archetype === 'engineer') expect(unit.lastOutput!.length).toBeLessThan(output.length);
    rejectsInspection({ ...record, units: [{ ...unit, lastReport: { ...report, filesModified: 'src/csv.ts' } }] });
    rejectsInspection({ ...record, units: [{ ...unit, lastReport: { ...report, unrecognizedClaim: true } }] });
  } finally {
    await clean(h, id);
  }
}, 25_000);

test('durable native worktree deferral survives GET/LIST inspection without losing its receipts', async () => {
  const h = makeHarness({
    recordNative: true, plan: nativePlan(), scripts: {},
    durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) },
    nativeDecisions: {
      authorityOf: () => identity,
      conditions: (_contract, stage) => stage === 'plan' ? [{
        ref: { id: 'evidence-ready', revision: '1' }, description: 'Independent evidence arrives',
        current: () => ({ id: 'evidence-ready', revision: '1' }),
        wait: signal => new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      }] : [],
    },
    port: context => {
      const binding = context.state['binding'];
      return context.name === 'disposition' && binding !== null && typeof binding === 'object'
        && !Array.isArray(binding) && 'actionId' in binding && String(binding.actionId).includes(':plan:')
        ? choiceAnswer(context.question, 'defer_0', 0.99) : undefined;
    },
  });
  let id: string | undefined;
  try {
    const started = await h.runner.startDurable({
      key: { workId: 'native-work', criteriaId: source.criteriaId, criteriaRevision: source.criteriaRevision, attemptId: 'attempt-1' },
      binding: { sourceId: source.sourceId, inputRevision: source.inputRevision, actionId: 'start-native-contract', actionRevision: '1', ...identity },
      input: { ask: 'Parser display request', nativeSource: source, sessionId: 'inspection-schema', origin: 'turn', projectRoot: h.root, isolation: 'worktree' },
    });
    id = started.contract.id;
    const contractId = id;
    await waitFor(() => h.store.get(contractId)?.nativeProgress?.state === 'deferred', 'native plan deferral', 15_000);
    const record = await inspectOverHttp(h, id, 'native-durable-deferred-worktree');
    expect(record.nativeSource).toEqual(source);
    expect(record.nativeProgress).toMatchObject({ schemaVersion: 1, state: 'deferred', stage: 'plan', until: { id: 'evidence-ready', revision: '1' } });
    expect(record.nativeWaiting).toBeUndefined();
    expect(record.inputSnapshot).toMatchObject({ version: 1, sourceRoot: h.root });
    expect(record.durableAdmission).toMatchObject({ schemaVersion: 2, contractId: id, execution: { isolation: 'worktree' }, input: { nativeSource: source } });
    expect(record.durableLaunchState).toBe('launch-claimed');
    const native = record.nativeDecisions;
    if (native === undefined) throw new Error('Native deferral did not retain its decision records');
    const deferred = native.history.find(entry => entry.stage === 'plan' && entry.decision.outcome === 'defer');
    expect(deferred).toBeDefined();
    if (deferred === undefined) throw new Error('Native deferral did not record its semantic decision');
    expect(deferred.decision.binding).toMatchObject({ sourceId: source.sourceId, ...identity });
    expect(deferred.decision.judgmentDecisionIds.length).toBeGreaterThan(0);
    expect(Object.values(native.pending)).toContainEqual(deferred);
    expect(native.spent['plan']).toBeGreaterThan(0);
    rejectsInspection({ ...record, nativeSource: { ...source, criteria: [42] } });
    rejectsInspection({ ...record, nativeSource: { ...source, unexpectedField: true } });
    rejectsInspection({ ...record, nativeProgress: { ...record.nativeProgress, state: 'waiting-for-approval' } });
    rejectsInspection({ ...record, nativeProgress: { ...record.nativeProgress, until: { id: 'evidence-ready', revision: 1 } } });
    rejectsInspection({ ...record, nativeDecisions: { ...native, spent: [] } });
    rejectsInspection({ ...record, nativeDecisions: { ...native, spent: { plan: 'one' } } });
    rejectsInspection({ ...record, nativeDecisions: { ...native, attemptedChoices: { unit: [42] } } });
    rejectsInspection({ ...record, nativeDecisions: { ...native, pending: { plan: { ...deferred, operationRevision: 1 } } } });
    rejectsInspection({ ...record, nativeDecisions: { ...native, history: native.history.map(entry => ({ ...entry, decision: { ...entry.decision, outcome: 'approved' } })) } });
    rejectsInspection({ ...record, nativeDecisions: { ...native, pending: [] } });
    rejectsInspection({ ...record, durableAdmission: { ...record.durableAdmission, execution: { isolation: 'automatic' } } });
    rejectsInspection({ ...record, durableLaunchState: 'executing' });
  } finally {
    if (id === undefined) h.dispose();
    else await clean(h, id);
  }
}, 25_000);

test('real shared transport retry waiting survives native GET/LIST inspection', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const h = makeHarness({ recordNative: true, decisionLog: log, plan: nativePlan(), scripts: {} });
  const scripted = runnerPort();
  let failedRequests = 0;
  const real = createSystemOnePort({
    endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-key' }, model: PINNED_MODEL,
    timeoutMs: 1_000,
    // Hold the actual backoff state steady for both HTTP reads; cancellation aborts this delay.
    retry: { backoffInitialMs: 60_000, backoffMaxMs: 60_000, backoffJitter: 0 },
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { state: EntryType; questions: Questions };
      if ('disposition' in request.questions) {
        failedRequests += 1;
        return Response.json({}, { status: 503 });
      }
      const result = await scripted.port.ask(request);
      return Response.json({ model: PINNED_MODEL, answers: result.answers, usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  installJudgmentPort(withDecisionLog(real, log));
  const id = startContract(h, { nativeSource: source, isolation: 'shared' }).contract.id;
  try {
    await waitFor(() => (h.store.get(id)?.nativeWaiting?.requests.length ?? 0) > 0, 'native transport backoff', 15_000);
    const record = await inspectOverHttp(h, id, 'native-backoff-shared');
    expect(failedRequests).toBe(1);
    expect(record.isolation).toBe('shared');
    expect(record.nativeSource).toEqual(source);
    expect(record.inputSnapshot).toBeUndefined();
    expect(record.nativeProgress?.state).toBe('deciding');
    const waiting = record.nativeWaiting;
    if (waiting === undefined) throw new Error('Failed native judgment request did not publish transport waiting');
    expect(waiting.schemaVersion).toBe(1);
    expect(waiting.requests).toHaveLength(1);
    const retry = waiting.requests[0]!;
    expect(retry.logicalRequestId.length).toBeGreaterThan(0);
    expect(retry.attempt).toMatchObject({ attempt: 1, endpointIndex: 0, endpointKind: 'local', requestedModel: PINNED_MODEL, status: 503 });
    expect(retry.nextDelayMs).toBe(60_000);
    expect(retry.elapsedMs).toBeGreaterThanOrEqual(0);
    rejectsInspection({ ...record, nativeWaiting: { ...waiting, schemaVersion: 2 } });
    rejectsInspection({ ...record, nativeWaiting: { ...waiting, requests: [{ ...retry, nextDelayMs: 'later' }] } });
    rejectsInspection({ ...record, nativeWaiting: { ...waiting, requests: [{ ...retry, attempt: { ...retry.attempt, endpointKind: 'unknown' } }] } });
    rejectsInspection({ ...record, nativeWaiting: { ...waiting, requests: [{ ...retry, attempt: { ...retry.attempt, outcome: 'approved' } }] } });
    rejectsInspection({ ...record, nativeWaiting: { ...waiting, requests: [{ ...retry, unexpectedField: true }] } });
  } finally {
    await clean(h, id);
  }
}, 25_000);
