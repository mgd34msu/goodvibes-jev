export const NODE_ACTIVATION_LIMITS = Object.freeze({ nodes: Number.POSITIVE_INFINITY, sources: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY, concurrency: 4, timeoutMs: 2_147_483_647, defaultTimeoutMs: 0 });
export interface KnowledgeNodeActivationOptions {
  readonly signal?: AbortSignal | undefined;
  /** Retained caller authority, rechecked synchronously at every final commit. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly timeoutMs?: number | undefined;
  /** A composed serving pass cannot consume a pending draft as a successful claim. */
  readonly requireAccepted?: boolean | undefined;
}
export type NodeActivationReason = 'no' | 'uncertain' | 'unavailable' | 'unconfigured' | 'missing-evidence' | 'foreign-space' | 'budget' | 'aborted' | 'stale' | 'malformed' | 'observation-revalidation' | 'owner-confidence-floor' | 'replacement-requires-review';
export class KnowledgeNodeActivationHeldError extends Error {
  override readonly name = 'KnowledgeNodeActivationHeldError';
  constructor(readonly reason: NodeActivationReason) { super(`Knowledge node activation held: ${reason}.`); }
}
export interface NodeActivationReading {
  readonly outcome: 'accepted' | 'pending-review';
  readonly reason?: NodeActivationReason | undefined;
  readonly probability?: number | undefined;
  readonly decisionId?: string | undefined;
  readonly model?: string | undefined;
  readonly requestedModel?: string | undefined;
}
