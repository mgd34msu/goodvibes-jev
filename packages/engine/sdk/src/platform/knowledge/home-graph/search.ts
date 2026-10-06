import { getKnowledgeSpaceId } from '../spaces.js';
import { KnowledgeAnswerQualityHeldError } from '../semantic/answer-verification/types.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { assertKnowledgeExtractionInput, knowledgeExtractionNeedsRefresh } from '../extraction-policy.js';
import { belongsToSpace, edgeIsActive, isGeneratedPageSource, readRecord } from './helpers.js';
import { isUnusableHomeGraphExtractionText } from './extraction-quality.js';
import { buildSourceLinkIndex } from './source-links.js';
import { intersects, isSingularObjectQuery } from './search-utils.js';

const MAX_SEARCH_TEXT_CHARS = 64 * 1024;
const ANCHOR_SCOPE_LIMIT = 5;

const STOPWORDS = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'are',
  'as',
  'at',
  'available',
  'be',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'show',
  'tell',
  'that',
  'the',
  'this',
  'to',
  'use',
  'what',
  'which',
  'with',
]);

const SHORT_MEANINGFUL_TOKENS = new Set(['ac', 'av', 'dc', 'ha', 'ip', 'ir', 'pc', 'tv']);

const GENERIC_ANCHOR_TOKENS = new Set([
  'area',
  'assistant',
  'automation',
  'calendar',
  'device',
  'entity',
  'graph',
  'home',
  'library',
  'living',
  'media',
  'media_player',
  'room',
  'sensor',
  'shows',
  'smart',
  'storage',
  'switch',
  'television',
  'tv',
]);

const HOME_GRAPH_ANCHOR_KINDS = new Set([
  'ha_home',
  'ha_entity',
  'ha_device',
  'ha_area',
  'ha_automation',
  'ha_script',
  'ha_scene',
  'ha_label',
  'ha_integration',
  'ha_room',
  'ha_device_passport',
  'ha_maintenance_item',
  'ha_troubleshooting_case',
  'ha_purchase',
  'ha_network_node',
]);

const INTEGRATION_QUERY_TOKENS = new Set(['automation', 'automations', 'homeassistant', 'integration', 'integrations', 'webostv']);

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
  query: string,
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  extractionBySourceId: (sourceId: string) => KnowledgeExtractionRecord | null | undefined,
  limit: number,
): Promise<KnowledgeSourceRecord[]> {
  assertExtractionInputs(sources, extractionBySourceId);
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const anchors = selectAnchorNodes(tokens, nodes);
  const sourceAnchors = selectSourceAnchors(tokens, anchors.map((anchor) => anchor.node), isSingularObjectQuery(query, tokens));
  const anchorIds = new Set(sourceAnchors.map((anchor) => anchor.id));
  const anchorIdentityTokens = collectAnchorIdentityTokens(sourceAnchors);
  const sourceLinks = buildSourceLinkIndex(edges, nodes);
  return (await Promise.all(sources
    .map(async (source) => {
      if (!source.artifactId || !(await homeGraphExtractionNeedsRepair(extractionBySourceId(source.id)))) return { source, score: 0 };
      const linkedNodeIds = sourceLinks.get(source.id) ?? new Set<string>();
      const linkedToAnchor = sourceAnchors.length > 0 && intersects(linkedNodeIds, anchorIds);
      const anchorIdentityScore = sourceAnchors.length > 0
        ? await sourceAnchorIdentityScore(anchorIdentityTokens, source, extractionBySourceId(source.id))
        : 0;
      const identityScore = scoreFields(tokens, [
        source.title,
        source.summary,
        source.description,
        source.sourceUri,
        source.canonicalUri,
        source.tags.join(' '),
      ]);
      const sourceKindBoost = isManualLikeSource(source) ? 30 : 0;
      const score = linkedToAnchor
        ? 140 + relationBoost(source.id, anchorIds, edges) + sourceKindBoost + identityScore
        : identityScore > 0 || anchorIdentityScore > 0
          ? identityScore + anchorIdentityScore + sourceKindBoost
          : 0;
      return { source, score };
    })))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.source);
}

