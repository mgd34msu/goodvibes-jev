import { createKnowledgeFactQualityReader } from './fact-quality.js';
import { createSemanticWriteGuard } from './primary-source-plan.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import { REPAIRS_GAP_RELATION } from '../home-graph/types.js';
import {
  DEFAULT_KNOWLEDGE_SPACE_ID,
  getKnowledgeSpaceId,
} from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import { canonicalRepairSubjectNodes, captureRepairSubjectReadSet } from './repair-subjects.js';
import {
  factsForObject,
  factsForSource,
  isConcreteRepairSubject,
  isSelfImprovementFactCandidate,
  linkedObjectsForSource,
  matchingObjectProfiles,
  repairTargetFactCount,
  sourcesForObject,
  uniqueById,
} from './self-improvement-graph.js';
import { readString, readStringArray, semanticMetadata, uniqueStrings } from './utils.js';

export interface GapContext {
  readonly assertCurrent?: (() => void) | undefined;
  readonly gap: KnowledgeNodeRecord;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly repairSourceIds: readonly string[];
}

export interface GapClassification {
  readonly assertCurrent?: (() => void) | undefined;
  readonly action: 'repair' | 'skip' | 'suppress';
  readonly reason?: string | undefined;
  readonly status?: string | undefined;
  readonly markAttempt?: boolean | undefined;
}

export function collectCandidateGaps(
  store: KnowledgeStore,
  spaceId: string,
  sourceIdFilter: ReadonlySet<string> | null,
  gapIdFilter: ReadonlySet<string> | null,
): KnowledgeNodeRecord[] {
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const edges = graph.edges;
  return [...graph.nodesById.values()]
    .filter((node) => node.kind === 'knowledge_gap' && node.status === 'active')
    .filter((node) => !gapIdFilter || gapIdFilter.has(node.id))
    .filter((node) => !sourceIdFilter || gapMatchesSourceFilter(node, sourceIdFilter, edges))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
}

export async function buildGapContext(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  options: { readonly signal?: AbortSignal | undefined; readonly shouldStop?: (() => boolean) | undefined } = {},
): Promise<GapContext> {
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const edges = graph.edges;
  const sourcesById = graph.sourcesById;
  const nodesById = graph.nodesById;
  const sourceIds = uniqueStrings([
    gap.sourceId,
    ...readStringArray(gap.metadata.sourceIds),
    ...edges
      .filter((edge) => edge.toKind === 'node' && edge.toId === gap.id && edge.fromKind === 'source')
      .map((edge) => edge.fromId),
  ]);
  const guard = captureRepairSubjectReadSet(store, gap, [], options.signal, options.shouldStop);
  const directSources = sourceIds.map((id) => sourcesById.get(id)).filter((source): source is KnowledgeSourceRecord => Boolean(source));
  guard.watch('subject-edges', () => store.listEdges());
  const selected = await canonicalRepairSubjectNodes({ store, spaceId, context: { gap }, evidenceSources: directSources, ...options,
    text: `${gap.title} ${gap.summary ?? ''}`,
    objectProfiles,
    nodes: [
      ...readStringArray(gap.metadata.linkedObjectIds).map((id) => nodesById.get(id)).filter((node): node is KnowledgeNodeRecord => Boolean(node)),
      ...sourceIds.flatMap((sourceId) => linkedObjectsForSource(sourceId, edges, nodesById)),
      ...edges
        .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id)
        .map((edge) => nodesById.get(edge.fromId))
        .filter((node): node is KnowledgeNodeRecord => Boolean(node)),
    ],
  });
  const assertCurrent = () => { guard.assertCurrent(); selected.assertCurrent(); };
  assertCurrent();
  const linkedObjects = selected.nodes;
  const sources = uniqueById([
    ...directSources,
    ...linkedObjects.flatMap((object) => sourcesForObject(object.id, edges, sourcesById)),
  ]);
  const facts = uniqueById([
    ...sources.flatMap((source) => factsForSource(source.id, edges, nodesById)),
    ...linkedObjects.flatMap((object) => factsForObject(object.id, edges, nodesById)),
  ]);
  const repairSourceIds = uniqueStrings(edges
    .filter((edge) => edge.fromKind === 'source'
      && edge.toKind === 'node'
      && edge.toId === gap.id
      && edge.relation === REPAIRS_GAP_RELATION)
    .map((edge) => edge.fromId));
  return { gap, sources, linkedObjects, facts, repairSourceIds, assertCurrent };
}

