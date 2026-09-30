import { assertJudgmentInput, JudgmentInputError } from '../../../gate/judgment-input.js';
import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace } from '../../spaces.js';
import { isGeneratedKnowledgeSource } from '../../generated-projections.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../../types.js';
import { createSemanticWriteGuard } from '../primary-source-plan.js';
import { freezeSupport } from '../verification/projection.js';
import { readString, readStringArray } from '../utils.js';
import { KnowledgeAnswerQualityHeldError as Held, type AnswerEvidenceProjection } from './types.js';
import { ANSWER_VERIFICATION_LIMITS } from './reader.js';

/** Inspect records without invoking accessors, including metadata not selected for transmission. */
function assertPlainRecord(value: unknown): void {
  const ancestors = new Set<object>(); let count = 0;
  function visit(item: unknown, depth: number): void {
    if (++count > 20_000 || depth > 64) throw new JudgmentInputError('unsupported-input');
    if (item === null || item === undefined || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)) throw new JudgmentInputError('unsupported-input');
    const prototype: unknown = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new JudgmentInputError('unsupported-input');
    ancestors.add(item);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      if (descriptor.get || descriptor.set) throw new JudgmentInputError('unsupported-input');
      if (descriptor.enumerable) visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function extractionText(extraction: NonNullable<ReturnType<KnowledgeStore['getExtractionBySourceId']>>): string {
  const structure = record(extraction.structure);
  const containers = [structure, record(structure.structure), record(structure.metadata), record(extraction.metadata)];
  const strings: string[] = [];
  for (const value of [extraction.excerpt, ...extraction.sections]) {
    if (value !== undefined && typeof value !== 'string') throw new Held('malformed');
    if (value) strings.push(value);
  }
  for (const container of containers) for (const name of ['text', 'content', 'searchText']) {
    const value = container[name];
    if (value !== undefined && typeof value !== 'string') throw new Held('malformed');
    if (typeof value === 'string' && value) strings.push(value);
  }
  return [...new Set(strings)].join('\n\n');
}
function factText(fact: KnowledgeNodeRecord): string {
  return [fact.title, fact.summary, readString(fact.metadata.value), readString(fact.metadata.evidence)].filter(Boolean).join('\n');
}
function associated(fact: KnowledgeNodeRecord, sourceId: string, store: KnowledgeStore): boolean {
  return [fact.sourceId, readString(fact.metadata.sourceId), ...readStringArray(fact.metadata.sourceIds)].includes(sourceId)
    || store.edgesFor('node', fact.id).some((edge) => edge.fromKind === 'source' && edge.fromId === sourceId
      && edge.toKind === 'node' && edge.toId === fact.id && edge.relation === 'supports_fact' && edge.metadata.deleted !== true);
}

/** Exact local records stay local; only labelled extraction evidence enters model state. */
export function prepareAnswerEvidence(input: {
  readonly store: KnowledgeStore; readonly spaceId: string; readonly query: string;
  readonly sources: readonly KnowledgeSourceRecord[]; readonly facts: readonly KnowledgeNodeRecord[];
  readonly subjects: readonly KnowledgeNodeRecord[]; readonly signal?: AbortSignal | undefined;
}) {
  for (const value of [...input.sources, ...input.facts, ...input.subjects]) assertPlainRecord(value);
  const guard = createSemanticWriteGuard(input.store, input.signal);
  const matches = (value: KnowledgeNodeRecord | KnowledgeSourceRecord) => getKnowledgeSpaceId(value) === input.spaceId
    || (input.spaceId === 'homeassistant' && isHomeAssistantKnowledgeSpace(getKnowledgeSpaceId(value)));
  const sources = [...new Map(input.sources.filter(matches).map((source) => [source.id, source])).values()];
  const facts = input.facts.filter(matches), subjects = input.subjects.filter(matches);
  if (sources.length > ANSWER_VERIFICATION_LIMITS.evidence) throw new Held('budget');
  const evidence: AnswerEvidenceProjection[] = [];
  const references: { readonly reference: string; readonly sourceId: string; readonly extractionId: string }[] = [];
  for (const node of [...facts, ...subjects]) {
    assertPlainRecord(node); guard.watch(`node:${node.id}`, () => input.store.getNode(node.id), node);
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  const nodeIds = new Set([...facts, ...subjects].map((node) => node.id));
  guard.watch('answer-source-subject-edges', () => input.store.listEdges().filter((edge) =>
    (edge.fromKind === 'source' && sourceIds.has(edge.fromId)) || (edge.toKind === 'source' && sourceIds.has(edge.toId))
    || (edge.fromKind === 'node' && nodeIds.has(edge.fromId)) || (edge.toKind === 'node' && nodeIds.has(edge.toId))));
  for (const source of sources) {
    assertPlainRecord(source); guard.watch(`source:${source.id}`, () => input.store.getSource(source.id), source);
    const extraction = input.store.getExtractionBySourceId(source.id);
    if (extraction) assertPlainRecord(extraction);
    guard.watch(`extraction:${source.id}`, () => input.store.getExtractionBySourceId(source.id), extraction);
    if (isGeneratedKnowledgeSource(source) || !extraction || source.status === 'stale' || source.status === 'failed') continue;
    if (extraction.sourceId !== source.id || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source)) throw new Held('malformed');
    const text = extractionText(extraction);
    if (!text.trim()) continue;
    const reference = `evidence-${evidence.length + 1}`;
    const row = { reference, title: source.title, text,
      facts: facts.filter((fact) => getKnowledgeSpaceId(fact) === getKnowledgeSpaceId(source) && associated(fact, source.id, input.store)).map(factText),
      subjects: subjects.filter((subject) => getKnowledgeSpaceId(subject) === getKnowledgeSpaceId(source))
        .map((subject) => [subject.title, subject.summary, ...subject.aliases, readString(subject.metadata.model), readString(subject.metadata.manufacturer)].filter(Boolean).join('\n')),
    };
    evidence.push(row); references.push({ reference, sourceId: source.id, extractionId: extraction.id });
  }
  // Full selected content, before any generation request and without clipping.
  assertJudgmentInput({ query: input.query, evidence });
  if (JSON.stringify({ query: input.query, evidence }).length > ANSWER_VERIFICATION_LIMITS.characters) throw new Held('budget');
  guard.assertCurrent();
  return { evidence: freezeSupport(structuredClone(evidence)), references: freezeSupport(references), guard,
    assertCurrent() { try { guard.assertCurrent(); } catch { throw new Held(input.signal?.aborted ? 'aborted' : 'stale'); } },
  };
}