async function readSearchText(extraction: KnowledgeExtractionRecord | null | undefined): Promise<string | undefined> {
  if (!extraction) return undefined;
  const structure = readRecord(extraction.structure);
  const metadata = readRecord(extraction.metadata);
  const text = firstBoundedText([
    structure.searchText,
    structure.text,
    structure.content,
    metadata.searchText,
  ], MAX_SEARCH_TEXT_CHARS);
  return await isUnusableHomeGraphExtractionText(text) ? undefined : text;
}

function readNodeMetadataText(node: KnowledgeNodeRecord): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const values = [
    homeAssistant.objectKind,
    homeAssistant.objectId,
    homeAssistant.entityId,
    homeAssistant.deviceId,
    homeAssistant.areaId,
    homeAssistant.integrationId,
    node.metadata.manufacturer,
    node.metadata.model,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return values.length > 0 ? values.join(' ') : undefined;
}

function nodeIdentityFields(node: KnowledgeNodeRecord): string[] {
  return [
    node.title,
    node.summary,
    node.aliases.join(' '),
    readNodeMetadataText(node),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function collectAnchorIdentityTokens(nodes: readonly KnowledgeNodeRecord[]): string[] {
  const tokens = new Set<string>();
  for (const node of nodes) {
    for (const field of nodeIdentityFields(node)) {
      for (const token of tokenizeQuery(field)) {
        if (GENERIC_ANCHOR_TOKENS.has(token)) continue;
        tokens.add(token);
      }
    }
  }
  return [...tokens];
}

async function sourceAnchorIdentityScore(
  anchorTokens: readonly string[],
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined,
): Promise<number> {
  if (anchorTokens.length === 0) return 0;
  return scoreFields(anchorTokens, [
    source.title,
    source.summary,
    source.description,
    source.sourceUri,
    source.canonicalUri,
    source.tags.join(' '),
    extraction?.title,
    extraction?.summary,
    extraction?.excerpt,
    await readSearchText(extraction),
  ]);
}

function selectAnchorNodes(tokens: readonly string[], nodes: readonly KnowledgeNodeRecord[]): Array<{ readonly node: KnowledgeNodeRecord; readonly score: number }> {
  if (tokens.length === 0) return [];
  const scored = nodes.map((node) => {
    if (!isHomeGraphAnchorNode(node)) return { node, score: 0 };
    const baseScore = scoreFields(tokens, nodeIdentityFields(node));
    const intentBoost = sourceAnchorIntentBoost(tokens, node);
    return {
      node,
      score: baseScore > 0 ? baseScore + nodeKindBoost(node.kind) + intentBoost : 0,
    };
  })
    .filter((entry) => entry.score >= 10)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const topScore = scored[0]?.score ?? 0;
  return scored
    .filter((entry) => entry.score >= Math.max(10, topScore - 12))
    .slice(0, 12);
}

function isHomeGraphAnchorNode(node: KnowledgeNodeRecord): boolean {
  if (typeof node.metadata.semanticKind === 'string') return false;
  return HOME_GRAPH_ANCHOR_KINDS.has(node.kind);
}

function selectSourceAnchors(
  tokens: readonly string[],
  nodes: readonly KnowledgeNodeRecord[],
  singularObjectQuery = false,
): KnowledgeNodeRecord[] {
  const preferred = nodes.filter((node) => sourceAnchorIntentBoost(tokens, node) >= 0);
  if (preferred.length > 0) return preferred.slice(0, singularObjectQuery ? 1 : ANCHOR_SCOPE_LIMIT);
  return nodes.slice(0, ANCHOR_SCOPE_LIMIT);
}

function sourceAnchorIntentBoost(tokens: readonly string[], node: KnowledgeNodeRecord): number {
  const metadata = readRecord(node.metadata);
  const homeAssistant = readRecord(metadata.homeAssistant);
  const domain = typeof metadata.domain === 'string' ? metadata.domain.toLowerCase() : '';
  const platform = typeof metadata.platform === 'string' ? metadata.platform.toLowerCase() : '';
  const objectKind = typeof homeAssistant.objectKind === 'string' ? homeAssistant.objectKind.toLowerCase() : '';
  const text = nodeIdentityFields(node).join(' ').toLowerCase();
  const tvQuery = tokens.some((token) => token === 'tv' || token === 'television' || token === 'media_player');
  if (tvQuery) {
    if (node.kind === 'ha_device' && /\b(tv|television|webos|bravia)\b/.test(text)) return 80;
    if (node.kind === 'ha_entity' && (domain === 'media_player' || platform === 'webostv')) return 70;
    if (node.kind === 'ha_integration' && (platform === 'webostv' || text.includes('webos'))) return 40;
    if (domain === 'calendar' || domain === 'sensor' || domain === 'automation' || domain === 'switch'
      || objectKind === 'automation' || node.kind === 'ha_automation') return -80;
  }
  if (node.kind === 'ha_device') return 30;
  if (node.kind === 'ha_entity') return 10;
  if (node.kind === 'ha_integration' && queryMentionsIntegration(tokens)) return 8;
  return node.kind === 'ha_integration' ? -10 : 0;
}

function relationBoost(sourceId: string, anchorIds: ReadonlySet<string>, edges: readonly KnowledgeEdgeRecord[]): number {
  let boost = 0;
  for (const edge of edges) {
    const connectsAnchor = (edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node' && anchorIds.has(edge.toId))
      || (edge.fromKind === 'node' && anchorIds.has(edge.fromId) && edge.toKind === 'source' && edge.toId === sourceId);
    if (!connectsAnchor) continue;
    if (edge.relation === 'has_manual') boost = Math.max(boost, 45);
    else if (edge.relation === 'source_for') boost = Math.max(boost, 25);
    else boost = Math.max(boost, 15);
  }
  return boost;
}

function nodeKindBoost(kind: string): number {
  switch (kind) {
    case 'ha_device':
    case 'ha_entity':
      return 20;
    case 'ha_area':
    case 'ha_room':
    case 'ha_automation':
    case 'ha_script':
    case 'ha_scene':
      return 12;
    case 'ha_integration':
      return 6;
    default:
      return 0;
  }
}

export async function homeGraphExtractionNeedsRepair(extraction: KnowledgeExtractionRecord | null | undefined): Promise<boolean> {
  return knowledgeExtractionNeedsRefresh(extraction ?? null);
}

function queryMentionsIntegration(tokens: readonly string[]): boolean {
  return tokens.some((token) => INTEGRATION_QUERY_TOKENS.has(token));
}

function isManualLikeSource(source: KnowledgeSourceRecord): boolean {
  const tags = source.tags.map((tag) => tag.toLowerCase());
  return source.sourceType === 'manual'
    || source.sourceType === 'document'
    || source.sourceType === 'url'
    || tags.includes('manual')
    || tags.includes('artifact')
    || tags.includes('document');
}

function firstBoundedText(values: readonly unknown[], maxLength: number): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    return clampText(trimmed, maxLength);
  }
  return undefined;
}

function clampText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function tokenizeQuery(value: string): string[] {
  const tokens = value.toLowerCase()
    .split(/[^a-z0-9_.:-]+/)
    .map((entry) => entry.trim())
    .filter((entry) => isMeaningfulToken(entry));
  return [...new Set(tokens)];
}

function isMeaningfulToken(token: string): boolean {
  if (!token || STOPWORDS.has(token)) return false;
  if (token.length === 1) return false;
  if (token.length <= 2 && !SHORT_MEANINGFUL_TOKENS.has(token)) return false;
  return true;
}

function scoreFields(tokens: readonly string[], fields: readonly (string | undefined)[]): number {
  let score = 0;
  for (const field of fields) {
    const raw = typeof field === 'string' ? field.trim() : '';
    const haystack = clampText(raw, MAX_SEARCH_TEXT_CHARS).toLowerCase();
    if (!haystack) continue;
    for (const token of tokens) {
      if (fieldIncludesToken(haystack, token)) score += token.length <= 3 ? 14 : 10;
    }
  }
  return score;
}

function fieldIncludesToken(haystack: string, token: string): boolean {
  if (token.length <= 3 || token.includes('_') || token.includes('-')) {
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(token)}(?:$|[^a-z0-9])`).test(haystack);
  }
  return haystack.includes(token);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
