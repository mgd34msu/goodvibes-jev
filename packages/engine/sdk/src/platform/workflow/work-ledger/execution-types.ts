import { array, enum as enumSchema, json, number, strictObject, string, type z } from 'zod/v4';

/** Host-owned dispatch journal. Stored atomically in the existing ledger row. */
export const workExecutionSchema = strictObject({
  id: string().min(1).max(200),
  actorId: string().min(1).max(200),
  projectId: string().min(1).max(200),
  target: strictObject({
    workId: string().min(1).max(200),
    workRevision: number().int().nonnegative(),
    criteriaRevision: number().int().nonnegative(),
    attemptId: string().min(1).max(200),
    attemptRevision: number().int().nonnegative(),
  }),
  goal: string().min(1).max(20_000),
  criteria: array(string().min(1).max(20_000)).min(1).max(100),
  /** The existing runner assigns this identity; the outbox never invents it. */
  contractId: string().regex(/^ctr-[a-f0-9]{8}$/).nullable(),
  runnerReceipt: json().optional(),
  runnerReceiptDigest: string().regex(/^[a-f0-9]{64}$/).optional(),
  sessionId: string().min(1),
  projectRoot: string().min(1),
  /** Complete frozen input identity; never a prefix or model-supplied identifier. */
  inputDigest: string().regex(/^[a-f0-9]{64}$/),
  status: enumSchema(['pending', 'dispatching', 'running', 'settled', 'revising', 'deferred', 'rejected', 'cancelled', 'invalidated']),
  decisionIds: array(string().min(1)),
  /** Complete shared semantic receipts, oldest first; transport retries add none. */
  admissions: array(json()).default([]),
  reason: string(),
  /** A result is published only through the normal verifier service. */
  evidenceId: string().nullable(),
  /** Frozen publication material, saved before the atomic report/evidence commit. */
  publication: strictObject({
    expectedRevision: number().int().nonnegative(),
    report: string().min(1).max(20_000),
    attestation: json(),
  }).optional(),
});
export type WorkExecution = z.infer<typeof workExecutionSchema>;

/** Read-only product projection; no dispatch/publication material crosses it. */
export const workExecutionViewSchema = workExecutionSchema.pick({ id: true, contractId: true, target: true, status: true, reason: true, decisionIds: true, evidenceId: true });
export type WorkExecutionView = z.infer<typeof workExecutionViewSchema>;
