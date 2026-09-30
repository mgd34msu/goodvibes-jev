import { snapshotNodeInput } from '../activation/projection.js';
import { knowledgeSourceJudgmentUris } from '../source-structural-references.js';
import { projectAnswerFactClaim } from './answer-claim-projection.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { createSemanticWriteGuard, type SemanticWriteGuard } from './primary-source-plan.js';
import { prepareAnswerEvidenceRelevance, KnowledgeEvidenceRelevanceHeldError, type AnswerEvidenceCandidate } from './evidence-ranking/reader.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
} from '../types.js';
import {
  getExplicitKnowledgeSpaceId,
  getKnowledgeSpaceId,
  isHomeAssistantKnowledgeSpace,
  normalizeKnowledgeSpaceId,
} from '../spaces.js';
import {
  knowledgeNodeMatchesScope,
  knowledgeSourceMatchesScope,
} from '../scope-records.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeSemanticAnswerInput } from './types.js';
import {
  clampText,
  normalizeWhitespace,
  readRecord,
  readString,
  readStringArray,
  scoreSemanticText,
  sourceSemanticText,
  splitSentences,
  tokenizeSemanticQuery,
  uniqueStrings,
} from './utils.js';
import {
  isLowValueFeatureOrSpecText,
  isSemanticAnswerLinkedObject,
} from './fact-quality.js';
import {
  inferAnswerObjectScope,
} from './object-scope.js';
import { canonicalRepairSubjectNodes } from './repair-subjects.js';
import { readAnswerSourceRanking } from './answer-source-ranking.js';
import {
  GENERIC_ANSWER_INTENT_TOKENS,
  isBroadKnowledgeSpaceAlias,
  type EvidenceItem,
} from './answer-common.js';
import {
  filterFactsForQuery,
  hasFeatureIntentForQuery,
  renderFactForPrompt,
  renderNodeEvidence,
} from './answer-fact-selection.js';

interface InitialEvidencePass {
  readonly store: KnowledgeStore;
  readonly query: string;
  readonly rejectedSourceIds: ReadonlySet<string>;
  readonly assertCurrent: () => void;
}
const initialPasses = new WeakMap<readonly EvidenceItem[], InitialEvidencePass>();
function carryInitialPass(items: EvidenceItem[], pass?: InitialEvidencePass): EvidenceItem[] {
  if (pass) initialPasses.set(items, pass);
  return items;
}

