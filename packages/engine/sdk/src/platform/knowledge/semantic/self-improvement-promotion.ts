import { sleep, yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { hasConcreteFeatureSignal, isLowValueFeatureOrSpecText, semanticFactText } from './fact-quality.js';
import { deriveRepairProfileFacts, type RepairProfileFact } from './repair-profile.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import { factsForSource, linkedObjectsForSource } from './self-improvement-graph.js';
import { updateRefinementTask } from './self-improvement-tasks.js';
import { withTimeout } from './timeouts.js';
import { canonicalRepairSubjectNodes, repairSubjectHints } from './repair-subjects.js';
import {
  classifyRepairFact,
  selectRepairFactSentences,
  sourceAuthority,
  type RepairFactClassification,
} from './repair-fact-selection.js';
import { isKnowledgeSourceQualityFailure, KnowledgeSourceQualityHeldError } from '../source-quality.js';
import { createSemanticPrimarySourcePlanner, createSemanticWriteGuard } from './primary-source-plan.js';
import {
  normalizeWhitespace,
  readRecord,
  readString,
  readStringArray,
  semanticFactId,
  semanticMetadata,
  semanticSlug,
  sourceSemanticText,
  uniqueStrings,
} from './utils.js';

export interface SelfImprovePromotionContext {
  readonly store: KnowledgeStore;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
  readonly enrichSource?: (sourceId: string, options: { readonly force?: boolean; readonly knowledgeSpaceId?: string }) => Promise<unknown>;
}

export interface PromoteRepairSourcesResult {
  readonly promotedFactCount: number;
  readonly repairComplete: boolean;
  readonly promotedSourceIds: readonly string[];
}

const REPAIR_SOURCE_TEXT_WAIT_MS = 1_500;

export async function promoteRepairSources(
  context: SelfImprovePromotionContext,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
  task: KnowledgeRefinementTaskRecord,
  deadlineAt: number,
): Promise<PromoteRepairSourcesResult> {
  const targetUsableFactCount = repairTargetUsableFactCount(gap);
  const subjects = linkedRepairSubjects(context.store, spaceId, gap, context.objectProfiles ?? []);
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const processedSourceIds: string[] = [];
  if (context.enrichSource) {
    for (const [index, sourceId] of sourceIds.entries()) {
      await yieldEvery(index, 2);
      processedSourceIds.push(sourceId);
      await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
      if (countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds) >= targetUsableFactCount) break;
      await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId]);
      await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
      if (countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds) >= targetUsableFactCount) break;
      await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
      await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId]);
      await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
      if (countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds) >= targetUsableFactCount) break;
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs < 1_000) break;
      try {
        await withTimeout(
          context.enrichSource(sourceId, { knowledgeSpaceId: spaceId, force: true }),
          Math.min(remainingMs, 20_000),
          'Semantic repair source enrichment exceeded its run budget.',
        );
      } catch (error) {
        // Earlier settled promotion/link passes stand; this hold must not start a fallback pass.
        if (isKnowledgeSourceQualityFailure(error)) throw error;
        await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
        await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId]);
        await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
        await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Repair source enrichment did not finish for one accepted source.', {
          sourceId,
          enrichmentError: error instanceof Error ? error.message : String(error),
          promotedSourceIds: processedSourceIds,
          promotedFactCount: countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds),
        });
        if (deadlineAt - Date.now() < 1_000) break;
        continue;
      }
      await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
      await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId]);
      await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, [sourceId]);
      if (countUsableRepairFacts(context.store, spaceId, processedSourceIds, subjectIds) >= targetUsableFactCount) break;
      await yieldToEventLoop();
    }
  }
  const promotionSourceIds = processedSourceIds.length > 0 ? uniqueStrings(processedSourceIds) : sourceIds;
  const promotedFactCount = processedSourceIds.length > 0
    ? 0
    : await promoteRepairEvidenceFacts(context.store, spaceId, gap, sourceIds);
  await linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, promotionSourceIds);
  const usableFactCount = promotedFactCount > 0
    ? promotedFactCount
    : countUsableRepairFacts(context.store, spaceId, promotionSourceIds, subjectIds);
  const repairComplete = usableFactCount >= targetUsableFactCount;
  if (repairComplete) {
    await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'verified', 'Accepted repair sources were semantically enriched.', {
      promotedSourceIds: promotionSourceIds,
      promotedFactCount: usableFactCount,
    });
  } else if (usableFactCount > 0) {
    await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Accepted repair sources yielded partial subject-linked facts.', {
      promotedSourceIds: promotionSourceIds,
      promotedFactCount: usableFactCount,
      targetPromotedFactCount: targetUsableFactCount,
    });
  } else {
    await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Accepted repair sources did not yield usable subject-linked facts.', {
      promotedSourceIds: promotionSourceIds,
      promotedFactCount: usableFactCount,
    });
  }
  return { promotedFactCount: usableFactCount, repairComplete, promotedSourceIds: promotionSourceIds };
}

