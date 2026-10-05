/** Unmodified real REST captures. Keep the bytes, then validate before narrowing. */
import { readFileSync } from 'node:fs';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import inspectionSchema from '../../src/lib/generated/contract-inspection-schema.json' with { type: 'json' };
import type { ContractRecord } from '../../src/lib/contract-bridge-types';

export const CAPTURE_NAMES = [
  'ordinary-completed-worktree',
  'native-durable-deferred-worktree',
  'native-backoff-shared',
  'partial-engineer-report-worktree',
  'partial-researcher-report-worktree',
] as const;

function assertWire(method: 'contracts.get' | 'contracts.list', value: unknown): void {
  const schema = operatorContract.operator.methods.find((entry) => entry.id === method)?.outputSchema;
  if (!schema) throw new Error(`Missing canonical output schema: ${method}`);
  const failure = firstJsonSchemaFailure(schema, value);
  if (failure) throw new Error(`Invalid captured ${method}: ${failure.path}`);
}

export function loadCapturedContract(name: typeof CAPTURE_NAMES[number]) {
  const body = (kind: 'get' | 'list') => readFileSync(new URL(`./fixtures/contract-inspection/${name}-${kind}.json`, import.meta.url), 'utf8');
  const getBody = body('get'), listBody = body('list');
  const get: unknown = JSON.parse(getBody), list: unknown = JSON.parse(listBody);
  assertWire('contracts.get', get);
  assertWire('contracts.list', list);
  const failure = firstJsonSchemaFailure(inspectionSchema, get);
  if (failure) throw new Error(`Product inspection schema rejected ${name}: ${failure.path}`);
  // This is the sole wire-type boundary: both the closed canonical schema and
  // the production hook's generated snapshot have validated the complete value.
  // No field is removed, renamed, normalized, or replaced with a synthetic value.
  const record = get as ContractRecord;
  return { name, record, getBody, listBody };
}

export const CAPTURED_CONTRACTS = CAPTURE_NAMES.map(loadCapturedContract);

/** Deliberate negative responses, never substituted for the original fixtures. */
export function malformedCapturedRecords(record: ContractRecord): { name: string; value: unknown }[] {
  return [
    { name: 'unknown root field', value: { ...record, inspectionInvented: true } },
    ...(record.inputSnapshot ? [
      { name: 'capture enum', value: { ...record, inputSnapshot: { ...record.inputSnapshot, files: [{ path: 'README.md', mode: '100644', kind: 'directory' }] } } },
    ] : []),
    ...(record.units.some((unit) => unit.lastReport) ? [
      { name: 'lastReport primitive', value: { ...record, units: record.units.map((unit) => ({ ...unit, lastReport: { ...unit.lastReport, summary: 42 } })) } },
      { name: 'lastReport closed shape', value: { ...record, units: record.units.map((unit) => ({ ...unit, lastReport: { ...unit.lastReport, invented: true } })) } },
    ] : []),
    ...(record.nativeSource ? [
      { name: 'native source closed shape', value: { ...record, nativeSource: { ...record.nativeSource, invented: true } } },
      { name: 'native source primitive', value: { ...record, nativeSource: { ...record.nativeSource, criteria: [42] } } },
    ] : []),
    ...(record.nativeProgress ? [
      { name: 'native progress enum', value: { ...record, nativeProgress: { ...record.nativeProgress, state: 'waiting-for-approval' } } },
    ] : []),
    ...(record.nativeWaiting ? [
      { name: 'retry primitive', value: { ...record, nativeWaiting: { ...record.nativeWaiting, requests: record.nativeWaiting.requests.map((request) => ({ ...request, nextDelayMs: 'later' })) } } },
      { name: 'retry endpoint enum', value: { ...record, nativeWaiting: { ...record.nativeWaiting, requests: record.nativeWaiting.requests.map((request) => ({ ...request, attempt: { ...request.attempt, endpointKind: 'invented' } })) } } },
    ] : []),
    ...(record.nativeDecisions ? [
      { name: 'native ledger numeric map', value: { ...record, nativeDecisions: { ...record.nativeDecisions, spent: { plan: 'one' } } } },
      { name: 'native ledger object map', value: { ...record, nativeDecisions: { ...record.nativeDecisions, pending: [] } } },
      ...(record.nativeDecisions.history.length ? [
        { name: 'native decision outcome enum', value: { ...record, nativeDecisions: { ...record.nativeDecisions, history: record.nativeDecisions.history.map((entry) => ({ ...entry, decision: { ...entry.decision, outcome: 'approved' } })) } } },
        { name: 'native decision union', value: { ...record, nativeDecisions: { ...record.nativeDecisions, history: record.nativeDecisions.history.map((entry) => ({ ...entry, decision: { ...entry.decision, outcome: 'act' } })) } } },
      ] : []),
    ] : []),
    ...(record.durableAdmission ? [
      { name: 'durable execution enum', value: { ...record, durableAdmission: { ...record.durableAdmission, execution: { isolation: 'automatic' } } } },
    ] : []),
  ];
}
