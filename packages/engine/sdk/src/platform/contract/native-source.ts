import { createHash } from 'node:crypto';
import { captureNativeConversationContinuation, canonicalNativeConversationContinuation, type NativeConversationContinuation } from '../workflow/work-ledger/native-continuation-context.js';
/** Immutable native requirements, independent of every generated plan and correction. */
import { types as nodeTypes } from 'node:util';
import type { NativeSelectedDiffContext } from '../workflow/work-ledger/native-diff-context.js';
import type { ContractPlan, PlanProblem } from './plan-schema.js';
import type { Contract, ContractView, Criterion, NativeContractSource } from './types.js';

const SOURCE_KEYS = ['sourceId', 'sourceRevision', 'inputRevision', 'criteriaId', 'criteriaRevision', 'goal', 'criteria'];
const REFERENCE_KEYS = ['sourceId', 'sourceRevision', 'inputRevision', 'criteriaId', 'criteriaRevision'] as const;

/** Validates, detaches and freezes a complete host-owned native source. Never infers missing criteria. */
export function captureNativeContractSource(value: unknown): NativeContractSource {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !('value' in descriptor))) throw new Error('Invalid native contract source');
  const source = value as Record<string, unknown>;
  if (Reflect.ownKeys(source).length !== SOURCE_KEYS.length + (Object.hasOwn(source, 'continuation') ? 1 : 0) || SOURCE_KEYS.some(key => !Object.hasOwn(source, key))
    || REFERENCE_KEYS.some(key => typeof source[key] !== 'string' || !/^[\x21-\x7e][\x20-\x7e]{0,255}$/.test(source[key]))
    || typeof source['goal'] !== 'string' || source['goal'].trim().length === 0
    || !Array.isArray(source['criteria']) || nodeTypes.isProxy(source['criteria']) || source['criteria'].length === 0
    || Object.getPrototypeOf(source['criteria']) !== Array.prototype
    || Reflect.ownKeys(source['criteria']).length !== source['criteria'].length + 1) {
    throw new Error('Invalid native contract source');
  }
  const criteria: string[] = [];
  for (let index = 0; index < source['criteria'].length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(source['criteria'], String(index));
    if (item === undefined || !('value' in item) || typeof item.value !== 'string' || item.value.trim().length === 0) {
      throw new Error('Invalid native contract source');
    }
    criteria.push(item.value);
  }
  const continuation = Object.hasOwn(source, 'continuation') ? captureNativeConversationContinuation(source['continuation']) : undefined;
  if (continuation && continuation.revision !== createHash('sha256').update(canonicalNativeConversationContinuation(continuation.sessionId, continuation.messages, continuation.selectedDiff)).digest('hex')) throw new Error('Invalid native continuation revision');
  return Object.freeze({
    ...(continuation ? { continuation } : {}),
    sourceId: source['sourceId'] as string,
    sourceRevision: source['sourceRevision'] as string,
    inputRevision: source['inputRevision'] as string,
    criteriaId: source['criteriaId'] as string,
    criteriaRevision: source['criteriaRevision'] as string,
    goal: source['goal'],
    criteria: Object.freeze(criteria),
  });
}

/** Complete semantic requirements for planner/unit/fix task prose. Protocol
 * identity stays in the typed source/admission binding, and private context is
 * supplied only at its existing guarded provider boundary. Neither belongs in
 * the raw text subsequently read as a knowledge query.
 */
export function nativeContractTaskSource(source: NativeContractSource): Pick<NativeContractSource, 'goal' | 'criteria'> {
  return { goal: source.goal, criteria: source.criteria };
}

/** Explicit JSON projection retains frozen context while giving judgment mutable JSON arrays. */
export function nativeContractSourceData(source: NativeContractSource) {
  const { continuation, ...original } = source;
  const selectedDiff = continuation?.selectedDiff;
  return { ...original, criteria: [...source.criteria], ...(continuation ? { continuation: {
    sessionId: continuation.sessionId, revision: continuation.revision, messages: continuation.messages.map(message => ({ ...message })),
    ...(selectedDiff ? { selectedDiff: selectedDiff.kind === 'session'
      ? { ...selectedDiff, provenance: { ...selectedDiff.provenance } }
      : { ...selectedDiff, provenance: { ...selectedDiff.provenance } } } : {}),
  } } : {}) };
}

