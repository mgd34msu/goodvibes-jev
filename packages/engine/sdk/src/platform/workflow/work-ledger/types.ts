import { nativeConversationContinuationSchema } from './native-continuation-context.js';
import { array, discriminatedUnion, enum as enumSchema, literal, number, strictObject, string, union, unknown as unknownSchema, type z } from 'zod/v4';
import { nativeConversationSpanSchema, nativeConversationProposalRevision, validateNativeConversationProposal } from './native-intake-types.js';
import { NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES } from './native-submission-wire.js';
import { LEGACY_IMPORT_MAX_BYTES, validateLegacyWorkLedgerManifest, type LegacyMigrationManifest } from './legacy-import.js';

const id = string().min(1).max(200);
const text = string().trim().min(1).max(20_000);
/** Requirements are immutable source text; validate without normalization. */
export const workLedgerSemanticTextSchema = string().min(1).max(20_000).refine(value => value.trim().length > 0, 'Text must contain non-whitespace characters');
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stamp = number().int().nonnegative();

/** Identity is supplied by the authenticated host, never parsed from a command. */
export interface WorkLedgerHostIdentity {
  readonly actorId: string;
  readonly projectId: string;
  readonly role: 'coordinator' | 'worker' | 'verifier';
}

export const evidenceTargetSchema = strictObject({
  workId: id,
  workRevision: revision,
  criteriaRevision: revision,
  attemptId: id,
  attemptRevision: revision,
});
export type WorkEvidenceTarget = z.infer<typeof evidenceTargetSchema>;

export const evidenceReferenceSchema = strictObject({
  kind: enumSchema(['decision', 'artifact', 'test', 'commit']),
  ref: text,
  /** Content identity, when the host can supply it; a URI alone is not content. */
  digest: string().min(1).max(200).optional(),
});
export type WorkEvidenceReference = z.infer<typeof evidenceReferenceSchema>;

const reportedState = enumSchema(['pending', 'in_progress', 'blocked', 'complete', 'cancelled']);
export type WorkReportedState = z.infer<typeof reportedState>;
export type WorkVerificationState = 'unverified' | 'verified' | 'failed' | 'unavailable' | 'stale';

export const workLedgerExplicitSourceSchema = strictObject({
  version: literal(1),
  sourceId: id,
  sourceRevision: id,
  inputId: id,
  sessionId: id,
});
export const workLedgerExtractedSourceSchema = strictObject({
  version: literal(2), sourceId: id, sourceRevision: id, inputId: id, sessionId: id,
  continuation: nativeConversationContinuationSchema.optional(),
  extraction: strictObject({
    version: literal(1), offsetEncoding: literal('utf16'),
    spans: array(nativeConversationSpanSchema).min(1).max(100),
    proposalRevision: id, admissionDecisionId: id, judgmentDecisionIds: array(id).min(1).max(128),
  }),
});
export const workLedgerSourceSchema = union([workLedgerExplicitSourceSchema, workLedgerExtractedSourceSchema]);
export type WorkLedgerSource = z.infer<typeof workLedgerSourceSchema>;

export const ledgerWorkSchema = strictObject({
  id,
  title: text,
  goal: workLedgerSemanticTextSchema,
  criteria: array(workLedgerSemanticTextSchema).min(1).max(100),
  /** No explicit-submission provenance; migration creates no authority. */
  source: workLedgerSourceSchema.nullable(),
  revision,
  criteriaRevision: revision,
  reportedState,
  currentAttemptId: id.nullable(),
  createdAt: stamp,
  updatedAt: stamp,
});
export type LedgerWork = z.infer<typeof ledgerWorkSchema>;

export const ledgerAttemptSchema = strictObject({
  id,
  workId: id,
  predecessorId: id.nullable(),
  ownerId: id,
  revision,
  state: enumSchema(['active', 'complete', 'released', 'cancelled']),
  report: text.nullable(),
  blocker: text.nullable(),
  createdAt: stamp,
  updatedAt: stamp,
});
export type LedgerAttempt = z.infer<typeof ledgerAttemptSchema>;

export const criterionResultSchema = strictObject({
  criterionIndex: revision,
  status: enumSchema(['satisfied', 'unsatisfied', 'unknown']),
  references: array(text).max(100),
});

