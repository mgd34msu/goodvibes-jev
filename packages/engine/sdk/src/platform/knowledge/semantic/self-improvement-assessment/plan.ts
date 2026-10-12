import { types as nodeTypes } from 'node:util';
import { toJson, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, retainOwnedJson } from '../../../gate/judgment-input.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../../types.js';
import type { KnowledgeObjectProfilePolicy } from '../../extensions.js';
import { getKnowledgeSpaceId } from '../../spaces.js';
import { prepareKnowledgeRecordAdmission, assertKnowledgeRecordAdmissions, assertKnowledgeRecordContainers, KnowledgeRecordAdmissionHeldError } from '../../store-record-snapshot.js';
import { captureKnowledgeSourceReferences } from '../../source-structural-references.js';
import { projectRepairProfileInput, repairProfileSourceText, repairProfileSubject } from '../repair-profile.js';
import { readString } from '../utils.js';
import { matchingObjectProfiles } from '../self-improvement-graph.js';
import { prepareRepairProfileRequirement } from '../repair-profile-requirement/reader.js';
import { readSelfImprovementAssessment, KnowledgeSelfImprovementAssessmentHeldError as Held, type SelfImprovementAssessment } from './reader.js';

interface AssessmentInput {
  readonly kind: 'context' | 'coverage';
  readonly store: KnowledgeStore; readonly spaceId: string; readonly query: string;
  readonly fullProfileRequired?: boolean | undefined;
  readonly gap?: KnowledgeNodeRecord | undefined;
  readonly subjects: readonly KnowledgeNodeRecord[]; readonly sources: readonly KnowledgeSourceRecord[];
  readonly facts: readonly KnowledgeNodeRecord[]; readonly objectProfiles: readonly KnowledgeObjectProfilePolicy[];
  readonly signal?: AbortSignal | undefined; readonly shouldStop?: (() => boolean) | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
function content(value: object): Readonly<Record<string, JsonValue>> {
  const result = toJson(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Held('malformed');
  return result;
}
/** Full stored originals precede projection, caps and any reader acquisition. Native clocks and reference authority remain local. */
export async function prepareSelfImprovementAssessment(input: AssessmentInput): Promise<SelfImprovementAssessment> {
  const { store, spaceId, kind, query, gap, subjects: originalSubjects, sources: originalSources, facts: originalFacts,
    objectProfiles: originalProfiles, fullProfileRequired, signal, shouldStop, assertCurrent: ownerCurrent } = input;
  const data = () => ({ query: input.query, gap: input.gap, subjects: input.subjects, sources: input.sources,
    facts: input.facts, objectProfiles: input.objectProfiles, fullProfileRequired: input.fullProfileRequired });
  const original = retainOwnedJson(data(), nodeTypes.isProxy);
  const evidence = input.sources.map(source => {
    const extraction = store.getExtractionBySourceId(source.id);
    return { source, extraction, references: { source, extraction, proof: captureKnowledgeSourceReferences(store, source, extraction) } };
  });
  const nodeContents: Readonly<Record<string, JsonValue>>[] = [];
  const capture = () => [
    ...(input.gap ? [prepareKnowledgeRecordAdmission(store, 'node', input.gap)] : []),
    ...[...input.subjects, ...input.facts].map((node, index) => prepareKnowledgeRecordAdmission(store, 'node', node, undefined, metadata => {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Held('malformed');
      nodeContents[index] = content(metadata);
    })),
    ...evidence.flatMap(({ source, extraction, references }) => [prepareKnowledgeRecordAdmission(store, 'source', source, references),
      ...(extraction ? [prepareKnowledgeRecordAdmission(store, 'extraction', extraction, references)] : [])]),
  ];
  let admissions: ReturnType<typeof capture> | undefined;
  try { store.assertRecordSnapshotFrame(() => { admissions = capture(); }); }
  catch (error) { if (error instanceof KnowledgeRecordAdmissionHeldError) throw new Held(error.reason); throw error; }
  if (!admissions) throw new Held('stale');
  const receipts = admissions;
  assertKnowledgeRecordContainers(data(), receipts);
  for (const row of [...input.subjects, ...input.facts, ...(input.gap ? [input.gap] : []),
    ...evidence.flatMap(({ source, extraction }) => [source, ...(extraction ? [extraction] : [])])]) {
    if (getKnowledgeSpaceId(row) !== spaceId) throw new Held('foreign-space');
    for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
      const declared = row.metadata[key];
      if (declared !== undefined && (typeof declared !== 'string' || declared.trim() !== spaceId)) throw new Held('foreign-space');
    }
  }
  const assertIdentity = () => {
    if (signal?.aborted || shouldStop?.()) throw new Held('aborted');
    if (input.store !== store || input.spaceId !== spaceId || input.kind !== kind || input.query !== query || input.gap !== gap
      || input.subjects !== originalSubjects || input.sources !== originalSources || input.facts !== originalFacts || input.objectProfiles !== originalProfiles
      || input.fullProfileRequired !== fullProfileRequired
      || input.signal !== signal || input.shouldStop !== shouldStop || input.assertCurrent !== ownerCurrent) throw new Held('stale');
    try { original.assertCurrent(); } catch { throw new Held('stale'); }
  };
  const assertCurrent = () => {
    try { store.assertRecordSnapshotFrame(() => {
      assertIdentity();
      const result: unknown = ownerCurrent?.();
      if (result !== undefined) { try { void Promise.resolve(result).catch(() => {}); } catch { /* Restriction only. */ } throw new Held('stale'); }
      assertIdentity();
      assertKnowledgeRecordAdmissions(store, receipts);
      for (const { source, extraction } of evidence) if (store.getExtractionBySourceId(source.id) !== extraction) throw new Held('stale');
    }); } catch (error) { if (error instanceof KnowledgeRecordAdmissionHeldError) throw new Held(error.reason); throw error; }
  };
  assertCurrent();
  const admittedContent = (index: number): Readonly<Record<string, JsonValue>> => {
    const value = nodeContents[index];
    if (!value) throw new Held('malformed');
    return value;
  };
  const subjects = input.subjects.map((node, index) => ({ ...repairProfileSubject(node), kind: node.kind, aliases: node.aliases,
    identity: repairProfileSubject(node).identity ?? {}, summary: node.summary, content: admittedContent(index) }));
  const facts = input.facts.map((fact, index) => ({ title: fact.title, summary: fact.summary, aliases: fact.aliases,
    kind: readString(fact.metadata.factKind) ?? fact.kind, content: admittedContent(originalSubjects.length + index) }));
  const projected = evidence.map(({ source, extraction, references }) => {
    const result = projectRepairProfileInput({ query: input.query, subjects, source, extraction,
      text: repairProfileSourceText(extraction), structuralReferences: references.proof });
    return { source: content(result.source), ...(result.extraction ? { extraction: content(result.extraction) } : {}), text: result.text };
  });
  const assessment = { query, subjects, facts, evidence: projected,
    objectProfiles: matchingObjectProfiles(originalSubjects, originalProfiles) };
  // The entire native candidate projection is screened before either semantic reader.
  assertJudgmentInput(assessment);
  assertCurrent();
  const requirement = kind === 'coverage' && fullProfileRequired === undefined
    ? await prepareRepairProfileRequirement({ query, subjects: originalSubjects.map(repairProfileSubject) }, { signal, assertCurrent }) : undefined;
  const requiredScope = requirement?.fullProfileRequired ?? fullProfileRequired;
  const assertAssessmentCurrent = () => { assertCurrent(); requirement?.assertCurrent(); assertCurrent(); };
  assertAssessmentCurrent();
  const result = await readSelfImprovementAssessment(kind, { ...assessment,
    ...(requiredScope === undefined ? {} : { requestedScope: { fullProfileRequired: requiredScope } }) },
    { signal, assertCurrent: assertAssessmentCurrent });
  result.assertCurrent(); return result;
}
