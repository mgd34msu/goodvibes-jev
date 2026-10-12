import type { KnowledgeStore } from '../store.js';
import { captureOwnedJson, retainOwnedJson } from '../../gate/judgment-input.js';
import { hasGeneratedFactRecordReferences, retainGeneratedFactRecordReferences } from '../generated-fact-record-references.js';
import { assertKnowledgeRecordAdmissions, assertKnowledgeRecordContainers, prepareKnowledgeRecordAdmission } from '../store-record-snapshot.js';
import { captureKnowledgeSourceReferences } from '../source-structural-references.js';
import { projectRepairProfileInput, repairProfileSourceText, repairProfileSubject } from './repair-profile.js';
import { prepareRepairFactScoring } from './repair-fact-scoring/reader.js';
import { KnowledgeRepairFactScoringHeldError } from './repair-fact-scoring/types.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import { factsForSource } from './self-improvement-graph.js';
import { assertSemanticWriteAllowed, createSemanticWriteGuard } from './primary-source-plan.js';
import { createGeneratedFactWritePlanner, exactKnowledgeIds, generatedFactSupportMetadata } from './fact-support-write-plan.js';
import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';
import { repairSubjectHints } from './repair-subjects.js';
import { readString, readStringArray, semanticMetadata } from './utils.js';
import { generatedClaimSupportReferences, retainRevalidatedGeneratedClaim, type GeneratedClaimRelinking } from './verification/structural-references.js';

