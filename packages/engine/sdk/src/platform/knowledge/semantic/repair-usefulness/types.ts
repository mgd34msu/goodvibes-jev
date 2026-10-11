export interface RepairFactUsefulnessInput {
  /** Operation-local label. Store identifiers stay with the caller. */
  readonly reference: string;
  /** Present only for the separately registered page-quality rubric. */
  readonly pagePolicy?: { readonly rejectRemoteAccessoryDetails: boolean } | undefined;
  readonly query: string;
  readonly subjects: readonly {
    readonly title: string;
    readonly kind?: string | undefined;
    readonly aliases?: readonly string[] | undefined;
    readonly identity?: Readonly<Record<string, string>> | undefined;
  }[];
  readonly fact: {
    readonly title: string;
    readonly kind: string;
    readonly summary?: string | undefined;
    readonly value?: unknown;
    readonly evidence?: unknown;
    readonly subject?: unknown;
    readonly labels?: readonly string[] | undefined;
    readonly aliases: readonly string[];
  };
  readonly evidence: readonly {
    readonly source: {
      readonly title?: string | undefined;
      readonly sourceType: string;
      readonly url?: string | undefined;
      readonly sourceUri?: string | undefined;
      readonly canonicalUri?: string | undefined;
    };
    readonly extraction?: { readonly format: string; readonly title?: string | undefined } | undefined;
    readonly text: string;
  }[];
}

export interface RepairFactUsefulnessReading {
  readonly reference: string;
  readonly useful: boolean;
  readonly probability: number;
}
export interface RepairFactUsefulnessOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}
export type RepairFactUsefulnessHoldReason = 'unconfigured' | 'unavailable' | 'uncertain' | 'not-useful' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeRepairFactUsefulnessHeldError extends Error {
  override readonly name = 'KnowledgeRepairFactUsefulnessHeldError';
  constructor(readonly reason: RepairFactUsefulnessHoldReason) {
    super(`Knowledge repair fact usefulness held (${reason}); no partial reading was authorized.`);
  }
}
export const REPAIR_FACT_USEFULNESS_LIMITS = Object.freeze({
  inputs: 100, characters: 160_000, requests: 100, bytes: 16_000_000,
  concurrency: 4, defaultTimeoutMs: 30_000, timeoutMs: 60_000,
});
