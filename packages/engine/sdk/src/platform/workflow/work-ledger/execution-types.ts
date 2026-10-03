import { z } from 'zod/v4';

/** Host-owned dispatch journal. Stored atomically in the existing ledger row. */
export const workExecutionSchema = z.strictObject({
  id: z.string().min(1).max(200),
  actorId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  target: z.strictObject({
    workId: z.string().min(1).max(200),
    workRevision: z.number().int().nonnegative(),
    criteriaRevision: z.number().int().nonnegative(),
    attemptId: z.string().min(1).max(200),
    attemptRevision: z.number().int().nonnegative(),
  }),
  goal: z.string().min(1).max(20_000),
  criteria: z.array(z.string().min(1).max(20_000)).min(1).max(100),
  /** The existing runner assigns this identity; the outbox never invents it. */
  contractId: z.string().regex(/^ctr-[a-f0-9]{8}$/).nullable(),
  runnerReceipt: z.json().optional(),
  runnerReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sessionId: z.string().min(1),
  projectRoot: z.string().min(1),
  /** Complete frozen input identity; never a prefix or model-supplied identifier. */
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'dispatching', 'running', 'settled', 'revising', 'deferred', 'rejected', 'cancelled', 'invalidated']),
  decisionIds: z.array(z.string().min(1)),
  /** Complete shared semantic receipts, oldest first; transport retries add none. */
  admissions: z.array(z.json()).default([]),
  reason: z.string(),
  /** A result is published only through the normal verifier service. */
  evidenceId: z.string().nullable(),
  /** Frozen publication material, saved before the atomic report/evidence commit. */
  publication: z.strictObject({
    expectedRevision: z.number().int().nonnegative(),
    report: z.string().min(1).max(20_000),
    attestation: z.json(),
  }).optional(),
});
export type WorkExecution = z.infer<typeof workExecutionSchema>;

/** Read-only product projection; no dispatch/publication material crosses it. */
export const workExecutionViewSchema = workExecutionSchema.pick({ id: true, contractId: true, target: true, status: true, reason: true, decisionIds: true, evidenceId: true });
export type WorkExecutionView = z.infer<typeof workExecutionViewSchema>;
