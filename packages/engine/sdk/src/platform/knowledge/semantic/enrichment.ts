import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { extractedSentenceKind, readKnowledgeBattery } from './repair-decisions.js';
import { repairProfileValueCandidates } from './repair-profile/reader.js';
import { prepareKnowledgeExtractionValueReading } from './extraction-value/reader.js';
import { guardKnowledgeEdgeInput } from '../store-edge-writes.js';
import { captureKnowledgeSourceReferences, knowledgeSourceJudgmentUris, projectKnowledgeSourceReferences } from '../source-structural-references.js';
import { createSemanticNodeSlugPlanner } from './node-slug.js';
import { prepareObservedKnowledgeNodeInput } from '../store-node-observation.js';
import { KnowledgeRecordAdmissionHeldError } from '../store-record-snapshot.js';
import { enrichmentFactNodeInput, enrichmentGapNodeInput } from './enrichment-node-plans.js';
import { prepareEnrichmentFactDrafts, resolveEnrichmentSpaceId } from './enrichment-fact-drafts.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { sourceRankingContent } from './answer-source-ranking.js';
import { freezeSupport } from './verification/projection.js';
import { createGeneratedFactWritePlanner, generatedFactSupportMetadata } from './fact-support-write-plan.js';
import { persistWikiPage, prepareWikiPageNodeInput, renderDeterministicWikiPage } from './wiki-page-persistence.js';
import type { KnowledgeStore } from '../store.js';
// Descriptive producer scores stay on the declared 0-100 scale. They never authorize activation.
import { clampConfidence, guardKnowledgeSemanticStateInput } from '../store-node-history.js';
import { prepareKnowledgeScopeSelection } from '../scope-selection.js';
import type {
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type {
  KnowledgeSemanticEntityInput,
  KnowledgeSemanticExtraction,
  KnowledgeSemanticFactInput,
  KnowledgeSemanticGapInput,
  KnowledgeSemanticLlm,
  KnowledgeSemanticRelationInput,
} from './types.js';
import {
  clampText,
  normalizeWhitespace,
  readRecord,
  readString,
  readStringArray,
  semanticHash,
  semanticMetadata,
  semanticSlug,
  sourceKnowledgeSpace,
  sourceSemanticHash,
  sourceSemanticText,
  splitSentences,
  uniqueStrings,
} from './utils.js';
import { canonicalRepairSubjectNodes } from './repair-subjects.js';
import { createRepairFactUsefulnessReader, KnowledgeRepairFactUsefulnessHeldError } from './repair-usefulness/reader.js';
import { deriveRepairProfileFacts, projectRepairProfileInput, repairProfileSourceText, repairProfileSubject } from './repair-profile.js';
import { assertSemanticWriteAllowed, createSemanticPrimarySourcePlanner, createSemanticWriteGuard } from './primary-source-plan.js';
import { prepareSemanticSupersession } from './supersession-plan.js';

const semanticPersistenceGuards = new WeakMap<PersistedSemanticExtraction, () => void>();

export interface KnowledgeSemanticEnrichmentContext {
  readonly store: KnowledgeStore;
  readonly llm?: KnowledgeSemanticLlm | null | undefined;
}

export interface EnrichKnowledgeSourceOptions {
  readonly force?: boolean | undefined;
  readonly knowledgeSpaceId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
}

export interface PersistedSemanticExtraction {
  readonly source: KnowledgeSourceRecord;
  readonly skipped: boolean;
  readonly reason?: string | undefined;
  readonly extractor?: 'llm' | 'deterministic' | undefined;
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly wikiPage?: KnowledgeNodeRecord | undefined;
  readonly gaps: readonly KnowledgeNodeRecord[];
}

export async function enrichKnowledgeSource(
  context: KnowledgeSemanticEnrichmentContext,
  source: KnowledgeSourceRecord,
  options: EnrichKnowledgeSourceOptions = {},
): Promise<PersistedSemanticExtraction> {
  const spaceId = resolveEnrichmentSpaceId(source, options.knowledgeSpaceId);
  const generationGuard = createSemanticWriteGuard(context.store, options.signal, options.shouldStop);
  generationGuard.watch(`source:${source.id}`, () => context.store.getSource(source.id), source);
  const extraction = generationGuard.extraction(source.id);
  generationGuard.watch('source-subject-edges', () => context.store.listEdges().filter((edge) => edge.fromKind === 'source' && edge.fromId === source.id));
  repairSubjectCandidatesForSource(context.store, source, (id) => generationGuard.node(id));
  generationGuard.assertCurrent();
  if (!extraction) return emptyResult(source, true, 'semantic enrichment requires extracted source evidence');
  const uris = knowledgeSourceJudgmentUris(source);
  const text = sourceSemanticText({ ...source, ...uris }, extraction);
  const structural = projectKnowledgeSourceReferences(source, extraction, captureKnowledgeSourceReferences(context.store, source, extraction));
  const generationSource = { id: structural?.sourceId ?? source.id, title: source.title, sourceType: source.sourceType, tags: source.tags,
    uri: uris.canonicalUri ?? uris.sourceUri ?? uris.url, provenance: sourceRankingContent(source).claimedProvenance };
  const textHash = sourceSemanticHash(source, extraction);
  const existingSemantic = readRecord(context.store.getSemanticEnrichmentState(source.id)?.metadata);
  const currentExtractor = readString(existingSemantic.extractor);
  const shouldUpgradeDeterministic = Boolean(context.llm && existingSemantic.textHash === textHash && currentExtractor !== 'llm');
  const scopeSelection = await prepareKnowledgeScopeSelection(context.store, { includeAllSpaces: true },
    { signal: options.signal, shouldStop: options.shouldStop, kinds: ['source'], sourceIds: [source.id] });
  generationGuard.watch('enrichment-source-scope', () => { scopeSelection.assertCurrent(); return true; });
  if (!scopeSelection.source(source)) {
    generationGuard.assertCurrent();
    await markSourceSemanticState(context.store, source, textHash, {
      skippedReason: 'source is outside active knowledge scope',
    }, generationGuard.assertCurrent);
    return emptyResult(source, true, 'source is outside active knowledge scope');
  }
  if (!options.force && existingSemantic.textHash === textHash && !shouldUpgradeDeterministic) {
    return emptyResult(source, true, 'semantic enrichment is current');
  }
  // Admit the complete original source, extraction and candidates before any
  // generation request. The reading remains live through the persistence pass.
  const generationSubjects = await linkedObjectsForSource(context.store, source, new Set(), options.signal, options.shouldStop);
  generationGuard.watch('generation-subject-selection', () => { generationSubjects.assertCurrent(); return true; });
  // Minimize and protect the complete generation input before any display cap.
  assertJudgmentInput({ source: generationSource, text, extraction: { format: extraction.format, title: extraction.title, summary: extraction.summary, sections: extraction.sections } });
  // This source/extraction owner outlives generation. The generation guard also
  // watches pre-write graph choices, which the native persistence pass changes.
  const valueOwner = createSemanticWriteGuard(context.store, options.signal, options.shouldStop);
  valueOwner.source(source.id, source);
  valueOwner.extraction(source.id, extraction);
  const originalStore = context.store, originalLlm = context.llm, originalGenerate = context.llm?.completeJson;
  const originalSignal = options.signal, originalStop = options.shouldStop, originalSpace = options.knowledgeSpaceId, originalForce = options.force;
  valueOwner.watch('extraction-caller-configuration', () => ({ store: context.store === originalStore,
    llm: context.llm === originalLlm, generation: context.llm?.completeJson === originalGenerate,
    signal: options.signal === originalSignal, stop: options.shouldStop === originalStop,
    space: options.knowledgeSpaceId === originalSpace, force: options.force === originalForce }));
  const assertValueOwnerCurrent = () => { valueOwner.assertCurrent(); scopeSelection.assertCurrent(); };
  const extractionValue = prepareKnowledgeExtractionValueReading({
    source: sourceRankingContent(source), text,
    extraction: { format: extraction.format, title: extraction.title, summary: extraction.summary,
      excerpt: extraction.excerpt, sections: extraction.sections },
  }, { signal: options.signal, assertCurrent: assertValueOwnerCurrent });
  const assertExtractionCurrent = () => { generationGuard.assertCurrent(); extractionValue.assertCurrent(); };
  if (!await extractionValue.read()) {
    assertExtractionCurrent();
    // No extraction attempt is made. Existing native supersession/support plans
    // still detach old support from this changed source and preserve other sources.
    const retired = await persistSemanticExtraction(context.store, source, extraction, {
      extractor: 'deterministic', entities: [], facts: [], relations: [], gaps: [], wikiPage: { markdown: '' },
    }, { knowledgeSpaceId: spaceId, signal: options.signal, shouldStop: options.shouldStop,
      textHash, assertCurrent: extractionValue.assertCurrent });
    const assertRetirementCurrent = semanticPersistenceGuards.get(retired)!;
    assertRetirementCurrent();
    await markSourceSemanticState(context.store, source, textHash, {
      skippedReason: 'source states no concrete fact worth a semantic extraction attempt',
    }, assertRetirementCurrent);
    assertRetirementCurrent();
    return emptyResult(source, true, 'source states no concrete fact worth a semantic extraction attempt');
  }
  assertExtractionCurrent();
  const llmExtraction = await extractSemanticsWithLlm(context.llm ?? null, generationSource, extraction, text, options.signal);
  assertExtractionCurrent();
  const extracted = normalizeSemanticExtraction(llmExtraction)
    ?? await deterministicSemanticExtraction(context.store, source, extraction, text, options.signal, options.shouldStop, generationGuard);
  assertExtractionCurrent();
  const semantic = freezeSupport(structuredClone(extracted));
  const persisted = await persistSemanticExtraction(context.store, source, extraction, semantic, {
    knowledgeSpaceId: spaceId,
    signal: options.signal,
    shouldStop: options.shouldStop,
    textHash,
    assertCurrent: extractionValue.assertCurrent,
  });
  assertSemanticWriteAllowed(options.signal, options.shouldStop);
  const assertPersistenceCurrent = semanticPersistenceGuards.get(persisted)!;
  assertPersistenceCurrent();
  await markSourceSemanticState(context.store, source, textHash, {
    extractor: semantic.extractor,
    factCount: persisted.facts.length,
    entityCount: persisted.entities.length,
    gapCount: persisted.gaps.length,
  }, assertPersistenceCurrent);
  assertPersistenceCurrent();
  return persisted;
}

async function extractSemanticsWithLlm(
  llm: KnowledgeSemanticLlm | null,
  generationSource: Record<string, unknown>,
  extraction: KnowledgeExtractionRecord | null,
  text: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  if (!llm) return null;
  return llm.completeJson({
    purpose: 'knowledge-semantic-enrichment',
    signal,
    systemPrompt: [
      'You extract a durable semantic knowledge graph from source material.',
      'Return only JSON. Do not invent facts. Every fact must be grounded in the supplied source text.',
      'Capture capabilities, features, specifications, procedures, warnings, maintenance items, compatibility, configuration, and troubleshooting facts when present.',
      'Prefer precise facts over broad summaries. Preserve numbers, model names, ports, version names, constraints, and useful procedures. Every `confidence` field is an INTEGER on a 0-100 scale (0 = none, 100 = certain), never a 0-1 probability.',
    ].join(' '),
    prompt: JSON.stringify({
      source: generationSource,
      extraction: {
        format: extraction?.format,
        title: extraction?.title,
        summary: extraction?.summary,
        sections: extraction?.sections,
      },
      instructions: {
        outputShape: {
          summary: 'short source summary',
          entities: [{ title: 'entity name', kind: 'entity type', aliases: ['alternate names'], summary: 'one sentence', confidence: 0 }],
          facts: [{
            kind: 'feature|capability|specification|identity|procedure|warning|maintenance|compatibility|configuration|troubleshooting|relationship|note',
            title: 'short fact title',
            value: 'precise value when applicable',
            summary: 'source-grounded explanation',
            evidence: 'short quote or close paraphrase from source',
            confidence: 0,
            labels: ['optional labels'],
            targetHints: ['entities this fact describes'],
          }],
          relations: [{ from: 'entity/fact title', relation: 'relation label', to: 'entity/fact title', evidence: 'source-grounded evidence', confidence: 0 }],
          gaps: [{ question: 'missing useful question', reason: 'why source does not answer it', subject: 'optional subject', severity: 'info|warning|error' }],
          wikiPage: { title: 'living page title', markdown: 'concise markdown page synthesized only from extracted facts' },
        },
      },
      text,
    }),
  });
}

function normalizeSemanticExtraction(value: unknown): KnowledgeSemanticExtraction | null {
  const record = readRecord(value);
  const facts = readArray(record.facts).map(normalizeFact).filter(isFact);
  const entities = readArray(record.entities).map(normalizeEntity).filter(isEntity);
  const relations = readArray(record.relations).map(normalizeRelation).filter(isRelation);
  const gaps = readArray(record.gaps).map(normalizeGap).filter(isGap);
  const wikiRecord = readRecord(record.wikiPage);
  const markdown = readString(wikiRecord.markdown);
  const title = readString(wikiRecord.title);
  if (facts.length === 0 && entities.length === 0 && !markdown) return null;
  return {
    summary: readString(record.summary),
    entities,
    facts,
    relations,
    gaps,
    ...(markdown || title ? { wikiPage: { ...(title ? { title } : {}), ...(markdown ? { markdown } : {}) } } : {}),
    extractor: 'llm',
  };
}

async function deterministicSemanticExtraction(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null,
  text: string,
  signal?: AbortSignal,
  shouldStop?: () => boolean,
  generationGuard?: ReturnType<typeof createSemanticWriteGuard>,
): Promise<KnowledgeSemanticExtraction> {
  const factText = repairProfileSourceText(extraction) || text;
  const selection = await linkedObjectsForSource(store, source, new Set(), signal, shouldStop);
  generationGuard?.watch('deterministic-subject-selection', () => { selection.assertCurrent(); return true; });
  const subjects = selection.nodes.map(repairProfileSubject);
  const candidates = repairProfileValueCandidates(factText);
  const states = candidates.map(candidate => ({ candidate: candidate.text, text: factText, subjects }));
  assertJudgmentInput(states);
  const current = () => { assertSemanticWriteAllowed(signal, shouldStop); selection.assertCurrent(); generationGuard?.assertCurrent(); };
  const profileOwner = captureJudgmentPort('engine.knowledge.enrichment-profile', { signal, assertCurrent: current });
  const profileFacts = await deriveRepairProfileFacts({
    query: 'complete features specifications capabilities', source, extraction, text: factText, subjects,
    structuralReferences: captureKnowledgeSourceReferences(store, source, extraction),
  }, { signal: profileOwner.signal, assertCurrent: profileOwner.assertCurrent });
  profileOwner.assertCurrent();
  // Retain the settled profile's port identity without recursing through the
  // generation guard used by the in-flight reader.
  const retainedProfileOwner = captureJudgmentPort('engine.knowledge.enrichment-profile', { signal });
  profileOwner.assertCurrent();
  generationGuard?.watch('enrichment-profile-owner', () => { retainedProfileOwner.assertCurrent(); return true; });
  const readings = await mapLimit(states, 4, state => readKnowledgeBattery(extractedSentenceKind, state, signal, { assertCurrent: current }));
  current();
  for (const [index, reading] of readings.entries()) {
    reading.assertDecisionCurrent();
    generationGuard?.watch(`sentence-reading:${source.id}:${index}`, () => { reading.assertDecisionCurrent(); return true; });
  }
  const sentenceFacts: KnowledgeSemanticFactInput[] = candidates.flatMap((candidate, index) => {
    const reading = readings[index]!.readings.kind;
    return reading.choice === 'none' ? [] : [{ kind: reading.choice, title: candidate.text,
      summary: candidate.text, evidence: candidate.text, confidence: reading.confidence * 100, labels: [] }];
  });
  const facts: KnowledgeSemanticFactInput[] = [...profileFacts, ...sentenceFacts];
  // Source names and tags identify source records; they do not establish entities.
  const entities: KnowledgeSemanticEntityInput[] = [];
  return {
    summary: extraction?.summary ?? source.summary ?? clampText(factText || text, 360),
    entities,
    facts,
    relations: [],
    gaps: facts.length === 0
      ? [{ question: `What useful facts should be extracted from ${source.title ?? source.id}?`, reason: 'No high-confidence semantic facts were detected.', severity: 'info' }]
      : [],
    wikiPage: {
      title: source.title ? `${source.title} knowledge page` : 'Knowledge page',
      markdown: renderDeterministicWikiPage(source, facts),
    },
    extractor: 'deterministic',
  };
}

async function persistSemanticExtraction(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null,
  semantic: KnowledgeSemanticExtraction,
  options: {
    readonly knowledgeSpaceId?: string | undefined;
    readonly textHash: string;
    readonly assertCurrent?: (() => void) | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly shouldStop?: (() => boolean) | undefined;
  },
): Promise<PersistedSemanticExtraction> {
  const spaceId = options.knowledgeSpaceId ?? sourceKnowledgeSpace(source);
  // Preflight every complete generated field before any verification/primary-source request.
  assertJudgmentInput(semantic);
  const guard = createSemanticWriteGuard(store, options.signal, options.shouldStop);
  guard.watch(`source:${source.id}`, () => store.getSource(source.id), source);
  guard.watch(`extraction:${source.id}`, () => store.getExtractionBySourceId(source.id), extraction);
  // Subject and usefulness readings now precede support planning. Bind the
  // graph they will consult before the first asynchronous judgment.
  guard.watch('enrichment-nodes', () => store.listNodesInSpace(spaceId));
  guard.watch('enrichment-sources', () => store.listSourcesInSpace(spaceId));
  guard.watch('enrichment-edges', () => store.listEdges());
  guard.watch('enrichment-extractions', () => store.listExtractions());
  const planner = createSemanticPrimarySourcePlanner(store, guard, options.signal);
  const support = createGeneratedFactWritePlanner(store, guard, { signal: options.signal });
  const entities: KnowledgeNodeRecord[] = [];
  const facts: KnowledgeNodeRecord[] = [];
  const gaps: KnowledgeNodeRecord[] = [];

  const nodeSlug = createSemanticNodeSlugPlanner(store);
  const entityPlans = semantic.entities.map((entity) => ({
      id: `sem-entity-${semanticHash(spaceId, source.id, entity.title)}`,
      kind: 'knowledge_entity' as const,
      slug: semanticSlug(`${spaceId}-${entity.title}`),
      title: entity.title,
      summary: entity.summary,
      aliases: entity.aliases,
      confidence: entity.confidence ?? 65,
      sourceId: source.id,
      metadata: semanticMetadata(spaceId, {
        ...(entity.metadata ?? {}),
        semanticKind: 'entity',
        entityKind: entity.kind ?? 'entity',
        sourceId: source.id,
        extractionId: extraction?.id,
        extractor: semantic.extractor,
        textHash: options.textHash,
      }),
  })).map(nodeSlug);
  const entityIds = new Set(entityPlans.map((entity) => entity.id));
  for (const id of entityIds) guard.node(id);
  guard.watch('source-subject-edges', () => store.listEdges().filter((edge) => edge.fromKind === 'source' && edge.fromId === source.id));
  // An entity-ID collision overlays semanticKind=entity, which excludes that old
  // object from canonical subjects just as the former write-then-read order did.
  const subjectSelection = await linkedObjectsForSource(store, source, entityIds, options.signal, options.shouldStop);
  guard.watch('source-subject-selection', () => { subjectSelection.assertCurrent(); return true; });
  const sourceLinkedObjects = subjectSelection.nodes;
  const proposedEntities: KnowledgeNodeRecord[] = entityPlans.map((plan) => {
    const existing = guard.node(plan.id);
    return { ...plan, aliases: plan.aliases ?? existing?.aliases ?? [], status: existing?.status ?? 'draft',
      metadata: { ...existing?.metadata, ...plan.metadata }, createdAt: existing?.createdAt ?? 0, updatedAt: existing?.updatedAt ?? 0 };
  });
  const qualityReader = createRepairFactUsefulnessReader({ signal: options.signal });
  const featureKinds = new Set(['feature', 'capability', 'specification', 'compatibility', 'configuration']);
  const proposedFacts = semantic.facts;
  const subjects = sourceLinkedObjects.map(repairProfileSubject);
  const projected = projectRepairProfileInput({ query: 'Extract useful concrete facts about the supplied subjects from this complete source.',
    source, extraction, subjects, text: repairProfileSourceText(extraction),
    structuralReferences: captureKnowledgeSourceReferences(store, source, extraction) });
  const qualitySource = store.getSource(source.id), qualityExtraction = store.getExtractionBySourceId(source.id);
  const qualitySubjects = sourceLinkedObjects.map((subject) => ({ subject, current: store.getNode(subject.id), version: JSON.stringify(subject) }));
  const evidenceVersion = JSON.stringify({ source, extraction });
  const assertQualityCurrent = () => {
    try { store.assertRecordSnapshotFrame(() => {
      assertSemanticWriteAllowed(options.signal, options.shouldStop); options.assertCurrent?.(); qualityReader.assertCurrent(); subjectSelection.assertCurrent();
      if (store.getSource(source.id) !== qualitySource || store.getExtractionBySourceId(source.id) !== qualityExtraction
        || JSON.stringify({ source: store.getSource(source.id), extraction: store.getExtractionBySourceId(source.id) }) !== evidenceVersion
        || qualitySubjects.some(({ subject, current, version }) => store.getNode(subject.id) !== current || JSON.stringify(store.getNode(subject.id)) !== version)) {
        throw new KnowledgeRepairFactUsefulnessHeldError('stale');
      }
    }); } catch (error) {
      if (error instanceof KnowledgeRecordAdmissionHeldError) throw new KnowledgeRepairFactUsefulnessHeldError('stale');
      throw error;
    }
  };
  const qualityInputs = proposedFacts.flatMap((fact, index) => featureKinds.has(fact.kind) ? [{
    reference: `fact-${index + 1}`, query: projected.query, subjects,
    fact: { title: fact.title, kind: fact.kind, summary: fact.summary, value: fact.value, evidence: fact.evidence,
      subject: fact.targetHints, labels: fact.labels, aliases: fact.labels ?? [] },
    evidence: [{ source: projected.source, extraction: projected.extraction, text: projected.text }],
  }] : []);
  const qualityReadings = await qualityReader.read(qualityInputs);
  guard.assertCurrent(); assertQualityCurrent();
  const acceptedReferences = new Set(qualityReadings.filter((reading) => reading.useful).map((reading) => reading.reference));
  const persistedFacts = proposedFacts.filter((fact, index) => !featureKinds.has(fact.kind) || acceptedReferences.has(`fact-${index + 1}`));
  // Rendering consumes the same settled fact set. Provider page text cannot
  // reintroduce a claim rejected by this complete-pass usefulness reading.
  const { wikiPage: suppliedWikiPage, ...extractedWithoutPage } = semantic;
  semantic = { ...extractedWithoutPage, facts: persistedFacts,
    ...(persistedFacts.length === proposedFacts.length && suppliedWikiPage ? { wikiPage: suppliedWikiPage } : {}) };
  const factDrafts = await prepareEnrichmentFactDrafts({ signal: options.signal, assertCurrent: assertQualityCurrent, store, source, extraction, spaceId, guard, primary: planner, support,
    allFacts: semantic.facts, persistedFacts,
    sourceSubjects: sourceLinkedObjects, proposedEntities,
  });
  const activeIds = new Set([
    ...entityIds, ...factDrafts.map((fact) => fact.factId),
    ...semantic.gaps.map((gap) => `sem-gap-${semanticHash(spaceId, source.id, gap.question)}`),
    ...((semantic.wikiPage?.markdown ?? renderDeterministicWikiPage(source, semantic.facts)).trim()
      ? [`sem-page-${semanticHash(spaceId, source.id)}`] : []),
  ]);
  for (const id of activeIds) guard.node(id);
  guard.watch('active-fact-edges', () => store.listEdges().filter((edge) =>
    (edge.toKind === 'node' && activeIds.has(edge.toId)) || (edge.fromKind === 'node' && activeIds.has(edge.fromId))));
  const resolveSupersession = prepareSemanticSupersession(store, source.id, spaceId, activeIds, guard, planner, support, assertQualityCurrent);
  await support.readAll();
  guard.assertCurrent(); assertQualityCurrent();
  const factPlans = [];
  const virtualSupport = new Map<string, unknown>();
  for (const draft of factDrafts) {
    const supportMetadata = generatedFactSupportMetadata(support.plans(draft.supportKey),
      virtualSupport.get(draft.factId) ?? draft.existingFact?.metadata.generatedFactSupport);
    virtualSupport.set(draft.factId, supportMetadata);
    const plan = { ...draft, supportMetadata, primarySourceId: await draft.resolve() };
    guard.assertCurrent(); assertQualityCurrent();
    factPlans.push({ ...plan, nodeInput: nodeSlug(enrichmentFactNodeInput(plan, spaceId, extraction, semantic, options.textHash)) });
  }
  const applySupersession = await resolveSupersession();
  guard.assertCurrent(); assertQualityCurrent();
  const gapPlans = semantic.gaps.map((gap) => ({ gap, nodeInput: prepareObservedKnowledgeNodeInput(store, nodeSlug(enrichmentGapNodeInput(gap, source,
    extraction, semantic, spaceId, options.textHash, store.getNode(`sem-gap-${semanticHash(spaceId, source.id, gap.question)}`))), 'research-task', { source, extraction },
      () => ({ source: store.getSource(source.id), extraction: store.getExtractionBySourceId(source.id) })),
  }));
  const wikiDraft = prepareWikiPageNodeInput(source, semantic, spaceId, options.textHash);
  const wikiInput = wikiDraft ? nodeSlug(wikiDraft) : undefined;
  const activation = await store.prepareNodeWrites([...entityPlans, ...factPlans.map((plan) => plan.nodeInput),
    ...gapPlans.map((plan) => plan.nodeInput), ...(wikiInput ? [wikiInput] : [])], { signal: options.signal, requireAccepted: true, assertCurrent: assertQualityCurrent });
  let activationIndex = 0;
  guard.assertCurrent();
  store.assertPreparedNodeWrites(activation);
  assertQualityCurrent();

  for (const input of entityPlans) {
    assertSemanticWriteAllowed(options.signal, options.shouldStop);
    assertQualityCurrent();
    const node = await store.upsertPreparedNode(activation, activationIndex++);
    entities.push(node);
    await linkSourceToNode(store, source.id, node.id, 'mentions_entity', spaceId, semantic.extractor, {}, assertQualityCurrent);
  }
  for (const plan of factPlans) {
    assertSemanticWriteAllowed(options.signal, options.shouldStop);
    assertQualityCurrent();
    const { factLinkedObjects, supportMetadata } = plan;
    const node = await store.upsertPreparedNode(activation, activationIndex++);
    facts.push(node);
    await linkSourceToNode(store, source.id, node.id, 'supports_fact', spaceId, semantic.extractor, { generatedFactSupport: supportMetadata }, assertQualityCurrent);
    await linkFactToSourceLinkedObjects(store, source.id, node, factLinkedObjects, spaceId, semantic.extractor, supportMetadata, assertQualityCurrent);
    await linkFactToEntities(store, node, entities.filter((entity) => plan.entitySubjectIds.has(entity.id)), spaceId, semantic.extractor, supportMetadata, assertQualityCurrent);
  }

  for (const relation of semantic.relations) {
    assertSemanticWriteAllowed(options.signal, options.shouldStop);
    assertQualityCurrent();
    await linkRelation(store, entities, facts, relation, spaceId, semantic.extractor, assertQualityCurrent);
  }

  for (const { gap, nodeInput } of gapPlans) {
    assertSemanticWriteAllowed(options.signal, options.shouldStop);
    assertQualityCurrent();
    const node = await store.upsertPreparedNode(activation, activationIndex++);
    gaps.push(node);
    await linkSourceToNode(store, source.id, node.id, 'has_gap', spaceId, semantic.extractor, {}, assertQualityCurrent);
    await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({ nodes: [], edges: [], issues: [{
      id: `sem-issue-${semanticHash(spaceId, source.id, gap.question)}`,
      severity: gap.severity ?? 'info',
      code: 'knowledge.semantic_gap',
      message: gap.question,
      status: 'open',
      sourceId: source.id,
      nodeId: node.id,
      metadata: semanticMetadata(spaceId, {
        reason: gap.reason,
        subject: gap.subject,
        namespace: `knowledge:${spaceId}:semantic`,
      }),
    }], assertCurrent: assertQualityCurrent }));
  }

  assertSemanticWriteAllowed(options.signal, options.shouldStop);
  const wikiPage = await persistWikiPage(store, source, semantic, spaceId, wikiInput, wikiInput ? () => store.upsertPreparedNode(activation, activationIndex++) : undefined, assertQualityCurrent);
  await applySupersession();
  assertQualityCurrent();
  const result = { source, skipped: false, extractor: semantic.extractor, facts, entities, gaps, ...(wikiPage ? { wikiPage } : {}) };
  semanticPersistenceGuards.set(result, assertQualityCurrent);
  return result;
}