export async function collectAnswerEvidence(
  store: KnowledgeStore,
  input: KnowledgeSemanticAnswerInput,
  spaceId: string,
  limit: number,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  signal?: AbortSignal,
): Promise<EvidenceItem[]> {
  const query = input.query;
  if (!query.trim()) return [];
  const guard = createSemanticWriteGuard(store, signal);
  guard.assertCurrent();
  const candidateSourceIds = new Set(input.candidateSourceIds ?? []);
  const candidateNodeIds = new Set(input.candidateNodeIds ?? []);
  const linkedObjectIds = new Set((input.linkedObjects ?? []).map((node) => node.id));
  const strictCandidates = input.strictCandidates === true && (candidateSourceIds.size > 0 || candidateNodeIds.size > 0);
  const answerSources = listAnswerSources(store, spaceId).filter(isUsableAnswerSource);
  const usableSourceIds = new Set(answerSources.map((source) => source.id));
  const sourceFacts = buildSourceFactIndex(store, spaceId, usableSourceIds);
  const linkedSourceIds = sourceIdsLinkedToNodes(store, new Set([...candidateNodeIds, ...linkedObjectIds]), spaceId);
  // Structural bounded windows, never a keyword/record-kind quality guess.
  // Inferred subject scope cannot discard a semantic paraphrase before the reading.
  const sources = answerSources.filter((source) => belongsToAnswerSpace(source, spaceId))
    .filter((source) => !strictCandidates || candidateSourceIds.has(source.id) || linkedSourceIds.has(source.id)).slice(0, 50);
  const nodes = listAnswerNodes(store, spaceId)
    .filter((node) => belongsToAnswerSpace(node, spaceId) && node.status === 'active')
    .filter((node) => node.metadata.semanticKind !== 'fact' || factHasUsableSource(node, usableSourceIds))
    .filter((node) => !strictCandidates || candidateNodeIds.has(node.id) || linkedObjectIds.has(node.id)
      || (typeof node.sourceId === 'string' && candidateSourceIds.has(node.sourceId))).slice(0, 50);
  const texts = new Map<string, string>();
  const items: EvidenceItem[] = [];
  for (const source of sources) {
    const snapshot = snapshotNodeInput(source);
    guard.watch(`source:${source.id}`, () => store.getSource(source.id), source);
    const extraction = snapshotNodeInput(guard.extraction(source.id));
    if (extraction && (extraction.sourceId !== source.id || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source))) {
      throw new KnowledgeEvidenceRelevanceHeldError('malformed');
    }
    const facts = sourceFacts.get(source.id) ?? [];
    texts.set(`source:${source.id}`, sourceSemanticText({ ...snapshot, ...knowledgeSourceJudgmentUris(source) }, extraction));
    items.push({ kind: 'source', id: source.id, title: source.title ?? source.canonicalUri ?? source.sourceUri ?? 'Untitled source', score: 0, source, facts });
  }
  for (const node of nodes) {
    const snapshot = snapshotNodeInput(node);
    guard.watch(`node:${node.id}`, () => store.getNode(node.id), node);
    texts.set(`node:${node.id}`, [renderNodeEvidence(snapshot), ...snapshot.aliases,
      readString(snapshot.metadata.manufacturer), readString(snapshot.metadata.model),
      initialNodeReferenceContext(store, snapshot, spaceId, guard)].filter(Boolean).join('\n'));
    items.push({ kind: 'node', id: node.id, title: node.title, score: 0, node, facts: node.metadata.semanticKind === 'fact' ? [node] : [] });
  }
  for (const fact of uniqueNodes(items.flatMap((item) => item.facts))) {
    snapshotNodeInput(fact);
    guard.watch(`node:${fact.id}`, () => store.getNode(fact.id), fact);
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  const nodeIds = new Set([...nodes, ...items.flatMap((item) => item.facts)].map((node) => node.id));
  guard.watch('initial-evidence-relations', () => store.listEdges().filter((edge) =>
    (edge.fromKind === 'source' && sourceIds.has(edge.fromId)) || (edge.toKind === 'source' && sourceIds.has(edge.toId))
    || (edge.fromKind === 'node' && nodeIds.has(edge.fromId)) || (edge.toKind === 'node' && nodeIds.has(edge.toId))));
  const candidates = items.map((item, index) => initialEvidenceCandidate(item, `candidate-${index + 1}`,
    texts.get(`${item.kind}:${item.id}`)!, store, guard));
  // Full selected input is preflighted before any semantic port, including later
  // fact/excerpt readings. No keyword filter or display clipping precedes it.
  const plan = await prepareAnswerEvidenceRelevance({ query, candidates }, { signal });
  guard.assertCurrent();
  const byReference = new Map(candidates.map((candidate, index) => [candidate.reference, items[index]!]));
  const selected = plan.accepted.map((reading) => ({ ...byReference.get(reading.reference)!, score: reading.probability,
    scoreScale: 'relevance-probability' as const }));
  const selectedFacts = await filterFactsForQuery(query, uniqueNodes(selected.flatMap((item) => item.facts)), signal);
  const factIds = new Set(selectedFacts.map((fact) => fact.id));
  const featureIntent = selected.some((item) => item.source) ? await hasFeatureIntentForQuery(query, signal) : false;
  guard.assertCurrent();
  const primary = uniqueEvidenceItems(selected).filter((item) => item.node?.metadata.semanticKind !== 'fact' || factIds.has(item.node.id))
    .slice(0, Math.max(1, limit));
  const neededSources = new Set(primary.flatMap((item) => item.node ? factSourceIds(item.node) : []));
  // Internal evidence includes accepted backing references even when a fact wins
  // the display window. Never revive a source whose relevance reading said no.
  const result = uniqueEvidenceItems([...primary, ...selected.filter((item) => item.source && neededSources.has(item.source.id))])
    .map((item) => {
      const facts = item.facts.filter((fact) => factIds.has(fact.id));
      return { ...item, facts, excerpt: item.source
        ? selectEvidenceExcerpt(query, texts.get(`source:${item.id}`)!, facts, featureIntent)
        : renderNodeEvidence(item.node!) };
    });
  return carryInitialPass(result, { store, query,
    rejectedSourceIds: new Set(plan.rejected.flatMap((reading) => {
      const source = byReference.get(reading.reference)?.source;
      return source ? [source.id] : [];
    })), assertCurrent: guard.assertCurrent });
}

