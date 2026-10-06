import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { snapshotNodeInput } from '../../activation/projection.js';
import { knowledgeSourceJudgmentUris } from '../../source-structural-references.js';
import { getKnowledgeSpaceId } from '../../spaces.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeSourceRecord, KnowledgeExtractionRecord } from '../../types.js';
import type { SemanticWriteGuard } from '../primary-source-plan.js';
import { readRecord } from '../utils.js';
import { freezeSupport } from '../verification/projection.js';
import { prepareAnswerExcerptReadings, KnowledgeAnswerExcerptHeldError as Held,
  type AnswerExcerptDocument, type AnswerExcerptInput, type AnswerExcerptSpan } from './reader.js';

export interface LocalAnswerExcerptSpan {
  readonly sourceId: string;
  readonly extractionId?: string | undefined;
  readonly field: string;
  /** Half-open UTF-16 offsets for String.slice on the exact original field. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
interface Document extends AnswerExcerptDocument { readonly field: string; }
function documents(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | null | undefined): Document[] {
  const result: Document[] = [];
  function add(field: string, kind: AnswerExcerptDocument['kind'], value: unknown) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') throw new Held('malformed');
    // Preserve exact bytes, including short facts, URLs, whitespace and table rows.
    result.push({ reference: `document-${result.length + 1}`, kind, text: value, field });
  }
  add('source.summary', 'source-summary', source.summary);
  add('source.description', 'source-description', source.description);
  if (extraction) {
    add('extraction.title', 'extraction', extraction.title);
    add('extraction.summary', 'extraction', extraction.summary);
    add('extraction.excerpt', 'extraction', extraction.excerpt);
    extraction.sections.forEach((section, index) => add(`extraction.sections[${index}]`, 'extraction', section));
    const structure = readRecord(extraction.structure);
    for (const [path, container] of [
      ['extraction.structure', structure], ['extraction.structure.structure', readRecord(structure.structure)],
      ['extraction.structure.metadata', readRecord(structure.metadata)], ['extraction.metadata', readRecord(extraction.metadata)],
    ] as const) for (const key of ['searchText', 'text', 'content']) add(`${path}.${key}`, 'extraction', container[key]);
  }
  return result;
}

/** Bind projected exact fields back to local records without sending their IDs. */
export function prepareAnswerSourceExcerpts(store: KnowledgeStore, query: string,
  entries: readonly { readonly source: KnowledgeSourceRecord; readonly context: string }[], guard: SemanticWriteGuard, signal?: AbortSignal,
) {
  return prepareSourceExcerpts(store, query, entries, guard, signal);
}

function prepareSourceExcerpts(store: KnowledgeStore, query: string,
  entries: readonly { readonly source: KnowledgeSourceRecord; readonly context: string }[], guard: SemanticWriteGuard, signal?: AbortSignal,
  observeModel?: (model: string, requestedModel: string) => void,
) {
  const rows = entries.map(({ source, context }, index) => {
    const original = guard.watch(`source:${source.id}`, () => store.getSource(source.id), source);
    if (!original) throw new Held('stale');
    const snapshot = snapshotNodeInput(original);
    const extraction = snapshotNodeInput(guard.extraction(source.id));
    if (extraction && (extraction.sourceId !== source.id || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source))) throw new Held('malformed');
    const uris = knowledgeSourceJudgmentUris(source);
    const values = documents(snapshot, extraction);
    const input: AnswerExcerptInput = { reference: `source-${index + 1}`, query,
      source: { title: snapshot.title ?? '', sourceType: snapshot.sourceType, uri: uris.url ?? uris.sourceUri ?? uris.canonicalUri ?? '' },
      context: JSON.stringify({ claims: context, sourceTags: snapshot.tags,
        sourceUris: uris, extractionFormat: extraction?.format }), documents: values.map(({ field: _field, ...document }) => document) };
    return { input, values, sourceId: source.id, extractionId: extraction?.id };
  });
  let configured: JudgmentPort | undefined, model: string | undefined;
  const assertCurrent = () => {
    try { guard.assertCurrent(); }
    catch { throw new Held(signal?.aborted ? 'aborted' : 'stale'); }
    if (configured) {
      let current: JudgmentPort;
      try { current = judgmentPort('engine.knowledge.answer-excerpt-selection'); } catch { throw new Held('stale'); }
      if (current !== configured || configured.model !== model) throw new Held('stale');
    }
  };
  const prepared = prepareAnswerExcerptReadings(rows.map((row) => row.input), { signal, assertCurrent, observeModel });
  return {
    /** Capture provider configuration only after the caller's complete preflight. */
    start() {
      assertCurrent();
      if (rows.length && !configured) { configured = judgmentPort('engine.knowledge.answer-excerpt-selection'); model = configured.model; }
    },
    assertCurrent() { assertCurrent(); prepared.assertCurrent(); },
    async read(sourceIds: ReadonlySet<string>) {
      assertCurrent();
      // One complete pass; rejected initial sources never enter downstream output.
      const selections = await prepared.read(new Set(rows.filter((row) => sourceIds.has(row.sourceId)).map((row) => row.input.reference)));
      assertCurrent();
      return new Map(rows.flatMap((row, index) => {
        if (!sourceIds.has(row.sourceId)) return [];
        const spans = selections[index]!.spans;
        const local = row.values.flatMap((document) => mergeSpans(spans.filter((span) => span.document === document.reference)).map((span) => ({
          sourceId: row.sourceId, ...(document.kind === 'extraction' ? { extractionId: row.extractionId } : {}),
          field: document.field, start: span.start, end: span.end, text: document.text.slice(span.start, span.end),
        })));
        return [[row.sourceId, freezeSupport(local)] as const];
      }));
    },
  };
}
/** Prepare every complete source before any reading. Each unchanged reader sees
 * one source's full documents; its exact spans never depend on other sources.
 * The caller supplies the shared operation signal/deadline. No per-source result
 * escapes until every requested source settles under one model configuration.
 */
