import { knowledgeRawRepresentation } from '../store-record-representation.js';
import { prepareGeneratedKnowledgeNodeIdentity } from '../source-structural-references.js';
import { createSemanticWriteGuard } from './primary-source-plan.js';
import { KnowledgeRepairFactUsefulnessHeldError } from './repair-usefulness/types.js';
import { createKnowledgeFactQualityReader, type KnowledgeFactQualityPlan } from './fact-quality.js';
import { canonicalRepairSubjectNodes } from './repair-subjects.js';
import { prepareSelfImprovementAssessment } from './self-improvement-assessment/plan.js';
import { prepareObservedKnowledgeNodeInput } from '../store-node-observation.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { yieldEvery } from '../cooperative.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import {
  factsForObject,
  factsForSource,
  isSelfImprovementFactCandidate,
  linkedObjectsForSource,
  sourcesForObject,
  subjectTitle,
} from './self-improvement-graph.js';
import {
  readString,
  semanticHash,
  semanticMetadata,
  semanticSlug,
} from './utils.js';

export async function discoverIntrinsicGaps(
  store: KnowledgeStore,
  spaceId: string,
  sourceIdFilter: ReadonlySet<string> | null,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  signal?: AbortSignal,
  shouldStop?: () => boolean,
): Promise<number> {
  const graph = await buildKnowledgeSemanticGraphIndex(store, spaceId, { signal, shouldStop,
    nodeIds: store.listNodesInSpace(spaceId).filter(node => node.kind !== 'knowledge_gap').map(node => node.id) });
  const edges = graph.edges;
  const sourcesById = new Map([...graph.sourcesById.values()]
    .filter((source) => source.status === 'indexed')
    .filter((source) => !isGeneratedKnowledgeSource(source))
    .filter((source) => !sourceIdFilter || sourceIdFilter.has(source.id))
    .map((source) => [source.id, source]));
  const nodesById = graph.nodesById;
  const createdIds = new Set<string>();
  let created = 0;
  let sourceIndex = 0;

  for (const source of sourcesById.values()) {
    await yieldEvery(sourceIndex++);
    const linkedObjects = linkedObjectsForSource(source.id, edges, nodesById);
    const facts = factsForSource(source.id, edges, nodesById);
    const selection = await canonicalRepairSubjectNodes({ store, spaceId, context: { source }, nodes: linkedObjects,
      text: 'Which supplied subjects need a complete intrinsic feature and specification profile?', objectProfiles,
      signal, shouldStop, assertCurrent: graph.assertCurrent });
    for (const [subjectIndex, subject] of selection.nodes.entries()) {
      await yieldEvery(subjectIndex, 16);
      const quality = await prepareQuality(store, spaceId, subject, facts, signal, shouldStop, selection.assertCurrent);
      const coverage = await intrinsicCoverage(store, spaceId, subject, quality, [source], objectProfiles, signal, shouldStop);
      if (coverage.sufficient) continue;
      if (await upsertIntrinsicFeatureGap(store, spaceId, subject, [source], createdIds, coverage.assertCurrent)) created += 1;
    }
  }

  if (!sourceIdFilter) {
    let subjectIndex = 0;
    for (const subject of nodesById.values()) {
      await yieldEvery(subjectIndex++);
      const sourceList = sourcesForObject(subject.id, edges, sourcesById);
      const selection = await canonicalRepairSubjectNodes({ store, spaceId, context: { subject }, nodes: [subject], evidenceSources: sourceList,
        text: `What are the complete features and specifications for ${subjectTitle(subject)}?`, objectProfiles,
        signal, shouldStop, assertCurrent: graph.assertCurrent });
      if (selection.nodes.length === 0) continue;
      const facts = [
        ...sourceList.flatMap((source) => factsForSource(source.id, edges, nodesById)),
        ...factsForObject(subject.id, edges, nodesById),
      ];
      const quality = await prepareQuality(store, spaceId, subject, facts, signal, shouldStop, selection.assertCurrent);
      const coverage = await intrinsicCoverage(store, spaceId, subject, quality, sourceList, objectProfiles, signal, shouldStop);
      if (coverage.sufficient) continue;
      if (await upsertIntrinsicFeatureGap(store, spaceId, subject, sourceList, createdIds, coverage.assertCurrent)) created += 1;
    }
  }

  return created;
}