/** A claim's source and subject identities carry meaning; their database keys stay local. */
function initialNodeReferenceContext(store: KnowledgeStore, node: KnowledgeNodeRecord, spaceId: string, guard: SemanticWriteGuard): string {
  const sourceIds = factSourceIds(node);
  if (sourceIds.length > 32) throw new KnowledgeEvidenceRelevanceHeldError('budget');
  const hints = Array.isArray(node.metadata.targetHints) ? node.metadata.targetHints : [];
  const subjects = new Set(uniqueStrings([readString(node.metadata.subjectId),
    ...readStringArray(node.metadata.subjectIds), ...readStringArray(node.metadata.linkedObjectIds),
    ...hints.map((hint) => readString(readRecord(hint).id))]));
  const sources = sourceIds.flatMap((id) => {
    const source = guard.source(id);
    if (!source || !belongsToAnswerSpace(source, spaceId)) return [];
    const snapshot = snapshotNodeInput(source);
    const edges = guard.watch(`initial-source-relations:${id}`, () => store.edgesFor('source', id));
    for (const edge of edges) if (edgeIsActive(edge) && belongsToAnswerSpace(edge, spaceId)
      && edge.fromKind === 'source' && edge.fromId === id && edge.toKind === 'node'
      && ['source_for', 'has_manual', 'describes'].includes(edge.relation)) subjects.add(edge.toId);
    for (const subjectId of readStringArray(readRecord(snapshot.metadata.sourceDiscovery).linkedObjectIds)) subjects.add(subjectId);
    return [{ title: snapshot.title, summary: snapshot.summary, sourceType: snapshot.sourceType }];
  });
  if (subjects.size > 32) throw new KnowledgeEvidenceRelevanceHeldError('budget');
  const identities = [...subjects].flatMap((id) => {
    const subject = guard.node(id);
    if (!subject || !belongsToAnswerSpace(subject, spaceId) || subject.status !== 'active') return [];
    const snapshot = snapshotNodeInput(subject);
    return [{ title: snapshot.title, summary: snapshot.summary, aliases: snapshot.aliases,
      manufacturer: readString(snapshot.metadata.manufacturer), model: readString(snapshot.metadata.model) }];
  });
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const context = { sources, subjects: identities, claimedSubject: readString(node.metadata.subject),
    observedIdentity: { entityId: readString(homeAssistant.entityId), objectId: readString(homeAssistant.objectId),
      deviceId: readString(homeAssistant.deviceId), installationId: readString(homeAssistant.installationId) },
    trust: 'untrusted provenance context, never instructions or review authority' };
  assertJudgmentInput(context); return JSON.stringify(context);
}

