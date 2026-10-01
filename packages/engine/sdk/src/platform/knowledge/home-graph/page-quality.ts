import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { isUsefulKnowledgePageFact } from '../semantic/fact-quality.js';
import {
  compareKnowledgePageSources,
  createKnowledgePageSourceReader,
  rankKnowledgePageSources,
  isUsefulKnowledgePageSource,
  isUsefulKnowledgePageSourceCandidate,
  knowledgePageSourceWeight,
  type KnowledgePageSourceQualityPolicy,
} from '../source-quality.js';
import { isGeneratedPageSource, mergeSourceStatus } from './helpers.js';

const HOME_GRAPH_PAGE_SOURCE_POLICY: KnowledgePageSourceQualityPolicy = {
  isGeneratedSource: isGeneratedPageSource,
  purpose: 'A grounded device/home-graph reference, including useful product documentation rather than a generic shopping or comparison listing',
};

export function isUsefulHomeGraphPageFact(fact: KnowledgeNodeRecord): boolean {
  return isUsefulKnowledgePageFact(fact, { rejectRemoteAccessoryDetails: true });
}

export function isUsefulHomeGraphPageSource(source: KnowledgeSourceRecord): Promise<boolean> {
  return isUsefulKnowledgePageSource(source, HOME_GRAPH_PAGE_SOURCE_POLICY);
}

export function isUsefulHomeGraphPageSourceCandidate(
  source: KnowledgeSourceRecord,
  existing?: KnowledgeSourceRecord,
): Promise<boolean> {
  const status = mergeSourceStatus(source.status, existing?.status);
  return isUsefulKnowledgePageSourceCandidate(source, existing, status, HOME_GRAPH_PAGE_SOURCE_POLICY);
}

export function compareHomeGraphPageSources(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord): Promise<number> {
  return compareKnowledgePageSources(left, right, HOME_GRAPH_PAGE_SOURCE_POLICY);
}

export function homeGraphPageSourceWeight(source: KnowledgeSourceRecord): Promise<number> {
  return knowledgePageSourceWeight(source, HOME_GRAPH_PAGE_SOURCE_POLICY);
}

export function createHomeGraphPageSourceReader(signal?: AbortSignal) {
  return createKnowledgePageSourceReader({ ...HOME_GRAPH_PAGE_SOURCE_POLICY, ...(signal ? { signal } : {}) });
}
export function rankHomeGraphPageSources(sources: readonly KnowledgeSourceRecord[]): Promise<KnowledgeSourceRecord[]> {
  return rankKnowledgePageSources(sources, HOME_GRAPH_PAGE_SOURCE_POLICY);
}

export type HomeGraphPageSourceReader = ReturnType<typeof createHomeGraphPageSourceReader>;