export async function classifyGap(
  context: GapContext,
  force: boolean,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  store: KnowledgeStore,
  options: { readonly signal?: AbortSignal | undefined; readonly shouldStop?: (() => boolean) | undefined } = {},
): Promise<GapClassification> {
  const status = readString(context.gap.metadata.repairStatus);
  const nextAttemptAt = readNumber(context.gap.metadata.nextRepairAttemptAt);
  let usefulEvidence = false;
  let assertCurrent = context.assertCurrent;
  assertCurrent?.();
  if (!force && (status === 'repaired' || hasRepairEdge(context))) {
    const guard = createSemanticWriteGuard(store, options.signal, options.shouldStop);
    guard.watch(`gap:${context.gap.id}`, () => store.getNode(context.gap.id), context.gap);
    const reader = createKnowledgeFactQualityReader(store, { spaceId: getKnowledgeSpaceId(context.gap),
      purpose: 'repair', query: [context.gap.title, context.gap.summary].filter(Boolean).join('\n\n'),
      subjects: context.linkedObjects, signal: options.signal, guard });
    const candidates = repairEvidenceCandidates(context);
    const quality = await reader.prepare(candidates);
    assertCurrent = () => { context.assertCurrent?.(); quality.assertCurrent(); };
    usefulEvidence = quality.facts.length >= repairTargetFactCount(context.gap);
  }
  const repairedWithFacts = status === 'repaired' && usefulEvidence;
  if (!force && repairedWithFacts) return { action: 'skip', reason: 'Gap already has promoted repair facts.', status: 'repaired', assertCurrent };
  if (!force && status !== 'repaired' && nextAttemptAt && nextAttemptAt > Date.now()) return { action: 'skip', reason: 'Gap repair retry window has not elapsed.', status: 'retry_wait', markAttempt: true, assertCurrent };
  if (!force && hasRepairEdge(context) && usefulEvidence) return { action: 'skip', reason: 'Gap already has promoted repair facts.', status: 'already_repaired', assertCurrent };
  if (isDefaultUnanchoredAnswerGap(context)) {
    return { action: 'skip', reason: 'Default answer gaps without a linked subject are not automatically web-repaired.', status: 'needs_context', markAttempt: true, assertCurrent };
  }
  if (isNotApplicableGap(context, objectProfiles)) return { action: 'suppress', reason: 'The gap is not applicable to the linked subject.', assertCurrent };
  if (!hasConcreteSubject(context, objectProfiles)) {
    return { action: 'skip', reason: 'Gap has no concrete source or subject for automatic repair.', status: 'needs_context', markAttempt: true, assertCurrent };
  }
  if (context.sources.length === 0 && context.linkedObjects.length === 0) {
    return { action: 'skip', reason: 'Gap has no source context for automatic repair.', status: 'needs_context', markAttempt: true, assertCurrent };
  }
  return { action: 'repair', assertCurrent };
}

function isDefaultUnanchoredAnswerGap(context: GapContext): boolean {
  return getKnowledgeSpaceId(context.gap) === DEFAULT_KNOWLEDGE_SPACE_ID
    && readString(context.gap.metadata.semanticKind) === 'gap'
    && readString(context.gap.metadata.gapKind) === 'answer'
    && context.linkedObjects.length === 0;
}

export async function linkRepairSources(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
  query: string,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  shouldStop: () => boolean = () => false,
  signal?: AbortSignal,
): Promise<number> {
  const guard = createSemanticWriteGuard(store, signal, shouldStop);
  guard.watch('repair-link-edges', () => store.listEdges());
  const sources = [...new Set(sourceIds)].flatMap(id => {
    const source = guard.source(id);
    return source && getKnowledgeSpaceId(source) === spaceId ? [source] : [];
  });
  const selection = await repairSubjectsForGap(store, spaceId, gap, objectProfiles, shouldStop, signal, sourceIds);
  const assertCurrent = () => { guard.assertCurrent(); selection.assertCurrent(); };
  const edges = sources.flatMap(source => [
    { fromKind: 'source' as const, fromId: source.id, toKind: 'node' as const, toId: gap.id,
      relation: REPAIRS_GAP_RELATION, weight: 0.8,
      metadata: semanticMetadata(spaceId, { query, repairedAt: Date.now() }) },
    ...selection.nodes.map(node => ({ fromKind: 'source' as const, fromId: source.id,
      toKind: 'node' as const, toId: node.id, relation: 'source_for', weight: 0.78,
      metadata: semanticMetadata(spaceId, { query, linkedBy: 'semantic-gap-repair', repairedAt: Date.now() }) })),
  ]);
  assertCurrent();
  await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
    nodes: [], edges, issues: [], assertCurrent,
  }), { requireAccepted: true, signal });
  return sources.length;
}