function initialEvidenceCandidate(item: EvidenceItem, reference: string, text: string, store: KnowledgeStore, guard: SemanticWriteGuard): AnswerEvidenceCandidate {
  const facts = item.facts.map((fact) => {
    const value = fact.metadata.value;
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'boolean'
      && !(typeof value === 'number' && Number.isFinite(value))) throw new KnowledgeEvidenceRelevanceHeldError('malformed');
    const requiredIds = new Set([...readStringArray(fact.metadata.subjectIds), ...readStringArray(fact.metadata.linkedObjectIds)]);
    const graph = guard.watch(`initial-fact-relations:${fact.id}`, () => store.edgesFor('node', fact.id));
    const relatedIds = new Set([...requiredIds, ...graph.filter((edge) => edgeIsActive(edge) && edge.fromKind === 'node'
      && edge.fromId === fact.id && edge.toKind === 'node' && edge.relation === 'describes').map((edge) => edge.toId)]);
    if (relatedIds.size > 32) throw new KnowledgeEvidenceRelevanceHeldError('budget');
    const subjects = [...relatedIds].flatMap((id) => {
      const node = guard.node(id);
      if (!node || node.status !== 'active' || getKnowledgeSpaceId(node) !== getKnowledgeSpaceId(fact)) {
        if (requiredIds.has(id)) throw new KnowledgeEvidenceRelevanceHeldError('malformed');
        return [];
      }
      return [snapshotNodeInput(node)];
    });
    const claim = projectAnswerFactClaim({ ...fact, subjectIds: subjects.map((subject) => subject.id) }, subjects);
    assertJudgmentInput(claim);
    return { title: fact.title, kind: readString(fact.metadata.factKind), summary: fact.summary, value,
      evidence: readString(fact.metadata.evidence), details: JSON.stringify(claim) };
  });
  return { reference, kind: item.kind, title: item.source?.title ?? item.node?.title ?? 'Untitled source', text, facts,
    ...(item.source ? { sourceType: item.source.sourceType,
      claimedProvenance: JSON.stringify({ reason: readString(readRecord(item.source.metadata.sourceDiscovery).trustReason), domain: readString(readRecord(item.source.metadata.sourceDiscovery).sourceDomain) }) } : {}),
    ...(item.node ? { nodeKind: item.node.kind,
      claimedProvenance: JSON.stringify({ extractor: readString(item.node.metadata.extractor), sourceAuthority: readString(item.node.metadata.sourceAuthority) }) } : {}),
  };
}

export function inferObjectLinkedObjects(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): KnowledgeNodeRecord[] {
  const tokens = expandQueryTokens(tokenizeSemanticQuery(query));
  const subjectTokens = tokens.filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  const scope = inferAnswerObjectScope(store, spaceId, query, subjectTokens, objectProfiles);
  if (!scope || scope.anchorNodeIds.size === 0) return [];
  return listAnswerNodes(store, spaceId)
    .filter((node) => scope.anchorNodeIds.has(node.id))
    .filter((node) => belongsToAnswerSpace(node, spaceId))
    .filter(isSemanticAnswerLinkedObject);
}

export function filterAnswerLinkedObjects(
  spaceId: string,
  query: string,
  nodes: readonly KnowledgeNodeRecord[],
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): readonly KnowledgeNodeRecord[] {
  const canonical = canonicalRepairSubjectNodes({ nodes, text: query, objectProfiles });
  if (canonical.length > 0) return canonical.slice(0, 24);
  const integrationIntent = /\b(integration|platform|add-?on|addon|plugin|service|api|setup|configure|configuration|auth|credential|rate limit)\b/i.test(query);
  return nodes.filter((node) => integrationIntent || !/integration/i.test(node.kind)).slice(0, 24);
}

export function shouldUseEvidenceLinkedObjects(
  spaceId: string,
  input: KnowledgeSemanticAnswerInput,
  inferredObjectLinkedObjects: readonly KnowledgeNodeRecord[],
): boolean {
  if (input.linkedObjects?.length) return true;
  if (isBroadKnowledgeSpaceAlias(spaceId) || isHomeAssistantKnowledgeSpace(normalizeKnowledgeSpaceId(spaceId))) {
    return inferredObjectLinkedObjects.length > 0;
  }
  return true;
}

