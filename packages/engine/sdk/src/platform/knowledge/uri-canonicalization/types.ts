export type KnowledgeUriHoldReason = 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeUriCanonicalizationHeldError extends Error {
  override readonly name = 'KnowledgeUriCanonicalizationHeldError';
  constructor(readonly reason: KnowledgeUriHoldReason) {
    super(`Knowledge URI canonicalization held (${reason}); no source identity or link was authorized.`);
  }
}
export interface KnowledgeUriOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly timeoutMs?: number | undefined;
}
export interface KnowledgeUriCanonicalizer {
  readonly assertCurrent: () => void;
  readonly canonicalize: (input: string) => Promise<string | null>;
  readonly canonicalizeAll: (inputs: readonly string[]) => Promise<readonly (string | null)[]>;
}
export const KNOWLEDGE_URI_LIMITS = Object.freeze({ inputs: 1000, characters: 160_000, requests: 256,
  bytes: 8_000_000, concurrency: 4, defaultTimeoutMs: 30_000, timeoutMs: 60_000 });
