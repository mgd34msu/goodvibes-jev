import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeStore } from '../store.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { sameKnowledgeRecord } from '../store-record-representation.js';
import { assertKnowledgeRecordContainers, KnowledgeRecordAdmissionHeldError, prepareKnowledgeRecordAdmission } from '../store-record-snapshot.js';
import { captureKnowledgeSourceReferences } from '../source-structural-references.js';
import { createRepairSubjectSelectionReader, KnowledgeRepairSubjectSelectionHeldError as Held } from './repair-subject-selection/reader.js';
import { repairProfileSubject } from './repair-profile.js';
import { readString, readStringArray, uniqueStrings } from './utils.js';
import { createSemanticWriteGuard } from './primary-source-plan.js';

export interface RepairSubjectHint {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly [key: string]: unknown;
}
export interface RepairSubjectSelection {
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly assertCurrent: () => void;
}
interface RepairSubjectInput {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly nodes: readonly (KnowledgeNodeRecord | undefined)[];
  readonly excludedNodeIds?: readonly string[] | undefined;
  readonly evidenceSources?: readonly KnowledgeSourceRecord[] | undefined;
  readonly context: { readonly gap: KnowledgeNodeRecord } | { readonly source: KnowledgeSourceRecord };
  readonly text?: string | undefined;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

/** Schema exclusion is mechanical. Every remaining meaning decision is a current,
 * operation-owned canonical judgment; a hold never becomes an empty selection. */
export async function canonicalRepairSubjectNodes(input: RepairSubjectInput): Promise<RepairSubjectSelection> {
  try { return await prepareRepairSubjects(input); }
  catch (error) {
    if (error instanceof KnowledgeRecordAdmissionHeldError) throw new Held(error.reason);
    throw error;
  }
}
async function prepareRepairSubjects(input: RepairSubjectInput): Promise<RepairSubjectSelection> {
  const { store, spaceId, signal, shouldStop, assertCurrent: ownerCurrent } = input;
  const data = () => ({ nodes: input.nodes, excludedNodeIds: input.excludedNodeIds, evidenceSources: input.evidenceSources, context: input.context, text: input.text, objectProfiles: input.objectProfiles });
  const original = captureOwnedJson(data());
  const context = input.context;
  const extraction = 'source' in context ? store.getExtractionBySourceId(context.source.id) : null;
  const references = 'source' in context ? { source: context.source, extraction,
    proof: captureKnowledgeSourceReferences(store, context.source, extraction) } : undefined;
  const evidence = (input.evidenceSources ?? []).map(source => {
    const extraction = store.getExtractionBySourceId(source.id);
    const references = { source, extraction, proof: captureKnowledgeSourceReferences(store, source, extraction) };
    return { source, extraction, references };
  });
  const excludedAdmissions = input.nodes.filter((node): node is KnowledgeNodeRecord => node !== undefined && input.excludedNodeIds?.includes(node.id) === true)
    .map(node => prepareKnowledgeRecordAdmission(store, 'node', node));
  const admissions = [
    ...evidence.flatMap(({ source, extraction, references }) => [prepareKnowledgeRecordAdmission(store, 'source', source, references),
      ...(extraction ? [prepareKnowledgeRecordAdmission(store, 'extraction', extraction, references)] : [])]),
    ...input.nodes.filter((node): node is KnowledgeNodeRecord => node !== undefined && !input.excludedNodeIds?.includes(node.id))
      .map(node => prepareKnowledgeRecordAdmission(store, 'node', node)),
    ...('gap' in context ? [prepareKnowledgeRecordAdmission(store, 'node', context.gap)]
      : [prepareKnowledgeRecordAdmission(store, 'source', context.source, references),
        ...(extraction ? [prepareKnowledgeRecordAdmission(store, 'extraction', extraction, references)] : [])]),
  ];
  assertKnowledgeRecordContainers(data(), [...admissions, ...excludedAdmissions]);
  // Explicit entity overlays are absent from this decision, but their complete
  // original rows still receive privacy admission before the authorized overwrite.
  for (const admission of excludedAdmissions) admission.assertCurrent();
  const all = [...input.nodes.filter((node): node is KnowledgeNodeRecord => node !== undefined),
    'gap' in context ? context.gap : context.source, ...(extraction ? [extraction] : []),
    ...evidence.flatMap(({ source, extraction }) => [source, ...(extraction ? [extraction] : [])])];
  for (const record of all) {
    if (getKnowledgeSpaceId(record) !== spaceId) throw new Held('foreign-space');
    for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
      const value = record.metadata[key];
      if (value !== undefined && (typeof value !== 'string' || value.trim() !== spaceId)) throw new Held('foreign-space');
    }
  }
  const assertOriginalCurrent = () => {
    try { store.assertRecordSnapshotFrame(() => {
      if (signal?.aborted || shouldStop?.()) throw new Held('aborted');
      if (input.store !== store || input.spaceId !== spaceId || input.signal !== signal || input.shouldStop !== shouldStop
        || input.assertCurrent !== ownerCurrent || !sameKnowledgeRecord(data(), original)) throw new Held('stale');
      ownerCurrent?.();
      for (const admission of admissions) {
        try { admission.assertCurrent(); } catch (error) {
          if (error instanceof KnowledgeRecordAdmissionHeldError) throw new Held(error.reason);
          throw error;
        }
      }
      for (const { source, extraction } of evidence) if (store.getExtractionBySourceId(source.id) !== extraction) throw new Held('stale');
      if ('source' in context && store.getExtractionBySourceId(context.source.id) !== extraction) throw new Held('stale');
    }); } catch (error) {
      if (error instanceof KnowledgeRecordAdmissionHeldError) throw new Held(error.reason);
      throw error;
    }
  };
  assertOriginalCurrent();
  const usable = uniqueNodes(input.nodes)
    .filter(node => !input.excludedNodeIds?.includes(node.id))
    .filter(node => node.status !== 'stale')
    .filter(node => !readString(node.metadata.semanticKind))
    .filter(node => !['fact', 'wiki_page', 'knowledge_gap'].includes(node.kind))
    .filter(node => node.metadata.generatedKnowledgePage !== true && node.metadata.generatedProjection !== true);
  const candidates = usable.map((node, index) => ({ ...repairProfileSubject(node), kind: node.kind,
    aliases: node.aliases, identity: repairProfileSubject(node).identity ?? {}, summary: node.summary, reference: `subject-${index + 1}` }));
  const reader = createRepairSubjectSelectionReader({ signal, assertCurrent: assertOriginalCurrent });
  const readings = await reader.read(candidates.map(candidate => ({ reference: candidate.reference,
    candidate: candidate.reference, candidates, query: input.text ?? '',
    objectProfiles: (input.objectProfiles ?? []).map(profile => ({ subjectKinds: profile.subjectKinds })) })));
  reader.assertCurrent();
  const selected = new Set(readings.filter(reading => reading.selected).map(reading => reading.reference));
  return Object.freeze({ nodes: Object.freeze(usable.filter((_node, index) => selected.has(`subject-${index + 1}`))),
    assertCurrent: reader.assertCurrent });
}

