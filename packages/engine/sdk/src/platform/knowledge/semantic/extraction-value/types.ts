import type { sourceRankingContent } from '../answer-source-ranking.js';
import type { KnowledgeExtractionRecord } from '../../types.js';

export interface KnowledgeExtractionValueInput {
  readonly source: ReturnType<typeof sourceRankingContent>;
  readonly extraction: Pick<KnowledgeExtractionRecord, 'format' | 'title' | 'summary' | 'excerpt' | 'sections'>;
  readonly text: string;
}

export interface KnowledgeExtractionValueOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
  readonly timeoutMs?: number | undefined;
}

export type KnowledgeExtractionValueHoldReason = 'malformed' | 'budget' | 'aborted' | 'stale' | 'unconfigured' | 'unavailable' | 'uncertain';
export class KnowledgeExtractionValueHeldError extends Error {
  override readonly name = 'KnowledgeExtractionValueHeldError';
  constructor(readonly reason: KnowledgeExtractionValueHoldReason) {
    super(`Knowledge extraction value held (${reason}); no semantic extraction or write was authorized.`);
  }
}

export const EXTRACTION_VALUE_LIMITS = Object.freeze({ characters: 160_000, bytes: 800_000, timeoutMs: 20_000 });