function repairTargetUsableFactCount(gap: KnowledgeNodeRecord): number {
  const text = `${gap.title} ${gap.summary ?? ''}`.toLowerCase();
  if (/\b(complete|full|features?|capabilities|specifications?|profile)\b/.test(text)) return 3;
  return 1;
}

async function waitForRepairSourceText(
  store: KnowledgeStore,
  sourceId: string,
  deadlineAt: number,
): Promise<void> {
  while (deadlineAt - Date.now() >= 1_000) {
    const source = store.getSource(sourceId);
    if (!source) return;
    const extraction = store.getExtractionBySourceId(source.id);
    if (extractedSemanticText(extraction).length >= 40) return;
    if (!sourceRequiresExtractedEvidence(source) && sourceSemanticText(source, extraction).length >= 80) return;
    await yieldToEventLoop();
    await sleep(100);
  }
}

function extractedSemanticText(extraction: ReturnType<KnowledgeStore['getExtractionBySourceId']>): string {
  const structure = readRecord(extraction?.structure);
  const nestedStructure = readRecord(structure.structure);
  const metadata = readRecord(extraction?.metadata);
  const nestedMetadata = readRecord(structure.metadata);
  return normalizeWhitespace([
    extraction?.excerpt,
    ...(extraction?.sections ?? []),
    readString(structure.searchText),
    readString(structure.text),
    readString(structure.content),
    readString(nestedStructure.searchText),
    readString(nestedStructure.text),
    readString(nestedStructure.content),
    readString(metadata.searchText),
    readString(metadata.text),
    readString(nestedMetadata.searchText),
    readString(nestedMetadata.text),
  ].filter(Boolean).join(' '));
}

function sourceRequiresExtractedEvidence(source: KnowledgeSourceRecord): boolean {
  return Boolean(source.url || source.sourceUri || source.canonicalUri);
}

function repairSourceEvidenceText(
  source: KnowledgeSourceRecord,
  extraction: ReturnType<KnowledgeStore['getExtractionBySourceId']>,
): string {
  const extracted = extractedSemanticText(extraction);
  return extracted.length >= 40 ? extracted : sourceSemanticText(source, extraction);
}

async function promoteRepairEvidenceFacts(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
): Promise<number> {
  const guard = createSemanticWriteGuard(store);
  // Repeated foreground reads may upsert the identical gap while search runs.
  // Rebase only that timestamp; every intent/provenance/status field must match,
  // and the complete current row is guarded through subsequent judgment awaits.
  const currentGap = store.getNode(gap.id);
  guard.watch(`node:${gap.id}`, () => store.getNode(gap.id), { ...gap, updatedAt: currentGap?.updatedAt ?? gap.updatedAt });
  guard.watch('repair-subjects', () => linkedRepairSubjects(store, spaceId, gap, []));
  const subjects = linkedRepairSubjects(store, spaceId, gap, []);
  if (subjects.length === 0) return 0;
  const inputs: SourceLinkedRepairProfileFactInput[] = [];
  for (const sourceId of sourceIds) {
    const source = store.getSource(sourceId);
    if (!source || getKnowledgeSpaceId(source) !== spaceId) continue;
    const extraction = store.getExtractionBySourceId(source.id);
    const authority = sourceAuthority(source);
    const text = repairSourceEvidenceText(source, extraction);
    if (text.length < 40) continue;
    const profileFacts = deriveRepairProfileFacts({
      query: gap.title,
      source,
      text,
    });
    for (const profileFact of profileFacts) {
      inputs.push(promotedRepairFactInput({
        store,
        spaceId,
        gap,
        source,
        subjects,
        authority,
        title: profileFact.title,
        summary: profileFact.summary,
        classification: profileFact,
        evidence: profileFact.evidence,
      }));
    }
    const sentences = selectRepairFactSentences({
      query: gap.title,
      source,
      text,
    });
    for (const sentence of sentences) {
      const classification = classifyRepairFact(sentence);
      if (!classification) continue;
      inputs.push(promotedRepairFactInput({
        store,
        spaceId,
        gap,
        source,
        subjects,
        authority,
        title: classification.title,
        summary: classification.summary,
        classification,
        evidence: sentence,
      }));
    }
  }
  const prepared = await prepareSourceLinkedRepairProfileFacts(inputs);
  await store.batch(async () => {
    guard.assertCurrent();
    prepared.assertCurrent();
    await prepared.write();
  });
  return inputs.length;
}

