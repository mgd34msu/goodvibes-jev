import { assertKnowledgeRecordContainers, KnowledgeRecordAdmissionHeldError, prepareKnowledgeRecordAdmission } from '../store-record-snapshot.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { KnowledgeRepairSourceAuthorityHeldError } from './repair-source-authority/types.js';
import { createKnowledgeFactQualityReader } from './fact-quality.js';
import { guardKnowledgeEdgeInput } from '../store-edge-writes.js';
import { createSemanticNodeSlugPlanner } from './node-slug.js';
import { writeSupportedRepairSubjectLinks } from './repair-subject-write-plan.js';
import { createGeneratedClaimReferenceScope, type GeneratedClaimRelinking } from './verification/structural-references.js';
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
import { createRepairUsefulnessGuard, prepareRepairUsefulness } from './repair-usefulness-plan.js';
import { deriveRepairProfileFactPass, repairProfileSourceText, repairProfileSubject, type RepairProfileFact } from './repair-profile.js';
import { captureKnowledgeSourceReferences } from '../source-structural-references.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import { factsForSource, linkedObjectsForSource } from './self-improvement-graph.js';
import { updateRefinementTask } from './self-improvement-tasks.js';
import { canonicalRepairSubjectNodes, captureRepairSubjectReadSet, repairSubjectHints } from './repair-subjects.js';
import {
  prepareRepairSourceAuthorities,
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
  const requestStore = context.store, requestEnrich = context.enrichSource, requestStop = context.shouldStop;
  const requestData = () => captureOwnedJson({ spaceId, gap, sourceIds, taskId: task.id, deadlineAt, objectProfiles: context.objectProfiles });
  const requestVersion = JSON.stringify(requestData());
  const assertRequestCurrent = () => {
    assertSemanticWriteAllowed(signal, requestStop);
    if (context.store !== requestStore || context.enrichSource !== requestEnrich || context.shouldStop !== requestStop
      || JSON.stringify(requestData()) !== requestVersion) throw new KnowledgeRepairSourceAuthorityHeldError('stale');
  };
  const targetUsableFactCount = repairTargetUsableFactCount(gap);
  const usefulness = createRepairFactUsefulnessReader({ signal });
  const generatedClaims = createGeneratedClaimReferenceScope(context.store);
  const countUsable = async (ids: readonly string[]) => {
    // Zero structurally eligible facts is an exact count, not a semantic no.
    // Keep the complete count read-set live through subsequent task bookkeeping.
    const emptyGuard = createRepairUsefulnessGuard(context.store, spaceId, gap, [], signal, context.shouldStop);
    for (const id of ids) { emptyGuard.source(id); emptyGuard.extraction(id); }
    if (repairSourceFactCandidates(context.store, spaceId, ids).length === 0) {
      const assertAdmissionCurrent = admitEmptyRepairCount(context.store, spaceId, gap, ids, context.objectProfiles);
      const assertCurrent = () => { assertRequestCurrent(); emptyGuard.assertCurrent(); assertAdmissionCurrent(); };
      assertCurrent(); return { count: 0, assertCurrent };
    }
    const selected = await linkedRepairSubjects(context.store, spaceId, gap, context.objectProfiles ?? [], signal, context.shouldStop, ids);
    const prepared = await countUsableRepairFacts(context.store, spaceId, ids, new Set(selected.nodes.map(node => node.id)),
      gap, selected.nodes, usefulness, signal, context.shouldStop);
    const assertCurrent = () => { assertRequestCurrent(); selected.assertCurrent(); prepared.assertCurrent(); };
    assertCurrent(); return { ...prepared, assertCurrent };
  };
  const linkSubjects = (ids: readonly string[]) => linkPromotedFactsToRepairSubjects(context.store, spaceId, gap, ids,
    usefulness, signal, context.shouldStop, generatedClaims.relinking);
  const promote = (ids: readonly string[]) => promoteRepairEvidenceFacts(context.store, spaceId, gap, ids,
    usefulness, signal, context.shouldStop, generatedClaims.rememberGenerated, assertRequestCurrent);
  const processedSourceIds: string[] = [];
  if (context.enrichSource) {
    for (const [index, sourceId] of sourceIds.entries()) {
      await yieldEvery(index, 2);
      assertSemanticWriteAllowed(signal, context.shouldStop);
      processedSourceIds.push(sourceId);
      await linkSubjects([sourceId]);
      if ((await countUsable(processedSourceIds)).count >= targetUsableFactCount) break;
      await promote([sourceId]);
      await linkSubjects([sourceId]);
      if ((await countUsable(processedSourceIds)).count >= targetUsableFactCount) break;
      await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
      await promote([sourceId]);
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
        await promote([sourceId]);
        await linkSubjects([sourceId]);
        const recoveryUsefulness = await countUsable(processedSourceIds);
        await context.store.batch(async () => {
          recoveryUsefulness.assertCurrent();
          await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Repair source enrichment did not finish for one accepted source.', {
            sourceId, enrichmentError: error instanceof Error ? error.message : String(error),
            promotedSourceIds: processedSourceIds, promotedFactCount: recoveryUsefulness.count,
          }, recoveryUsefulness.assertCurrent);
        });
        if (deadlineAt - Date.now() < 1_000) break;
        continue;
      }
      await waitForRepairSourceText(context.store, sourceId, Math.min(deadlineAt, Date.now() + REPAIR_SOURCE_TEXT_WAIT_MS));
      await promote([sourceId]);
      await linkSubjects([sourceId]);
      if ((await countUsable(processedSourceIds)).count >= targetUsableFactCount) break;
      await yieldToEventLoop();
    }
  }
  assertSemanticWriteAllowed(signal, context.shouldStop);
  const promotionSourceIds = processedSourceIds.length > 0 ? uniqueStrings(processedSourceIds) : sourceIds;
  const promotedFactCount = processedSourceIds.length > 0
    ? 0
    : await promote(sourceIds);
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
      }, finalUsefulness.assertCurrent);
    } else if (usableFactCount > 0) {
      await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Accepted repair sources yielded partial subject-linked facts.', {
        promotedSourceIds: promotionSourceIds,
        promotedFactCount: usableFactCount,
        targetPromotedFactCount: targetUsableFactCount,
      }, finalUsefulness.assertCurrent);
    } else {
      await updateRefinementTask(context.store, context.store.getRefinementTask(task.id) ?? task, 'applying', 'Accepted repair sources did not yield usable subject-linked facts.', {
        promotedSourceIds: promotionSourceIds,
        promotedFactCount: usableFactCount,
      }, finalUsefulness.assertCurrent);
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
  rememberGenerated?: (fact: KnowledgeNodeRecord) => void,
  assertRequestCurrent?: () => void,
): Promise<number> {
  assertSemanticWriteAllowed(signal, shouldStop);
  assertRequestCurrent?.();
  const guard = createSemanticWriteGuard(store, signal, shouldStop);
  guard.watch('repair-request', () => { assertRequestCurrent?.(); return true; });
  // Repeated foreground reads may upsert the identical gap while search runs.
  // Rebase only that timestamp; every intent/provenance/status field must match,
  // and the complete current row is guarded through subsequent judgment awaits.
  const currentGap = store.getNode(gap.id);
  guard.watch(`node:${gap.id}`, () => store.getNode(gap.id), { ...gap, updatedAt: currentGap?.updatedAt ?? gap.updatedAt });
  const inputs: SourceLinkedRepairProfileFactInput[] = [];
  const entries = sourceIds.flatMap((sourceId) => {
    const source = guard.source(sourceId);
    if (!source || getKnowledgeSpaceId(source) !== spaceId) return [];
    const extraction = guard.extraction(source.id);
    if (!extraction) return [];
    const text = repairProfileSourceText(extraction);
    if (!text.trim()) return [];
    return [{ source, extraction, text }];
  });
  // No extraction text means no fact can be derived or written in this pass.
  // This is deliberately before subject meaning is read; it does not select a
  // subject, reject evidence semantically, or authorize any write.
  if (entries.length === 0) { guard.assertCurrent(); return 0; }
  const subjectSelection = await linkedRepairSubjects(store, spaceId, gap, [], signal, shouldStop, sourceIds);
  guard.watch('repair-subject-selection', () => { subjectSelection.assertCurrent(); return true; });
  const subjects = subjectSelection.nodes;
  if (subjects.length === 0) return 0;
  const authorityPlan = await prepareRepairSourceAuthorities({ store, spaceId, gap, subjects, sources: entries,
    signal, shouldStop, assertCurrent: guard.assertCurrent });
  guard.assertCurrent(); authorityPlan.assertCurrent();
  const profiles = await deriveRepairProfileFactPass(entries.map(({ source, extraction, text }) => ({
    query: gap.title, source, extraction, text, subjects: subjects.map(repairProfileSubject),
    structuralReferences: captureKnowledgeSourceReferences(store, source, extraction),
  })), { signal });
  guard.assertCurrent();
  authorityPlan.assertCurrent();
  for (const [index, { source, extraction }] of entries.entries()) {
    const { authority } = authorityPlan.sources[index]!;
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
  }

  let assertUsefulCurrent = () => { reader.assertCurrent(); };
  const assertPublicationCurrent = () => { guard.assertCurrent(); authorityPlan.assertCurrent(); assertUsefulCurrent(); };
  const prepared = await prepareSourceLinkedRepairProfileFacts(inputs, { signal, shouldStop, assertCurrent: assertPublicationCurrent });
  guard.assertCurrent(); prepared.assertCurrent(); reader.assertCurrent();
  const proposals = [...new Map(prepared.plans.map((plan) => {
    const node = repairProfileNodeInput(plan), existing = store.getNode(plan.factId);
    const fact: KnowledgeNodeRecord = { ...node, id: plan.factId, kind: 'fact', title: plan.input.title,
      aliases: node.aliases ?? [], status: 'active', confidence: node.confidence ?? 0, metadata: node.metadata ?? {},
      createdAt: existing?.createdAt ?? 0, updatedAt: existing?.updatedAt ?? 0 };
    return [fact.id, fact] as const;
  })).values()];
  const qualityGuard = createSemanticWriteGuard(store, signal, shouldStop);
  qualityGuard.watch(`gap:${gap.id}`, () => store.getNode(gap.id), store.getNode(gap.id));
  qualityGuard.watch('original-usefulness-owner', () => { reader.assertCurrent(); return true; });
  const quality = await createKnowledgeFactQualityReader(store, { spaceId, purpose: 'repair',
    query: [gap.title, gap.summary].filter(Boolean).join('\n\n'), subjects, signal, guard: qualityGuard,
    proposedFacts: new Set(proposals) }).prepare(proposals);
  guard.assertCurrent(); reader.assertCurrent();
  if (quality.facts.length !== proposals.length) throw new KnowledgeRepairFactUsefulnessHeldError('not-useful');
  assertUsefulCurrent = quality.assertCurrent;
  await store.batch(async () => {
    guard.assertCurrent(); prepared.assertCurrent(); quality.assertCurrent();
    await prepared.write({ nodeWritten: (fact) => { quality.acknowledgeWritten(fact); rememberGenerated?.(fact); },
      edgeWritten: quality.acknowledgeEdgeWritten });
  });
  quality.assertCurrent();
  return proposals.length;
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
  options: { readonly signal?: AbortSignal | undefined; readonly shouldStop?: (() => boolean) | undefined; readonly assertCurrent?: (() => void) | undefined } = {},
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
  const activation = await store.prepareNodeWrites(plans.map(repairProfileNodeInput).map(nodeSlug), { signal: options.signal, requireAccepted: true, assertCurrent: options.assertCurrent });
  guard.assertCurrent();
  return {
    plans: Object.freeze(plans),
    assertCurrent: () => { options.assertCurrent?.(); guard.assertCurrent(); store.assertPreparedNodeWrites(activation); },
    async write(observer?: RepairProfileWriteObserver): Promise<KnowledgeNodeRecord[]> {
      // Callers may have awaited other prepared work since this plan resolved.
      // Validate once at entry, before this pass intentionally changes its rows.
      options.assertCurrent?.(); guard.assertCurrent();
      store.assertPreparedNodeWrites(activation);
      const facts: KnowledgeNodeRecord[] = [];
      for (const [index, plan] of plans.entries()) {
        assertSemanticWriteAllowed(options.signal, options.shouldStop);
        facts.push(await writeResolvedSourceLinkedRepairProfileFact(plan, observer,
          () => { assertSemanticWriteAllowed(options.signal, options.shouldStop); options.assertCurrent?.(); }, () => store.upsertPreparedNode(activation, index)));
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
  const supportEdge = await input.store.upsertEdge(guardKnowledgeEdgeInput({
    fromKind: 'source',
    fromId: input.source.id,
    toKind: 'node',
    toId: fact.id,
    relation: 'supports_fact',
    weight: supportWeight,
    metadata: writeData.supportMetadata,
  }, assertActive));
  observer?.edgeWritten?.(supportEdge);
  for (const subject of input.subjects) {
    assertActive();
    const describesEdge = await input.store.upsertEdge(guardKnowledgeEdgeInput({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: subject.id,
      relation: 'describes',
      weight: describesWeight,
      metadata: writeData.describesMetadata,
    }, assertActive));
    observer?.edgeWritten?.(describesEdge);
  }
  return fact;
}

async function linkPromotedFactsToRepairSubjects(
  store: KnowledgeStore, spaceId: string, gap: KnowledgeNodeRecord, sourceIds: readonly string[],
  reader: ReturnType<typeof createRepairFactUsefulnessReader>, signal?: AbortSignal, shouldStop?: () => boolean,
  generatedClaims?: GeneratedClaimRelinking,
): Promise<void> {
  // A synchronous empty candidate set has no links to publish. Do not ask for
  // subject meaning merely to return from an effect-free pass.
  if (repairSourceFactCandidates(store, spaceId, sourceIds).length === 0) {
    assertSemanticWriteAllowed(signal, shouldStop); return;
  }
  const subjectSelection = await linkedRepairSubjects(store, spaceId, gap, [], signal, shouldStop, sourceIds);
  const subjects = subjectSelection.nodes;
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
    candidate: prepared.accepts, assertCurrent: () => { subjectSelection.assertCurrent(); prepared.assertCurrent(); }, generatedClaims,
  });
}

/** Empty counting still authorizes bookkeeping. Retain full raw-row admission
 * and exact current identities, including replacement/restore ABA, without
 * asking a model to choose a subject for a fact set that does not exist. */
function admitEmptyRepairCount(store: KnowledgeStore, spaceId: string, gap: KnowledgeNodeRecord,
  sourceIds: readonly string[], objectProfiles: readonly KnowledgeObjectProfilePolicy[] | undefined) {
  const admit = (...args: Parameters<typeof prepareKnowledgeRecordAdmission>) => {
    try { return prepareKnowledgeRecordAdmission(...args); }
    catch (error) { if (error instanceof KnowledgeRecordAdmissionHeldError) throw new KnowledgeRepairSourceAuthorityHeldError(error.reason); throw error; }
  };
  const evidence = sourceIds.map(id => ({ id, source: store.getSource(id), extraction: store.getExtractionBySourceId(id) }));
  const admissions = [admit(store, 'node', gap), ...evidence.flatMap(({ source, extraction }) => {
    const references = source ? { source, extraction, proof: captureKnowledgeSourceReferences(store, source, extraction) } : undefined;
    return [...(source ? [admit(store, 'source', source, references)] : []),
      ...(extraction ? [admit(store, 'extraction', extraction, references)] : [])];
  })];
  assertKnowledgeRecordContainers({ gap, sourceIds, evidence, objectProfiles }, admissions);
  for (const record of [gap, ...evidence.flatMap(({ source, extraction }) => [...(source ? [source] : []), ...(extraction ? [extraction] : [])])]) {
    if (getKnowledgeSpaceId(record) !== spaceId) throw new KnowledgeRepairSourceAuthorityHeldError('foreign-space');
    for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
      const value = record.metadata[key];
      if (value !== undefined && (typeof value !== 'string' || value.trim() !== spaceId)) throw new KnowledgeRepairSourceAuthorityHeldError('foreign-space');
    }
  }
  return () => {
    try { store.assertRecordSnapshotFrame(() => {
      for (const admission of admissions) {
        try { admission.assertCurrent(); }
        catch (error) { if (error instanceof KnowledgeRecordAdmissionHeldError) throw new KnowledgeRepairSourceAuthorityHeldError(error.reason); throw error; }
      }
      for (const { id, source, extraction } of evidence) {
        if (store.getSource(id) !== source || store.getExtractionBySourceId(id) !== extraction) throw new KnowledgeRepairSourceAuthorityHeldError('stale');
      }
    }); } catch (error) {
      if (error instanceof KnowledgeRecordAdmissionHeldError) throw new KnowledgeRepairSourceAuthorityHeldError(error.reason);
      throw error;
    }
  };
}

