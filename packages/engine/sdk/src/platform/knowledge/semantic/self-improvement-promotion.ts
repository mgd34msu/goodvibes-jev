import { createSemanticNodeSlugPlanner } from './node-slug.js';
import { writeSupportedRepairSubjectLinks } from './repair-subject-write-plan.js';
import { withSupportBudget } from './support-budget.js';
import { sleep, yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { KnowledgeRepairFactUsefulnessHeldError } from './repair-usefulness/types.js';
import { createRepairFactUsefulnessReader } from './repair-usefulness/reader.js';
import { createRepairUsefulnessGuard, prepareRepairUsefulness, prepareProposedRepairUsefulness } from './repair-usefulness-plan.js';
import { deriveRepairProfileFactPass, repairProfileSourceText, repairProfileSubject, type RepairProfileFact } from './repair-profile.js';
import { captureKnowledgeSourceReferences } from '../source-structural-references.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import { factsForSource, linkedObjectsForSource } from './self-improvement-graph.js';
import { updateRefinementTask } from './self-improvement-tasks.js';
import { canonicalRepairSubjectNodes, repairSubjectHints } from './repair-subjects.js';
import {
  classifyRepairFact,
  selectRepairFactSentences,
  sourceAuthority,
  type RepairFactClassification,
} from './repair-fact-selection.js';
import { isKnowledgeSourceQualityFailure, KnowledgeSourceQualityHeldError } from '../source-quality.js';
import { assertSemanticWriteAllowed, createSemanticPrimarySourcePlanner, createSemanticWriteGuard } from './primary-source-plan.js';
import { createGeneratedFactWritePlanner, exactKnowledgeIds } from './fact-support-write-plan.js';
import { prepareRepairProfileWriteData, repairProfileNodeInput } from './repair-profile-write-data.js';
import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';
import {
  normalizeWhitespace,
  readRecord,
  readString,
  readStringArray,
  semanticFactId,
  semanticMetadata,
  sourceSemanticText,
  uniqueStrings,
} from './utils.js';

export interface SelfImprovePromotionContext {
  readonly shouldStop?: (() => boolean) | undefined;
  readonly store: KnowledgeStore;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
  readonly enrichSource?: (sourceId: string, options: { readonly force?: boolean; readonly knowledgeSpaceId?: string; readonly signal?: AbortSignal; readonly shouldStop?: (() => boolean) | undefined }) => Promise<unknown>;
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
  return withSupportBudget((signal) => promoteRepairSourcesWithinBudget(context, spaceId, gap, sourceIds, task, deadlineAt, signal), deadlineAt - Date.now());
}

async function promoteRepairSourcesWithinBudget(
  context: SelfImprovePromotionContext, spaceId: string, gap: KnowledgeNodeRecord, sourceIds: readonly string[],
  task: KnowledgeRefinementTaskRecord, deadlineAt: number, signal: AbortSignal,
): Promise<PromoteRepairSourcesResult> {
  assertSemanticWriteAllowed(signal, context.shouldStop);
  const targetUsableFactCount = repairTargetUsableFactCount(gap);
  const subjects = linkedRepairSubjects(context.store, spaceId, gap, context.objectProfiles ?? []);
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const usefulness = createRepairFactUsefulnessReader({ signal });
  const countUsable = (ids: readonly string[]) => countUsableRepairFacts(context.store, spaceId, ids, subjectIds,
    gap, subjects, usefulness, signal, context.shouldStop);
  const linkSubjects = (ids: readonly string[]) => linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, ids,
    usefulness, signal, context.shouldStop);
  const processedSourceIds: string[] = [];
  if (context.enrichSource) {
    for (const [index, sourceId] of sourceIds.entries()) {
      await yieldEvery(index, 2);
      assertSemanticWriteAllowed(signal, context.shouldStop);
      processedSourceIds.push(sourceId);
      await linkSubjects([sourceId]);
      if ((await countUsable(processedSourceIds)).count >= targetUsableFactCount) break;
      await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId], usefulness, signal, context.shouldStop);
      await linkSubjects([sourceId]);
      if ((await countUsable(processedSourceIds)).count >= targetUsableFactCount) break;
      await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
      await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId], usefulness, signal, context.shouldStop);
      await linkSubjects([sourceId]);
      if ((await countUsable(processedSourceIds)).count >= targetUsableFactCount) break;
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs < 1_000) break;
      try {
        const enrich = context.enrichSource;
        await withSupportBudget((childSignal) => enrich(sourceId, { knowledgeSpaceId: spaceId, force: true, signal: childSignal, shouldStop: context.shouldStop }),
          Math.min(remainingMs, 20_000), signal);
      } catch (error) {
        // Earlier settled promotion/link passes stand; this hold must not start a fallback pass.
        if (isKnowledgeSourceQualityFailure(error) || error instanceof KnowledgeGeneratedFactSupportHeldError) throw error;
        await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
        await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId], usefulness, signal, context.shouldStop);
        await linkSubjects([sourceId]);
        const recoveryUsefulness = await countUsable(processedSourceIds);
        await context.store.batch(async () => {
          recoveryUsefulness.assertCurrent();
          await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Repair source enrichment did not finish for one accepted source.', {
            sourceId, enrichmentError: error instanceof Error ? error.message : String(error),
            promotedSourceIds: processedSourceIds, promotedFactCount: recoveryUsefulness.count,
          });
        });
        if (deadlineAt - Date.now() < 1_000) break;
        continue;
      }
      await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
      await promoteRepairEvidenceFacts(context.store, spaceId, gap, [sourceId], usefulness, signal, context.shouldStop);
      await linkSubjects([sourceId]);
      if ((await countUsable(processedSourceIds)).count >= targetUsableFactCount) break;
      await yieldToEventLoop();
    }
  }
  assertSemanticWriteAllowed(signal, context.shouldStop);
  const promotionSourceIds = processedSourceIds.length > 0 ? uniqueStrings(processedSourceIds) : sourceIds;
  const promotedFactCount = processedSourceIds.length > 0
    ? 0
    : await promoteRepairEvidenceFacts(context.store, spaceId, gap, sourceIds, usefulness, signal, context.shouldStop);
  await linkSubjects(promotionSourceIds);
  const finalUsefulness = await countUsable(promotionSourceIds);
  const usableFactCount = promotedFactCount > 0 ? promotedFactCount : finalUsefulness.count;
  assertSemanticWriteAllowed(signal, context.shouldStop);
  const repairComplete = usableFactCount >= targetUsableFactCount;
  await context.store.batch(async () => {
    finalUsefulness.assertCurrent();
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
  });
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