/** Verify all existing facts and proposed attachments before this pass changes any. */
export async function writeSupportedRepairSubjectLinks(input: {
  readonly store: KnowledgeStore; readonly spaceId: string; readonly gap: KnowledgeNodeRecord;
  readonly subjects: readonly KnowledgeNodeRecord[]; readonly sourceIds: readonly string[];
  readonly candidate: (fact: KnowledgeNodeRecord) => boolean;
  readonly assertCurrent?: (() => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  /** Opaque in-memory producer scope, never inferred from a stored ID or receipt. */
  readonly generatedClaims?: GeneratedClaimRelinking | undefined;
}): Promise<void> {
  const { store, spaceId, subjects, signal, shouldStop, assertCurrent: ownerCurrent, candidate, generatedClaims } = input;
  const originalData = () => {
    const { store: _store, assertCurrent: _owner, candidate: _candidate, signal: _signal, shouldStop: _stop, generatedClaims: _claims, ...data } = input;
    return data;
  };
  const original = retainOwnedJson(originalData()), originalVersion = JSON.stringify(original.snapshot);
  const assertOriginalCurrent = () => {
    if (input.store !== store || input.spaceId !== spaceId || input.subjects !== subjects || input.signal !== signal
      || input.shouldStop !== shouldStop || input.assertCurrent !== ownerCurrent || input.candidate !== candidate || input.generatedClaims !== generatedClaims) throw new KnowledgeRepairFactScoringHeldError('stale');
    assertSemanticWriteAllowed(signal, shouldStop);
    original.assertCurrent();
    if (JSON.stringify(captureOwnedJson(originalData())) !== originalVersion) throw new KnowledgeRepairFactScoringHeldError('stale');
  };
  const assertOwnerCurrent = () => {
    assertOriginalCurrent();
    const result: unknown = ownerCurrent?.();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new KnowledgeRepairFactScoringHeldError('stale'); }
    assertOriginalCurrent();
  };
  assertOwnerCurrent();
  if (subjects.length === 0) return;
  const guard = createSemanticWriteGuard(store, input.signal, input.shouldStop);
  const support = createGeneratedFactWritePlanner(store, guard, { signal: input.signal });
  guard.node(input.gap.id);
  const graph = await buildKnowledgeSemanticGraphIndex(store, spaceId, { signal: input.signal, shouldStop: input.shouldStop, assertCurrent: input.assertCurrent });
  guard.watch('attachment-scope', () => { graph.assertCurrent(); return true; });
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
    }, sources, allSubjects, new Map(), new Set(), input.generatedClaims
      ? generatedClaimSupportReferences(input.generatedClaims, store, fact) : undefined);
    return { fact, sources, primarySourceId: fact.sourceId ?? fallback, allSubjects, subjectIds, targetHints, subject, key };
  });
  const factIds = new Set(drafts.map((draft) => draft.fact.id));
  guard.watch('attachment-fact-edges', () => store.listEdges().filter((edge) =>
    (edge.fromKind === 'node' && factIds.has(edge.fromId)) || (edge.toKind === 'node' && factIds.has(edge.toId))));
  // The complete actual persisted facts, including unrecognized metadata tails,
  // must pass native admission before any support or scoring request can leave.
  const factAdmissions = drafts.map(({ fact }) => prepareKnowledgeRecordAdmission(store, 'node', fact));
  assertKnowledgeRecordContainers({ facts: drafts.map(({ fact }) => fact) }, factAdmissions);
  assertKnowledgeRecordAdmissions(store, factAdmissions);
  await support.readAll();
  // A relink is a new publication decision. Read the complete persisted claim
  // and original primary evidence again; stored score metadata is no authority.
  const scoringRecords = drafts.map((draft) => {
    const source = guard.source(draft.primarySourceId), extraction = guard.extraction(draft.primarySourceId);
    if (!source) throw new KnowledgeGeneratedFactSupportHeldError('missing-evidence');
    const references = { source, extraction, proof: captureKnowledgeSourceReferences(store, source, extraction) };
    return { source, extraction, subjects: draft.allSubjects, references };
  });
  const scoringAdmissions = [...factAdmissions, ...scoringRecords.flatMap(({ source, extraction, subjects: scoringSubjects, references }) => [
    prepareKnowledgeRecordAdmission(store, 'source', source, references),
    ...(extraction ? [prepareKnowledgeRecordAdmission(store, 'extraction', extraction, references)] : []),
    ...scoringSubjects.map(subject => prepareKnowledgeRecordAdmission(store, 'node', subject)),
  ])];
  assertKnowledgeRecordContainers({ facts: drafts.map(({ fact }) => fact), records: scoringRecords.map(({ source, extraction, subjects: scoringSubjects }) => ({ source, extraction, subjects: scoringSubjects })) }, scoringAdmissions);
  const assertScoringOwnerCurrent = () => { store.assertRecordSnapshotFrame(() => {
    assertOwnerCurrent(); guard.assertCurrent(); assertKnowledgeRecordAdmissions(store, scoringAdmissions);
    for (const { fact } of drafts) if (store.getNode(fact.id) !== fact) throw new KnowledgeRepairFactScoringHeldError('stale');
    for (const { source, extraction, subjects: scoringSubjects } of scoringRecords) {
      if (store.getSource(source.id) !== source || store.getExtractionBySourceId(source.id) !== extraction
        || scoringSubjects.some(subject => store.getNode(subject.id) !== subject)) throw new KnowledgeRepairFactScoringHeldError('stale');
    }
  }); };
  const scoringInputs = drafts.map((draft, index) => {
    const records = scoringRecords[index];
    if (!records) throw new KnowledgeRepairFactScoringHeldError('malformed');
    const query = [input.gap.title, input.gap.summary].filter(value => value !== undefined).join('\n\n');
    const projected = projectRepairProfileInput({ query, source: records.source, extraction: records.extraction,
      text: repairProfileSourceText(records.extraction), subjects: records.subjects.map(repairProfileSubject), structuralReferences: records.references.proof });
    const evidence = { source: projected.source, ...(projected.extraction ? { extraction: projected.extraction } : {}), text: projected.text };
    return { reference: `fact-${index + 1}`, query, subjects: projected.subjects,
      fact: { title: draft.fact.title, kind: readString(draft.fact.metadata.factKind) ?? draft.fact.kind,
        summary: draft.fact.summary, value: draft.fact.metadata.value, evidence: draft.fact.metadata.evidence,
        subject: draft.subject, labels: readStringArray(draft.fact.metadata.labels), aliases: draft.fact.aliases },
      evidence: [evidence], trustEvidence: evidence };
  });
  const scoringPlan = await prepareRepairFactScoring(scoringInputs, { signal, assertCurrent: assertScoringOwnerCurrent });
  const plans = drafts.map((draft, index) => {
    const scoring = scoringPlan.readings[index];
    if (!scoring || scoring.reference !== scoringInputs[index]?.reference) throw new KnowledgeRepairFactScoringHeldError('malformed');
    const factScoring = { ...scoring, sourceId: draft.primarySourceId, trustSourceId: draft.primarySourceId };
    const supportPlans = Object.freeze([...support.plans(draft.key)]);
    const generatedRecord = hasGeneratedFactRecordReferences(store, draft.fact);
    const supportMetadata = generatedFactSupportMetadata(supportPlans, draft.fact.metadata.generatedFactSupport);
    const nodeInput = { ...draft.fact, confidence: scoring.trust * 100, sourceId: draft.primarySourceId, metadata: semanticMetadata(spaceId, {
      ...draft.fact.metadata, subject: draft.subject, subjectIds: draft.subjectIds, linkedObjectIds: draft.subjectIds,
      targetHints: draft.targetHints, sourceId: draft.primarySourceId, sourceIds: draft.sources,
      generatedFactSupport: supportMetadata, factScoring, linkedBy: readString(draft.fact.metadata.linkedBy) ?? 'semantic-gap-repair',
    }) };
    return { ...draft, supportMetadata, factScoring, scoring, supportPlans, generatedRecord, nodeInput };
  });
  const assertCurrent = () => { store.assertRecordSnapshotFrame(() => { assertScoringOwnerCurrent(); scoringPlan.assertCurrent(); }); };
  const edges = plans.flatMap(({ fact, primarySourceId, supportMetadata, factScoring, scoring }) => subjects.map((object) => ({
    fromKind: 'node' as const, fromId: fact.id, toKind: 'node' as const, toId: object.id,
    relation: 'describes', weight: scoring.subjectSupport,
    metadata: semanticMetadata(spaceId, { linkedBy: 'semantic-gap-repair', repairedAt: Date.now(),
      sourceId: primarySourceId, generatedFactSupport: supportMetadata, factScoring }),
  })));
  // One final original-authority check precedes all node/edge publication. There
  // is no await between affected rows and no need to rebase our own writes.
  const receipt = await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
    nodes: plans.map((plan) => plan.nodeInput), edges, issues: [], assertCurrent,
  }), { signal: input.signal, requireAccepted: true });
  for (const { fact, supportPlans, generatedRecord } of plans) {
    const written = receipt.nodes.find((node) => node.id === fact.id);
    if (!written || store.getNode(fact.id) !== written) throw new KnowledgeGeneratedFactSupportHeldError('stale');
    if (generatedRecord) retainGeneratedFactRecordReferences(store, written, supportPlans, fact);
    if (input.generatedClaims) retainRevalidatedGeneratedClaim(input.generatedClaims, store, fact, written);
  }
}