export async function includeOfficialLinkedEvidence(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  evidence: readonly EvidenceItem[],
  linkedObjects: readonly KnowledgeNodeRecord[],
  limit: number,
  signal?: AbortSignal,
): Promise<EvidenceItem[]> {
  const initial = initialPasses.get(evidence);
  if (initial) {
    if (initial.store !== store || initial.query !== query) throw new KnowledgeEvidenceRelevanceHeldError('stale');
    initial.assertCurrent();
  }
  if (linkedObjects.length === 0) return carryInitialPass([...evidence], initial);
  const linkedIds = new Set(linkedObjects.map((node) => node.id));
  const linkedSourceIds = sourceIdsLinkedToNodes(store, linkedIds, spaceId);
  const usableSourceIds = new Set(listAnswerSources(store, spaceId).filter(isUsableAnswerSource).map((source) => source.id));
  const sourceFacts = buildSourceFactIndex(store, spaceId, usableSourceIds);
  const officialSources = listAnswerSources(store, spaceId)
    .filter(isUsableAnswerSource)
    .filter((source) => belongsToAnswerSpace(source, spaceId))
    .filter((source) => !initial?.rejectedSourceIds.has(source.id))
    .filter((source) => linkedSourceIds.has(source.id) || readStringArray(readRecord(source.metadata.sourceDiscovery).linkedObjectIds).some((id) => linkedIds.has(id)))
    .slice(0, 50);
  if (officialSources.length === 0) return carryInitialPass([...evidence], initial);
  const selectedFacts = await filterFactsForQuery(query, uniqueNodes(officialSources.flatMap((source) => sourceFacts.get(source.id) ?? [])), signal);
  const selectedFactIds = new Set(selectedFacts.map((fact) => fact.id));
  const featureIntent = await hasFeatureIntentForQuery(query, signal);
  const retrievalScores = new Map(evidence.filter((item) => item.source).map((item) => [item.source!.id, item]));
  const candidates = officialSources.map((source) => {
    const extraction = store.getExtractionBySourceId(source.id);
    const facts = (sourceFacts.get(source.id) ?? []).filter((fact) => selectedFactIds.has(fact.id));
    const text = sourceSemanticText(source, extraction);
    return {
      kind: 'source' as const, id: source.id,
      title: source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id,
      score: retrievalScores.get(source.id)?.score ?? 0, scoreScale: retrievalScores.get(source.id)?.scoreScale,
      source, excerpt: selectEvidenceExcerpt(query, text, facts, featureIntent), facts,
    };
  });
  const ranked = await readAnswerSourceRanking(candidates, selectedFacts, query, signal);
  const byId = new Map(candidates.map((item) => [item.id, item]));
  // Preserve supplied score units. This separate reading only orders the linked
  // set; it is not answer confidence. New references have no initial score.
  const officialItems = ranked.map((reading) => byId.get(reading.source.id)!);
  initial?.assertCurrent();
  if (officialItems.length === 0) return carryInitialPass([...evidence], initial);
  // Do not arithmetically compare scores from separate readings or legacy callers.
  // Preserve the bounded union for the final semantic source ranking; newly
  // settled matches lead its request window rather than being cut by old points.
  return carryInitialPass(uniqueEvidenceItems([...officialItems, ...evidence]), initial);
}

export function toSearchResult(item: EvidenceItem): KnowledgeSearchResult {
  return {
    kind: item.kind,
    id: item.id,
    score: item.score,
    reason: item.scoreScale === 'relevance-probability'
      ? 'semantic evidence relevance probability (0–1)' : 'semantic evidence match',
    ...(item.source ? { source: item.source } : {}),
    ...(item.node ? { node: item.node } : {}),
  };
}

