import { JEV_CONTINUATION_KINDS, JEV_DECISION_BINDING_KEYS } from './schema.ts';
import type { JevContinuation, JevDecision, JevDecisionBinding, JevDecisionContext, JevVersionRef } from './types.ts';

export type JevDecisionErrorKind = 'invalid-contract' | 'binding-mismatch' | 'unknown-judgment' | 'unknown-evidence' | 'unknown-continuation' | 'unknown-condition';

/** Value-free errors: never echo untrusted payloads or host context into logs. */
export class JevDecisionError extends Error {
  override readonly name = 'JevDecisionError';
  constructor(readonly kind: JevDecisionErrorKind) {
    super(`Jev decision validation failed: ${kind}`);
  }
}

function fail(kind: JevDecisionErrorKind = 'invalid-contract'): never { throw new JevDecisionError(kind); }

function object(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return fail();
  // Snapshot data properties only. Accessors must not change values between checks.
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return fail();
    copy[key] = descriptor.value;
  }
  return copy;
}

function refString(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[^!-~]/u.test(value)) return fail();
  return value;
}

function versionRef(value: unknown): JevVersionRef {
  const ref = object(value, ['id', 'revision']);
  return Object.freeze({ id: refString(ref.id), revision: refString(ref.revision) });
}

function continuation(value: unknown): JevContinuation {
  const ref = object(value, ['id', 'revision', 'kind']);
  const kind = JEV_CONTINUATION_KINDS.find((candidate) => candidate === ref.kind);
  if (kind === undefined) return fail();
  return Object.freeze({ id: refString(ref.id), revision: refString(ref.revision), kind });
}

function binding(value: unknown): JevDecisionBinding {
  const record = object(value, JEV_DECISION_BINDING_KEYS);
  return Object.freeze(Object.fromEntries(JEV_DECISION_BINDING_KEYS.map((key) => [key, refString(record[key])]))) as unknown as JevDecisionBinding;
}

function list<T>(value: unknown, parse: (item: unknown) => T, minimum = 0): readonly T[] {
  if (!Array.isArray(value)) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < minimum || length > 256) return fail();
  const result: T[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return fail();
    result.push(parse(descriptor.value));
  }
  // Canonical parser output has stable property order; exact repeated refs are forbidden.
  if (new Set(result.map((item) => JSON.stringify(item))).size !== result.length) return fail();
  return Object.freeze(result);
}

function parse(value: unknown): JevDecision {
  if (value === null || typeof value !== 'object') return fail();
  const outcome = Object.getOwnPropertyDescriptor(value, 'outcome')?.value as unknown;
  if (outcome !== 'act' && outcome !== 'revise' && outcome !== 'defer' && outcome !== 'reject') return fail();
  const extra = outcome === 'revise' ? ['next'] : outcome === 'defer' ? ['until'] : [];
  const record = object(value, ['schemaVersion', 'decisionId', 'binding', 'judgmentDecisionIds', 'evidence', 'summary', 'outcome', ...extra]);
  if (record.outcome !== outcome) return fail();
  if (record.schemaVersion !== 1 || typeof record.summary !== 'string' || [...record.summary].length > 2000 || !/\S/u.test(record.summary)) return fail();
  const common = {
    schemaVersion: 1 as const,
    decisionId: refString(record.decisionId),
    binding: binding(record.binding),
    judgmentDecisionIds: list(record.judgmentDecisionIds, refString, 1),
    evidence: list(record.evidence, versionRef, outcome === 'act' ? 1 : 0),
    summary: record.summary,
  };
  if (outcome === 'revise') return Object.freeze({ ...common, outcome, next: continuation(record.next) });
  if (outcome === 'defer') return Object.freeze({ ...common, outcome, until: versionRef(record.until) });
  return Object.freeze({ ...common, outcome });
}

/** Strict shape parser and detached immutable snapshot. Does not establish authority. */
export function parseJevDecision(value: unknown): JevDecision {
  try { return parse(value); }
  catch { return fail(); }
}

function matches(ref: JevVersionRef, known: readonly JevVersionRef[]): boolean {
  return known.some((candidate) => ref.id === candidate.id && ref.revision === candidate.revision);
}

/**
 * Detached, frozen host protocol metadata, including a pre-reading context
 * with no call IDs yet. This establishes shape/ownership, never authority.
 * Opaque registry IDs are not raw semantic content or credential containers.
 */
export function captureJevDecisionContext(value: unknown): JevDecisionContext {
  try {
    const record = object(value, ['decisionId', 'binding', 'judgmentDecisionIds', 'evidence', 'continuations', 'resumeConditions']);
    return Object.freeze({
      decisionId: refString(record.decisionId), binding: binding(record.binding),
      judgmentDecisionIds: list(record.judgmentDecisionIds, refString),
      evidence: list(record.evidence, versionRef), continuations: list(record.continuations, continuation),
      resumeConditions: list(record.resumeConditions, versionRef),
    });
  } catch { return fail(); }
}

/**
 * Check a record against host-owned, current context. This is binding validation,
 * not an authorization service. Deterministic execution boundaries still run.
 */
export function validateJevDecision(value: unknown, context: JevDecisionContext): JevDecision {
  const decision = parseJevDecision(value);
  try {
    if (decision.decisionId !== refString(context.decisionId)
      || JEV_DECISION_BINDING_KEYS.some((key) => decision.binding[key] !== refString(context.binding[key]))) fail('binding-mismatch');
    if (decision.judgmentDecisionIds.some((id) => !context.judgmentDecisionIds.includes(id))) fail('unknown-judgment');
    if (decision.evidence.some((ref) => !matches(ref, context.evidence))) fail('unknown-evidence');
    if (decision.outcome === 'revise' && !context.continuations.some((ref) =>
      ref.id === decision.next.id && ref.revision === decision.next.revision && ref.kind === decision.next.kind)) fail('unknown-continuation');
    if (decision.outcome === 'defer' && !matches(decision.until, context.resumeConditions)) fail('unknown-condition');
    return decision;
  } catch (error) { if (error instanceof JevDecisionError) throw error; return fail(); }
}
