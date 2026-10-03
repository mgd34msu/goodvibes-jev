/** A host-owned, immutable version reference. Its shape is not proof of authority. */
export interface JevVersionRef {
  readonly id: string;
  readonly revision: string;
}

/** Every identity whose change invalidates a semantic decision. */
export interface JevDecisionBinding {
  readonly sourceId: string;
  readonly inputRevision: string;
  readonly actionId: string;
  readonly actionRevision: string;
  readonly authorityId: string;
  readonly authorityRevision: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
}

/** Offered by the host; Jev chooses the next step, never arbitrary executable prose. */
export interface JevContinuation extends JevVersionRef {
  readonly kind: 'reconsider' | 'gather-evidence' | 'revise-action';
}

interface JevDecisionRecord {
  readonly schemaVersion: 1;
  /** Assigned by the host for this semantic decision, not supplied as authority by a model. */
  readonly decisionId: string;
  readonly binding: JevDecisionBinding;
  /** Real recorded Jev calls supporting this decision, validated against the host's records. */
  readonly judgmentDecisionIds: readonly string[];
  /** References to evidence captured for this exact input/action/authority/scope snapshot. */
  readonly evidence: readonly JevVersionRef[];
  /** Informational only. Must never be parsed as instructions, credentials or approval. */
  readonly summary: string;
}

/**
 * Semantic outcomes only. Transport waiting/retries are not a decision.
 * An act decision is an execution candidate, never a grant of authority.
 */
export type JevDecision = JevDecisionRecord & (
  | { readonly outcome: 'act' }
  | { readonly outcome: 'revise'; readonly next: JevContinuation }
  | { readonly outcome: 'defer'; readonly until: JevVersionRef }
  | { readonly outcome: 'reject' }
);

/**
 * Trusted host context, built from the actual input, call records and registries.
 * Never populate it by echoing the model's response. Rebuild from live authority
 * immediately before execution; revision changes invalidate the old decision.
 */
export interface JevDecisionContext {
  readonly decisionId: string;
  readonly binding: JevDecisionBinding;
  readonly judgmentDecisionIds: readonly string[];
  readonly evidence: readonly JevVersionRef[];
  readonly continuations: readonly JevContinuation[];
  readonly resumeConditions: readonly JevVersionRef[];
}
