import { z } from 'zod/v4';

const id = z.string().min(1).max(200);
const text = z.string().trim().min(1).max(20_000);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stamp = z.number().int().nonnegative();

/** Identity is supplied by the authenticated host, never parsed from a command. */
export interface WorkLedgerHostIdentity {
  readonly actorId: string;
  readonly projectId: string;
  readonly role: 'coordinator' | 'worker' | 'verifier';
}

export const evidenceTargetSchema = z.strictObject({
  workId: id,
  workRevision: revision,
  criteriaRevision: revision,
  attemptId: id,
  attemptRevision: revision,
});
export type WorkEvidenceTarget = z.infer<typeof evidenceTargetSchema>;

export const evidenceReferenceSchema = z.strictObject({
  kind: z.enum(['decision', 'artifact', 'test', 'commit']),
  ref: text,
  /** Content identity, when the host can supply it; a URI alone is not content. */
  digest: z.string().min(1).max(200).optional(),
});
export type WorkEvidenceReference = z.infer<typeof evidenceReferenceSchema>;

const reportedState = z.enum(['pending', 'in_progress', 'blocked', 'complete', 'cancelled']);
export type WorkReportedState = z.infer<typeof reportedState>;
export type WorkVerificationState = 'unverified' | 'verified' | 'failed' | 'unavailable' | 'stale';

export const ledgerWorkSchema = z.strictObject({
  id,
  title: text,
  goal: text,
  criteria: z.array(text).min(1).max(100),
  revision,
  criteriaRevision: revision,
  reportedState,
  currentAttemptId: id.nullable(),
  createdAt: stamp,
  updatedAt: stamp,
});
export type LedgerWork = z.infer<typeof ledgerWorkSchema>;

export const ledgerAttemptSchema = z.strictObject({
  id,
  workId: id,
  predecessorId: id.nullable(),
  ownerId: id,
  revision,
  state: z.enum(['active', 'complete', 'released', 'cancelled']),
  report: text.nullable(),
  blocker: text.nullable(),
  createdAt: stamp,
  updatedAt: stamp,
});
export type LedgerAttempt = z.infer<typeof ledgerAttemptSchema>;

export const criterionResultSchema = z.strictObject({
  criterionIndex: revision,
  status: z.enum(['satisfied', 'unsatisfied', 'unknown']),
  references: z.array(text).max(100),
});

export const ledgerEvidenceSchema = z.strictObject({
  id,
  target: evidenceTargetSchema,
  outcome: z.enum(['verified', 'failed', 'unavailable']),
  reason: text,
  references: z.array(evidenceReferenceSchema).max(100),
  source: z.enum(['host_check', 'judgment']),
  criteriaResults: z.array(criterionResultSchema).max(100),
  actorId: id,
  at: stamp,
});
export type LedgerEvidence = z.infer<typeof ledgerEvidenceSchema>;

const envelope = { requestId: id, expectedRevision: revision };
const workEnvelope = { ...envelope, workId: id };
export const workLedgerCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('create'), ...envelope, title: text, goal: text, criteria: z.array(text).min(1).max(100) }),
  z.strictObject({ type: z.literal('revise'), ...workEnvelope, title: text, goal: text, criteria: z.array(text).min(1).max(100) }),
  z.strictObject({ type: z.literal('claim'), ...workEnvelope }),
  z.strictObject({ type: z.literal('report'), ...workEnvelope, attemptId: id, state: z.enum(['in_progress', 'blocked', 'complete']), report: text, blocker: text.optional() }),
  z.strictObject({ type: z.literal('release'), ...workEnvelope, attemptId: id, reason: text }),
  z.strictObject({ type: z.literal('handoff'), ...workEnvelope, attemptId: id, targetActorId: id, reason: text }),
  z.strictObject({ type: z.literal('cancel'), ...workEnvelope, reason: text }),
  z.strictObject({ type: z.literal('reopen'), ...workEnvelope, reason: text }),
  z.strictObject({ type: z.literal('record_evidence'), ...envelope, target: evidenceTargetSchema, outcome: z.enum(['verified', 'failed', 'unavailable']), reason: text, references: z.array(evidenceReferenceSchema).max(100), source: ledgerEvidenceSchema.shape.source, criteriaResults: ledgerEvidenceSchema.shape.criteriaResults }),
]);
export type WorkLedgerCommand = z.infer<typeof workLedgerCommandSchema>;
export type WorkLedgerAction = WorkLedgerCommand['type'];

export const ledgerEventSchema = z.strictObject({
  sequence: revision,
  type: z.enum(['create', 'revise', 'claim', 'report', 'release', 'handoff', 'cancel', 'reopen', 'record_evidence']),
  actorId: id,
  requestId: id,
  workId: id,
  attemptId: id.nullable(),
  at: stamp,
  /** Full changed records make old criteria, ownership and reports inspectable. */
  work: ledgerWorkSchema,
  attempts: z.array(ledgerAttemptSchema),
  evidence: ledgerEvidenceSchema.nullable(),
  reason: text.nullable(),
});
export type WorkLedgerEvent = z.infer<typeof ledgerEventSchema>;

