import { KnowledgeAnswerExcerptHeldError } from './answer-excerpts/reader.js';
import { projectAnswerFactClaim } from './answer-claim-projection.js';
import type {
  KnowledgeNodeRecord,
} from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import { normalizeKnowledgeSpaceId, getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace } from '../spaces.js';
import type {
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerResult,
} from './types.js';
import {
  readRecord,
  readString,
  readStringArray,
  uniqueStrings,
} from './utils.js';
import { concreteAnswerGapSpaceId } from './answer-space.js';
import { answerNeedsEvidenceGap, answerConfidence } from './answer-quality.js';
import { prepareAnswerEvidence } from './answer-verification/evidence.js';
import { verifyKnowledgeAnswer, KnowledgeAnswerQualityHeldError, type AnswerCandidate } from './answer-verification/reader.js';
import { withAnswerVerificationBudget } from './answer-verification/budget.js';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { createSemanticWriteGuard } from './primary-source-plan.js';
import { KnowledgeSourceQualityHeldError } from '../source-quality.js';
import { KnowledgeEvidenceRelevanceHeldError } from './evidence-ranking/reader.js';
import { prepareAnswerLinkedObjects, type PreparedAnswerLinkedObjects } from './answer-object-alignment/prepare.js';
import { KnowledgeAnswerObjectAlignmentHeldError } from './answer-object-alignment/reader.js';
import { renderFallbackAnswer } from './answer-fallback.js';
import { rankAnswerSources, KnowledgeSourceRankingHeldError } from './answer-source-ranking.js';
import {
  type AnswerFactRecord,
  type EvidenceItem,
  type KnowledgeAnswerContext,
} from './answer-common.js';
import {
  filterFactsForQuery, KnowledgeFactSelectionHeldError,
} from './answer-fact-selection.js';
import {
  assertAnswerEvidenceCurrent,
  settledAnswerFacts,
  collectAnswerEvidence,
  includeOfficialLinkedEvidence,
  toSearchResult,
  uniqueNodes,
  withAnswerSourceAliases,
} from './answer-evidence.js';
import {
  isRepairedAnswerGap,
  persistAnswerGap,
  answerGapRecordIds,
  shouldPersistNoMatchGap,
} from './answer-gaps.js';
import { synthesizeAnswer } from './answer-llm.js';

export async function answerKnowledgeQuery(
  context: KnowledgeAnswerContext,
  input: KnowledgeSemanticAnswerInput,
): Promise<KnowledgeSemanticAnswerResult> {
  assertJudgmentInput({ query: input.query });
  if (typeof input.query !== 'string' || !input.query.trim()) throw new KnowledgeAnswerQualityHeldError('malformed');
  try {
    return await withAnswerVerificationBudget((signal, deadlineAt) => answerWithinBudget(context, input, signal, deadlineAt), input.timeoutMs, input.signal);
  } catch (error) {
    if (error instanceof KnowledgeAnswerQualityHeldError || error instanceof JudgmentInputError) throw error;
    if (error instanceof KnowledgeSourceRankingHeldError || error instanceof KnowledgeFactSelectionHeldError) throw new KnowledgeAnswerQualityHeldError('uncertain');
    if (error instanceof KnowledgeSourceQualityHeldError) throw new KnowledgeAnswerQualityHeldError(error.reason === 'aborted' ? 'aborted' : 'stale');
    if (error instanceof KnowledgeAnswerObjectAlignmentHeldError) throw new KnowledgeAnswerQualityHeldError(
      error.reason === 'unconfigured' ? 'unavailable' : error.reason);
    if (error instanceof KnowledgeEvidenceRelevanceHeldError || error instanceof KnowledgeAnswerExcerptHeldError) throw new KnowledgeAnswerQualityHeldError(
      error.reason === 'unsettled' ? 'uncertain' : error.reason === 'unconfigured' ? 'unavailable' : error.reason);
    throw new KnowledgeAnswerQualityHeldError('unavailable');
  }
}

