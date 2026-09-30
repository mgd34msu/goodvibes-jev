import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../spaces.js';
import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeSemanticFactInput } from './types.js';
import type { SemanticPrimarySourcePlanner, SemanticWriteGuard } from './primary-source-plan.js';
import { exactKnowledgeIds, type GeneratedFactWritePlanner } from './fact-support-write-plan.js';
import { readString, readStringArray, semanticFactId, uniqueStrings } from './utils.js';

export function prepareEnrichmentFactDrafts(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly source: KnowledgeSourceRecord;
  readonly extraction: KnowledgeExtractionRecord | null;
  readonly allFacts: readonly KnowledgeSemanticFactInput[];
  readonly persistedFacts: readonly KnowledgeSemanticFactInput[];
  readonly sourceSubjects: readonly KnowledgeNodeRecord[];
  readonly proposedEntities: readonly KnowledgeNodeRecord[];
  readonly guard: SemanticWriteGuard;
  readonly primary: SemanticPrimarySourcePlanner;
  readonly support: GeneratedFactWritePlanner;
}) {
  const { spaceId, source, extraction, guard, primary, support } = input;
  const virtualSources = new Map<string, readonly string[]>();
  const originalExtractions = new Map([[source.id, extraction]]);
  const proposedIds = new Set(input.proposedEntities.map((subject) => subject.id));
  // Even facts omitted from node persistence can appear in generated wiki text.
  for (const [index, fact] of input.allFacts.entries()) support.add(spaceId, {
    ...factClaim(`wiki-fact-${index}`, fact),
  }, [source.id], [], originalExtractions);
  return input.persistedFacts.map((fact) => {
    const hints = uniqueStrings(fact.targetHints ?? []);
    const factLinkedObjects = hints.length === 0 ? input.sourceSubjects
      : input.sourceSubjects.filter((subject) => hints.some((hint) => entityMatchesHint(subject, hint)));
    const entitySubjects = (hints.length === 0 ? input.proposedEntities.slice(0, 1)
      : input.proposedEntities.filter((subject) => hints.some((hint) => entityMatchesHint(subject, hint)))).slice(0, 6);
    const sourceLinkedObjectIds = factLinkedObjects.map((node) => node.id);
    const sourceTargetHints = factLinkedObjects.map((node) => ({ id: node.id, kind: node.kind, title: node.title }));
    const targetHints = fact.targetHints?.length ? fact.targetHints : sourceTargetHints;
    const factId = semanticFactId({ spaceId, kind: fact.kind, title: fact.title,
      value: fact.value, summary: fact.summary, subjectIds: sourceLinkedObjectIds, fallbackScope: source.id });
    const existingFact = guard.node(factId);
    const sourceIds = exactKnowledgeIds([
      ...(virtualSources.get(factId) ?? readStringArray(existingFact?.metadata.sourceIds)),
      readString(existingFact?.metadata.sourceId), existingFact?.sourceId, source.id,
    ]);
    virtualSources.set(factId, sourceIds);
    const subjects = [...new Map([...factLinkedObjects.slice(0, 8), ...entitySubjects].map((subject) => [subject.id, subject])).values()];
    const supportKey = support.add(spaceId, { ...factClaim(factId, fact),
      subject: factLinkedObjects[0]?.title, targetHints,
    }, sourceIds, subjects, originalExtractions, proposedIds);
    const resolve = primary.prepare(spaceId, { kind: fact.kind, title: fact.title, summary: fact.summary,
      value: fact.value, evidence: fact.evidence, subjects: factLinkedObjects.map(({ id, title, kind }) => ({ id, title, kind })),
      targetHints: fact.targetHints,
    }, sourceIds);
    return { fact, factId, existingFact, factLinkedObjects, sourceLinkedObjectIds, targetHints, sourceIds,
      supportKey, resolve, entitySubjectIds: new Set(entitySubjects.map((subject) => subject.id)) };
  });
}
function factClaim(id: string, fact: KnowledgeSemanticFactInput) {
  return { id, kind: fact.kind, title: fact.title, summary: fact.summary ?? fact.value ?? fact.evidence,
    value: fact.value, evidence: fact.evidence, labels: fact.labels, aliases: fact.labels };
}
/** Candidate generation only; support readings decide every resulting attachment. */
function entityMatchesHint(entity: KnowledgeNodeRecord, hint: string): boolean {
  const lower = hint.toLowerCase();
  const candidates = uniqueStrings([entity.title, entity.summary, ...entity.aliases,
    readString(entity.metadata.manufacturer), readString(entity.metadata.model),
    readString(entity.metadata.modelId), readString(entity.metadata.model_id),
  ]).map((entry) => entry.toLowerCase());
  const compactHint = lower.replace(/[\s_-]+/g, '');
  return candidates.some((candidate) => {
    const compactCandidate = candidate.replace(/[\s_-]+/g, '');
    return candidate.includes(lower) || lower.includes(candidate)
      || (compactCandidate.length >= 4 && compactHint.includes(compactCandidate))
      || (compactHint.length >= 4 && compactCandidate.includes(compactHint));
  });
}

/** A namespace alias filters concrete spaces; it never relabels source content. */
export function resolveEnrichmentSpaceId(source: KnowledgeSourceRecord, requested?: string): string {
  const actual = getKnowledgeSpaceId(source);
  if (requested === undefined) return actual;
  if (typeof requested !== 'string') throw new KnowledgeGeneratedFactSupportHeldError('malformed');
  const normalized = normalizeKnowledgeSpaceId(requested);
  if (normalized !== actual && !(normalized === 'homeassistant' && isHomeAssistantKnowledgeSpace(actual))) {
    throw new KnowledgeGeneratedFactSupportHeldError('foreign-space');
  }
  return actual;
}
