/** Opaque host-adapter evidence. Evidence describes a destination; it never grants authority. */
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
const brand: unique symbol = Symbol('external-request-evidence');
export interface ExternalRequestEvidence { readonly [brand]: true }
const owned = new WeakMap<ExternalRequestEvidence, Readonly<Record<string, unknown>>>();
export function captureExternalRequestEvidence(value: unknown): ExternalRequestEvidence {
  const snapshot = snapshotJudgmentInput(value);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('External evidence must be owned data');
  const token: ExternalRequestEvidence = Object.freeze({ [brand]: true as const });
  owned.set(token, snapshot as Readonly<Record<string, unknown>>);
  return token;
}
export function readExternalRequestEvidence(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const snapshot = typeof value === 'object' && value !== null ? owned.get(value as ExternalRequestEvidence) : undefined;
  if (!snapshot) throw new Error('External evidence requires an authenticated adapter snapshot');
  return snapshot;
}
