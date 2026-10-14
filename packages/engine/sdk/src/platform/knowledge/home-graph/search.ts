import { mapLimit } from '@goodvibes-jev/judgment';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeEdgeRecord, KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { belongsToSpace, edgeIsActive, isGeneratedPageSource } from './helpers.js';
import { assertKnowledgeExtractionInput, knowledgeExtractionNeedsRefresh } from '../extraction-policy.js';
import { KnowledgeAnswerQualityHeldError } from '../semantic/answer-verification/types.js';
import { repairProfileSourceText, repairProfileSubject } from '../semantic/repair-profile.js';
import { readKnowledgeBattery, repairSourceRelevance } from '../semantic/repair-decisions.js';
import { buildSourceLinkIndex } from './source-links.js';
export interface HomeGraphSearchState {
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
}

export function readHomeGraphSearchState(store: KnowledgeStore, spaceId: string): HomeGraphSearchState {
  const sources = store.listSourcesInSpace(spaceId)
    .filter((source) => source.status !== 'stale' && !isGeneratedPageSource(source));
  const nodes = store.listNodesInSpace(spaceId).filter((node) => node.status === 'active');
  const sourceIds = new Set(sources.map((source) => source.id));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = store.listEdges().filter((edge) => (
    edgeIsActive(edge)
    && belongsToSpace(edge, spaceId)
    && (edge.fromKind !== 'source' || sourceIds.has(edge.fromId))
    && (edge.toKind !== 'source' || sourceIds.has(edge.toId))
    && (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
    && (edge.toKind !== 'node' || nodeIds.has(edge.toId))
  ));
  const extractionBySourceId = new Map<string, KnowledgeExtractionRecord>();
  for (const extraction of store.listExtractionsForSources(sourceIds)) {
    const source = sourcesById.get(extraction.sourceId);
    if (!source || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source)) {
      throw new KnowledgeAnswerQualityHeldError('malformed');
    }
    if (!extractionBySourceId.has(extraction.sourceId)) {
      extractionBySourceId.set(extraction.sourceId, extraction);
    }
  }
  return { spaceId, sources, nodes, edges, extractionBySourceId };
}

export async function selectHomeGraphExtractionRepairCandidates(
  query: string, sources: readonly KnowledgeSourceRecord[], nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[], extractionBySourceId: (sourceId: string) => KnowledgeExtractionRecord | null | undefined,
  limit: number,
): Promise<KnowledgeSourceRecord[]> {
  assertExtractionInputs(sources, extractionBySourceId);
  const originalVersion = JSON.stringify({ query, sources, nodes, edges, extractions: sources.map((source) => extractionBySourceId(source.id)) });
  const links = buildSourceLinkIndex(edges, nodes);
  const eligible = sources.filter(source => source.artifactId);
  const snapshots = eligible.map((source) => {
    const extraction = extractionBySourceId(source.id);
    return { request: query, source: { title: source.title, summary: source.summary, description: source.description,
      sourceType: source.sourceType, tags: source.tags, uri: source.sourceUri,
      extraction: extraction ? { title: extraction.title, summary: extraction.summary, excerpt: extraction.excerpt, text: repairProfileSourceText(extraction) } : null,
      subjects: nodes.filter((node) => links.get(source.id)?.has(node.id)).map(repairProfileSubject) } };
  });
  for (const state of snapshots) assertJudgmentInput(state);
  if (snapshots.some(state => JSON.stringify(state).length > 160_000)) throw new JudgmentInputError('unsupported-input');
  if (!query.trim()) return [];
  const decisionGuards: Array<() => void> = [];
  const results = await mapLimit(structuredClone(snapshots), 4, async (state, index) => {
    const source = eligible[index]!;
    if (!source.artifactId || !(await homeGraphExtractionNeedsRepair(extractionBySourceId(source.id)))) return undefined;
    const run = await readKnowledgeBattery(repairSourceRelevance, state);
    decisionGuards.push(run.assertDecisionCurrent);
    return run.readings.relevant.verdict === 'yes' ? { source, score: run.readings.relevant.probability } : undefined;
  });
  if (JSON.stringify({ query, sources, nodes, edges, extractions: sources.map((source) => extractionBySourceId(source.id)) }) !== originalVersion) throw new KnowledgeAnswerQualityHeldError('stale');
  for (const check of decisionGuards) check();
  return results.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id))
    .slice(0, Math.max(1, limit)).map((entry) => entry.source);
}
export async function homeGraphExtractionNeedsRepair(extraction: KnowledgeExtractionRecord | null | undefined): Promise<boolean> {
  return knowledgeExtractionNeedsRefresh(extraction ?? null);
}
function assertExtractionInputs(
  sources: readonly KnowledgeSourceRecord[],
  extractionBySourceId: (sourceId: string) => KnowledgeExtractionRecord | null | undefined,
): void {
  for (const source of sources) {
    assertJudgmentInput({ summary: source.summary, description: source.description });
    assertKnowledgeExtractionInput(extractionBySourceId(source.id));
  }
}