async function markSourceSemanticState(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  textHash: string,
  details: Record<string, unknown>,
  assertCurrent: () => void = () => {},
): Promise<void> {
  // Derived bookkeeping in its own record, not the append-only source row. (Invariant 1.)
  const enrichedAt = Date.now();
  await store.upsertSemanticEnrichmentState(guardKnowledgeSemanticStateInput({
    sourceId: source.id,
    textHash,
    enrichedAt,
    metadata: { textHash, enrichedAt, ...details },
  }, assertCurrent));
}

async function linkSourceToNode(
  store: KnowledgeStore,
  sourceId: string,
  nodeId: string,
  relation: string,
  spaceId: string,
  extractor: string,
  metadata: Record<string, unknown> = {},
  assertCurrent: () => void = () => {},
): Promise<void> {
  await store.upsertEdge(guardKnowledgeEdgeInput({
    fromKind: 'source',
    fromId: sourceId,
    toKind: 'node',
    toId: nodeId,
    relation,
    weight: extractor === 'llm' ? 1 : 0.6,
    metadata: semanticMetadata(spaceId, { ...metadata, extractor }),
  }, assertCurrent));
}

async function linkFactToEntities(
  store: KnowledgeStore,
  fact: KnowledgeNodeRecord,
  entities: readonly KnowledgeNodeRecord[],
  spaceId: string,
  extractor: string,
  supportMetadata: unknown,
  assertCurrent: () => void = () => {},
): Promise<void> {
  for (const entity of entities) {
    await store.upsertEdge(guardKnowledgeEdgeInput({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: entity.id,
      relation: 'describes',
      metadata: semanticMetadata(spaceId, { extractor, generatedFactSupport: supportMetadata }),
    }, assertCurrent));
  }
}