async function upsertIntrinsicFeatureGap(
  store: KnowledgeStore,
  spaceId: string,
  subject: KnowledgeNodeRecord,
  sources: readonly KnowledgeSourceRecord[],
  createdIds: Set<string>,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  const identity = prepareGeneratedKnowledgeNodeIdentity(store, 'sem-intrinsic-gap', [spaceId, subject.id, 'features-specifications']);
  const id = identity.id;
  if (createdIds.has(id)) return false;
  createdIds.add(id);
  const existing = store.getNode(id);
  const title = `What are the complete features and specifications for ${subjectTitle(subject)}?`;
  const primarySource = sources[0]!;
  const gapInput = prepareObservedKnowledgeNodeInput(store, {
      id,
      kind: 'knowledge_gap',
      slug: semanticSlug(`${spaceId}-intrinsic-gap-${subject.title}`),
      title,
      summary: `The current source-backed facts for ${subjectTitle(subject)} do not yet cover the full feature/specification profile.`,
      aliases: [subject.title, ...subject.aliases],
      confidence: 75,
      ...(primarySource ? { sourceId: primarySource.id } : {}),
      metadata: semanticMetadata(spaceId, {
        // Carry the complete stored original, including owned clock strings and
        // unknown caller fields. Regenerated semantic fields still win below.
        ...knowledgeRawRepresentation(existing?.metadata ?? {}),
        semanticKind: 'gap',
        gapKind: 'intrinsic_features',
        subject: subject.title,
        sourceIds: sources.map((source) => source.id),
        linkedObjectIds: [subject.id],
        repairStatus: readString(existing?.metadata.repairStatus) ?? 'open',
        createdBy: 'semantic-self-improvement',
      }),
    }, 'research-task', subject, () => { assertCurrent(); return store.getNode(subject.id); });
  const edges: import('../types.js').KnowledgeEdgeUpsertInput[] = sources.map((source) => ({
        fromKind: 'source' as const,
        fromId: source.id,
        toKind: 'node' as const,
        toId: id,
        relation: 'has_gap',
        metadata: semanticMetadata(spaceId, { intrinsic: true }),
      }));
  edges.push({
      fromKind: 'node',
      fromId: subject.id,
      toKind: 'node',
      toId: id,
      relation: 'has_gap',
      metadata: semanticMetadata(spaceId, { intrinsic: true }),
    });
  const issue = {
      id: `sem-intrinsic-gap-issue-${semanticHash(spaceId, subject.id, 'features-specifications')}`,
      severity: 'info' as const,
      code: 'knowledge.intrinsic_gap',
      message: title,
      status: 'open' as const,
      ...(primarySource ? { sourceId: primarySource.id } : {}),
      nodeId: id,
      metadata: semanticMetadata(spaceId, {
        namespace: `knowledge:${spaceId}:semantic`,
        subjectId: subject.id,
        gapKind: 'intrinsic_features',
      }),
    };
  const existingVersion = JSON.stringify(existing);
  const published = await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
    nodes: [gapInput], edges, issues: [issue], assertCurrent: () => {
      assertCurrent();
      if (store.getNode(id) !== existing || JSON.stringify(store.getNode(id)) !== existingVersion) throw new KnowledgeRepairFactUsefulnessHeldError('stale');
    },
  }));
  const node = published.nodes.find(node => node.id === id);
  if (!node) throw new KnowledgeRepairFactUsefulnessHeldError('stale');
  identity.retain(node);
  return !existing;
}

async function prepareQuality(store: KnowledgeStore, spaceId: string, subject: KnowledgeNodeRecord, facts: readonly KnowledgeNodeRecord[], signal?: AbortSignal, shouldStop?: () => boolean, assertScopeCurrent?: () => void) {
  const guard = createSemanticWriteGuard(store, signal, shouldStop);
  guard.watch('intrinsic-scope', () => { assertScopeCurrent?.(); return true; });
  const reader = createKnowledgeFactQualityReader(store, { spaceId, query: `What are the complete features and specifications for ${subjectTitle(subject)}?`,
    purpose: 'repair', subjects: [subject], signal, guard });
  return reader.prepare([...new Map(facts.filter((fact) => isSelfImprovementFactCandidate(fact)).map((fact) => [fact.id, fact])).values()]);
}

async function intrinsicCoverage(store: KnowledgeStore, spaceId: string, subject: KnowledgeNodeRecord,
  quality: KnowledgeFactQualityPlan, sources: readonly KnowledgeSourceRecord[], objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  signal?: AbortSignal, shouldStop?: () => boolean) {
  const coverage = await prepareSelfImprovementAssessment({ kind: 'coverage', store, spaceId,
    query: `What are the complete features and specifications for ${subjectTitle(subject)}?`, subjects: [subject], sources,
    facts: quality.facts, objectProfiles, signal, shouldStop, assertCurrent: quality.assertCurrent });
  if (coverage.kind !== 'coverage') throw new KnowledgeRepairFactUsefulnessHeldError('malformed');
  coverage.assertCurrent(); return coverage;
}
