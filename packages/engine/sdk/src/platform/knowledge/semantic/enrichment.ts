import { guardKnowledgeEdgeInput } from '../store-edge-writes.js';
import { captureKnowledgeSourceReferences, knowledgeSourceJudgmentUris, projectKnowledgeSourceReferences } from '../source-structural-references.js';
import { createSemanticNodeSlugPlanner } from './node-slug.js';
import { prepareObservedKnowledgeNodeInput } from '../store-node-observation.js';
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
import { knowledgeSourceMatchesScope } from '../scope-records.js';
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
  MAX_SEMANTIC_SOURCE_CHARS,
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
  linkedObjectsForSource(context.store, source, new Set(), (id) => generationGuard.node(id));
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
  if (!knowledgeSourceMatchesScope(source, { includeAllSpaces: true })) {
    await markSourceSemanticState(context.store, source, textHash, {
      skippedReason: 'source is outside active knowledge scope',
    });
    return emptyResult(source, true, 'source is outside active knowledge scope');
  }
  if (!options.force && existingSemantic.textHash === textHash && !shouldUpgradeDeterministic) {
    return emptyResult(source, true, 'semantic enrichment is current');
  }
  if (text.length < 40) {
    await markSourceSemanticState(context.store, source, textHash, {
      skippedReason: 'source has too little extracted text',
    });
    return emptyResult(source, true, 'source has too little extracted text');
  }

  // Minimize and protect the complete generation input before any display cap.
  assertJudgmentInput({ source: generationSource, text, extraction: { format: extraction.format, title: extraction.title, summary: extraction.summary, sections: extraction.sections } });
  const llmExtraction = await extractSemanticsWithLlm(context.llm ?? null, generationSource, extraction, text, options.signal);
  generationGuard.assertCurrent();
  const extracted = normalizeSemanticExtraction(llmExtraction)
    ?? await deterministicSemanticExtraction(context.store, source, extraction, text, options.signal);
  generationGuard.assertCurrent();
  const semantic = freezeSupport(structuredClone(extracted));
  const persisted = await persistSemanticExtraction(context.store, source, extraction, semantic, {
    knowledgeSpaceId: spaceId,
    signal: options.signal,
    shouldStop: options.shouldStop,
    textHash,
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
    maxTokens: 2600,
    timeoutMs: 20_000,
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
        sections: extraction?.sections.slice(0, 80),
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
      text: clampText(text, MAX_SEMANTIC_SOURCE_CHARS),
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
): Promise<KnowledgeSemanticExtraction> {
  const factText = cleanDeterministicSourceText(deterministicFactSourceText(extraction) || text);
  const sentences = splitSentences(factText);
  const profileFacts = (await deriveRepairProfileFacts({
    query: 'complete features specifications capabilities', source, extraction,
    text: repairProfileSourceText(extraction) || text,
    subjects: linkedObjectsForSource(store, source).map(repairProfileSubject),
    structuralReferences: captureKnowledgeSourceReferences(store, source, extraction),
  }, { signal })).map((fact) => ({
    kind: fact.kind, title: fact.title, value: fact.value, summary: fact.summary,
    evidence: fact.evidence, confidence: 72, labels: fact.labels,
  }));
  const facts = [
    ...profileFacts,
    ...sentences
    .map((sentence) => classifySentenceFact(sentence))
    .filter((fact): fact is KnowledgeSemanticFactInput => Boolean(fact)),
  ].slice(0, 80);
  const entities = uniqueStrings([
    source.title,
    extraction?.title,
    ...source.tags,
  ]).slice(0, 12).map((title) => ({
    title,
    kind: title === source.title ? source.sourceType : 'topic',
    summary: `Entity inferred from ${source.title ?? source.id}.`,
    confidence: 45,
  }));
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

function deterministicFactSourceText(extraction: KnowledgeExtractionRecord | null): string {
  const structure = readRecord(extraction?.structure);
  const nestedStructure = readRecord(structure.structure);
  const metadata = readRecord(extraction?.metadata);
  const nestedMetadata = readRecord(structure.metadata);
  return uniqueStrings([
    extraction?.title,
    extraction?.summary,
    extraction?.excerpt,
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
  ]).join('\n\n');
}

function cleanDeterministicSourceText(text: string): string {
  return normalizeWhitespace(text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bsemantic-gap-repair\b/gi, ' ')
    .replace(/\bhomegraph:\/\/\S+/gi, ' ')
    .replace(/\b(?:manual|file|artifact):\/\/\S+/gi, ' ')
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|dev|tv|ca|co\.uk)(?:\/\S*)?/gi, ' '));
}