export function repairSubjectHints(subjects: readonly KnowledgeNodeRecord[]): RepairSubjectHint[] {
  return subjects.map(subject => ({ id: subject.id, kind: subject.kind, title: subject.title }));
}
function uniqueNodes(nodes: readonly (KnowledgeNodeRecord | undefined)[]): KnowledgeNodeRecord[] {
  const seen = new Set<string>();
  return nodes.filter((node): node is KnowledgeNodeRecord => {
    if (!node || seen.has(node.id)) return false;
    seen.add(node.id); return true;
  });
}

/** Observe references before graph scope/status filtering can discard missing
 * endpoints. A null read is part of the operation, never permission to adopt a
 * row that appears while a model request is suspended. */
export function captureRepairSubjectReadSet(store: KnowledgeStore, gap: KnowledgeNodeRecord,
  evidenceSourceIds: readonly string[] = [], signal?: AbortSignal, shouldStop?: () => boolean) {
  const guard = createSemanticWriteGuard(store, signal, shouldStop);
  const edges = store.listEdges();
  const sourceIds = uniqueStrings([gap.sourceId, ...readStringArray(gap.metadata.sourceIds), ...evidenceSourceIds,
    ...edges.filter(edge => edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === gap.id).map(edge => edge.fromId)]);
  const sourceSet = new Set(sourceIds);
  const subjectEdge = (edge: typeof edges[number]) => {
    if (edge.toKind === 'node' && edge.toId === gap.id) return true;
    if (edge.fromKind !== 'source' || !sourceSet.has(edge.fromId) || edge.toKind !== 'node') return false;
    const node = store.getNode(edge.toId);
    // Own generated fact/entity links cannot change the subject set. Missing
    // endpoints and every potentially usable original candidate remain watched.
    return !node || (!readString(node.metadata.semanticKind)
      && !['fact', 'wiki_page', 'knowledge_gap'].includes(node.kind)
      && node.metadata.generatedKnowledgePage !== true && node.metadata.generatedProjection !== true);
  };
  guard.watch('repair-subject-reference-edges', () => store.listEdges().filter(subjectEdge));
  for (const id of sourceIds) { guard.source(id); guard.extraction(id); }
  const nodeIds = uniqueStrings([...readStringArray(gap.metadata.linkedObjectIds),
    ...edges.filter(edge => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id).map(edge => edge.fromId),
    ...edges.filter(edge => edge.fromKind === 'source' && subjectEdge(edge)).map(edge => edge.toId)]);
  for (const id of nodeIds) guard.node(id);
  return guard;
}
