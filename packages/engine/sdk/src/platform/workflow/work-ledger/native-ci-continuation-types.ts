/** Durable evidence of a host transfer. Only the paired owner's private grant can authorize recovery. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import type { NativeContinuationGrant } from '../../pairing/pairing-token-store.js';
import type { DurableContractKey, DurableContractRequest } from '../../contract/durable-admission.js';
import type { NativeWorkExecutionTarget, NativeWorkExecutionTransaction } from './native-execution-types.js';
import type { CiWatchSubscription } from '../../ci-watch/types.js';

const id = z.string().min(1).max(256); const hash = z.string().regex(/^[0-9a-f]{64}$/); const revision = z.number().int().nonnegative();
const key = z.strictObject({ workId: id, criteriaId: id, criteriaRevision: id, attemptId: id });
const target = z.strictObject({ workId: id, workRevision: revision, criteriaRevision: revision, attemptId: id, attemptRevision: revision });
const issueSchema = z.strictObject({ projectId: id, originalKey: key, originalPayloadRevision: hash, ledgerSourceRevision: hash,
  principalId: id, authorityRevision: id, authorityScopes: z.array(id).min(1),
  scopeId: id, scopeRevision: id, policyRevision: hash, seedRevision: hash });
const watchSchema = z.strictObject({ id, repo: id, ref: id.optional(), prNumber: z.number().int().positive().optional(), deliveryChannel: id,
  triggerFixSession: z.boolean(), createdAt: z.number().finite(), updatedAt: z.number().finite(), continuationId: id.optional() });
const recordSchema = z.strictObject({ version: z.literal(1), id, issue: issueSchema,
  grant: z.strictObject({ id, binding: hash }), watch: watchSchema.nullable(), state: z.enum(['issued', 'claimed', 'cancelled']),
  failureRevision: hash.nullable(), successor: target.nullable() });
export type NativeCiContinuationIssue = z.infer<typeof issueSchema>;
export interface NativeCiContinuationRecord {
  readonly version: 1; readonly id: string; readonly issue: NativeCiContinuationIssue; readonly grant: NativeContinuationGrant;
  readonly watch: CiWatchSubscription | null; readonly state: 'issued' | 'claimed' | 'cancelled';
  readonly failureRevision: string | null; readonly successor: NativeWorkExecutionTarget | null;
}
export function nativeCiDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex'); }
export function nativeCiSourceBinding(projectId: string, request: Pick<DurableContractRequest, 'key' | 'binding' | 'input'>): string {
  const { authorityId, authorityRevision, scopeId, scopeRevision } = request.binding;
  return nativeCiDigest({ projectId, projectRoot: request.input.projectRoot, key: request.key, authorityId, authorityRevision, scopeId, scopeRevision });
}
export function nativeCiWatchIdentity(watch: CiWatchSubscription) {
  return { id: watch.id, repo: watch.repo, ...(watch.ref ? { ref: watch.ref } : {}), ...(watch.prNumber === undefined ? {} : { prNumber: watch.prNumber }),
    deliveryChannel: watch.deliveryChannel, triggerFixSession: watch.triggerFixSession, createdAt: watch.createdAt, updatedAt: watch.createdAt,
    ...(watch.continuationId ? { continuationId: watch.continuationId } : {}) };
}
export function parseNativeCiContinuation(value: unknown): NativeCiContinuationRecord {
  const row = recordSchema.parse(value);
  if (!isDeepStrictEqual(value, row) || row.id !== row.grant.id || row.grant.binding !== nativeCiDigest(row.issue)
    || (row.watch !== null && row.watch.continuationId !== row.id)
    || (row.state === 'issued' && (row.failureRevision !== null || row.successor !== null))
    || (row.state === 'claimed' && (row.failureRevision === null || row.successor === null))) throw new Error('Invalid native CI continuation');
  return row;
}
export interface NativeCiContinuationTransaction { readonly record: NativeCiContinuationRecord | null; readonly original: NativeWorkExecutionTransaction; }
export interface NativeCiContinuationStorage {
  current(id: string, originalKey?: DurableContractKey): NativeCiContinuationTransaction;
  transaction<T>(id: string, originalKey: DurableContractKey,
    decide: (current: NativeCiContinuationTransaction) => { readonly next: NativeCiContinuationRecord | null; readonly value: T },
    assertCurrent: () => void): Promise<T>;
  /** Claim and publish a successor in one ledger transaction. Replay returns exactly that successor. */
  claim(id: string, failureRevision: string, assertCurrent: (current: NativeCiContinuationTransaction) => void): Promise<NativeCiContinuationRecord>;
}