export const ledgerEvidenceSchema = strictObject({
  id,
  target: evidenceTargetSchema,
  outcome: enumSchema(['verified', 'failed', 'unavailable']),
  reason: text,
  references: array(evidenceReferenceSchema).max(100),
  source: enumSchema(['host_check', 'judgment']),
  criteriaResults: array(criterionResultSchema).max(100),
  actorId: id,
  at: stamp,
});
export type LedgerEvidence = z.infer<typeof ledgerEvidenceSchema>;

export const legacyWorkLedgerManifestSchema = unknownSchema().superRefine((input, context) => {
  try { validateLegacyWorkLedgerManifest(input); } catch {
    context.addIssue({ code: 'custom', message: 'Invalid or oversized legacy import manifest' });
  }
}) as unknown as z.ZodType<LegacyMigrationManifest>;


const envelope = { requestId: id, expectedRevision: revision };
const workEnvelope = { ...envelope, workId: id };
const commandSchemas = [
  strictObject({ type: literal('import_legacy'), ...envelope, manifest: legacyWorkLedgerManifestSchema }),
  strictObject({ type: literal('create'), ...envelope, title: text, goal: workLedgerSemanticTextSchema, criteria: array(workLedgerSemanticTextSchema).min(1).max(100) }),
  strictObject({ type: literal('revise'), ...workEnvelope, title: text, goal: workLedgerSemanticTextSchema, criteria: array(workLedgerSemanticTextSchema).min(1).max(100) }),
  strictObject({ type: literal('claim'), ...workEnvelope }),
  strictObject({ type: literal('report'), ...workEnvelope, attemptId: id, state: enumSchema(['in_progress', 'blocked', 'complete']), report: text, blocker: text.optional() }),
  strictObject({ type: literal('release'), ...workEnvelope, attemptId: id, reason: text }),
  strictObject({ type: literal('handoff'), ...workEnvelope, attemptId: id, targetActorId: id, reason: text }),
  strictObject({ type: literal('cancel'), ...workEnvelope, reason: text }),
  strictObject({ type: literal('reopen'), ...workEnvelope, reason: text }),
  strictObject({ type: literal('record_evidence'), ...envelope, target: evidenceTargetSchema, outcome: enumSchema(['verified', 'failed', 'unavailable']), reason: text, references: array(evidenceReferenceSchema).max(100), source: ledgerEvidenceSchema.shape.source, criteriaResults: ledgerEvidenceSchema.shape.criteriaResults }),
] as const;
export const workLedgerCommandSchema = discriminatedUnion('type', [
  ...commandSchemas,
  strictObject({ type: literal('submit_native'), ...envelope, title: text, goal: workLedgerSemanticTextSchema, criteria: array(workLedgerSemanticTextSchema).min(1).max(100), source: workLedgerSourceSchema }),
]).superRefine((command, context) => {
  if (command.type === 'import_legacy' && new TextEncoder().encode(JSON.stringify(command)).byteLength > LEGACY_IMPORT_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: 'Complete import command exceeds 256 KiB' });
  }
  if (command.type === 'submit_native') {
    if (command.source.version === 2) {
      try {
        const proposal = validateNativeConversationProposal({ sourceRevision: command.source.sourceRevision, spans: command.source.extraction.spans }, command.goal, command.source.sourceRevision);
        const extraction = command.source.extraction;
        if (nativeConversationProposalRevision(proposal) !== extraction.proposalRevision
          || new Set(extraction.judgmentDecisionIds).size !== extraction.judgmentDecisionIds.length
          || JSON.stringify(proposal.spans.map(span => command.goal.slice(span.start, span.end))) !== JSON.stringify(command.criteria)) throw new Error();
      } catch { context.addIssue({ code: 'custom', message: 'Extracted native source does not match its exact input ranges' }); }
    }
    // Match the explicit input boundary; individually bounded host metadata and
    // display text must not consume the caller's accepted source-text budget.
    const input = { requestId: command.requestId, inputId: command.source.inputId, expectedRevision: command.expectedRevision, goal: command.goal, criteria: command.criteria };
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES) {
      context.addIssue({ code: 'custom', message: 'Native submission input exceeds 256 KiB' });
    }
  }
});
export type WorkLedgerCommand = z.infer<typeof workLedgerCommandSchema>;
export type WorkLedgerAction = WorkLedgerCommand['type'];

