import { assertAnswerVerificationActive } from './answer-verification/budget.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { answerSourceRerank } from './ranking/source-rerank.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { readRecord, readString, readStringArray, uniqueStrings } from './utils.js';

export interface AnswerSourceRankingEvidence {
  readonly score: number;
  readonly excerpt?: string | undefined;
  readonly source?: KnowledgeSourceRecord | undefined;
}

/** A reading that cannot support an answer is held, never converted into a point fallback. */
export class KnowledgeSourceRankingHeldError extends Error {
  override readonly name = 'KnowledgeSourceRankingHeldError';
  constructor() { super('Knowledge source relevance did not settle; no source was selected.'); }
}

/** The caller supplies only sources inside its existing access/space filter. */
export async function readAnswerSourceRanking(
  evidence: readonly AnswerSourceRankingEvidence[],
  facts: readonly KnowledgeNodeRecord[],
  query: string,
  signal?: AbortSignal,
): Promise<Array<{ source: KnowledgeSourceRecord; probability: number }>> {
  assertAnswerVerificationActive(signal);
  const sources = uniqueSources(evidence.flatMap((item) => item.source ? [item.source] : []))
    .filter((source) => source.status !== 'failed' && source.status !== 'stale');
  const realSources = sources.filter((source) => !isGeneratedKnowledgeSource(source));
  // A request budget, not a quality threshold. Retrieval order chooses the window.
  const shortlist = (realSources.length > 0 ? realSources : sources).slice(0, 50);
  if (shortlist.length === 0) return [];
  const candidates = shortlist.map((source) => ({
    id: source.id,
    content: {
      ...sourceRankingContent(source),
      excerpts: evidence.filter((item) => item.source?.id === source.id && item.excerpt).map((item) => item.excerpt!),
      facts: facts.filter((fact) => fact.status !== 'stale' && uniqueStrings([
        ...readStringArray(fact.metadata.sourceIds), readString(fact.metadata.sourceId), fact.sourceId,
      ]).includes(source.id)).map((fact) => ({
        title: fact.title, summary: fact.summary ?? '',
        value: readString(fact.metadata.value) ?? '', evidence: readString(fact.metadata.evidence) ?? '',
      })),
    },
  }));
  // Preflight the complete selected batch before any concurrent request starts.
  assertJudgmentInput({ query, candidates: candidates.map((candidate) => candidate.content) });
  const port = judgmentPort('engine.knowledge.answer-source-rank');
  const result = await answerSourceRerank.rerank(port, query, candidates, { site: 'engine.knowledge.answer-source-rank', ...(signal ? { signal } : {}) });
  assertAnswerVerificationActive(signal);
  for (const item of result.ranked) if (item.decisionId !== undefined) port.recorder?.recordAction(item.decisionId, item.reading.verdict === 'yes' && item.reading.outcome === 'act' ? 'selected: query-supporting source' : `not selected: ${item.reading.verdict} (${item.reading.outcome})`);
  const accepted = result.ranked.filter((item) => item.reading.verdict === 'yes' && item.reading.outcome === 'act');
  if (accepted.length === 0 && result.ranked.some((item) => item.reading.outcome !== 'act')) throw new KnowledgeSourceRankingHeldError();
  const byId = new Map(shortlist.map((source) => [source.id, source]));
  return accepted.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)).map((item) => ({ source: byId.get(item.id)!, probability: item.probability }));
}

export async function rankAnswerSources(evidence: readonly AnswerSourceRankingEvidence[], facts: readonly KnowledgeNodeRecord[], query: string, signal?: AbortSignal): Promise<KnowledgeSourceRecord[]> {
  return (await readAnswerSourceRanking(evidence, facts, query, signal)).map((item) => item.source);
}

/** Minimal content/provenance evidence; no arbitrary metadata or numeric database dates. */
export function sourceRankingContent(source: KnowledgeSourceRecord) {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  return {
    title: source.title ?? '', summary: source.summary ?? '', description: source.description ?? '',
    uri: source.url ?? source.sourceUri ?? source.canonicalUri ?? '',
    sourceType: source.sourceType, status: source.status, trust: 'untrusted reference material',
    claimedProvenance: { reason: readString(discovery.trustReason) ?? '', domain: readString(discovery.sourceDomain) ?? '' },
  };
}

function uniqueSources(values: readonly KnowledgeSourceRecord[]): KnowledgeSourceRecord[] {
  const seen = new Set<string>();
  const result: KnowledgeSourceRecord[] = [];
  for (const source of values) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    result.push(source);
  }
  return result;
}