function promotedRepairFactInput(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly gap: KnowledgeNodeRecord;
  readonly source: KnowledgeSourceRecord;
  readonly subjects: readonly KnowledgeNodeRecord[];
  readonly authority: 'official-vendor' | 'vendor' | 'secondary';
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly classification: RepairFactClassification | RepairProfileFact;
}): SourceLinkedRepairProfileFactInput {
  return {
    store: input.store,
    spaceId: input.spaceId,
    source: input.source,
    subjects: input.subjects,
    authority: input.authority,
    title: input.title,
    summary: input.summary,
    evidence: input.evidence,
    classification: input.classification,
    extractor: 'repair-promotion',
    factMetadata: {
      gapId: input.gap.id,
      sourceDiscovery: readRecord(input.source.metadata.sourceDiscovery),
    },
    edgeMetadata: {
      linkedBy: 'semantic-gap-repair',
      gapId: input.gap.id,
    },
  };
}

export interface SourceLinkedRepairProfileFactInput {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly source: KnowledgeSourceRecord;
  readonly subjects: readonly KnowledgeNodeRecord[];
  readonly authority: 'official-vendor' | 'vendor' | 'secondary';
  readonly title: string;
  readonly summary: string;
  readonly evidence: string;
  readonly classification: RepairFactClassification | RepairProfileFact;
  readonly extractor: string;
  readonly confidence?: number | undefined;
  readonly supportWeight?: number | undefined;
  readonly describesWeight?: number | undefined;
  readonly factMetadata?: Record<string, unknown> | undefined;
  readonly edgeMetadata?: Record<string, unknown> | undefined;
  readonly metadataBuilder?: ((metadata: Record<string, unknown>) => Record<string, unknown>) | undefined;
}

export interface PreparedSourceLinkedRepairProfileFact {
  readonly input: SourceLinkedRepairProfileFactInput;
  readonly factId: string;
  readonly sourceIds: readonly string[];
  readonly primarySourceId: string;
}
export interface PreparedSourceLinkedRepairProfileFacts {
  readonly plans: readonly PreparedSourceLinkedRepairProfileFact[];
  readonly assertCurrent: () => void;
  readonly write: () => Promise<KnowledgeNodeRecord[]>;
}

