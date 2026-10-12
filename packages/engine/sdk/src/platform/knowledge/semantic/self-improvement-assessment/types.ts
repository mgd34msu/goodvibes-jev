import type { JsonValue } from '@goodvibes-jev/judgment';

export interface SelfImprovementAssessmentInput {
  readonly query: string;
  readonly requestedScope?: { readonly fullProfileRequired: boolean } | undefined;
  readonly subjects: readonly { readonly title: string; readonly kind: string; readonly aliases: readonly string[];
    readonly summary?: string | undefined; readonly identity: Readonly<Record<string, string>>;
    readonly content: Readonly<Record<string, JsonValue>> }[];
  readonly facts: readonly { readonly title: string; readonly kind: string; readonly aliases: readonly string[];
    readonly summary?: string | undefined; readonly content: Readonly<Record<string, JsonValue>> }[];
  readonly evidence: readonly { readonly source: Readonly<Record<string, JsonValue>>;
    readonly extraction?: Readonly<Record<string, JsonValue>> | undefined; readonly text: string }[];
  readonly objectProfiles: readonly { readonly id: string; readonly subjectKinds: readonly string[];
    readonly intrinsicFactKinds?: readonly string[] | undefined; readonly suppressedGapKinds?: readonly string[] | undefined;
    readonly searchHints?: readonly string[] | undefined }[];
}
export interface SelfImprovementAssessmentOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export type SelfImprovementAssessment =
  | { readonly kind: 'context'; readonly applicable: boolean; readonly concrete: boolean; readonly assertCurrent: () => void }
  | { readonly kind: 'coverage'; readonly sufficient: boolean; readonly assertCurrent: () => void };
export class KnowledgeSelfImprovementAssessmentHeldError extends Error {
  override readonly name = 'KnowledgeSelfImprovementAssessmentHeldError';
  constructor(readonly reason: 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale' | 'foreign-space') {
    super(`Knowledge self-improvement assessment held (${reason}); no gap decision was authorized.`);
  }
}
export const SELF_IMPROVEMENT_ASSESSMENT_LIMITS = Object.freeze({
  subjects: 100, facts: 100, sources: 100, profiles: 100, characters: 160_000, bytes: 16_000_000,
  defaultTimeoutMs: 30_000, timeoutMs: 60_000,
});