async function answerWithinBudget(context: KnowledgeAnswerContext, input: KnowledgeSemanticAnswerInput,
  signal: AbortSignal, deadlineAt: number,
): Promise<KnowledgeSemanticAnswerResult> {
  const check = () => {
    if (signal.aborted) throw new KnowledgeAnswerQualityHeldError('aborted');
    if (Date.now() >= deadlineAt) throw new KnowledgeAnswerQualityHeldError('budget');
  };
  const spaceId = normalizeKnowledgeSpaceId(input.knowledgeSpaceId);
  const mode = input.mode ?? 'standard';
  const limit = Math.max(1, input.limit ?? 8);
  const objectProfiles = context.objectProfiles ?? [];
  // Protect the full structural candidate universe before the first evidence reading.
  const objects = input.includeLinkedObjects === false ? undefined
    : prepareAnswerLinkedObjects(context.store, spaceId, input, objectProfiles, signal);
  let evidenceReadSet: readonly EvidenceItem[] = [];
  const checkReadSet = () => { check(); objects?.assertCurrent(); assertAnswerEvidenceCurrent(evidenceReadSet); };
  const evidenceResolution = await resolveAnswerEvidence(context, input, spaceId, mode, limit, objectProfiles, signal, checkReadSet, objects);
  check();
  if (evidenceResolution.kind === 'no-match') return evidenceResolution.result;

  let evidence = evidenceResolution.evidence;
  evidenceReadSet = evidence;
  checkReadSet();
  let rawFacts = await collectRawAnswerFacts(input.query, evidence, signal);
  checkReadSet();
  const linkedObjects = (await objects?.read(evidence, rawFacts))?.linkedObjects ?? [];
  checkReadSet();
  evidence = await includeOfficialLinkedEvidence(context.store, spaceId, input.query, evidence, linkedObjects, limit, signal);
  evidenceReadSet = evidence;
  checkReadSet();
  rawFacts = await collectRawAnswerFacts(input.query, evidence, signal);
  checkReadSet();
  const rankedSources = await rankAnswerSources(evidence, rawFacts, input.query, signal);
  checkReadSet();
  const acceptedSourceIds = new Set(rankedSources.map((source) => source.id));
  evidence = evidence.filter((item) => !item.source || acceptedSourceIds.has(item.source.id));
  rawFacts = rawFacts.filter((fact) => {
    const sources = uniqueStrings([...readStringArray(fact.metadata.sourceIds), readString(fact.metadata.sourceId), fact.sourceId]);
    return sources.length === 0 || sources.some((id) => acceptedSourceIds.has(id));
  });
  const acceptedFactIds = new Set(rawFacts.map((fact) => fact.id));
  evidence = evidence.filter((item) => item.node?.metadata.semanticKind !== 'fact' || acceptedFactIds.has(item.node.id));
  if (evidence.length === 0) return {
    ok: true, spaceId, query: input.query,
    answer: { text: input.noMatchMessage ?? `No source-backed knowledge matched "${input.query}".`, mode, confidence: 0, quality: { status: 'no-evidence', decisionIds: [] }, sources: [], linkedObjects: [], facts: [], gaps: [], synthesized: false },
    results: [],
  };
  const facts = withAnswerFactContract(context.store, rawFacts, linkedObjects);
  const sources = rankedSources.slice(0, limit).map(withAnswerSourceAliases);
  const gapSpaceId = concreteAnswerGapSpaceId(spaceId, evidence, sources, linkedObjects);
  const claimSubjects = uniqueNodes([...linkedObjects, ...linkedObjectsFromFacts(context.store, rawFacts)])
    .filter((node) => getKnowledgeSpaceId(node) === spaceId || (spaceId === 'homeassistant' && isHomeAssistantKnowledgeSpace(getKnowledgeSpaceId(node))));
  checkReadSet();
  const prepared = prepareAnswerEvidence({ store: context.store, spaceId, query: input.query, sources: rankedSources.slice(0, limit), facts: rawFacts, subjects: claimSubjects, signal });
  const gapIds = answerGapRecordIds(gapSpaceId, input.query, linkedObjects[0]?.title, linkedObjects[0]?.id);
  prepared.guard.node(gapIds.nodeId);
  prepared.guard.watch(`answer-gap-issue:${gapIds.issueId}`, () => context.store.getIssue(gapIds.issueId));
  for (const fact of facts) {
    // Returned associations must resolve locally; an unknown/foreign/stale
    // reference cannot disappear from the claim while remaining in metadata.
    const subjectIds = uniqueStrings([...(fact.subjectIds ?? []), ...readStringArray(fact.metadata.subjectIds), ...readStringArray(fact.metadata.linkedObjectIds)]);
    if (subjectIds.some((id) => !claimSubjects.some((subject) => subject.id === id))) throw new KnowledgeAnswerQualityHeldError('malformed');
  }
  const candidateClaims = facts.map((fact) => projectAnswerFactClaim(fact, claimSubjects));
  assertJudgmentInput({ query: input.query, facts: candidateClaims });
  const candidateFacts = candidateClaims.map((claim) => JSON.stringify(claim));
  checkReadSet(); prepared.assertCurrent();
  const generated = prepared.evidence.length ? await synthesizeAnswer(context.llm ?? null, input.query, mode, prepared.evidence,
    { signal, timeoutMs: Math.max(1, deadlineAt - Date.now()) }) : null;
  checkReadSet(); prepared.assertCurrent();
  const rendered = renderFallbackAnswer(input.query, mode, prepared.evidence.map((row) => ({ title: row.title ?? row.reference, excerpt: row.text })), facts);
  const candidates: AnswerCandidate[] = [
    ...(generated ? [{ id: 'generated' as const, text: generated, facts: candidateFacts }] : []),
    ...(rendered.synthesized ? [{ id: 'rendered' as const, text: rendered.text, facts: candidateFacts }] : []),
  ];
  const selection = await verifyKnowledgeAnswer({ query: input.query, evidence: prepared.evidence, candidates },
    { signal, timeoutMs: Math.max(1, deadlineAt - Date.now()) });
  checkReadSet(); prepared.assertCurrent();
  const missingExtraction = selection.quality.status === 'no-evidence';
  const evidenceGap = answerNeedsEvidenceGap(selection.quality) || missingExtraction
    ? await persistAnswerGap(context.store, gapSpaceId, input.query, missingExtraction
      ? 'Matching sources have no extracted evidence available for verification.'
      : 'Verified evidence does not establish every requested detail consistently.', { sources, linkedObjects, signal, assertCurrent: () => { checkReadSet(); prepared.assertCurrent(); } })
    : null;
  check();
  const text = selection.candidate?.text ?? (selection.quality.status === 'no-evidence'
    ? 'Matching sources have no extracted evidence available for a verified answer.'
    : 'I could not verify an answer from the available evidence.');

  return {
    ok: true,
    spaceId,
    query: input.query,
    answer: {
      text,
      mode,
      confidence: input.includeConfidence === false ? 0 : answerConfidence(selection.quality),
      quality: { ...selection.quality, evidenceReferences: prepared.references },
      sources: input.includeSources === false ? [] : sources,
      linkedObjects,
      facts: selection.candidate ? facts : [],
      gaps: evidenceGap && !isRepairedAnswerGap(evidenceGap) ? [evidenceGap] : [],
      synthesized: Boolean(selection.candidate),
    },
    results: evidence.slice(0, limit).map(toSearchResult),
  };
}