function classifySentenceFact(sentence: string): KnowledgeSemanticFactInput | null {
  const text = normalizeWhitespace(sentence);
  if (text.length < 28) return null;
  const lower = text.toLowerCase();
  const kind = (() => {
    if (/\b(warning|caution|do not|never|risk|hazard|important)\b/.test(lower)) return 'warning';
    if (/\b(reset|press|hold|select|open|install|pair|configure|enable|disable|connect|setup|set up)\b/.test(lower)) return 'procedure';
    if (/\b(clean|replace|battery|filter|firmware|update|service|maintenance|warranty)\b/.test(lower)) return 'maintenance';
    if (/\b(compatible|works with|requires|supports?|supported|connects? to|integrates? with)\b/.test(lower)) return 'compatibility';
    if (/\b(feature|features|capabilit|function|mode|built-in|includes?|provides?|allows?|can )\b/.test(lower)) return 'feature';
    if (/\b(specification|specifications|model|serial|version|hdmi|usb|port|ports|resolution|volt|watt|hz|inch|mm|gb|mb|ip[0-9])\b/.test(lower)) return 'specification';
    return null;
  })();
  if (!kind) return null;
  return {
    kind,
    title: titleFromSentence(text),
    summary: text,
    evidence: text,
    confidence: 55,
    labels: inferLabels(text),
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
  const planner = createSemanticPrimarySourcePlanner(store, guard, options.signal);
  const support = createGeneratedFactWritePlanner(store, guard, { signal: options.signal });
  const entities: KnowledgeNodeRecord[] = [];
  const facts: KnowledgeNodeRecord[] = [];
  const gaps: KnowledgeNodeRecord[] = [];

  const nodeSlug = createSemanticNodeSlugPlanner(store);
  const entityPlans = semantic.entities.slice(0, 60).map((entity) => ({
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
  const sourceLinkedObjects = linkedObjectsForSource(store, source, entityIds, (id) => guard.node(id));
  const proposedEntities: KnowledgeNodeRecord[] = entityPlans.map((plan) => {
    const existing = guard.node(plan.id);
    return { ...plan, aliases: plan.aliases ?? existing?.aliases ?? [], status: existing?.status ?? 'draft',
      metadata: { ...existing?.metadata, ...plan.metadata }, createdAt: existing?.createdAt ?? 0, updatedAt: existing?.updatedAt ?? 0 };
  });
  const qualityReader = createRepairFactUsefulnessReader({ signal: options.signal });
  const featureKinds = new Set(['feature', 'capability', 'specification', 'compatibility', 'configuration']);
  const proposedFacts = semantic.facts.slice(0, 160);
  const subjects = sourceLinkedObjects.map(repairProfileSubject);
  const projected = projectRepairProfileInput({ query: 'Extract useful concrete facts about the supplied subjects from this complete source.',
    source, extraction, subjects, text: repairProfileSourceText(extraction),
    structuralReferences: captureKnowledgeSourceReferences(store, source, extraction) });
  const qualitySource = store.getSource(source.id), qualityExtraction = store.getExtractionBySourceId(source.id);
  const qualitySubjects = sourceLinkedObjects.map((subject) => ({ subject, current: store.getNode(subject.id), version: JSON.stringify(subject) }));
  const evidenceVersion = JSON.stringify({ source, extraction });
  const assertQualityCurrent = () => {
    assertSemanticWriteAllowed(options.signal, options.shouldStop); qualityReader.assertCurrent();
    if (store.getSource(source.id) !== qualitySource || store.getExtractionBySourceId(source.id) !== qualityExtraction
      || JSON.stringify({ source: store.getSource(source.id), extraction: store.getExtractionBySourceId(source.id) }) !== evidenceVersion
      || qualitySubjects.some(({ subject, current, version }) => store.getNode(subject.id) !== current || JSON.stringify(store.getNode(subject.id)) !== version)) {
      throw new KnowledgeRepairFactUsefulnessHeldError('stale');
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
  const factDrafts = prepareEnrichmentFactDrafts({ store, source, extraction, spaceId, guard, primary: planner, support,
    allFacts: semantic.facts, persistedFacts,
    sourceSubjects: sourceLinkedObjects, proposedEntities,
  });
  const activeIds = new Set([
    ...entityIds, ...factDrafts.map((fact) => fact.factId),
    ...semantic.gaps.slice(0, 32).map((gap) => `sem-gap-${semanticHash(spaceId, source.id, gap.question)}`),
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
  const gapPlans = semantic.gaps.slice(0, 32).map((gap) => ({ gap, nodeInput: prepareObservedKnowledgeNodeInput(store, nodeSlug(enrichmentGapNodeInput(gap, source,
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

  for (const relation of semantic.relations.slice(0, 80)) {
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
  for (const object of linkedObjects.slice(0, 8)) {
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

function linkedObjectsForSource(
  store: KnowledgeStore, source: KnowledgeSourceRecord,
  entityOverlayIds: ReadonlySet<string> = new Set(),
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
    if (entityOverlayIds.has(id)) continue;
    if (node && node.status !== 'stale') nodes.push(node);
  }
  return canonicalRepairSubjectNodes({
    nodes,
    text: `${source.title ?? ''} ${source.summary ?? ''} ${source.description ?? ''}`,
  });
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

function titleFromSentence(sentence: string): string {
  const withoutLead = sentence.replace(/^(the|this|these|it)\s+/i, '');
  return clampText(withoutLead, 96).replace(/[.:;,\s]+$/g, '');
}

function inferLabels(text: string): readonly string[] {
  const lower = text.toLowerCase();
  return uniqueStrings([
    /\bhdmi\b/.test(lower) ? 'hdmi' : undefined,
    /\busb\b/.test(lower) ? 'usb' : undefined,
    /\bbattery\b/.test(lower) ? 'battery' : undefined,
    /\bfirmware\b/.test(lower) ? 'firmware' : undefined,
    /\bwarranty\b/.test(lower) ? 'warranty' : undefined,
    /\bvoice\b/.test(lower) ? 'voice' : undefined,
    /\bnetwork|wi-?fi|ethernet|bluetooth\b/.test(lower) ? 'network' : undefined,
  ]);
}

function findSemanticNode(nodes: readonly KnowledgeNodeRecord[], label: string): KnowledgeNodeRecord | undefined {
  const lower = label.toLowerCase();
  return nodes.find((node) => node.title.toLowerCase() === lower)
    ?? nodes.find((node) => node.title.toLowerCase().includes(lower) || lower.includes(node.title.toLowerCase()));
}

function emptyResult(source: KnowledgeSourceRecord, skipped: boolean, reason: string): PersistedSemanticExtraction {
  return { source, skipped, reason, facts: [], entities: [], gaps: [] };
}