const receiptSchema = z.strictObject({
  actorId: id,
  requestId: id,
  signature: z.string(),
  event: ledgerEventSchema,
});

/** Serializable host-owned state. This core creates no database or file. */
export const workLedgerStateSchema = z.strictObject({
  version: z.literal(1),
  projectId: id,
  revision,
  works: z.array(ledgerWorkSchema),
  attempts: z.array(ledgerAttemptSchema),
  evidence: z.array(ledgerEvidenceSchema),
  history: z.array(ledgerEventSchema),
  receipts: z.array(receiptSchema),
});
export type WorkLedgerState = z.infer<typeof workLedgerStateSchema>;

export interface WorkLedgerView {
  readonly work: LedgerWork;
  readonly attempt: LedgerAttempt | null;
  readonly verification: {
    readonly state: WorkVerificationState;
    readonly reason: string;
    readonly evidence: LedgerEvidence | null;
  };
  readonly attention: readonly { readonly kind: 'blocked' | 'verification'; readonly reason: string }[];
  /** Ledger edits available to this actor, NOT permission to run tools or code. */
  readonly allowedActions: readonly WorkLedgerAction[];
}

export interface WorkLedgerSnapshot {
  readonly projectId: string;
  readonly revision: number;
  readonly cursor: number;
  readonly works: readonly WorkLedgerView[];
}

/** Opaque capability; only this instance's trusted host authority can mint it. */
declare const actorBrand: unique symbol;
export interface WorkLedgerActor {
  readonly [actorBrand]: true;
}

export type WorkLedgerRejection =
  | 'invalid_command' | 'forbidden' | 'conflict' | 'stale_evidence'
  | 'not_found' | 'invalid_transition' | 'request_conflict'
  | 'cancelled' | 'closed' | 'invalid_state' | 'host_error';

export type WorkLedgerResult = {
  readonly kind: 'accepted';
  readonly replayed: boolean;
  readonly event: WorkLedgerEvent;
} | {
  readonly kind: 'rejected';
  readonly code: WorkLedgerRejection;
  readonly reason: string;
  /** Latest aggregate revision, when admission reached the authoritative store. */
  readonly revision: number | null;
} | {
  readonly kind: 'indeterminate';
  readonly requestId: string;
  readonly actorId: string;
  readonly reason: string;
};

export interface WorkLedgerDecision<T> {
  readonly next: WorkLedgerState | null;
  readonly value: T;
}

/**
 * Implement on the ONE authoritative host store; this core opens no files.
 * transaction serializes all writers and calls decide exactly once with current
 * state. The synchronous callback and commit decision are one linearization
 * point: no await, hook or other writer between callback and commit acceptance.
 * Reject async decision callbacks at runtime. Lock ownership remains with the
 * store until persistence finishes; callback invocation alone is NOT durable
 * success. Abort/revocation after acceptance does not roll back the command.
 * Resolve only after durable commit. On I/O failure throw; service returns an
 * indeterminate receipt identity, which must be reconciled via a later exact
 * retry against durable storage. Never turn postcommit notification/cleanup
 * failure into rollback or rejection. History and receipts commit
 * atomically with state. A read/rename JSON store does not satisfy this contract.
 * subscribe reports committed states in order, including other writers, and
 * must isolate callback failures from commits. It returns synchronous cleanup.
 * Notifications are best-effort wake-ups; use snapshot/history(cursor) after
 * reconnect, not delivery count. Cross-process auth must route through this
 * authority owner or enforce durable revocation epochs in the adapter.
 */
export interface WorkLedgerStorage {
  read(): Promise<unknown>;
  transaction<T>(decide: (current: unknown) => WorkLedgerDecision<T>): Promise<T>;
  subscribe(listener: (state: WorkLedgerState) => void): () => void;
}

export interface WorkLedgerClock {
  now(): number;
  /** Host-generated stable identity, never inferred from prose. */
  newId(kind: 'work' | 'attempt' | 'evidence'): string;
}

/** Stable error codes for read/history/subscription admission failures. */
export class WorkLedgerAccessError extends Error {
  constructor(readonly code: 'closed' | 'forbidden' | 'invalid_cursor' | 'invalid_state' | 'storage_error', message: string) {
    super(message);
    this.name = 'WorkLedgerAccessError';
  }
}

export interface WorkLedgerService {
  readSnapshot(actor: WorkLedgerActor): Promise<WorkLedgerSnapshot>;
  history(afterSequence: number, actor: WorkLedgerActor): Promise<readonly WorkLedgerEvent[]>;
  /** Delta notification; readSnapshot is the authoritative initial view. */
  subscribe(actor: WorkLedgerActor, listener: (snapshot: WorkLedgerSnapshot) => void): () => void;
  execute(command: unknown, trustedHostActor: WorkLedgerActor, options?: { readonly signal?: AbortSignal }): Promise<WorkLedgerResult>;
  /** Stop new admissions and notifications; drain already admitted commands. */
  close(): Promise<void>;
}

/** Keep in trusted host composition; never expose to editable product data. */
export interface WorkLedgerAuthority {
  issueActor(identity: WorkLedgerHostIdentity): WorkLedgerActor;
  revokeActor(actor: WorkLedgerActor): void;
}
