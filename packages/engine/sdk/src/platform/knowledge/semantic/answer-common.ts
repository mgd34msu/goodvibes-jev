import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeSemanticLlm } from './types.js';

export interface KnowledgeAnswerContext {
  readonly store: KnowledgeStore;
  readonly llm?: KnowledgeSemanticLlm | null | undefined;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
}

export interface EvidenceItem {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly title: string;
  readonly score: number;
  /** Explicit units for initial relevance readings; never an answer-confidence score. */
  readonly scoreScale?: 'relevance-probability' | undefined;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly node?: KnowledgeNodeRecord | undefined;
  readonly excerpt?: string | undefined;
  readonly facts: readonly KnowledgeNodeRecord[];
}

export type AnswerFactRecord = KnowledgeNodeRecord & {
  readonly subject?: string | undefined;
  readonly subjectIds?: readonly string[] | undefined;
  readonly targetHints?: readonly Record<string, unknown>[] | undefined;
  readonly linkedObjectIds?: readonly string[] | undefined;
};

export function isBroadKnowledgeSpaceAlias(spaceId: string): boolean {
  return normalizeKnowledgeSpaceId(spaceId) === 'homeassistant';
}