type ObjectProfiles = NonNullable<KnowledgeAnswerContext['objectProfiles']>;

type AnswerEvidenceResolution =
  | { readonly kind: 'matched'; readonly evidence: readonly EvidenceItem[] }
  | { readonly kind: 'no-match'; readonly result: KnowledgeSemanticAnswerResult };

async function resolveAnswerEvidence(
  context: KnowledgeAnswerContext,
  input: KnowledgeSemanticAnswerInput,
  spaceId: string,
  mode: string,
  limit: number,
  objectProfiles: ObjectProfiles,
  signal: AbortSignal,
  check: () => void,
  objects?: PreparedAnswerLinkedObjects,
): Promise<AnswerEvidenceResolution> {
  // Snapshot absence as well as selected records: a late indexing/operator change
  // cannot turn an earlier no-match observation into a repair write.
  const guard = createSemanticWriteGuard(context.store, signal);
  const matches = (value: { readonly metadata: Readonly<Record<string, unknown>> }) => getKnowledgeSpaceId(value) === spaceId
    || (spaceId === 'homeassistant' && isHomeAssistantKnowledgeSpace(getKnowledgeSpaceId(value)));
  guard.watch('retrieval-sources', () => context.store.listSources(Number.MAX_SAFE_INTEGER).filter(matches));
  guard.watch('retrieval-nodes', () => context.store.listNodes(Number.MAX_SAFE_INTEGER).filter(matches));
  guard.watch('retrieval-extractions', () => context.store.listExtractions(Number.MAX_SAFE_INTEGER).filter(matches));
  const evidence = await collectAnswerEvidence(context.store, input, spaceId, limit, objectProfiles, signal);
  check(); guard.assertCurrent(); assertAnswerEvidenceCurrent(evidence);
  if (signal.aborted) throw new KnowledgeAnswerQualityHeldError('aborted');
  if (evidence.length > 0) return { kind: 'matched', evidence };

  const linkedObjects = (await objects?.read([], []))?.linkedObjects ?? [];
  check(); guard.assertCurrent(); assertAnswerEvidenceCurrent(evidence);
  const linkedEvidence = await includeOfficialLinkedEvidence(context.store, spaceId, input.query, evidence, linkedObjects, limit, signal);
  check(); guard.assertCurrent(); assertAnswerEvidenceCurrent(evidence);
  assertAnswerEvidenceCurrent(linkedEvidence);
  if (linkedEvidence.length > 0) return { kind: 'matched', evidence: linkedEvidence };

  if (signal.aborted) throw new KnowledgeAnswerQualityHeldError('aborted');
  const gap = shouldPersistNoMatchGap(spaceId, input.query, linkedObjects)
    ? await persistAnswerGap(context.store, concreteAnswerGapSpaceId(spaceId, [], [], linkedObjects), input.query, 'No indexed evidence matched the question.', {
      linkedObjects, signal, assertCurrent: () => { check(); guard.assertCurrent(); assertAnswerEvidenceCurrent(linkedEvidence); },
    })
    : null;
  return {
    kind: 'no-match',
    result: {
      ok: true,
      spaceId,
      query: input.query,
      answer: {
        text: input.noMatchMessage ?? `No knowledge matched "${input.query}".`,
        mode,
        confidence: 0,
        quality: { status: 'no-evidence', decisionIds: [] },
        sources: [],
        linkedObjects,
        facts: [],
        gaps: gap ? [gap] : [],
        synthesized: false,
      },
      results: [],
    },
  };
}