async function linkFactToSourceLinkedObjects(
  store: KnowledgeStore,
  sourceId: string,
  fact: KnowledgeNodeRecord,
  linkedObjects: readonly KnowledgeNodeRecord[],
  spaceId: string,
  extractor: string,
  supportMetadata: unknown,
  assertCurrent: () => void = () => {},
): Promise<void> {
  for (const object of linkedObjects) {
    await store.upsertEdge(guardKnowledgeEdgeInput({
      fromKind: 'node',
      fromId: fact.id,
      toKind: 'node',
      toId: object.id,
      relation: 'describes',
      weight: extractor === 'llm' ? 0.88 : 0.72,
      metadata: semanticMetadata(spaceId, { extractor, sourceId, generatedFactSupport: supportMetadata }),
    }, assertCurrent));
  }
}

async function linkRelation(
  store: KnowledgeStore,
  entities: readonly KnowledgeNodeRecord[],
  facts: readonly KnowledgeNodeRecord[],
  relation: KnowledgeSemanticRelationInput,
  spaceId: string,
  extractor: string,
  assertCurrent: () => void = () => {},
): Promise<void> {
  const from = findSemanticNode([...entities, ...facts], relation.from);
  const to = findSemanticNode([...entities, ...facts], relation.to);
  if (!from || !to || from.id === to.id) return;
  await store.upsertEdge(guardKnowledgeEdgeInput({
    fromKind: 'node',
    fromId: from.id,
    toKind: 'node',
    toId: to.id,
    relation: semanticSlug(relation.relation).replace(/-/g, '_') || 'related_to',
    weight: Math.max(0.1, Math.min(1, (relation.confidence ?? 70) / 100)),
    metadata: semanticMetadata(spaceId, {
      evidence: relation.evidence,
      extractor,
    }),
  }, assertCurrent));
}