async function promoteRepairEvidenceFacts(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
  reader: ReturnType<typeof createRepairFactUsefulnessReader>,
  signal?: AbortSignal, shouldStop?: () => boolean,
): Promise<number> {
  assertSemanticWriteAllowed(signal, shouldStop);
  const guard = createSemanticWriteGuard(store, signal, shouldStop);
  // Repeated foreground reads may upsert the identical gap while search runs.
  // Rebase only that timestamp; every intent/provenance/status field must match,
  // and the complete current row is guarded through subsequent judgment awaits.
  const currentGap = store.getNode(gap.id);
  guard.watch(`node:${gap.id}`, () => store.getNode(gap.id), { ...gap, updatedAt: currentGap?.updatedAt ?? gap.updatedAt });
  guard.watch('repair-subjects', () => linkedRepairSubjects(store, spaceId, gap, []));
  const subjects = linkedRepairSubjects(store, spaceId, gap, []);
  if (subjects.length === 0) return 0;
  const inputs: SourceLinkedRepairProfileFactInput[] = [];
  const entries = sourceIds.flatMap((sourceId) => {
    const source = guard.source(sourceId);
    if (!source || getKnowledgeSpaceId(source) !== spaceId) return [];
    const extraction = guard.extraction(source.id);
    if (!extraction) return [];
    const text = repairProfileSourceText(extraction);
    if (!text.trim()) return [];
    return [{ source, extraction, text, authority: sourceAuthority(source) }];
  });
  const profiles = await deriveRepairProfileFactPass(entries.map(({ source, extraction, text }) => ({
    query: gap.title, source, extraction, text, subjects: subjects.map(repairProfileSubject),
    structuralReferences: captureKnowledgeSourceReferences(store, source, extraction),
  })), { signal });
  guard.assertCurrent();
  for (const [index, { source, extraction, text, authority }] of entries.entries()) {
    const profileFacts = profiles[index]!;
    for (const profileFact of profileFacts) {
      inputs.push(promotedRepairFactInput({
        store,
        spaceId,
        gap,
        source,
        extraction,
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
      // A selected exact span already represents this evidence. Do not run it
      // through the separate legacy canonical-value classifier a second time.
      if (profileFacts.some((fact) => fact.evidence.split('\n\n').includes(sentence))) continue;
      const classification = classifyRepairFact(sentence);
      if (!classification) continue;
      inputs.push(promotedRepairFactInput({
        store,
        spaceId,
        gap,
        source,
        extraction,
        subjects,
        authority,
        title: classification.title,
        summary: classification.summary,
        classification,
        evidence: sentence,
      }));
    }
  }
  const usefulnessGuard = createRepairUsefulnessGuard(store, spaceId, gap, subjects, signal, shouldStop);
  const prepared = await prepareSourceLinkedRepairProfileFacts(inputs, { signal, shouldStop });
  guard.assertCurrent(); prepared.assertCurrent(); usefulnessGuard.assertCurrent();
  const useful = await prepareProposedRepairUsefulness({ store, spaceId, gap, subjects, guard: usefulnessGuard, reader,
    proposals: prepared.plans.map((plan) => ({ factId: plan.factId, sourceIds: plan.sourceIds, claim: {
      title: plan.input.title, kind: plan.input.classification.kind, summary: plan.input.summary,
      value: plan.writeData.factMetadata.value, evidence: plan.writeData.factMetadata.evidence,
      subject: plan.writeData.factMetadata.subject, labels: plan.input.classification.labels, aliases: plan.input.classification.aliases,
    } })),
  });
  // A stored fact may be excluded from a later count. These are newly selected
  // claims: disagreement holds this complete proposed pass before any writes.
  if (useful.count !== prepared.plans.length) throw new KnowledgeRepairFactUsefulnessHeldError('not-useful');
  await store.batch(async () => {
    guard.assertCurrent(); prepared.assertCurrent(); useful.assertCurrent();
    await prepared.write();
  });
  return inputs.length;
}

function promotedRepairFactInput(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly gap: KnowledgeNodeRecord;
  readonly source: KnowledgeSourceRecord;
  readonly extraction: KnowledgeExtractionRecord | null;
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
    extraction: input.extraction,
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
  readonly extraction: KnowledgeExtractionRecord | null;
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
  readonly writeData: ReturnType<typeof prepareRepairProfileWriteData>;
}
export interface RepairProfileWriteObserver {
  readonly nodeWritten?: ((node: KnowledgeNodeRecord) => void) | undefined;
  readonly edgeWritten?: ((edge: KnowledgeEdgeRecord) => void) | undefined;
}
export interface PreparedSourceLinkedRepairProfileFacts {
  readonly plans: readonly PreparedSourceLinkedRepairProfileFact[];
  readonly assertCurrent: () => void;
  readonly write: (observer?: RepairProfileWriteObserver) => Promise<KnowledgeNodeRecord[]>;
}

/** Resolve the entire pass before opening a batch. write() performs no judgments. */
export async function prepareSourceLinkedRepairProfileFacts(
  inputs: readonly SourceLinkedRepairProfileFactInput[],
  options: { readonly signal?: AbortSignal | undefined; readonly shouldStop?: (() => boolean) | undefined } = {},
): Promise<PreparedSourceLinkedRepairProfileFacts> {
  assertSemanticWriteAllowed(options.signal, options.shouldStop);
  const store = inputs[0]?.store;
  if (!store) return { plans: [], assertCurrent() {}, async write(): Promise<KnowledgeNodeRecord[]> { return []; } };
  const guard = createSemanticWriteGuard(store, options.signal, options.shouldStop);
  const planner = createSemanticPrimarySourcePlanner(store, guard, options.signal);
  const support = createGeneratedFactWritePlanner(store, guard, options);
  const virtualSources = new Map<string, readonly string[]>();
  const drafts = inputs.map((original) => {
    const { store: inputStore, metadataBuilder, ...data } = original;
    const input: SourceLinkedRepairProfileFactInput = Object.freeze({
      ...freezePlanData(structuredClone(data)), store: inputStore, metadataBuilder,
    });
    if (input.store !== store) throw new TypeError('A prepared repair fact pass must use one store.');
    guard.watch(`source:${input.source.id}`, () => store.getSource(input.source.id), input.source);
    guard.watch(`extraction:${input.source.id}`, () => store.getExtractionBySourceId(input.source.id), input.extraction);
    for (const subject of input.subjects) guard.watch(`node:${subject.id}`, () => store.getNode(subject.id), subject);
    const subjectIds = input.subjects.map((subject) => subject.id);
    const factId = semanticFactId({ spaceId: input.spaceId, kind: input.classification.kind,
      title: input.title, value: input.classification.value, summary: input.summary, subjectIds, fallbackScope: input.source.id });
    const existingFact = guard.node(factId);
    const sourceIds = exactKnowledgeIds([
      ...(virtualSources.get(factId) ?? readStringArray(existingFact?.metadata.sourceIds)),
      readString(existingFact?.metadata.sourceId), existingFact?.sourceId, input.source.id,
    ]);
    virtualSources.set(factId, sourceIds);
    const supportKey = support.add(input.spaceId, {
      id: factId, kind: input.classification.kind, title: input.title, summary: input.summary,
      value: input.classification.value, evidence: input.evidence, labels: input.classification.labels,
      aliases: input.classification.aliases, subject: input.subjects[0]?.title, targetHints: repairSubjectHints(input.subjects),
    }, sourceIds, input.subjects, new Map([[input.source.id, input.extraction]]), new Set(), { claimId: factId });
    const resolve = planner.prepare(input.spaceId, {
      kind: input.classification.kind, title: input.title, summary: input.summary,
      value: input.classification.value, evidence: input.evidence,
      subjects: input.subjects.map(({ id, title, kind }) => ({ id, title, kind })),
    }, sourceIds);
    return { input, factId, sourceIds, resolve, supportKey, existingFact };
  });
  const factIds = new Set(drafts.map((draft) => draft.factId));
  guard.watch('support-edges', () => store.listEdges().filter((edge) =>
    (edge.toKind === 'node' && factIds.has(edge.toId)) || (edge.fromKind === 'node' && factIds.has(edge.fromId))));
  await support.readAll();
  const plans: PreparedSourceLinkedRepairProfileFact[] = [];
  const virtualSupport = new Map<string, unknown>();
  for (const { input, factId, sourceIds, resolve, supportKey, existingFact } of drafts) {
    const primarySourceId = await resolve();
    const writeData = freezePlanData(prepareRepairProfileWriteData(input, primarySourceId, sourceIds,
      support.plans(supportKey), virtualSupport.get(factId) ?? existingFact?.metadata.generatedFactSupport));
    virtualSupport.set(factId, writeData.factMetadata.generatedFactSupport);
    plans.push(Object.freeze({ input, factId, sourceIds: Object.freeze([...sourceIds]), primarySourceId, writeData }));
  }
  const nodeSlug = createSemanticNodeSlugPlanner(store);
  const activation = await store.prepareNodeWrites(plans.map(repairProfileNodeInput).map(nodeSlug), { signal: options.signal, requireAccepted: true });
  guard.assertCurrent();
  return {
    plans: Object.freeze(plans),
    assertCurrent: () => { guard.assertCurrent(); store.assertPreparedNodeWrites(activation); },
    async write(observer?: RepairProfileWriteObserver): Promise<KnowledgeNodeRecord[]> {
      // Callers may have awaited other prepared work since this plan resolved.
      // Validate once at entry, before this pass intentionally changes its rows.
      guard.assertCurrent();
      store.assertPreparedNodeWrites(activation);
      const facts: KnowledgeNodeRecord[] = [];
      for (const [index, plan] of plans.entries()) {
        assertSemanticWriteAllowed(options.signal, options.shouldStop);
        facts.push(await writeResolvedSourceLinkedRepairProfileFact(plan, observer,
          () => assertSemanticWriteAllowed(options.signal, options.shouldStop), () => store.upsertPreparedNode(activation, index)));
      }
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

async function writeResolvedSourceLinkedRepairProfileFact(
  plan: PreparedSourceLinkedRepairProfileFact, observer?: RepairProfileWriteObserver,
  assertActive: () => void = () => {},
  writePrepared?: (() => Promise<KnowledgeNodeRecord>) | undefined,
): Promise<KnowledgeNodeRecord> {
  const { input, writeData } = plan;
  const supportWeight = input.supportWeight ?? (input.authority === 'official-vendor' ? 0.96 : 0.84);
  const describesWeight = input.describesWeight ?? (input.authority === 'official-vendor' ? 0.95 : 0.82);
  assertActive();
  const fact = await (writePrepared ? writePrepared() : input.store.upsertNode(repairProfileNodeInput(plan)));
  observer?.nodeWritten?.(fact);
  assertActive();
  const supportEdge = await input.store.upsertEdge({
    fromKind: 'source',
    fromId: input.source.id,
    toKind: 'node',
    toId: fact.id,
    relation: 'supports_fact',
    weight: supportWeight,
    metadata: writeData.supportMetadata,
  });
  observer?.edgeWritten?.(supportEdge);
  for (const subject of input.subjects) {
    assertActive();
    const describesEdge = await input.store.upsertEdge({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: subject.id,
      relation: 'describes',
      weight: describesWeight,
      metadata: writeData.describesMetadata,
    });
    observer?.edgeWritten?.(describesEdge);
  }
  return fact;
}

async function linkPromotedFactsToRepairSubjects(
  store: KnowledgeStore, spaceId: string, gap: KnowledgeNodeRecord, sourceIds: readonly string[],
  reader: ReturnType<typeof createRepairFactUsefulnessReader>, signal?: AbortSignal, shouldStop?: () => boolean,
): Promise<void> {
  const subjects = linkedRepairSubjects(store, spaceId, gap, []);
  if (!subjects.length) return;
  const guard = createRepairUsefulnessGuard(store, spaceId, gap, subjects, signal, shouldStop);
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const candidates = [...new Map(sourceIds.flatMap((sourceId) => [
    ...factsForSource(sourceId, graph.edges, graph.nodesById),
    ...[...graph.nodesById.values()].filter((node) => node.kind === 'fact' && node.status === 'active'
      && exactKnowledgeIds([node.sourceId, readString(node.metadata.sourceId), ...readStringArray(node.metadata.sourceIds)]).includes(sourceId)),
  ]).map((fact) => [fact.id, fact])).values()].filter((fact) => isRepairFactKind(fact) && isRepairFactCompatibleWithSubjects(fact, subjects));
  const prepared = await prepareRepairUsefulness({ store, spaceId, gap, subjects, candidates, guard, reader });
  await writeSupportedRepairSubjectLinks({ store, spaceId, gap, sourceIds, subjects, signal, shouldStop,
    candidate: prepared.accepts, assertCurrent: prepared.assertCurrent,
  });
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

async function countUsableRepairFacts(
  store: KnowledgeStore,
  spaceId: string,
  sourceIds: readonly string[],
  subjectIds: ReadonlySet<string>,
  gap: KnowledgeNodeRecord, subjects: readonly KnowledgeNodeRecord[],
  reader: ReturnType<typeof createRepairFactUsefulnessReader>, signal?: AbortSignal, shouldStop?: () => boolean,
) {
  const guard = createRepairUsefulnessGuard(store, spaceId, gap, subjects, signal, shouldStop);
  const sources = new Set(sourceIds);
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const sourceIdsByFactId = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.fromKind !== 'source' || edge.toKind !== 'node' || edge.relation !== 'supports_fact') continue;
    const current = sourceIdsByFactId.get(edge.toId) ?? new Set<string>();
    current.add(edge.fromId);
    sourceIdsByFactId.set(edge.toId, current);
  }
  const candidates = [...graph.nodesById.values()]
    .filter((node) => node.kind === 'fact' && node.status === 'active')
    .filter((node) => getKnowledgeSpaceId(node) === spaceId)
    .filter((node) => factSourceIds(node, sourceIdsByFactId).some((sourceId) => sources.has(sourceId)))
    .filter(isRepairFactKind)
    .filter((node) => {
      if (subjectIds.size === 0) return true;
      const linkedIds = uniqueStrings([
        ...readStringArray(node.metadata.linkedObjectIds),
        ...readStringArray(node.metadata.subjectIds),
      ]);
      return linkedIds.some((id) => subjectIds.has(id));
    });
  return prepareRepairUsefulness({ store, spaceId, gap, subjects, candidates, guard, reader });
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

function isRepairFactKind(node: KnowledgeNodeRecord): boolean {
  return ['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(readString(node.metadata.factKind) ?? '');
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