async function collectRawAnswerFacts(query: string, evidence: readonly EvidenceItem[], signal?: AbortSignal): Promise<readonly KnowledgeNodeRecord[]> {
  return (settledAnswerFacts(query, evidence) ?? await filterFactsForQuery(query, uniqueNodes(evidence.flatMap((item) => item.facts)), signal)).slice(0, 24);
}

function withAnswerFactContract(
  store: KnowledgeStore,
  facts: readonly KnowledgeNodeRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): readonly AnswerFactRecord[] {
  if (facts.length === 0) return [];
  const linkedObjectIds = new Set(linkedObjects.map((node) => node.id));
  const result: AnswerFactRecord[] = [];
  for (const fact of facts) {
    const source = fact.sourceId ? store.getSource(fact.sourceId) : null;
    const discovery = readRecord(source && getKnowledgeSpaceId(source) === getKnowledgeSpaceId(fact) ? source.metadata.sourceDiscovery : undefined);
    const metadataLinkedIds = uniqueStrings([
      ...readStringArray(fact.metadata.linkedObjectIds),
      ...readStringArray(fact.metadata.subjectIds),
      ...readStringArray(discovery.linkedObjectIds),
    ]);
    const subjectIds = uniqueStrings([
      ...metadataLinkedIds.filter((id) => linkedObjectIds.has(id)),
      ...factSubjectIdsFromGraph(store, fact, linkedObjects),
    ]);
    const subjects = subjectIds
      .map((id) => linkedObjects.find((node) => node.id === id) ?? store.getNode(id))
      .filter((node): node is KnowledgeNodeRecord => Boolean(node && node.status === 'active' && getKnowledgeSpaceId(node) === getKnowledgeSpaceId(fact)));
    if (subjects.length === 0) {
      result.push(fact as AnswerFactRecord);
      continue;
    }
    const targetHints = answerTargetHints(subjects);
    const metadata = {
      ...fact.metadata,
      subject: readString(fact.metadata.subject) ?? subjects[0]?.title,
      subjectIds: subjects.map((node) => node.id),
      linkedObjectIds: subjects.map((node) => node.id),
      targetHints,
    };
    result.push({
      ...fact,
      metadata,
      subject: metadata.subject as string | undefined,
      subjectIds: metadata.subjectIds as readonly string[],
      linkedObjectIds: metadata.linkedObjectIds as readonly string[],
      targetHints,
    });
  }
  return result;
}