const ordinaryLedgerEventSchema = strictObject({
  sequence: revision,
  type: enumSchema(['create', 'submit_native', 'revise', 'claim', 'report', 'release', 'handoff', 'cancel', 'reopen', 'record_evidence']),
  actorId: id,
  requestId: id,
  workId: id,
  attemptId: id.nullable(),
  at: stamp,
  /** Full changed records make old criteria, ownership and reports inspectable. */
  work: ledgerWorkSchema,
  attempts: array(ledgerAttemptSchema),
  evidence: ledgerEvidenceSchema.nullable(),
  reason: text.nullable(),
});
export const ledgerImportEventSchema = strictObject({
  sequence: revision, type: literal('import_legacy'), actorId: id, requestId: id, at: stamp,
  manifest: legacyWorkLedgerManifestSchema, works: array(ledgerWorkSchema).max(5000),
});
export const ledgerEventSchema = union([ordinaryLedgerEventSchema, ledgerImportEventSchema]);
export type WorkLedgerEvent = z.infer<typeof ledgerEventSchema>;
/** Immutable original submission image for trusted host reconciliation. */
export type WorkLedgerSubmission = Exclude<WorkLedgerEvent, { type: 'import_legacy' }> & {
  readonly type: 'submit_native';
  readonly work: LedgerWork & { readonly source: WorkLedgerSource };
  readonly attemptId: string;
  readonly attempts: [LedgerAttempt];
};
/** Permission-aware public history, preserving cursor continuity without disclosing raw sources. */
export const workLedgerReadEventSchema = union([ordinaryLedgerEventSchema,
  ledgerImportEventSchema.extend({ manifest: legacyWorkLedgerManifestSchema.nullable(), provenance: literal('requires_read_knowledge').optional() }),
]);
export type WorkLedgerReadEvent = z.infer<typeof workLedgerReadEventSchema>;
/** Generic ledger readership never grants access to a captured hosted transcript. */
export function projectWorkLedgerReadWork(work: LedgerWork): LedgerWork {
  if (work.source?.version !== 2 || !work.source.continuation) return work;
  const { continuation: _privateContext, ...source } = work.source;
  return { ...work, source };
}
export function projectWorkLedgerReadEvent(event: WorkLedgerEvent | WorkLedgerReadEvent, allowLegacyProvenance: boolean): WorkLedgerReadEvent {
  if (event.type !== 'import_legacy') return { ...event, work: projectWorkLedgerReadWork(event.work) };
  const works = event.works.map(projectWorkLedgerReadWork);
  if (allowLegacyProvenance) return { ...event, works };
  return { type: event.type, sequence: event.sequence, actorId: event.actorId, requestId: event.requestId, at: event.at,
    works, manifest: null, provenance: 'requires_read_knowledge' };
}

const receiptSchema = strictObject({
  actorId: id,
  requestId: id,
  signature: string(),
  event: ledgerEventSchema,
});

/** Serializable host-owned state. This core creates no database or file. */
export const workLedgerStateSchema = strictObject({
  version: literal(2),
  projectId: id,
  revision,
  works: array(ledgerWorkSchema),
  attempts: array(ledgerAttemptSchema),
  evidence: array(ledgerEvidenceSchema),
  history: array(ledgerEventSchema),
  receipts: array(receiptSchema),
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
  | 'stale_source' | 'not_found' | 'invalid_transition' | 'request_conflict'
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
/** Available only inside the owning store's durable transaction. No cache reads. */
export interface WorkLedgerTransactionContext {
  readSource(id: string): { readonly source: unknown; readonly generation: string | null };
}
export interface WorkLedgerStorage {
  read(): Promise<unknown>;
  transaction<T>(decide: (current: unknown, context?: WorkLedgerTransactionContext) => WorkLedgerDecision<T>): Promise<T>;
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
  /** Actor-scoped persisted submission receipt; no execution or capability is returned. */
  lookupSubmission(requestId: string, actor: WorkLedgerActor): Promise<WorkLedgerSubmission | null>;
  /** Delta notification; readSnapshot is the authoritative initial view. */
  subscribe(actor: WorkLedgerActor, listener: (snapshot: WorkLedgerSnapshot) => void): () => void;
  execute(command: unknown, trustedHostActor: WorkLedgerActor, options?: { readonly signal?: AbortSignal | undefined; readonly isAuthorized?: (() => boolean) | undefined }): Promise<WorkLedgerResult>;
  /** Stop new admissions and notifications; drain already admitted commands. */
  close(): Promise<void>;
}

/** Keep in trusted host composition; never expose to editable product data. */
export interface WorkLedgerAuthority {
  issueActor(identity: WorkLedgerHostIdentity): WorkLedgerActor;
  revokeActor(actor: WorkLedgerActor): void;
}
