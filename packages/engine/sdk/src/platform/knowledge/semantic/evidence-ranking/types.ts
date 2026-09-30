/** Bookkeeping references are created by the caller; store identities stay in its local map. */
export interface AnswerEvidenceCandidate {
  readonly reference: string;
  readonly kind: 'source' | 'node';
  readonly title: string;
  readonly text: string;
  readonly sourceType?: string | undefined;
  readonly nodeKind?: string | undefined;
  readonly claimedProvenance?: string | undefined;
  readonly facts?: readonly { readonly title: string; readonly summary?: string | undefined;
    readonly value?: string | number | boolean | null | undefined; readonly evidence?: string | undefined }[] | undefined;
}
export interface AnswerEvidenceRelevanceInput { readonly query: string; readonly candidates: readonly AnswerEvidenceCandidate[]; }
export interface AnswerEvidenceRelevanceReading {
  readonly reference: string;
  /** Actual probability of relevance, never legacy retrieval points or answer confidence. */
  readonly probability: number;
  readonly verdict: 'yes' | 'no';
  readonly outcome: 'act';
  readonly decisionId?: string | undefined;
}
export interface AnswerEvidenceRelevancePlan {
  readonly inputHash: string;
  readonly accepted: readonly AnswerEvidenceRelevanceReading[];
  readonly rejected: readonly AnswerEvidenceRelevanceReading[];
  readonly model?: string | undefined;
  readonly requestedModel?: string | undefined;
}
export type EvidenceRelevanceHoldReason = 'unconfigured' | 'unavailable' | 'unsettled' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeEvidenceRelevanceHeldError extends Error {
  override readonly name = 'KnowledgeEvidenceRelevanceHeldError';
  constructor(readonly reason: EvidenceRelevanceHoldReason) {
    super(`Knowledge evidence relevance held (${reason}); no partial evidence selection was authorized.`);
  }
}
export const EVIDENCE_RELEVANCE_LIMITS = Object.freeze({ candidates: 100, facts: 100, characters: 160_000, concurrency: 4, defaultTimeoutMs: 30_000, timeoutMs: 60_000 });