/** Stable positional ids bind derived work to the original ordered native criteria. */
export function nativeSourcePlan(source: NativeContractSource): Pick<ContractPlan, 'goal' | 'criteria'> {
  return { goal: source.goal, criteria: source.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text })) };
}

/** No model, owner reply or later plan may rewrite, omit, add or reorder native roots. */
export function checkNativeSourcePlan(plan: { readonly goal: string; readonly criteria: readonly { readonly id: string; readonly text: string; readonly quote?: string | undefined }[] }, source: NativeContractSource): PlanProblem[] {
  const expected = nativeSourcePlan(source);
  const same = plan.goal === expected.goal && plan.criteria.length === expected.criteria.length
    && plan.criteria.every((criterion, index) => {
      const root = expected.criteria[index]!;
      return criterion.id === root.id && criterion.text === root.text && criterion.quote === root.quote;
    });
  return same ? [] : [{ code: 'native-source-changed', message: 'Keep the native source goal and every ordered root criterion (id, text and quote) exactly unchanged. Repair only derived groups, units and their criteria.' }];
}

export function nativeSourceCriteria(source: NativeContractSource): Criterion[] {
  return nativeSourcePlan(source).criteria.map(criterion => ({ ...criterion, origin: 'stated', serves: [], disposition: 'judged', status: 'unread', readings: [] }));
}

/** Checks persisted roots too; a mismatched snapshot must not resume or verify a different task. */
export function assertNativeContractSource(contract: ContractView): void {
  if (contract.nativeSource === undefined) return;
  const source = captureNativeContractSource(contract.nativeSource);
  if (checkNativeSourcePlan(contract, source).length > 0
    || contract.criteria.some(criterion => criterion.origin !== 'stated' || criterion.serves.length !== 0 || criterion.disposition !== 'judged')) {
    throw new Error('Native contract roots differ from their immutable source');
  }
}

/** Lock source and root identity while leaving evidence/status fields mutable for real verification. */
export function bindNativeContractSource(contract: Contract): void {
  if (contract.nativeSource === undefined) return;
  assertNativeContractSource(contract);
  const source = captureNativeContractSource(contract.nativeSource);
  // Called once at creation or deserialization; repeated boundary checks use assert instead.
  Object.defineProperty(contract, 'nativeSource', { value: source, enumerable: true, writable: false, configurable: false });
  Object.defineProperty(contract, 'goal', { value: source.goal, enumerable: true, writable: false, configurable: false });
  for (const criterion of contract.criteria) {
    for (const key of ['id', 'text', 'quote', 'origin', 'serves', 'disposition'] as const) {
      const value = key === 'serves' ? Object.freeze([]) : criterion[key];
      Object.defineProperty(criterion, key, { value, enumerable: true, writable: false, configurable: false });
    }
  }
  Object.freeze(contract.criteria);
  Object.defineProperty(contract, 'criteria', { value: contract.criteria, enumerable: true, writable: false, configurable: false });
}

/** Admission projection from native authority only. Legacy/generated roots are deliberately refused. */
export function nativeContractSourceForAdmission(contract: ContractView): Pick<NativeContractSource, 'goal' | 'criteria'> & { readonly conversationContext?: NativeConversationContinuation['messages']; readonly selectedDiffContext?: NativeSelectedDiffContext } {
  assertNativeContractSource(contract);
  if (contract.nativeSource === undefined) throw new Error('Contract has no native source for autonomous admission');
  return Object.freeze({ goal: contract.nativeSource.goal, criteria: Object.freeze([...contract.nativeSource.criteria]),
    ...(contract.nativeSource.continuation ? { conversationContext: contract.nativeSource.continuation.messages,
      ...(contract.nativeSource.continuation.selectedDiff ? { selectedDiffContext: contract.nativeSource.continuation.selectedDiff } : {}) } : {}) });
}
