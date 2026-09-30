import { isActiveKnowledgeEdge } from '../projection-utils.js';
import { KnowledgeRepairFactUsefulnessHeldError } from './repair-usefulness/types.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { captureKnowledgeSourceReferences } from '../source-structural-references.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { projectRepairProfileInput, repairProfileSourceText, repairProfileSubject } from './repair-profile.js';
import { exactKnowledgeIds } from './fact-support-write-plan.js';
import { createSemanticWriteGuard } from './primary-source-plan.js';
import { createRepairFactUsefulnessReader, type RepairFactUsefulnessInput } from './repair-usefulness/reader.js';
import { readString, readStringArray } from './utils.js';

/** Read-set includes excluded facts/statuses and edge changes that affect the whole-pass count. */
export function createRepairUsefulnessGuard(store: KnowledgeStore, spaceId: string, gap: KnowledgeNodeRecord,
  subjects: readonly KnowledgeNodeRecord[], signal?: AbortSignal, shouldStop?: () => boolean) {
  const guard = createSemanticWriteGuard(store, signal, shouldStop);
  guard.watch('repair-usefulness-facts', () => store.listNodesInSpace(spaceId).filter((node) => node.kind === 'fact'));
  guard.watch('repair-usefulness-edges', () => store.listEdges());
  const currentGap = store.getNode(gap.id);
  guard.watch(`node:${gap.id}`, () => store.getNode(gap.id), { ...gap, updatedAt: currentGap?.updatedAt ?? gap.updatedAt });
  for (const subject of subjects) guard.watch(`node:${subject.id}`, () => store.getNode(subject.id), subject);
  return guard;
}
interface UsefulnessContext {
  readonly store: KnowledgeStore; readonly spaceId: string; readonly gap: KnowledgeNodeRecord;
  readonly subjects: readonly KnowledgeNodeRecord[];
  readonly guard: ReturnType<typeof createRepairUsefulnessGuard>;
  readonly reader: ReturnType<typeof createRepairFactUsefulnessReader>;
}
export interface ProposedRepairUsefulClaim {
  readonly factId: string;
  readonly claim: RepairFactUsefulnessInput['fact'];
  readonly sourceIds: readonly string[];
}
function labels(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((label) => typeof label === 'string')) throw new KnowledgeRepairFactUsefulnessHeldError('malformed');
  return value;
}
/** Stored rows keep their existing identity; no review or metadata stamp exempts a claim. */
export async function prepareRepairUsefulness(input: UsefulnessContext & { readonly candidates: readonly KnowledgeNodeRecord[] }) {
  const proposals = input.candidates.map((fact) => {
    input.guard.watch(`node:${fact.id}`, () => input.store.getNode(fact.id), fact);
    const sourceIds = exactKnowledgeIds([fact.sourceId, readString(fact.metadata.sourceId), ...readStringArray(fact.metadata.sourceIds),
      ...input.store.listEdges().filter((edge) => isActiveKnowledgeEdge(edge) && edge.toKind === 'node' && edge.toId === fact.id && edge.fromKind === 'source' && edge.relation === 'supports_fact').map((edge) => edge.fromId)]);
    return { factId: fact.id, sourceIds, claim: { title: fact.title, kind: readString(fact.metadata.factKind) ?? fact.kind,
      summary: fact.summary, value: fact.metadata.value, evidence: fact.metadata.evidence, subject: fact.metadata.subject,
      labels: labels(fact.metadata.labels), aliases: fact.aliases } };
  });
  return prepareProposedRepairUsefulness({ ...input, proposals });
}
/** Uses exact final prepared claims, never fabricated stored-node/review authority. */
export async function prepareProposedRepairUsefulness(input: UsefulnessContext & { readonly proposals: readonly ProposedRepairUsefulClaim[] }) {
  const { store, guard } = input;
  const query = [input.gap.title, input.gap.summary].filter((value) => value !== undefined).join('\n\n');
  const subjects = input.subjects.map(repairProfileSubject);
  const candidates: RepairFactUsefulnessInput[] = input.proposals.map((proposal, index) => {
    guard.node(proposal.factId); // Missing and existing target rows both remain guarded.
    const evidence = proposal.sourceIds.flatMap((id) => {
      const source = guard.source(id), extraction = guard.extraction(id);
      if (!source || getKnowledgeSpaceId(source) !== input.spaceId || (source.status !== 'indexed' && source.status !== 'pending')
        || isGeneratedKnowledgeSource(source) || !extraction || getKnowledgeSpaceId(extraction) !== input.spaceId) return [];
      const projected = projectRepairProfileInput({ query, subjects, source, extraction, text: repairProfileSourceText(extraction),
        structuralReferences: captureKnowledgeSourceReferences(store, source, extraction) });
      return [{ source: projected.source, ...(projected.extraction ? { extraction: projected.extraction } : {}), text: projected.text }];
    });
    return { reference: `fact-${index + 1}`, query, subjects, fact: proposal.claim, evidence };
  });
  const readings = await input.reader.read(candidates);
  guard.assertCurrent(); input.reader.assertCurrent();
  const byReference = new Map(candidates.map((candidate, index) => [candidate.reference, index]));
  const acceptedIndexes = new Set(readings.filter((reading) => reading.useful).map((reading) => byReference.get(reading.reference)!));
  const acceptedIds = new Set([...acceptedIndexes].map((index) => input.proposals[index]!.factId));
  return { count: acceptedIndexes.size, acceptedIndexes, accepts: (fact: KnowledgeNodeRecord) => acceptedIds.has(fact.id),
    assertCurrent: () => { guard.assertCurrent(); input.reader.assertCurrent(); } };
}
