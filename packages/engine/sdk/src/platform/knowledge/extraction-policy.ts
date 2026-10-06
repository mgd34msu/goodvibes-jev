import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import { extractionReadability } from './batteries/extraction-readability.js';
import type { KnowledgeExtractionRecord } from './types.js';

/**
 * The current extractor generation. Stamped onto every extraction's metadata at
 * write time (`extractorVersion`). Bump this when the extraction pipeline improves
 * so that the retained raw-artifact lake is re-processed: an extraction produced by
 * an older generation is treated as stale-by-version and re-extracted from its
 * stored artifact, even when its prior text was non-empty. This is what turns the
 * retained lake into a compounding asset. Extractions written before versioning
 * carry no stamp and resolve to version 0, so they re-extract once.
 */
export const KNOWLEDGE_EXTRACTOR_VERSION = 3;

export function readKnowledgeExtractorVersion(metadata: Record<string, unknown>): number {
  const value = readDocumentFields(metadata, ['extractorVersion']).extractorVersion;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const KNOWLEDGE_MAX_STRUCTURE_SEARCH_TEXT_CHARS = 128 * 1024;

/** Transport budget only; no length or character-ratio readability threshold. */
export const KNOWLEDGE_EXTRACTION_SAMPLE_CHARS = 4_096;

/** No classification or mutation may proceed on an unresolved reading. */
export class KnowledgeExtractionJudgmentHoldError extends Error {
  constructor() {
    super('Knowledge extraction is on hold: a required extraction judgment did not reach an actionable conclusion.');
    this.name = 'KnowledgeExtractionJudgmentHoldError';
  }
}

const LIMITED_EXTRACTION_MARKERS = [
  'html extraction found no main content',
  'pdf extraction produced limited text',
  'no readable text streams',
  'no specialized extractor matched',
  'has no specialized in-core extractor',
];

export async function knowledgeExtractionNeedsRefresh(
  extraction: KnowledgeExtractionRecord | null,
  currentExtractorVersion: number = KNOWLEDGE_EXTRACTOR_VERSION,
): Promise<boolean> {
  if (!extraction) return true;
  if (readKnowledgeExtractorVersion(readDocumentFields(extraction, ['metadata']).metadata) < currentExtractorVersion) return true;
  // Inspect all candidate fields before a bounded sample of any field leaves.
  assertKnowledgeExtractionInput(extraction);
  const searchText = await readKnowledgeSearchText(extraction.structure) ?? await readKnowledgeSearchText(extraction.metadata);
  if (searchText) return false;
  for (const text of [extraction.excerpt, extraction.summary, ...extraction.sections]) {
    if (await hasUsefulKnowledgeExtractionText(text)) return false;
  }
  return true;
}

export async function readKnowledgeSearchText(record: Record<string, unknown>): Promise<string | undefined> {
  const candidates = readDocumentFields(record, ['searchText', 'text', 'content']);
  assertJudgmentInput(candidates);
  const value = candidates.searchText ?? candidates.text ?? candidates.content;
  return typeof value === 'string' && await hasUsefulKnowledgeExtractionText(value) ? value : undefined;
}

export function hasUsefulKnowledgeExtractionText(value: string | undefined): Promise<boolean> {
  return readKnowledgeExtractionTextUsability(value);
}

/** Shared readability operation with caller-owned cancellation. The public
 * compatibility helper above retains its existing signature and policy.
 */
export async function readKnowledgeExtractionTextUsability(value: string | undefined, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new KnowledgeExtractionJudgmentHoldError();
  if (!value?.trim()) return false;
  assertJudgmentInput(value);
  const normalized = value.toLowerCase();
  // These are this codebase's own extractor placeholder messages, not guesses.
  if (LIMITED_EXTRACTION_MARKERS.some((marker) => normalized.includes(marker))) return false;
  return requireExtractionJudgment(async () => {
    const run = await extractionReadability.run(judgmentPort('knowledge.extraction.readability'), {
      sample: value.slice(0, KNOWLEDGE_EXTRACTION_SAMPLE_CHARS),
    }, { site: 'knowledge.extraction.readability', ...(signal ? { signal } : {}) });
    if (signal?.aborted) throw new KnowledgeExtractionJudgmentHoldError();
    const reading = run.readings.readable;
    if (reading.outcome !== 'act' || reading.verdict === 'uncertain') {
      run.recordAction('hold');
      throw new KnowledgeExtractionJudgmentHoldError();
    }
    run.recordAction(reading.verdict === 'yes' ? 'keep-readable-text' : 'reject-unreadable-text');
    return reading.verdict === 'yes';
  });
}

/** Compatibility name: the same readability judgment, never a PDF-token scan. */
export async function looksLikeRawPdfPayload(value: string): Promise<boolean> {
  return !(await hasUsefulKnowledgeExtractionText(value));
}

/** Compatibility name: the same readability judgment, never character ratios. */
export async function looksBinaryLikeText(value: string): Promise<boolean> {
  return !(await hasUsefulKnowledgeExtractionText(value));
}

/** Normalize all port failures to an explicit, value-free hold for ingest callers. */
export async function requireExtractionJudgment<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch { throw new KnowledgeExtractionJudgmentHoldError(); }
}

/** Preflight document content, not database ids, timestamps or unrelated bookkeeping. */
export function assertKnowledgeExtractionInput(extraction: KnowledgeExtractionRecord | null | undefined): void {
  if (!extraction) return;
  const document = readDocumentFields(extraction, ['structure', 'metadata', 'excerpt', 'summary', 'sections']);
  assertJudgmentInput(document.sections);
  // Array iteration can consume non-enumerable data entries too. The preceding
  // check rejects accessors before their descriptors are projected as data.
  const sections = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(document.sections))
    .filter(([key]) => key !== 'length').map(([key, descriptor]) => [key, descriptor.value as unknown]));
  assertJudgmentInput({
    structure: readDocumentFields(document.structure, ['searchText', 'text', 'content']),
    metadata: readDocumentFields(document.metadata, ['searchText', 'text', 'content']),
    excerpt: document.excerpt, summary: document.summary, sections,
  });
}

/** Project only consumed fields, without executing getters or losing hidden data fields. */
function readDocumentFields<T extends object, K extends keyof T>(record: T, fields: readonly K[]): Pick<T, K> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new JudgmentInputError('unsupported-input');
  const prototype: unknown = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) throw new JudgmentInputError('unsupported-input');
  return Object.fromEntries(fields.map((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) throw new JudgmentInputError('unsupported-input');
    return [field, descriptor?.value as unknown];
  })) as Pick<T, K>;
}