/** Resolve the entire pass before opening a batch. write() performs no judgments. */
export async function prepareSourceLinkedRepairProfileFacts(
  inputs: readonly SourceLinkedRepairProfileFactInput[],
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<PreparedSourceLinkedRepairProfileFacts> {
  if (options.signal?.aborted) throw new KnowledgeSourceQualityHeldError('aborted');
  const store = inputs[0]?.store;
  if (!store) return { plans: [], assertCurrent() {}, async write(): Promise<KnowledgeNodeRecord[]> { return []; } };
  const guard = createSemanticWriteGuard(store, options.signal);
  const planner = createSemanticPrimarySourcePlanner(store, guard, options.signal);
  const virtualSources = new Map<string, readonly string[]>();
  const drafts = inputs.map((original) => {
    const { store: inputStore, metadataBuilder, ...data } = original;
    const input: SourceLinkedRepairProfileFactInput = Object.freeze({
      ...freezePlanData(structuredClone(data)), store: inputStore, metadataBuilder,
    });
    if (input.store !== store) throw new TypeError('A prepared repair fact pass must use one store.');
    guard.watch(`source:${input.source.id}`, () => store.getSource(input.source.id), input.source);
    guard.extraction(input.source.id);
    for (const subject of input.subjects) guard.watch(`node:${subject.id}`, () => store.getNode(subject.id), subject);
    const subjectIds = input.subjects.map((subject) => subject.id);
    const factId = semanticFactId({ spaceId: input.spaceId, kind: input.classification.kind,
      title: input.title, value: input.classification.value, summary: input.summary, subjectIds, fallbackScope: input.source.id });
    const existingFact = guard.node(factId);
    const sourceIds = uniqueStrings([
      ...(virtualSources.get(factId) ?? readStringArray(existingFact?.metadata.sourceIds)),
      readString(existingFact?.metadata.sourceId), existingFact?.sourceId, input.source.id,
    ]);
    virtualSources.set(factId, sourceIds);
    const resolve = planner.prepare(input.spaceId, {
      kind: input.classification.kind, title: input.title, summary: input.summary,
      value: input.classification.value, evidence: input.evidence,
      subjects: input.subjects.map(({ id, title, kind }) => ({ id, title, kind })),
    }, sourceIds);
    return { input, factId, sourceIds, resolve };
  });
  const factIds = new Set(drafts.map((draft) => draft.factId));
  guard.watch('support-edges', () => store.listEdges().filter((edge) =>
    (edge.toKind === 'node' && factIds.has(edge.toId)) || (edge.fromKind === 'node' && factIds.has(edge.fromId))));
  const plans: PreparedSourceLinkedRepairProfileFact[] = [];
  for (const { input, factId, sourceIds, resolve } of drafts) plans.push(Object.freeze({
    input, factId, sourceIds: Object.freeze([...sourceIds]), primarySourceId: await resolve(),
  }));
  guard.assertCurrent();
  return {
    plans: Object.freeze(plans),
    assertCurrent: guard.assertCurrent,
    async write(): Promise<KnowledgeNodeRecord[]> {
      // Callers may have awaited other prepared work since this plan resolved.
      // Validate once at entry, before this pass intentionally changes its rows.
      guard.assertCurrent();
      const facts: KnowledgeNodeRecord[] = [];
      for (const plan of plans) facts.push(await writeResolvedSourceLinkedRepairProfileFact(plan));
      return facts;
    },
  };
}

function freezePlanData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezePlanData(nested);
    Object.freeze(value);
  }
  return value;
}

export async function upsertSourceLinkedRepairProfileFact(input: SourceLinkedRepairProfileFactInput): Promise<KnowledgeNodeRecord> {
  const prepared = await prepareSourceLinkedRepairProfileFacts([input]);
  return input.store.batch(async () => {
    prepared.assertCurrent();
    return (await prepared.write())[0]!;
  });
}