export function uniqueNodes(nodes: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const seen = new Set<string>();
  const out: KnowledgeNodeRecord[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

export function withAnswerSourceAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  return {
    ...source,
    sourceId: source.id,
    url: source.sourceUri ?? source.canonicalUri,
  };
}

function buildSourceFactIndex(
  store: KnowledgeStore,
  spaceId: string,
  usableSourceIds: ReadonlySet<string>,
): Map<string, KnowledgeNodeRecord[]> {
  const facts = listAnswerNodes(store, spaceId).filter((node) => (
    node.status === 'active' && node.metadata.semanticKind === 'fact' && belongsToAnswerSpace(node, spaceId)
  ));
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const bySource = new Map<string, KnowledgeNodeRecord[]>();
  for (const fact of facts) {
    for (const sourceId of factSourceIds(fact)) {
      addSourceFact(bySource, usableSourceIds, sourceId, fact);
    }
  }
  for (const edge of store.listEdges()) {
    if (!edgeIsActive(edge)) continue;
    if (!belongsToAnswerSpace(edge, spaceId)) continue;
    if (edge.fromKind !== 'source' || edge.toKind !== 'node' || edge.relation !== 'supports_fact') continue;
    const fact = factsById.get(edge.toId);
    if (!fact) continue;
    addSourceFact(bySource, usableSourceIds, edge.fromId, fact);
  }
  return bySource;
}

function factHasUsableSource(node: KnowledgeNodeRecord, usableSourceIds: ReadonlySet<string>): boolean {
  return factSourceIds(node).some((sourceId) => usableSourceIds.has(sourceId));
}

function factSourceIds(fact: KnowledgeNodeRecord): string[] {
  return uniqueStrings([
    ...readStringArray(fact.metadata.sourceIds),
    readString(fact.metadata.sourceId),
    fact.sourceId,
  ]);
}

function addSourceFact(
  bySource: Map<string, KnowledgeNodeRecord[]>,
  usableSourceIds: ReadonlySet<string>,
  sourceId: string | undefined,
  fact: KnowledgeNodeRecord,
): void {
  if (!sourceId || !usableSourceIds.has(sourceId)) return;
  const existing = bySource.get(sourceId) ?? [];
  if (existing.some((entry) => entry.id === fact.id)) return;
  bySource.set(sourceId, [...existing, fact]);
}

function isUsableAnswerSource(source: KnowledgeSourceRecord): boolean {
  return source.status === 'indexed';
}

function listAnswerSources(store: KnowledgeStore, spaceId: string): KnowledgeSourceRecord[] {
  const sources = isBroadKnowledgeSpaceAlias(spaceId)
    ? store.listSources(Number.MAX_SAFE_INTEGER)
    : store.listSourcesInSpace(spaceId);
  return sources
    .filter((source) => source.status !== 'stale')
    .filter((source) => knowledgeSourceMatchesScope(source, answerEvidenceScope(spaceId)));
}

function listAnswerNodes(store: KnowledgeStore, spaceId: string): KnowledgeNodeRecord[] {
  const nodes = isBroadKnowledgeSpaceAlias(spaceId)
    ? store.listNodes(Number.MAX_SAFE_INTEGER)
    : store.listNodesInSpace(spaceId);
  const lookup = {
    getSource: (id: string) => store.getSource(id),
    getNode: (id: string) => store.getNode(id),
    edges: store.listEdges(),
  };
  return nodes
    .filter((node) => node.status === 'active' && node.kind !== 'knowledge_gap' && node.metadata.semanticKind !== 'gap')
    .filter((node) => knowledgeNodeMatchesScope(node, answerEvidenceScope(spaceId), lookup));
}

function answerEvidenceScope(spaceId: string): { readonly knowledgeSpaceId?: string; readonly includeAllSpaces?: boolean } {
  if (isBroadKnowledgeSpaceAlias(spaceId)) return { includeAllSpaces: true };
  return { knowledgeSpaceId: normalizeKnowledgeSpaceId(spaceId) };
}

function sourceIdsLinkedToNodes(store: KnowledgeStore, nodeIds: ReadonlySet<string>, spaceId: string): Set<string> {
  const sourceIds = new Set<string>();
  if (nodeIds.size === 0) return sourceIds;
  const usableSourceIds = new Set(listAnswerSources(store, spaceId).map((source) => source.id));
  const edges = store.listEdges();
  const factIds = new Set<string>();
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (!belongsToAnswerSpace(edge, spaceId)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && nodeIds.has(edge.toId) && usableSourceIds.has(edge.fromId)) sourceIds.add(edge.fromId);
    if (edge.fromKind === 'node' && nodeIds.has(edge.fromId) && edge.toKind === 'source' && usableSourceIds.has(edge.toId)) sourceIds.add(edge.toId);
    if (edge.fromKind === 'node' && edge.toKind === 'node' && nodeIds.has(edge.toId) && edge.relation === 'describes') {
      factIds.add(edge.fromId);
    }
  }
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (!belongsToAnswerSpace(edge, spaceId)) continue;
    if (edge.fromKind === 'source'
      && edge.toKind === 'node'
      && factIds.has(edge.toId)
      && edge.relation === 'supports_fact'
      && usableSourceIds.has(edge.fromId)) {
      sourceIds.add(edge.fromId);
    }
  }
  return sourceIds;
}

