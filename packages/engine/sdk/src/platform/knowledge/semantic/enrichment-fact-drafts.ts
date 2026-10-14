import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { createRepairSubjectSelectionReader } from './repair-subject-selection/reader.js';
import { repairProfileSubject } from './repair-profile.js';
import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../spaces.js';
import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeSemanticFactInput } from './types.js';
import type { SemanticPrimarySourcePlanner, SemanticWriteGuard } from './primary-source-plan.js';
import { exactKnowledgeIds, type GeneratedFactWritePlanner } from './fact-support-write-plan.js';
import { readString, readStringArray, semanticFactId } from './utils.js';

export async function prepareEnrichmentFactDrafts(input: {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
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
  const nodes = [...new Map([...input.sourceSubjects, ...input.proposedEntities].map(node => [node.id, node])).values()];
  const candidates = nodes.map((node, index) => ({ ...repairProfileSubject(node), kind: node.kind,
    aliases: node.aliases, identity: repairProfileSubject(node).identity ?? {}, reference: `subject-${index + 1}` }));
  const states = input.persistedFacts.map(fact => candidates.map(candidate => ({
    reference: candidate.reference, candidate: candidate.reference, candidates, objectProfiles: [],
    query: JSON.stringify({ title: fact.title, summary: fact.summary, value: fact.value,
      evidence: fact.evidence, labels: fact.labels, targetHints: fact.targetHints }),
  })));
  assertJudgmentInput(states);
  const current = () => { input.assertCurrent?.(); };
  const reader = createRepairSubjectSelectionReader({ signal: input.signal, assertCurrent: current });
  const drafts = [];
  for (const [index, fact] of input.persistedFacts.entries()) {
    guard.assertCurrent();
    const readings = await reader.read(states[index]!);
    guard.assertCurrent(); reader.assertCurrent();
    const selectedIds = new Set(readings.filter(reading => reading.selected).map(reading => nodes[candidates.findIndex(candidate => candidate.reference === reading.reference)]!.id));
    const factLinkedObjects = input.sourceSubjects.filter(subject => selectedIds.has(subject.id));
    const entitySubjects = input.proposedEntities.filter(subject => selectedIds.has(subject.id));
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
    const subjects = [...new Map([...factLinkedObjects, ...entitySubjects].map((subject) => [subject.id, subject])).values()];
    const supportKey = support.add(spaceId, { ...factClaim(factId, fact),
      subject: factLinkedObjects[0]?.title, targetHints,
    }, sourceIds, subjects, originalExtractions, proposedIds, { claimId: factId, subjectIds: new Set(entitySubjects.map((subject) => subject.id)) });
    const resolve = primary.prepare(spaceId, { kind: fact.kind, title: fact.title, summary: fact.summary,
      value: fact.value, evidence: fact.evidence, subjects: factLinkedObjects.map(({ id, title, kind }) => ({ id, title, kind })),
      targetHints: fact.targetHints,
    }, sourceIds);
    drafts.push({ fact, factId, existingFact, factLinkedObjects, sourceLinkedObjectIds, targetHints, sourceIds,
      supportKey, resolve, entitySubjectIds: new Set(entitySubjects.map((subject) => subject.id)) });
  }
  guard.watch('enrichment-fact-subject-readings', () => { reader.assertCurrent(); return true; });
  return drafts;
}
function factClaim(id: string, fact: KnowledgeSemanticFactInput) {
  return { id, kind: fact.kind, title: fact.title, summary: fact.summary ?? fact.value ?? fact.evidence,
    value: fact.value, evidence: fact.evidence, labels: fact.labels, aliases: fact.labels };
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
