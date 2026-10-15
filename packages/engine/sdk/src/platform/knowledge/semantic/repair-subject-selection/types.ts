export interface RepairSubjectSelectionInput {
  readonly reference: string;
  readonly query: string;
  readonly candidate: string;
  readonly candidates: readonly {
    readonly reference: string; readonly title: string; readonly kind: string;
    readonly summary?: string | undefined; readonly aliases: readonly string[];
    readonly identity: Readonly<Record<string, string>>;
  }[];
  readonly objectProfiles: readonly { readonly subjectKinds: readonly string[] }[];
}
export interface RepairSubjectSelectionReading {
  readonly reference: string; readonly selected: boolean; readonly probability: number;
}
export interface RepairSubjectSelectionOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export class KnowledgeRepairSubjectSelectionHeldError extends Error {
  override readonly name = 'KnowledgeRepairSubjectSelectionHeldError';
  constructor(readonly reason: 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale' | 'foreign-space') {
    super(`Knowledge repair subject selection held (${reason}); no selection was authorized.`);
  }
}
export const REPAIR_SUBJECT_SELECTION_LIMITS = Object.freeze({
  inputs: Number.POSITIVE_INFINITY, characters: Number.POSITIVE_INFINITY, requests: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY,
  concurrency: 4, defaultTimeoutMs: 0, timeoutMs: 2_147_483_647,
});
