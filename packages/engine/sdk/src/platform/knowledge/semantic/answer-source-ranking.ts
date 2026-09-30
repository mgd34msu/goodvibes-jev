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
export async function rankAnswerSources(
  evidence: readonly AnswerSourceRankingEvidence[],
  facts: readonly KnowledgeNodeRecord[],
  query: string,
): Promise<KnowledgeSourceRecord[]> {
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
  const result = await answerSourceRerank.rerank(port, query, candidates, { site: 'engine.knowledge.answer-source-rank' });
  for (const item of result.ranked) if (item.decisionId !== undefined) port.recorder?.recordAction(item.decisionId, item.reading.verdict === 'yes' && item.reading.outcome === 'act' ? 'selected: query-supporting source' : `not selected: ${item.reading.verdict} (${item.reading.outcome})`);
  const accepted = result.ranked.filter((item) => item.reading.verdict === 'yes' && item.reading.outcome === 'act');
  if (accepted.length === 0 && result.ranked.some((item) => item.reading.outcome !== 'act')) throw new KnowledgeSourceRankingHeldError();
  const byId = new Map(shortlist.map((source) => [source.id, source]));
  return accepted.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)).map((item) => byId.get(item.id)!);
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

export function sourceAuthorityBoostForAnswer(source: KnowledgeSourceRecord): number {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const text = [
    readString(discovery.trustReason),
    readString(discovery.sourceDomain),
    source.title,
    source.summary,
    source.description,
    source.url,
    source.sourceUri,
    source.canonicalUri,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\bofficial-vendor-domain\b/.test(text)) return 140;
  if (/\bofficial\b/.test(text) && /\b(support|specifications?|manual|product|docs?|datasheet)\b/.test(text) && !isCommercialLowValueSourceText(text)) return 120;
  if (/\bmanufacturer-domain\b/.test(text)) return 80;
  return 0;
}

function isCommercialLowValueSourceText(text: string): boolean {
  return /\b(shopping|shop now|affiliate|associate program|buy now|add to cart|price comparison|marketplace|retailer|store listing|seller listing|sponsored listing|latest price|compare prices)\b/.test(text)
    || /(^|\.)amazon\.[a-z.]+\b|(^|\.)ebay\.[a-z.]+\b|(^|\.)walmart\.[a-z.]+\b|(^|\.)bestbuy\.[a-z.]+\b|(^|\.)target\.[a-z.]+\b/.test(text);
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
