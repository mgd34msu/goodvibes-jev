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
export const KNOWLEDGE_URI_LIMITS = Object.freeze({ inputs: Infinity, characters: Infinity, requests: Infinity,
  bytes: Infinity, concurrency: 4, defaultTimeoutMs: 0, timeoutMs: 2_147_483_647 });
