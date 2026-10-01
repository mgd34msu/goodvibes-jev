import { getKnowledgeSpaceId } from '../spaces.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { projectKnowledgeSourceReferences } from '../source-structural-references.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { prepareRepairProfileSelections, REPAIR_PROFILE_CATEGORIES, KnowledgeRepairProfileHeldError, type RepairProfileSubject, type RepairProfileReadingInput } from './repair-profile/reader.js';
import { readRecord } from './utils.js';

export interface RepairProfileFact {
  readonly kind: 'feature' | 'capability' | 'specification' | 'compatibility' | 'configuration';
  readonly title: string;
  readonly value?: string | undefined;
  readonly summary: string;
  readonly evidence: string;
  readonly labels: readonly string[];
  readonly aliases: readonly string[];
}
export interface RepairProfileDerivationInput {
  readonly query: string;
  readonly source: KnowledgeSourceRecord;
  readonly extraction?: KnowledgeExtractionRecord | null | undefined;
  readonly text: string;
  readonly subjects?: readonly (string | RepairProfileSubject)[] | undefined;
  /** Opaque proof captured from the actual current store records; JSON cannot confer it. */
  readonly structuralReferences?: object | undefined;
}
export interface RepairProfileDerivationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}
/** Complete original extractor content, including table labels, qualifiers, and meaningful URLs. */
export function repairProfileSourceText(extraction: KnowledgeExtractionRecord | null | undefined): string {
  if (!extraction) return '';
  const structure = readRecord(extraction.structure);
  const containers = [structure, readRecord(structure.structure), readRecord(structure.metadata), readRecord(extraction.metadata)];
  return [extraction.title, extraction.summary, extraction.excerpt, ...extraction.sections,
    ...containers.flatMap((container) => ['searchText', 'text', 'content'].map((key) => container[key]))]
    .filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n\n');
}
/** Explicit subject identity fields only; database metadata and IDs stay local. */
export function repairProfileSubject(subject: KnowledgeNodeRecord): RepairProfileSubject {
  const identity: Record<string, string> = {};
  for (const key of ['manufacturer', 'brand', 'model', 'modelNumber', 'variant', 'entityKind']) {
    const value = subject.metadata[key];
    if (value !== undefined && typeof value !== 'string') throw new KnowledgeRepairProfileHeldError('malformed');
    if (typeof value === 'string') identity[key] = value;
  }
  return { title: subject.title, kind: subject.kind, aliases: subject.aliases, identity };
}
export function projectRepairProfileInput(input: RepairProfileDerivationInput): RepairProfileReadingInput {
  const { source, extraction } = input;
  if (extraction) {
    const spaceId = getKnowledgeSpaceId(source);
    if (getKnowledgeSpaceId(extraction) !== spaceId) throw new KnowledgeRepairProfileHeldError('foreign-space');
    for (const record of [source, extraction]) for (const key of ['knowledgeSpaceId', 'spaceId', 'namespace']) {
      const value = record.metadata[key];
      if (value !== undefined && (typeof value !== 'string' || value.trim() !== spaceId)) throw new KnowledgeRepairProfileHeldError('foreign-space');
    }
  }
  if ((source.status !== 'indexed' && source.status !== 'pending') || (extraction && extraction.sourceId !== source.id)) throw new KnowledgeRepairProfileHeldError('stale');
  const structural = projectKnowledgeSourceReferences(source, extraction, input.structuralReferences);
  const selected = {
    query: input.query, subjects: (input.subjects ?? []).map((subject) => typeof subject === 'string' ? { title: subject } : subject), text: input.text,
    source: { title: source.title, sourceType: source.sourceType, url: source.url,
      sourceUri: structural?.omitSourceUri ? undefined : source.sourceUri,
      canonicalUri: structural?.omitCanonicalUri ? undefined : source.canonicalUri },
    ...(extraction ? { extraction: { format: extraction.format, title: extraction.title } } : {}),
  };
  // IDs are local bookkeeping, still protected unless the exact record-bound producer proof applies.
  // No arbitrary metadata is transmitted, and no prefix/shape-based ID exception is possible.
  assertJudgmentInput({ sourceId: structural?.sourceId ?? source.id,
    extractionId: structural?.extractionId ?? extraction?.id,
    extractionSourceId: structural?.sourceId ?? extraction?.sourceId, selected, categories: REPAIR_PROFILE_CATEGORIES });
  return selected;
}
/** All selected inputs preflight and settle before any result can be consumed for writes. */
export async function deriveRepairProfileFactPass(inputs: readonly RepairProfileDerivationInput[], options: RepairProfileDerivationOptions = {}): Promise<readonly (readonly RepairProfileFact[])[]> {
  const selections = await prepareRepairProfileSelections(inputs.map(projectRepairProfileInput), options);
  return selections.map((groups) => groups.map(({ category, values }) => {
    const exact = [...new Set(values.map((value) => value.text))];
    return { ...category, value: exact.join('\n'), summary: `${category.title}: ${exact.join(' ')}`,
      evidence: exact.join('\n\n') };
  }));
}
export async function deriveRepairProfileFacts(input: RepairProfileDerivationInput, options: RepairProfileDerivationOptions = {}): Promise<readonly RepairProfileFact[]> {
  return (await deriveRepairProfileFactPass([input], options))[0]!;
}