function edgeIsActive(edge: { readonly weight: number; readonly metadata: Record<string, unknown> }): boolean {
  return isActiveKnowledgeEdge(edge);
}

function selectEvidenceExcerpt(
  query: string,
  text: string,
  facts: readonly KnowledgeNodeRecord[],
  featureIntent: boolean,
): string {
  const tokens = expandQueryTokens(tokenizeSemanticQuery(query));
  const evidenceText = stripEvidenceRoutingFragments(text);
  const factLines = facts
    .map(renderFactForPrompt)
    .filter((line) => scoreSemanticText(line, tokens) > 0)
    .filter((line) => !featureIntent || !isLowValueFeatureOrSpecText(line))
    .slice(0, 12);
  const windows = evidenceWindows(evidenceText, tokens)
    .filter((line) => !featureIntent || !isLowValueFeatureOrSpecText(line))
    .slice(0, 4);
  const fallback = featureIntent && (factLines.length > 0 || windows.length > 0) ? [] : [clampText(evidenceText, 720)];
  return uniqueStrings([...factLines, ...windows, ...fallback]).join('\n');
}

function stripEvidenceRoutingFragments(text: string): string {
  return normalizeWhitespace(text
    .replace(/homegraph:\/\/\S+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bsemantic-gap-repair\b/gi, ' ')
    .replace(/\bgenerated-page\b/gi, ' ')
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|dev|tv|ca|co\.uk)(?:\/\S*)?/gi, ' '));
}

function evidenceWindows(text: string, tokens: readonly string[]): string[] {
  const normalized = normalizeWhitespace(text);
  const sentences = splitSentences(normalized, 420);
  const sentenceMatches = sentences.filter((sentence) => scoreSemanticText(sentence, tokens) > 0);
  if (sentenceMatches.length > 0) return uniqueStrings(sentenceMatches).slice(0, 12);
  const lower = normalized.toLowerCase();
  const windows: string[] = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    const index = lower.indexOf(token);
    if (index < 0) continue;
    const start = Math.max(0, normalized.lastIndexOf('.', index - 1) + 1, index - 160);
    const nextPeriod = normalized.indexOf('.', index + token.length);
    const end = nextPeriod >= 0 ? Math.min(normalized.length, nextPeriod + 1) : Math.min(normalized.length, index + 360);
    windows.push(`${start > 0 ? '...' : ''}${normalized.slice(start, end).trim()}${end < normalized.length ? '...' : ''}`);
  }
  return uniqueStrings(windows);
}

function expandQueryTokens(tokens: readonly string[]): string[] {
  const expansions: Record<string, readonly string[]> = {
    capabilities: ['capability', 'feature', 'features', 'function', 'functions', 'supports', 'specifications'],
    capability: ['capabilities', 'feature', 'features', 'function', 'functions', 'supports', 'specifications'],
    feature: ['features', 'capability', 'capabilities', 'function', 'functions', 'supports', 'specifications'],
    features: ['feature', 'capability', 'capabilities', 'function', 'functions', 'supports', 'specifications'],
    settings: ['configuration', 'configure', 'options'],
    setup: ['install', 'configure', 'pair'],
  };
  return uniqueStrings(tokens.flatMap((token) => [token, ...(expansions[token] ?? [])]));
}


function belongsToAnswerSpace(
  record: { readonly metadata?: Record<string, unknown> } | undefined | null,
  spaceId: string,
): boolean {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  const explicitSpaceId = getExplicitKnowledgeSpaceId(record);
  if (!explicitSpaceId) return false;
  const recordSpaceId = normalizeKnowledgeSpaceId(explicitSpaceId);
  if (normalized === 'default') return recordSpaceId === 'default';
  if (normalized === 'homeassistant') return isHomeAssistantKnowledgeSpace(recordSpaceId);
  return recordSpaceId === normalized;
}

function uniqueSources(sources: readonly KnowledgeSourceRecord[]): KnowledgeSourceRecord[] {
  const seen = new Set<string>();
  const out: KnowledgeSourceRecord[] = [];
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    out.push(source);
  }
  return out;
}

function uniqueEvidenceItems(items: readonly EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
