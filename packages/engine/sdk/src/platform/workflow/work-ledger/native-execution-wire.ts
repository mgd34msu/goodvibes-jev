/** Transport-only projection. Never import host execution or authority modules here. */
import { boolean, union, enum as enumSchema, literal, number, strictObject, string, type z } from 'zod/v4';
import { CONTRACT_STATUSES } from '../../../events/contract.js';
import { contractIntegrationInspectionSchema } from '../../contract/integration-inspection-wire.js';

export const NATIVE_WORK_EXECUTION_MAX_REQUEST_BYTES = 4_096;
export const NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES = 16_384;

const id = string().min(1).max(200);
const count = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Selected host identity only; this grants no execution eligibility or authority. */
export const nativeWorkLedgerProjectSchema = strictObject({ projectId: id });

export const nativeWorkExecutionRevisionSchema = strictObject({
  work: count, criteria: count, attempt: count,
});

/** An existing attempt, never a request to mint an attempt or select host authority. */
export const nativeWorkExecutionIdentitySchema = strictObject({
  workId: id, attemptId: id, expectedRevision: nativeWorkExecutionRevisionSchema,
});

export const nativeWorkExecutionRequestSchema = strictObject({
  projectId: id, ...nativeWorkExecutionIdentitySchema.shape,
});

const observation = {
  ...nativeWorkExecutionRequestSchema.shape,
  currentRevision: nativeWorkExecutionRevisionSchema.nullable(),
  currentAttempt: boolean(),
  stale: boolean(),
};
export const nativeWorkExecutionExecutionSnapshotSchema = strictObject({
  kind: literal('execution'), ...observation,
  state: enumSchema(['prepared', 'launch-claimed', 'cancelled']),
  recovery: enumSchema(['available', 'required', 'terminal', 'cancelled']),
  receipt: strictObject({ contractId: id, ownerAgentId: id }).nullable(),
  /** Optional for older hosts; current hosts always report availability explicitly. */
  integration: contractIntegrationInspectionSchema.optional(),
  settlement: strictObject({ state: enumSchema(['pending', 'required', 'failed', 'published']), evidenceId: id.optional(), reportSequence: count.optional(), evidenceSequence: count.optional() }).optional(),
  progress: strictObject({
    status: enumSchema(CONTRACT_STATUSES),
    sessionMode: boolean(),
    semanticState: enumSchema(['deciding', 'deferred', 'refused']).nullable(),
    stage: string().max(200).nullable(),
    retrying: boolean(),
    units: strictObject({ total: count, passed: count, failed: count }),
    criteria: strictObject({ total: count, met: count, unmet: count, unshown: count }),
  }).nullable(),
});

export const nativeWorkExecutionPendingIntentSnapshotSchema = strictObject({
  kind: literal('pending-intent'), ...observation,
  state: enumSchema(['admitting', 'refused']), recovery: enumSchema(['pending', 'required']),
});
export const nativeWorkExecutionPreventedSnapshotSchema = strictObject({
  kind: literal('prevented-before-admission'), ...observation,
  state: literal('cancelled'), recovery: literal('cancelled'),
});
/** Intent projections contain no receipt, decision or executable progress. */
export const nativeWorkExecutionSnapshotSchema = union([
  nativeWorkExecutionExecutionSnapshotSchema, nativeWorkExecutionPendingIntentSnapshotSchema, nativeWorkExecutionPreventedSnapshotSchema,
]);
export type NativeWorkExecutionExecutionSnapshot = z.infer<typeof nativeWorkExecutionExecutionSnapshotSchema>;
export type NativeWorkExecutionPendingIntentSnapshot = z.infer<typeof nativeWorkExecutionPendingIntentSnapshotSchema>;
export type NativeWorkExecutionPreventedSnapshot = z.infer<typeof nativeWorkExecutionPreventedSnapshotSchema>;

export type NativeWorkExecutionRevision = z.infer<typeof nativeWorkExecutionRevisionSchema>;
export type NativeWorkExecutionIdentity = z.infer<typeof nativeWorkExecutionIdentitySchema>;
export type NativeWorkExecutionRequest = z.infer<typeof nativeWorkExecutionRequestSchema>;
export type NativeWorkExecutionSnapshot = z.infer<typeof nativeWorkExecutionSnapshotSchema>;
