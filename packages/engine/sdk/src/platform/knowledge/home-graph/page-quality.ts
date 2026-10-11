import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { createKnowledgeFactQualityReader, isKnowledgePageFactCandidate } from '../semantic/fact-quality.js';
import type { KnowledgeStore } from '../store.js';
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

/** Structural discovery only; semantic consumption requires a prepared reader. */
export function isHomeGraphPageFactCandidate(fact: KnowledgeNodeRecord): boolean {
  return isKnowledgePageFactCandidate(fact, { rejectRemoteAccessoryDetails: true });
}

const homeGraphFactPlans = new WeakSet<object>();

export function createHomeGraphPageFactReader(
  store: KnowledgeStore,
  options: Parameters<typeof createKnowledgeFactQualityReader>[1],
) {
  const reader = createKnowledgeFactQualityReader(store, { ...options, purpose: 'knowledge-page', rejectRemoteAccessoryDetails: true });
  return {
    assertCurrent: reader.assertCurrent,
    async prepare(candidates: readonly KnowledgeNodeRecord[]) {
      const plan = await reader.prepare(candidates);
      homeGraphFactPlans.add(plan);
      return plan;
    },
  };
}
export type HomeGraphPageFactReader = ReturnType<typeof createHomeGraphPageFactReader>;
export type HomeGraphPageFactPlan = Awaited<ReturnType<HomeGraphPageFactReader['prepare']>>;

/** A raw predicate or a repair-only plan cannot authorize Home Graph rendering. */
export function assertHomeGraphPageFactPlan(plan: HomeGraphPageFactPlan): void {
  if (!homeGraphFactPlans.has(plan)) throw new TypeError('Home Graph rendering requires a prepared page fact quality plan.');
  plan.assertCurrent();
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
