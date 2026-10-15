/** Only request-local references cross the judgment boundary. */
export interface AnswerExcerptDocument {
  readonly reference: string;
  readonly kind: 'source-summary' | 'source-description' | 'extraction';
  readonly text: string;
}
export interface AnswerExcerptInput {
  readonly reference: string;
  readonly query: string;
  readonly source: { readonly title: string; readonly sourceType: string; readonly uri: string };
  /** Complete projected claims/subject context, never database keys or authority. */
  readonly context: string;
  readonly documents: readonly AnswerExcerptDocument[];
}
export interface AnswerExcerptSpan {
  readonly reference: string;
  readonly document: string;
  /** Half-open UTF-16 offsets into the exact original document string. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
/** A structural bundle can retain labels or exceptions stored in another exact field. */
export interface AnswerExcerptCandidate {
  readonly reference: string;
  readonly text: string;
  readonly spans: readonly AnswerExcerptSpan[];
}
export interface AnswerExcerptSelection {
  readonly reference: string;
  readonly spans: readonly AnswerExcerptSpan[];
}
export type AnswerExcerptHoldReason = 'unconfigured' | 'unavailable' | 'unsettled' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeAnswerExcerptHeldError extends Error {
  override readonly name = 'KnowledgeAnswerExcerptHeldError';
  constructor(readonly reason: AnswerExcerptHoldReason) {
    super(`Knowledge answer excerpts held (${reason}); no partial selection was authorized.`);
  }
}
export const ANSWER_EXCERPT_LIMITS = Object.freeze({ inputs: Number.POSITIVE_INFINITY, documents: Number.POSITIVE_INFINITY, characters: Number.POSITIVE_INFINITY,
  candidates: Number.POSITIVE_INFINITY, requests: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY, concurrency: 4, defaultTimeoutMs: 0, timeoutMs: 2_147_483_647 });