export function prepareAnswerSourceExcerptBatches(store: KnowledgeStore, query: string,
  entries: readonly { readonly source: KnowledgeSourceRecord; readonly context: string }[], guard: SemanticWriteGuard, signal?: AbortSignal,
) {
  let model: string | undefined, requestedModel: string | undefined;
  const observeModel = (actual: string, requested: string) => {
    if ((model !== undefined && actual !== model) || (requestedModel !== undefined && requested !== requestedModel)) throw new Held('stale');
    model = actual; requestedModel = requested;
  };
  // Synchronous all-source preparation protects rejected and later sources too.
  const prepared = entries.map((entry) => ({ sourceId: entry.source.id,
    reader: prepareSourceExcerpts(store, query, [entry], guard, signal, observeModel) }));
  const assertCurrent = () => {
    if (signal?.aborted) throw new Held('aborted');
    // An empty source set still belongs to the caller's captured read-set.
    try { guard.assertCurrent(); } catch { throw new Held(signal?.aborted ? 'aborted' : 'stale'); }
    for (const entry of prepared) entry.reader.assertCurrent();
  };
  return {
    start() { assertCurrent(); for (const entry of prepared) entry.reader.start(); assertCurrent(); },
    assertCurrent,
    async read(sourceIds: ReadonlySet<string>) {
      const selected = new Set(sourceIds);
      const result = new Map<string, readonly LocalAnswerExcerptSpan[]>();
      assertCurrent();
      for (const entry of prepared) {
        if (!selected.has(entry.sourceId)) continue;
        assertCurrent();
        const spans = await entry.reader.read(new Set([entry.sourceId]));
        assertCurrent();
        for (const [sourceId, selection] of spans) result.set(sourceId, selection);
      }
      assertCurrent();
      return result;
    },
  };
}

function mergeSpans(spans: readonly AnswerExcerptSpan[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  return merged;
}