async function writeResolvedSourceLinkedRepairProfileFact(plan: PreparedSourceLinkedRepairProfileFact): Promise<KnowledgeNodeRecord> {
  const { input, factId, sourceIds, primarySourceId } = plan;
  const subjectIds = input.subjects.map((subject) => subject.id);
  const metadataBuilder = input.metadataBuilder ?? ((metadata: Record<string, unknown>) => semanticMetadata(input.spaceId, metadata));
  const confidence = input.confidence ?? (input.authority === 'official-vendor' ? 90 : input.authority === 'vendor' ? 82 : 76);
  const supportWeight = input.supportWeight ?? (input.authority === 'official-vendor' ? 0.96 : 0.84);
  const describesWeight = input.describesWeight ?? (input.authority === 'official-vendor' ? 0.95 : 0.82);
  const fact = await input.store.upsertNode({
    id: factId,
    kind: 'fact',
    slug: semanticSlug(`${input.spaceId}-${input.title}-${input.summary}-${input.source.id}`),
    title: input.title,
    summary: input.summary,
    aliases: input.classification.aliases,
    status: 'active',
    confidence,
    sourceId: primarySourceId,
    metadata: metadataBuilder({
      semanticKind: 'fact',
      factKind: input.classification.kind,
      value: input.classification.value,
      evidence: input.evidence,
      labels: input.classification.labels,
      sourceId: primarySourceId,
      sourceIds,
      subject: input.subjects[0]?.title,
      subjectIds,
      targetHints: repairSubjectHints(input.subjects),
      linkedObjectIds: subjectIds,
      extractor: input.extractor,
      sourceAuthority: input.authority,
      ...(input.factMetadata ?? {}),
    }),
  });
  await input.store.upsertEdge({
    fromKind: 'source',
    fromId: input.source.id,
    toKind: 'node',
    toId: fact.id,
    relation: 'supports_fact',
    weight: supportWeight,
    metadata: metadataBuilder(input.edgeMetadata ?? {}),
  });
  for (const subject of input.subjects) {
    await input.store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: subject.id,
      relation: 'describes',
      weight: describesWeight,
      metadata: metadataBuilder({
        ...(input.edgeMetadata ?? {}),
        repairedAt: Date.now(),
        sourceId: input.source.id,
      }),
    });
  }
  return fact;
}

async function linkPromotedFactsToRepairSubjects(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
): Promise<void> {
  const subjects = linkedRepairSubjects(store, spaceId, gap, []);
  if (subjects.length === 0) return;
  const linkedObjectIds = subjects.map((subject) => subject.id);
  const targetHints = repairSubjectHints(subjects);
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const edges = graph.edges;
  const nodesById = graph.nodesById;
  for (const sourceId of sourceIds) {
    await store.batch(async () => {
      for (const fact of factsForSource(sourceId, edges, nodesById)) {
        if (!isUsableRepairFact(fact) || !isRepairFactCompatibleWithSubjects(fact, subjects)) continue;
        await store.upsertNode({
          id: fact.id,
          kind: fact.kind,
          slug: fact.slug,
          title: fact.title,
          summary: fact.summary,
          aliases: fact.aliases,
          status: fact.status,
          confidence: fact.confidence,
          sourceId: fact.sourceId ?? sourceId,
          metadata: semanticMetadata(spaceId, {
            ...fact.metadata,
            subject: readString(fact.metadata.subject) ?? subjects[0]?.title,
            subjectIds: uniqueStrings([...readStringArray(fact.metadata.subjectIds), ...linkedObjectIds]),
            linkedObjectIds: uniqueStrings([...readStringArray(fact.metadata.linkedObjectIds), ...linkedObjectIds]),
            targetHints: uniqueTargetHints([
              ...readTargetHints(fact.metadata.targetHints),
              ...targetHints,
            ]),
            sourceId: fact.sourceId ?? sourceId,
            sourceIds: uniqueStrings([
              ...readStringArray(fact.metadata.sourceIds),
              readString(fact.metadata.sourceId),
              fact.sourceId,
              sourceId,
            ]),
            linkedBy: readString(fact.metadata.linkedBy) ?? 'semantic-gap-repair',
          }),
        });
        for (const objectId of linkedObjectIds) {
          await store.upsertEdge({
            fromKind: 'node',
            fromId: fact.id,
            toKind: 'node',
            toId: objectId,
            relation: 'describes',
            weight: 0.82,
            metadata: semanticMetadata(spaceId, {
              linkedBy: 'semantic-gap-repair',
              repairedAt: Date.now(),
              sourceId,
            }),
          });
        }
      }
    });
  }
}

function linkedRepairSubjects(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): KnowledgeNodeRecord[] {
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
  return canonicalRepairSubjectNodes({
    text: `${gap.title} ${gap.summary ?? ''}`,
    objectProfiles,
    nodes: [
      ...readStringArray(gap.metadata.linkedObjectIds).map((id) => nodesById.get(id)),
      ...edges
        .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id)
        .map((edge) => nodesById.get(edge.fromId)),
      ...sourceIds.flatMap((sourceId) => linkedObjectsForSource(sourceId, edges, nodesById)),
    ],
  });
}

