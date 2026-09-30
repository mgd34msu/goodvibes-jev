import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import { factsForSource } from './self-improvement-graph.js';
import { assertSemanticWriteAllowed, createSemanticWriteGuard } from './primary-source-plan.js';
import { createGeneratedFactWritePlanner, exactKnowledgeIds, generatedFactSupportMetadata } from './fact-support-write-plan.js';
import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';
import { repairSubjectHints } from './repair-subjects.js';
import { readString, readStringArray, semanticMetadata } from './utils.js';

/** Verify all existing facts and proposed attachments before this pass changes any. */
export async function writeSupportedRepairSubjectLinks(input: {
  readonly store: KnowledgeStore; readonly spaceId: string; readonly gap: KnowledgeNodeRecord;
  readonly subjects: readonly KnowledgeNodeRecord[]; readonly sourceIds: readonly string[];
  readonly candidate: (fact: KnowledgeNodeRecord) => boolean;
  readonly assertCurrent?: (() => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
}): Promise<void> {
  const { store, spaceId, subjects } = input;
  assertSemanticWriteAllowed(input.signal, input.shouldStop);
  input.assertCurrent?.();
  if (subjects.length === 0) return;
  const guard = createSemanticWriteGuard(store, input.signal, input.shouldStop);
  const support = createGeneratedFactWritePlanner(store, guard, { signal: input.signal });
  guard.node(input.gap.id);
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const selectedSourceIds = new Set(input.sourceIds);
  guard.watch('attachment-source-edges', () => store.listEdges().filter((edge) =>
    edge.fromKind === 'source' && selectedSourceIds.has(edge.fromId)));
  const byFact = new Map<string, { fact: KnowledgeNodeRecord; sources: string[]; fallback: string }>();
  for (const sourceId of input.sourceIds) for (const fact of new Map([
    ...factsForSource(sourceId, graph.edges, graph.nodesById),
    ...[...graph.nodesById.values()].filter((node) => node.kind === 'fact' && node.status !== 'stale'
      && exactKnowledgeIds([node.sourceId, readString(node.metadata.sourceId), ...readStringArray(node.metadata.sourceIds)]).includes(sourceId)),
  ].map((node) => [node.id, node])).values()) {
    if (!input.candidate(fact)) continue;
    if (getKnowledgeSpaceId(fact) !== spaceId) throw new KnowledgeGeneratedFactSupportHeldError('foreign-space');
    guard.watch(`node:${fact.id}`, () => store.getNode(fact.id), fact);
    const previous = byFact.get(fact.id);
    byFact.set(fact.id, { fact, fallback: sourceId, sources: exactKnowledgeIds([
      ...(previous?.sources ?? readStringArray(fact.metadata.sourceIds)),
      readString(fact.metadata.sourceId), fact.sourceId, sourceId,
    ]) });
  }
  const drafts = [...byFact.values()].map(({ fact, sources, fallback }) => {
    const subjectIds = exactKnowledgeIds([
      ...readStringArray(fact.metadata.subjectIds), ...readStringArray(fact.metadata.linkedObjectIds),
      ...subjects.map((subject) => subject.id),
    ]);
    const allSubjects = subjectIds.map((id) => {
      const subject = guard.node(id);
      if (!subject) throw new KnowledgeGeneratedFactSupportHeldError('missing-evidence');
      return subject;
    });
    const targetHints = repairSubjectHints(allSubjects);
    const subject = readString(fact.metadata.subject) ?? subjects[0]?.title;
    const key = support.add(spaceId, { id: fact.id, kind: readString(fact.metadata.factKind) ?? fact.kind,
      title: fact.title, summary: fact.summary, value: fact.metadata.value, evidence: fact.metadata.evidence,
      aliases: fact.aliases, labels: readStringArray(fact.metadata.labels), subject, targetHints,
    }, sources, allSubjects);
    return { fact, sources, primarySourceId: fact.sourceId ?? fallback, subjectIds, targetHints, subject, key };
  });
  const factIds = new Set(drafts.map((draft) => draft.fact.id));
  guard.watch('attachment-fact-edges', () => store.listEdges().filter((edge) =>
    (edge.fromKind === 'node' && factIds.has(edge.fromId)) || (edge.toKind === 'node' && factIds.has(edge.toId))));
  await support.readAll();
  const plans = drafts.map((draft) => {
    const supportMetadata = generatedFactSupportMetadata(support.plans(draft.key), draft.fact.metadata.generatedFactSupport);
    const nodeInput = { ...draft.fact, sourceId: draft.primarySourceId, metadata: semanticMetadata(spaceId, {
      ...draft.fact.metadata, subject: draft.subject, subjectIds: draft.subjectIds, linkedObjectIds: draft.subjectIds,
      targetHints: draft.targetHints, sourceId: draft.primarySourceId, sourceIds: draft.sources,
      generatedFactSupport: supportMetadata, linkedBy: readString(draft.fact.metadata.linkedBy) ?? 'semantic-gap-repair',
    }) };
    return { ...draft, supportMetadata, nodeInput };
  });
  const activation = await store.prepareNodeWrites(plans.map((plan) => plan.nodeInput), { signal: input.signal, requireAccepted: true });
  await store.batch(async () => {
    store.assertPreparedNodeWrites(activation);
    guard.assertCurrent();
    input.assertCurrent?.();
    for (const [index, { fact, primarySourceId, supportMetadata }] of plans.entries()) {
      assertSemanticWriteAllowed(input.signal, input.shouldStop);
      await store.upsertPreparedNode(activation, index);
      for (const object of subjects) await store.upsertEdge({
        fromKind: 'node', fromId: fact.id, toKind: 'node', toId: object.id,
        relation: 'describes', weight: 0.82,
        metadata: semanticMetadata(spaceId, { linkedBy: 'semantic-gap-repair', repairedAt: Date.now(),
          sourceId: primarySourceId, generatedFactSupport: supportMetadata }),
      });
    }
  });
}