function linkedObjectsFromFacts(
  store: KnowledgeStore,
  facts: readonly KnowledgeNodeRecord[],
): KnowledgeNodeRecord[] {
  return uniqueNodes(facts.flatMap((fact) => {
    const spaceId = getKnowledgeSpaceId(fact);
    const ids = uniqueStrings([...(fact.subjectIds ?? []), ...(fact.linkedObjectIds ?? []),
      ...readStringArray(fact.metadata.linkedObjectIds), ...readStringArray(fact.metadata.subjectIds),
      ...store.edgesFor('node', fact.id).filter((edge) => isActiveKnowledgeEdge(edge) && getKnowledgeSpaceId(edge) === spaceId
        && edge.fromKind === 'node' && edge.fromId === fact.id && edge.toKind === 'node' && edge.relation === 'describes').map((edge) => edge.toId)]);
    return ids.map((id) => store.getNode(id)).filter((node): node is KnowledgeNodeRecord => Boolean(node
      && node.status === 'active' && getKnowledgeSpaceId(node) === spaceId));
  }));
}

function factSubjectIdsFromGraph(
  store: KnowledgeStore,
  fact: KnowledgeNodeRecord,
  linkedObjects: readonly KnowledgeNodeRecord[],
): string[] {
  if (linkedObjects.length === 0) return [];
  const spaceId = getKnowledgeSpaceId(fact);
  const linkedIds = new Set(linkedObjects.filter((node) => node.status === 'active' && getKnowledgeSpaceId(node) === spaceId).map((node) => node.id));
  const factSourceId = readString(fact.metadata.sourceId) ?? fact.sourceId;
  const sourcesSupportingFact = new Set<string>();
  const sourcesLinkedToSubject = new Map<string, Set<string>>();
  const directSubjectIds = new Set<string>();
  for (const edge of store.listEdges()) {
    if (!isActiveKnowledgeEdge(edge) || getKnowledgeSpaceId(edge) !== spaceId) continue;
    const sourceId = edge.fromKind === 'source' ? edge.fromId : edge.toKind === 'source' ? edge.toId : undefined;
    if (sourceId) {
      const source = store.getSource(sourceId);
      if (!source || getKnowledgeSpaceId(source) !== spaceId) continue;
    }
    if (edge.fromKind === 'node' && edge.fromId === fact.id && edge.toKind === 'node' && linkedIds.has(edge.toId) && edge.relation === 'describes') {
      directSubjectIds.add(edge.toId);
    }
    if (edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === fact.id && edge.relation === 'supports_fact') {
      sourcesSupportingFact.add(edge.fromId);
    }
    if (edge.fromKind === 'source' && edge.toKind === 'node' && linkedIds.has(edge.toId)) {
      const current = sourcesLinkedToSubject.get(edge.fromId) ?? new Set<string>();
      current.add(edge.toId);
      sourcesLinkedToSubject.set(edge.fromId, current);
    }
    if (edge.fromKind === 'node' && linkedIds.has(edge.fromId) && edge.toKind === 'source') {
      const current = sourcesLinkedToSubject.get(edge.toId) ?? new Set<string>();
      current.add(edge.fromId);
      sourcesLinkedToSubject.set(edge.toId, current);
    }
  }
  const factSource = factSourceId ? store.getSource(factSourceId) : undefined;
  if (factSource && getKnowledgeSpaceId(factSource) === spaceId) sourcesSupportingFact.add(factSource.id);
  for (const sourceId of sourcesSupportingFact) {
    for (const subjectId of sourcesLinkedToSubject.get(sourceId) ?? []) directSubjectIds.add(subjectId);
  }
  return [...directSubjectIds];
}

function answerTargetHints(nodes: readonly KnowledgeNodeRecord[]): readonly Record<string, unknown>[] {
  return nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    title: node.title,
    ...(node.summary ? { summary: node.summary } : {}),
  }));
}
