import type { NativeCiContinuationStorage } from './native-ci-continuation-types.js';
import type { NativeWorkSettlementReceipt, NativeWorkSettlementPublication } from './native-settlement-types.js';
/** Host-only native execution records. Ledger reports are never execution authority. */
import { types as nodeTypes } from 'node:util';
import { captureJevDecisionContext, validateJevDecision, type JevDecision, type JevDecisionContext } from '@goodvibes-jev/judgment/decisions';
import { freezeDurableRequest, parseDurableAdmission, type DurableContractReceipt, type DurableContractRequest } from '../../contract/durable-admission.js';
import type { WorkLedgerState } from './types.js';

export interface NativeWorkExecutionTarget {
  readonly workId: string;
  readonly workRevision: number;
  readonly criteriaRevision: number;
  readonly attemptId: string;
  readonly attemptRevision: number;
}
export interface NativeWorkExecutionRecord {
  readonly version: 1;
  readonly projectId: string;
  readonly target: NativeWorkExecutionTarget;
  readonly authorityScopes: readonly string[];
  readonly request: DurableContractRequest;
  readonly decision: JevDecision;
  readonly decisionContext: JevDecisionContext;
  readonly receipt: DurableContractReceipt | null;
  readonly state: 'prepared' | 'launch-claimed' | 'cancelled';
}
/** A host request reservation, never a Jev decision or permission to execute. */
export interface NativeWorkExecutionIntent {
  readonly version: 1;
  readonly projectId: string;
  readonly target: NativeWorkExecutionTarget;
  readonly authorityScopes: readonly string[];
  readonly request: DurableContractRequest;
  readonly generation: number;
  readonly state: 'admitting' | 'associated' | 'cancelled' | 'refused';
}
export class NativeWorkExecutionError extends Error {
  constructor(readonly code: 'unavailable' | 'unsupported-authority' | 'stale' | 'conflict' | 'recovery-required' | 'closed' | 'invalid' | 'refused' | 'not-found' | 'pending-intent' | 'prevented-before-admission', readonly decision?: JevDecision) {
    super(`Native work execution: ${code}`); this.name = 'NativeWorkExecutionError';
  }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Data validation only. The actual authority owner supplies and checks all live identities. */
export function parseNativeWorkExecutionRecord(value: unknown): NativeWorkExecutionRecord {
  try {
    if (!object(value) || Object.keys(value).length !== 9 || value['version'] !== 1 || typeof value['projectId'] !== 'string' || !value['projectId']) throw new Error();
    if (!Array.isArray(value['authorityScopes']) || value['authorityScopes'].some(scope => typeof scope !== 'string' || !scope) || new Set(value['authorityScopes']).size !== value['authorityScopes'].length) throw new Error();
    const target = value['target'];
    if (!object(target) || Object.keys(target).length !== 5 || !['workId', 'attemptId'].every(key => typeof target[key] === 'string' && target[key])
      || !['workRevision', 'criteriaRevision', 'attemptRevision'].every(key => Number.isSafeInteger(target[key]) && Number(target[key]) >= 0)) throw new Error();
    const request = freezeDurableRequest(value['request'] as DurableContractRequest);
    if (request.key.workId !== target['workId'] || request.key.attemptId !== target['attemptId'] || request.key.criteriaRevision !== String(target['criteriaRevision']) || !request.input.nativeSource) throw new Error();
    const decisionContext = captureJevDecisionContext(value['decisionContext'] as JevDecisionContext);
    const decision = validateJevDecision(value['decision'], decisionContext);
    if (decision.outcome !== 'act' || Object.keys(request.binding).some(key => decision.binding[key as keyof typeof decision.binding] !== request.binding[key as keyof typeof request.binding])) throw new Error();
    let receipt: DurableContractReceipt | null = null;
    if (value['receipt'] !== null) {
      if (!object(value['receipt'])) throw new Error();
      const admission = parseDurableAdmission({ ...value['receipt'], input: request.input });
      if (Object.keys(request.binding).some(key => admission.binding[key as keyof typeof admission.binding] !== request.binding[key as keyof typeof request.binding]) || Object.keys(request.key).some(key => admission.key[key as keyof typeof admission.key] !== request.key[key as keyof typeof request.key])) throw new Error();
      const { input: _input, ...parsedReceipt } = admission; receipt = parsedReceipt;
    }
    if (!['prepared', 'launch-claimed', 'cancelled'].includes(String(value['state'])) || (value['state'] === 'launch-claimed' && !receipt)) throw new Error();
    return { version: 1, projectId: value['projectId'], authorityScopes: [...value['authorityScopes']] as string[], target: { workId: String(target['workId']), workRevision: Number(target['workRevision']), criteriaRevision: Number(target['criteriaRevision']), attemptId: String(target['attemptId']), attemptRevision: Number(target['attemptRevision']) }, request, decision, decisionContext, receipt, state: value['state'] as NativeWorkExecutionRecord['state'] };
  } catch { throw new NativeWorkExecutionError('invalid'); }
}
/** Strict additive format; the schema-3 execution parser above is unchanged. */
function intentObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return object(value) && !nodeTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
}
export function parseNativeWorkExecutionIntent(value: unknown): NativeWorkExecutionIntent {
  try {
    if (!intentObject(value, ['version', 'projectId', 'target', 'authorityScopes', 'request', 'generation', 'state']) || value['version'] !== 1 || typeof value['projectId'] !== 'string' || !value['projectId']) throw new Error();
    if (!Array.isArray(value['authorityScopes']) || nodeTypes.isProxy(value['authorityScopes']) || Object.getPrototypeOf(value['authorityScopes']) !== Array.prototype
      || Reflect.ownKeys(value['authorityScopes']).length !== value['authorityScopes'].length + 1 || Object.values(Object.getOwnPropertyDescriptors(value['authorityScopes'])).some(descriptor => !('value' in descriptor)) || value['authorityScopes'].some(scope => typeof scope !== 'string' || !scope) || new Set(value['authorityScopes']).size !== value['authorityScopes'].length) throw new Error();
    for (let index = 0; index < value['authorityScopes'].length; index++) if (!Object.hasOwn(value['authorityScopes'], index)) throw new Error();
    const target = value['target'];
    if (!intentObject(target, ['workId', 'attemptId', 'workRevision', 'criteriaRevision', 'attemptRevision']) || !['workId', 'attemptId'].every(key => typeof target[key] === 'string' && target[key])
      || !['workRevision', 'criteriaRevision', 'attemptRevision'].every(key => Number.isSafeInteger(target[key]) && Number(target[key]) >= 0)) throw new Error();
    const request = freezeDurableRequest(value['request'] as DurableContractRequest);
    if (request.key.workId !== target['workId'] || request.key.attemptId !== target['attemptId'] || request.key.criteriaRevision !== String(target['criteriaRevision']) || !request.input.nativeSource) throw new Error();
    if (!Number.isSafeInteger(value['generation']) || Number(value['generation']) < 1 || typeof value['state'] !== 'string' || !['admitting', 'associated', 'cancelled', 'refused'].includes(String(value['state']))) throw new Error();
    return { version: 1, projectId: value['projectId'], authorityScopes: [...value['authorityScopes']] as string[], target: { workId: String(target['workId']), workRevision: Number(target['workRevision']), criteriaRevision: Number(target['criteriaRevision']), attemptId: String(target['attemptId']), attemptRevision: Number(target['attemptRevision']) }, request, generation: Number(value['generation']), state: value['state'] as NativeWorkExecutionIntent['state'] };
  } catch { throw new NativeWorkExecutionError('invalid'); }
}
export interface NativeWorkExecutionTransaction {
  readonly ledger: WorkLedgerState;
  readonly record: NativeWorkExecutionRecord | null;
  readonly intent: NativeWorkExecutionIntent | null;
  readonly settlement?: NativeWorkSettlementReceipt | null;
}
export interface NativeWorkExecutionMutation<T> {
  readonly next: NativeWorkExecutionRecord | null;
  /** Omission or null preserves the current intent, including cancellation tombstones. */
  readonly nextIntent?: NativeWorkExecutionIntent | null;
  readonly value: T;
}
export interface NativeWorkExecutionStorage {
  readonly continuations?: NativeCiContinuationStorage;
  /** Authoritative synchronous reads, required before every semantic/tool operation. */
  current(key: DurableContractRequest['key']): NativeWorkExecutionTransaction;
  /** Unique persisted association; ledger edits cannot strand inspection or cancellation. */
  currentByAttempt(attemptId: string): NativeWorkExecutionTransaction;
  transaction<T>(key: DurableContractRequest['key'], decide: (current: NativeWorkExecutionTransaction) => NativeWorkExecutionMutation<T>, afterDurable?: (value: T, current: () => NativeWorkExecutionTransaction) => void): Promise<T>;
  transactionByAttempt<T>(attemptId: string, decide: (current: NativeWorkExecutionTransaction) => NativeWorkExecutionMutation<T>, afterDurable?: (value: T, current: () => NativeWorkExecutionTransaction) => void): Promise<T>;
  /** Atomic report, evidence and native settlement publication in the existing ledger transaction. */
  settle?(key: DurableContractRequest['key'], decide: (current: NativeWorkExecutionTransaction) => NativeWorkSettlementPublication | null,
    assertCurrent: () => void): Promise<NativeWorkSettlementReceipt>;
  close(): Promise<void>;
}
