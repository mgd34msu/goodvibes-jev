import type { JsonValue } from '@goodvibes-jev/judgment';
/** Request-local references are mapped to exact records only by the preparing caller. */
export interface AnswerObjectCandidate {
  readonly reference: string;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly aliases: readonly string[];
  readonly content: Readonly<Record<string, JsonValue>>;
  readonly associations: readonly { readonly origin: 'caller-context' | 'evidence' | 'fact' | 'graph';
    readonly reference?: string | undefined; readonly relation?: string | undefined }[];
}
export interface AnswerObjectAlignmentInput { readonly query: string; readonly candidates: readonly AnswerObjectCandidate[]; }
export interface AnswerObjectBoolean { readonly probability: number; readonly verdict: 'yes' | 'no'; readonly outcome: 'act'; }
export interface AnswerObjectReading {
  readonly reference: string;
  readonly concreteObject: AnswerObjectBoolean;
  readonly integrationObject: AnswerObjectBoolean;
  readonly aligned: AnswerObjectBoolean;
  readonly selected: boolean;
  readonly decisionId?: string | undefined;
}
export interface AnswerObjectAlignmentPlan {
  readonly inputHash: string;
  readonly integrationIntent?: AnswerObjectBoolean | undefined;
  readonly accepted: readonly AnswerObjectReading[];
  readonly rejected: readonly AnswerObjectReading[];
  readonly model?: string | undefined;
  readonly requestedModel?: string | undefined;
}
export type AnswerObjectHoldReason = 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeAnswerObjectAlignmentHeldError extends Error {
  override readonly name = 'KnowledgeAnswerObjectAlignmentHeldError';
  constructor(readonly reason: AnswerObjectHoldReason) {
    super(`Knowledge answer object alignment held (${reason}); no linked-object selection was authorized.`);
  }
}
export const ANSWER_OBJECT_LIMITS = Object.freeze({ candidates: 100, selected: 24, associations: 400,
  characters: 160_000, concurrency: 4, defaultTimeoutMs: 30_000, timeoutMs: 60_000 });