function normalizeFact(value: unknown): KnowledgeSemanticFactInput | null {
  const record = readRecord(value);
  const kind = normalizeFactKind(readString(record.kind));
  const title = readString(record.title);
  if (!kind || !title) return null;
  return {
    kind,
    title,
    ...(readString(record.value) ? { value: readString(record.value) } : {}),
    ...(readString(record.summary) ? { summary: readString(record.summary) } : {}),
    ...(readString(record.evidence) ? { evidence: readString(record.evidence) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
    labels: readStringArray(record.labels),
    targetHints: readStringArray(record.targetHints),
  };
}

function normalizeEntity(value: unknown): KnowledgeSemanticEntityInput | null {
  const record = readRecord(value);
  const title = readString(record.title);
  if (!title) return null;
  return {
    title,
    ...(readString(record.kind) ? { kind: readString(record.kind) } : {}),
    aliases: readStringArray(record.aliases),
    ...(readString(record.summary) ? { summary: readString(record.summary) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
    metadata: readRecord(record.metadata),
  };
}

function normalizeRelation(value: unknown): KnowledgeSemanticRelationInput | null {
  const record = readRecord(value);
  const from = readString(record.from);
  const relation = readString(record.relation);
  const to = readString(record.to);
  if (!from || !relation || !to) return null;
  return {
    from,
    relation,
    to,
    ...(readString(record.evidence) ? { evidence: readString(record.evidence) } : {}),
    ...(typeof record.confidence === 'number' ? { confidence: clampConfidence(record.confidence) } : {}),
  };
}

function normalizeGap(value: unknown): KnowledgeSemanticGapInput | null {
  const record = readRecord(value);
  const question = readString(record.question);
  if (!question) return null;
  const severity = readString(record.severity);
  return {
    question,
    ...(readString(record.reason) ? { reason: readString(record.reason) } : {}),
    ...(readString(record.subject) ? { subject: readString(record.subject) } : {}),
    severity: severity === 'warning' || severity === 'error' ? severity : 'info',
  };
}

function normalizeFactKind(value: string | undefined): KnowledgeSemanticFactInput['kind'] | null {
  switch (value) {
    case 'feature':
    case 'capability':
    case 'specification':
    case 'identity':
    case 'procedure':
    case 'warning':
    case 'maintenance':
    case 'compatibility':
    case 'configuration':
    case 'troubleshooting':
    case 'relationship':
    case 'note':
      return value;
    default:
      return value ? 'note' : null;
  }
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function repairSubjectCandidatesForSource(
  store: KnowledgeStore, source: KnowledgeSourceRecord,
  readNode: (id: string) => KnowledgeNodeRecord | null = (id) => store.getNode(id),
): KnowledgeNodeRecord[] {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const sourceSpaceId = sourceKnowledgeSpace(source);
  const ids = uniqueStrings([
    ...readStringArray(discovery.linkedObjectIds),
    ...store.listEdges()
      .filter((edge) => edge.fromKind === 'source' && edge.fromId === source.id)
      .filter((edge) => edge.toKind === 'node' && edge.relation === 'source_for')
      .filter((edge) => {
        const edgeSpaceId = readString(edge.metadata.knowledgeSpaceId);
        return !edgeSpaceId || edgeSpaceId === sourceSpaceId;
      })
      .map((edge) => edge.toId),
  ]);
  const nodes: KnowledgeNodeRecord[] = [];
  for (const id of ids) {
    const node = readNode(id);
    if (node) nodes.push(node);
  }
  return nodes;
}

async function linkedObjectsForSource(store: KnowledgeStore, source: KnowledgeSourceRecord,
  entityOverlayIds: ReadonlySet<string>, signal?: AbortSignal, shouldStop?: () => boolean) {
  const guard = createSemanticWriteGuard(store, signal, shouldStop);
  guard.watch('source-subject-edges', () => store.listEdges().filter(edge => edge.fromKind === 'source' && edge.fromId === source.id && edge.relation === 'source_for'));
  const nodes = repairSubjectCandidatesForSource(store, source, id =>
    entityOverlayIds.has(id) ? store.getNode(id) : guard.node(id));
  const selected = await canonicalRepairSubjectNodes({ store, spaceId: sourceKnowledgeSpace(source), context: { source },
    nodes, excludedNodeIds: [...entityOverlayIds], signal, shouldStop,
    text: `${source.title ?? ''} ${source.summary ?? ''} ${source.description ?? ''}` });
  const assertCurrent = () => { store.assertRecordSnapshotFrame(() => { guard.assertCurrent(); selected.assertCurrent(); }); };
  assertCurrent(); return { nodes: selected.nodes, assertCurrent };
}

function isFact(value: KnowledgeSemanticFactInput | null): value is KnowledgeSemanticFactInput {
  return Boolean(value);
}

function isEntity(value: KnowledgeSemanticEntityInput | null): value is KnowledgeSemanticEntityInput {
  return Boolean(value);
}

function isRelation(value: KnowledgeSemanticRelationInput | null): value is KnowledgeSemanticRelationInput {
  return Boolean(value);
}

function isGap(value: KnowledgeSemanticGapInput | null): value is KnowledgeSemanticGapInput {
  return Boolean(value);
}

function findSemanticNode(nodes: readonly KnowledgeNodeRecord[], label: string): KnowledgeNodeRecord | undefined {
  const lower = label.toLowerCase();
  const matches = nodes.filter((node) => node.title.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

function emptyResult(source: KnowledgeSourceRecord, skipped: boolean, reason: string): PersistedSemanticExtraction {
  return { source, skipped, reason, facts: [], entities: [], gaps: [] };
}