function gapMatchesSourceFilter(
  gap: KnowledgeNodeRecord,
  sourceIdFilter: ReadonlySet<string>,
  edges: readonly KnowledgeEdgeRecord[],
): boolean {
  if (gap.sourceId && sourceIdFilter.has(gap.sourceId)) return true;
  if (readStringArray(gap.metadata.sourceIds).some((sourceId) => sourceIdFilter.has(sourceId))) return true;
  return edges.some((edge) => (
    edge.fromKind === 'source'
    && sourceIdFilter.has(edge.fromId)
    && edge.toKind === 'node'
    && edge.toId === gap.id
  ));
}

function hasRepairEdge(context: GapContext): boolean {
  return context.repairSourceIds.length > 0;
}

function repairEvidenceCandidates(context: GapContext): KnowledgeNodeRecord[] {
  const repairSourceIds = new Set(context.repairSourceIds);
  const subjectIds = new Set(context.linkedObjects.map((node) => node.id));
  const usableFacts = context.facts.filter((fact) => (
    fact.sourceId
    && repairSourceIds.has(fact.sourceId)
    && readString(fact.metadata.extractor) === 'repair-promotion'
    && isSelfImprovementFactCandidate(fact, subjectIds)
  ));
  return usableFacts;
}

function isNotApplicableGap(context: GapContext, objectProfiles: readonly KnowledgeObjectProfilePolicy[]): boolean {
  const text = `${context.gap.title} ${context.gap.summary ?? ''}`.toLowerCase();
  const suppressedByProfile = matchingObjectProfiles(context.linkedObjects, objectProfiles)
    .flatMap((profile) => profile.suppressedGapKinds ?? [])
    .some((kind) => kind.trim().length > 0 && text.includes(kind.trim().toLowerCase()));
  if (suppressedByProfile) return true;
  if (text.includes('battery')) {
    return context.linkedObjects.length > 0
      && !/\b(remote|controller|accessory|handset)\b/.test(text)
      && context.linkedObjects.every((node) => !batteryCanBeIntrinsicToSubject(node));
  }
  return false;
}

function batteryCanBeIntrinsicToSubject(node: KnowledgeNodeRecord): boolean {
  if (node.metadata.batteryPowered === true) return true;
  const batteryType = readString(node.metadata.batteryType);
  if (batteryType && batteryType !== 'none') return true;
  const text = `${node.kind} ${node.title} ${node.summary ?? ''} ${node.aliases.join(' ')} ${JSON.stringify(node.metadata)}`.toLowerCase();
  return /\b(battery|button|keypad|leak sensor|motion sensor|contact sensor|door sensor|window sensor|remote|lock|thermostat|phone|watch|handheld|portable|ble beacon|ibeacon|tag)\b/.test(text);
}

function hasConcreteSubject(context: GapContext, objectProfiles: readonly KnowledgeObjectProfilePolicy[]): boolean {
  return context.linkedObjects.some((node) => {
    if (isConcreteRepairSubject(node, objectProfiles)) return true;
    return Boolean(readString(node.metadata.manufacturer) && readString(node.metadata.model));
  }) || context.sources.some((source) => Boolean(source.title || source.url || source.sourceUri || source.canonicalUri));
}

async function repairSubjectsForGap(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  shouldStop: () => boolean, signal?: AbortSignal, evidenceSourceIds: readonly string[] = [],
) {
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const edges = graph.edges;
  const nodesById = graph.nodesById;
  const sourceIds = uniqueStrings([
    gap.sourceId,
    ...readStringArray(gap.metadata.sourceIds),
    ...edges
      .filter((edge) => edge.toKind === 'node' && edge.toId === gap.id && edge.fromKind === 'source')
      .map((edge) => edge.fromId),
  ]);
  const guard = captureRepairSubjectReadSet(store, gap, evidenceSourceIds, signal, shouldStop);
  const selected = await canonicalRepairSubjectNodes({ store, spaceId, context: { gap }, shouldStop, signal,
    evidenceSources: uniqueStrings([...sourceIds, ...evidenceSourceIds]).map(id => store.getSource(id)).filter((source): source is KnowledgeSourceRecord => source !== null),
    text: `${gap.title} ${gap.summary ?? ''}`,
    objectProfiles,
    nodes: [
      ...readStringArray(gap.metadata.linkedObjectIds).map((nodeId) => nodesById.get(nodeId)),
      ...edges
        .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id)
        .map((edge) => nodesById.get(edge.fromId)),
      ...sourceIds.flatMap((sourceId) => linkedObjectsForSource(sourceId, edges, nodesById)),
    ],
  });
  const assertCurrent = () => { guard.assertCurrent(); selected.assertCurrent(); };
  assertCurrent(); return { nodes: selected.nodes, assertCurrent };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