function countUsableRepairFacts(
  store: KnowledgeStore,
  spaceId: string,
  sourceIds: readonly string[],
  subjectIds: ReadonlySet<string>,
): number {
  const sources = new Set(sourceIds);
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const sourceIdsByFactId = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.fromKind !== 'source' || edge.toKind !== 'node' || edge.relation !== 'supports_fact') continue;
    const current = sourceIdsByFactId.get(edge.toId) ?? new Set<string>();
    current.add(edge.fromId);
    sourceIdsByFactId.set(edge.toId, current);
  }
  return [...graph.nodesById.values()]
    .filter((node) => node.kind === 'fact' && node.status !== 'stale')
    .filter((node) => getKnowledgeSpaceId(node) === spaceId)
    .filter((node) => factSourceIds(node, sourceIdsByFactId).some((sourceId) => sources.has(sourceId)))
    .filter(isUsableRepairFact)
    .filter((node) => {
      if (subjectIds.size === 0) return true;
      const linkedIds = uniqueStrings([
        ...readStringArray(node.metadata.linkedObjectIds),
        ...readStringArray(node.metadata.subjectIds),
      ]);
      return linkedIds.some((id) => subjectIds.has(id));
    })
    .length;
}

function factSourceIds(
  fact: KnowledgeNodeRecord,
  sourceIdsByFactId: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): string[] {
  return uniqueStrings([
    ...readStringArray(fact.metadata.sourceIds),
    readString(fact.metadata.sourceId),
    fact.sourceId,
    ...(sourceIdsByFactId.get(fact.id) ?? []),
  ]);
}

function isUsableRepairFact(node: KnowledgeNodeRecord): boolean {
  if (!['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(readString(node.metadata.factKind) ?? '')) {
    return false;
  }
  const text = semanticFactText(node);
  return hasConcreteFeatureSignal(text) && !isLowValueFeatureOrSpecText(text);
}

function isRepairFactCompatibleWithSubjects(fact: KnowledgeNodeRecord, subjects: readonly KnowledgeNodeRecord[]): boolean {
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const existingIds = uniqueStrings([
    ...readStringArray(fact.metadata.linkedObjectIds),
    ...readStringArray(fact.metadata.subjectIds),
  ]);
  if (existingIds.length > 0) return existingIds.some((id) => subjectIds.has(id));
  const subject = readString(fact.metadata.subject);
  if (subject && !subjects.some((node) => textMatchesSubject(subject, node))) return false;
  const factModels = modelLikeTokens(`${fact.title} ${fact.summary ?? ''} ${readString(fact.metadata.value) ?? ''} ${readString(fact.metadata.evidence) ?? ''}`);
  if (factModels.length === 0) return true;
  const subjectModels = uniqueStrings(subjects.flatMap((node) => modelLikeTokens(`${node.title} ${node.aliases.join(' ')} ${readString(node.metadata.model) ?? ''}`)));
  return subjectModels.length === 0 || factModels.some((model) => subjectModels.includes(model));
}

function textMatchesSubject(value: string, subject: KnowledgeNodeRecord): boolean {
  const text = normalizeWhitespace(value).toLowerCase();
  const candidates = uniqueStrings([
    subject.title,
    ...subject.aliases,
    readString(subject.metadata.manufacturer),
    readString(subject.metadata.model),
  ]).map((entry) => entry.toLowerCase());
  return candidates.some((candidate) => candidate.length >= 3 && (text.includes(candidate) || candidate.includes(text)));
}

function modelLikeTokens(value: string): readonly string[] {
  return uniqueStrings([
    ...(value.match(/\b[A-Z]{2,}[-_ ]?[0-9][A-Z0-9._-]{2,}\b/g) ?? []),
    ...(value.match(/\b[0-9]{2,}[A-Z][A-Z0-9._-]{2,}\b/g) ?? []),
  ]
    .map((token) => token.replace(/[\s_-]+/g, '').toLowerCase())
    .filter((token) => !/^(hdr10|hdmi2(?:\.\d)?|usb[0-9]|wifi[0-9]|wi-fi[0-9]|atsc[0-9]?|ntsc|qam|rs232c?)$/.test(token)));
}

function readTargetHints(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function uniqueTargetHints(values: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const value of values) {
    const id = readString(value.id);
    const key = id ?? JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