/** A deliberately broad structural superset of link/count candidates. This
 * never decides usefulness or alignment: only an empty set short-circuits work.
 * All nonempty sets still use the existing semantic and support readers. */
function repairSourceFactCandidates(store: KnowledgeStore, spaceId: string, sourceIds: readonly string[]): KnowledgeNodeRecord[] {
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const sources = new Set(sourceIds);
  const linked = new Set(graph.edges.filter(edge => edge.fromKind === 'source' && sources.has(edge.fromId) && edge.toKind === 'node')
    .map(edge => edge.toId));
  const countSourcesByFactId = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.fromKind !== 'source' || edge.toKind !== 'node' || edge.relation !== 'supports_fact') continue;
    const ids = countSourcesByFactId.get(edge.toId) ?? new Set<string>(); ids.add(edge.fromId); countSourcesByFactId.set(edge.toId, ids);
  }
  return [...graph.nodesById.values()].filter(node => node.kind === 'fact' && node.status === 'active' && isRepairFactKind(node)
    && (linked.has(node.id) || exactKnowledgeIds([node.sourceId, readString(node.metadata.sourceId), ...readStringArray(node.metadata.sourceIds)])
      .some(id => sources.has(id)) || factSourceIds(node, countSourcesByFactId).some(id => sources.has(id))));
}

async function linkedRepairSubjects(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  signal?: AbortSignal, shouldStop?: () => boolean, evidenceSourceIds: readonly string[] = [],
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
  const selected = await canonicalRepairSubjectNodes({ store, spaceId, context: { gap }, signal, shouldStop,
    evidenceSources: uniqueStrings([...sourceIds, ...evidenceSourceIds]).map(id => store.getSource(id))
      .filter((source): source is KnowledgeSourceRecord => source !== null),
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
  const assertCurrent = () => { guard.assertCurrent(); selected.assertCurrent(); };
  assertCurrent(); return { nodes: selected.nodes, assertCurrent };
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
