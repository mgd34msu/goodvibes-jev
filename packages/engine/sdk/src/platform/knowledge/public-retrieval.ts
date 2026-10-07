import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import { assertKnowledgeExtractionInput } from './extraction-policy.js';
import { knowledgeNodeMatchesScope, knowledgeSourceMatchesScope } from './scope-records.js';
import { getKnowledgeSpaceId, type KnowledgeSpaceScopeInput } from './spaces.js';
import { knowledgeSourceJudgmentUris } from './source-structural-references.js';
import { KnowledgeSourceQualityHeldError } from './source-quality.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { projectAnswerFactClaim } from './semantic/answer-claim-projection.js';
import { prepareAnswerSourceExcerptBatches, type LocalAnswerExcerptSpan } from './semantic/answer-excerpts/prepare.js';
import { KnowledgeAnswerExcerptHeldError } from './semantic/answer-excerpts/types.js';
import { captureAnswerReadingPorts } from './semantic/answer-reading-ports.js';
import { withAnswerVerificationBudget } from './semantic/answer-verification/budget.js';
import { KnowledgeAnswerQualityHeldError } from './semantic/answer-verification/types.js';
import { prepareAnswerEvidenceRelevanceBatches } from './semantic/evidence-ranking/batch.js';
import { KnowledgeEvidenceRelevanceHeldError as Held, type AnswerEvidenceCandidate } from './semantic/evidence-ranking/types.js';
import { createSemanticWriteGuard, type SemanticWriteGuard } from './semantic/primary-source-plan.js';
import { readRecord, readString, readStringArray, sourceSemanticText, uniqueStrings } from './semantic/utils.js';

export interface PublicKnowledgeSelectionInput {
  readonly query: string;
  readonly writeScope?: readonly string[] | undefined;
  readonly scope: KnowledgeSpaceScopeInput;
  readonly mode: 'search' | 'packet';
  readonly signal?: AbortSignal | undefined;
}
export interface PublicKnowledgeSelectedRow {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly node?: KnowledgeNodeRecord | undefined;
  readonly probability: number;
  /** Complete semantic node content supplied to relevance, without store keys. */
  readonly nodeText?: string | undefined;
  /** Complete selected source fields, with exact local offsets; empty is settled. */
  readonly spans?: readonly LocalAnswerExcerptSpan[] | undefined;
}
export interface PublicKnowledgeSelection {
  readonly accepted: readonly PublicKnowledgeSelectedRow[];
  readonly assertCurrent: () => void;
  readonly relatedLabels: (kind: 'source' | 'node', id: string) => readonly string[];
}

/** Local structural capture only: preserve hidden data fields without invoking
 * accessors. IDs and administrative metadata never enter a privacy projection.
 * Bounds match the existing single-record snapshot; there is no corpus bound.
 */
function capture<T>(input: T): T {
  let count = 0, characters = 0;
  const ancestors = new Set<object>();
  const fail = (): never => { throw new JudgmentInputError('unsupported-input'); };
  function visit(value: unknown, depth: number): unknown {
    if (++count > 20_000 || depth > 64) return fail();
    if (typeof value === 'string') { characters += value.length; if (characters > 1_000_000) return fail(); return value; }
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fail();
    if (typeof value !== 'object' || ancestors.has(value)) return fail();
    const array = Array.isArray(value), proto: unknown = Object.getPrototypeOf(value);
    if ((array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((entry) => !('value' in entry) || typeof entry.value === 'function')
      || (array && Object.hasOwn(descriptors, 'constructor'))) return fail();
    if (array && (value.length > 20_000 || Array.from({ length: value.length }, (_, index) => !Object.hasOwn(descriptors, index)).some(Boolean))) return fail();
    ancestors.add(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  return visit(input, 0) as T;
}

/** The shared excerpt adapter also receives descriptor-safe local captures. */
function capturedGuard(store: KnowledgeStore): SemanticWriteGuard {
  const guard = createSemanticWriteGuard(store);
  const watch = <T>(key: string, read: () => T, expected: T = read()): T =>
    guard.watch(key, () => capture(read()), capture(expected));
  return { watch, source: (id) => watch(`source:${id}`, () => store.getSource(id)),
    node: (id) => watch(`node:${id}`, () => store.getNode(id)),
    extraction: (id) => watch(`extraction:${id}`, () => store.getExtractionBySourceId(id)),
    assertCurrent: guard.assertCurrent };
}

// Serving content, memory/catalog descriptors and object identity. Review,
// confidence, timestamps, provenance IDs and arbitrary metadata stay local.
const NODE_CONTENT_FIELDS = ['semanticKind', 'factKind', 'entityKind', 'value', 'evidence', 'labels', 'subject',
  'markdown', 'text', 'searchText', 'content', 'description', 'tags', 'tag', 'scope', 'cls',
  'manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'batteryPowered', 'batteryType',
  'manualRequired', 'serial', 'firmware', 'installDate', 'purchaseDate', 'warrantyExpiration',
  'documentation', 'documentationUrl', 'documentation_url', 'sourceUrl', 'source_url',
  'deviceClass', 'device_class', 'entryType', 'entry_type', 'attributes', 'homeAssistant',
  'gapKind', 'query', 'reason', 'resolution', 'path', 'filePath', 'folderPath', 'url',
  'project', 'projects', 'capability', 'capabilities', 'feature', 'features', 'repo', 'repository', 'repositories',
  'provider', 'providers', 'service', 'services', 'env', 'environment', 'environments', 'owner', 'owners'];

function requestData(input: PublicKnowledgeSelectionInput) {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((entry) => !('value' in entry))) throw new JudgmentInputError('unsupported-input');
  return capture({ query: descriptors.query?.value as string, writeScope: descriptors.writeScope?.value as readonly string[] | undefined,
    scope: descriptors.scope?.value as KnowledgeSpaceScopeInput, mode: descriptors.mode?.value as PublicKnowledgeSelectionInput['mode'] });
}
function requestSignal(input: PublicKnowledgeSelectionInput): AbortSignal | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, 'signal');
  if (descriptor && !('value' in descriptor)) throw new JudgmentInputError('unsupported-input');
  return descriptor?.value as AbortSignal | undefined;
}

function preflightSourceText(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | null | undefined): void {
  const structure = readRecord(extraction?.structure);
  const texts = [source.summary, source.description, extraction?.title, extraction?.summary, extraction?.excerpt,
    ...(extraction?.sections ?? [])];
  for (const container of [structure, readRecord(structure.structure), readRecord(structure.metadata), readRecord(extraction?.metadata)]) {
    for (const key of ['searchText', 'text', 'content']) texts.push(container[key] as string | undefined);
  }
  // Raw complete fields, including hidden descriptor values, precede text
  // normalization and every reader. Malformed fields cannot hide in a no result.
  assertJudgmentInput(texts);
  if (texts.some((text) => text !== undefined && text !== null && typeof text !== 'string')) throw new Held('malformed');
}

/** Shared readers own relevance and exact excerpts. Generic callers retain their
 * scope/status policies; no HomeGraph object policy or producer score is used.
 */
export async function readPublicKnowledgeSelection(store: KnowledgeStore, input: PublicKnowledgeSelectionInput,
  options: { readonly assertCurrent?: (() => void) | undefined } = {},
): Promise<PublicKnowledgeSelection> {
  try {
    const request = requestData(input);
    if (typeof request.query !== 'string' || !['search', 'packet'].includes(request.mode)
      || !request.scope || typeof request.scope !== 'object' || Array.isArray(request.scope)
      || (request.writeScope !== undefined && (!Array.isArray(request.writeScope) || request.writeScope.some((value) => typeof value !== 'string')))) throw new Held('malformed');
    const callerSignal = requestSignal(input);
    if (request.mode === 'search' && !request.query.trim()) {
      // An absent lookup question is an explicit input rule, not a no-match
      // fallback. It needs no corpus access or semantic provider availability.
      const guard = capturedGuard(store);
      guard.watch('empty-public-search-request', () => requestData(input), request);
      const assertCurrent = () => {
        if (callerSignal?.aborted || requestSignal(input) !== callerSignal) throw new Held('aborted');
        try { guard.assertCurrent(); options.assertCurrent?.(); }
        catch (error) { if (error instanceof JudgmentInputError || error instanceof Held) throw error; throw new Held('stale'); }
      };
      assertCurrent();
      return { accepted: Object.freeze([]), assertCurrent, relatedLabels() { assertCurrent(); return Object.freeze([]); } };
    }
    return await withAnswerVerificationBudget(async (signal, deadlineAt) => {
      const guard = capturedGuard(store);
      guard.watch('public-retrieval-request', () => requestData(input), request);
      const checkPorts = captureAnswerReadingPorts(['engine.knowledge.answer-evidence-relevance',
        ...(request.mode === 'packet' ? ['engine.knowledge.answer-excerpt-selection'] : [])]);
      const checkInitialization = () => {
        if (signal.aborted || callerSignal?.aborted || requestSignal(input) !== callerSignal) throw new Held('aborted');
        guard.assertCurrent(); checkPorts(); options.assertCurrent?.();
      };
      // A cold store is initialized only after capturing the original request.
      // Even an already-ready async init yields and cannot rebind that request.
      checkInitialization();
      await store.init();
      checkInitialization();
      // Capture each record separately. Scope resolution uses the entire graph,
      // including excluded records whose associations may change during a read.
      const readSources = () => store.listSources(Number.MAX_SAFE_INTEGER).map((source) => capture(source));
      const readNodes = () => store.listNodes(Number.MAX_SAFE_INTEGER).map((node) => capture(node));
      const readEdges = () => store.listEdges().map((edge) => capture(edge));
      // The corpus envelope must never pass through a single-record snapshot.
      const stateGuard = createSemanticWriteGuard(store);
      const allSources = stateGuard.watch('sources', readSources);
      const allNodes = stateGuard.watch('nodes', readNodes);
      const edges = stateGuard.watch('edges', readEdges);
      const sourcesById = new Map(allSources.map((source) => [source.id, source]));
      const nodesById = new Map(allNodes.map((node) => [node.id, node]));
      const lookup = { sources: sourcesById, nodes: nodesById, edges };
      const sourceInScope = (source: KnowledgeSourceRecord) => knowledgeSourceMatchesScope(source, request.scope);
      const nodeInScope = (node: KnowledgeNodeRecord) => knowledgeNodeMatchesScope(node, request.scope, lookup);
      const sources = allSources.filter((source) => sourceInScope(source) && (request.mode === 'packet' || source.status !== 'stale'));
      const nodes = allNodes.filter((node) => nodeInScope(node) && (request.mode === 'packet' || node.status === 'active'));
      const assertExternalCurrent = () => {
        if (callerSignal?.aborted || requestSignal(input) !== callerSignal) throw new Held('aborted');
        try { stateGuard.assertCurrent(); checkPorts(); options.assertCurrent?.(); }
        catch (error) { if (error instanceof JudgmentInputError || error instanceof Held) throw error; throw new Held('stale'); }
      };
      // The excerpt reader invokes this same guard before every dispatch.
      guard.watch('public-retrieval-context', () => { assertExternalCurrent(); return true; });
      const assertCurrent = () => {
        try { guard.assertCurrent(); }
        catch (error) { if (error instanceof JudgmentInputError || error instanceof Held) throw error; throw new Held('stale'); }
      };
      const check = () => { if (signal.aborted) throw new Held('aborted'); assertCurrent(); };
      const query = request.mode === 'packet' && request.writeScope?.length
        ? JSON.stringify({ task: request.query, writeScope: request.writeScope, context: 'Paths describe the requested work, not evidence or a requirement for literal word overlap.' })
        : request.query;
      assertJudgmentInput({ query });
      const rows: Omit<PublicKnowledgeSelectedRow, 'probability'>[] = [];
      const candidates: AnswerEvidenceCandidate[] = [];
      for (const source of sources) {
        const original = store.getSource(source.id);
        if (!original) throw new Held('stale');
        guard.watch(`source:${source.id}`, () => store.getSource(source.id), source);
        const extraction = guard.extraction(source.id);
        assertKnowledgeExtractionInput(extraction);
        if (extraction && (extraction.sourceId !== source.id || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source))) throw new Held('malformed');
        preflightSourceText(source, extraction);
        const uris = knowledgeSourceJudgmentUris(original);
        const meaning = { title: source.title, summary: source.summary, description: source.description, sourceType: source.sourceType,
          folderPath: source.folderPath, tags: source.tags, ...uris };
        assertJudgmentInput(meaning);
        const discovery = readRecord(source.metadata.sourceDiscovery);
        const provenance = { reason: readString(discovery.trustReason), domain: readString(discovery.sourceDomain) };
        assertJudgmentInput(provenance);
        const candidate: AnswerEvidenceCandidate = { reference: `candidate-${candidates.length + 1}`, kind: 'source', title: source.title ?? 'Untitled source',
          sourceType: source.sourceType, text: [sourceSemanticText({ ...source, ...uris }, extraction), source.folderPath].filter(Boolean).join('\n\n'),
          claimedProvenance: JSON.stringify(provenance) };
        assertJudgmentInput({ query, candidate });
        candidates.push(candidate); rows.push({ kind: 'source', id: source.id, source: original });
      }
      for (const node of nodes) {
        const original = store.getNode(node.id);
        if (!original) throw new Held('stale');
        guard.watch(`node:${node.id}`, () => store.getNode(node.id), node);
        const hints = Array.isArray(node.metadata.targetHints) ? node.metadata.targetHints : [];
        const subjectIds = uniqueStrings([readString(node.metadata.subjectId), ...readStringArray(node.metadata.subjectIds),
          ...readStringArray(node.metadata.linkedObjectIds), ...hints.map((hint) => readString(readRecord(hint).id))]);
        const subjects = subjectIds.flatMap((id) => { const subject = nodesById.get(id); return subject && nodeInScope(subject)
          && (request.mode === 'packet' || subject.status === 'active') ? [subject] : []; });
        // A known local key stays local even when its endpoint is outside this
        // scope. Do not supply a foreign subject just to erase its database ID.
        const targetHints = hints.map((hint) => {
          const record = readRecord(hint), id = readString(record.id);
          if (!id || !nodesById.has(id)) return hint;
          const { id: _localId, ...meaning } = record; return meaning;
        });
        const claim = projectAnswerFactClaim({ ...node, metadata: { ...node.metadata, targetHints },
          subjectIds: subjects.map((subject) => subject.id) }, subjects);
        const content = Object.fromEntries(NODE_CONTENT_FIELDS.filter((key) => node.metadata[key] !== undefined).map((key) => [key, node.metadata[key]]));
        const meaning = { title: node.title, summary: node.summary, aliases: node.aliases, content, claim };
        assertJudgmentInput(meaning);
        const candidate: AnswerEvidenceCandidate = { reference: `candidate-${candidates.length + 1}`, kind: 'node', title: node.title,
          nodeKind: node.kind, text: JSON.stringify(meaning) };
        assertJudgmentInput({ query, candidate });
        candidates.push(candidate); rows.push({ kind: 'node', id: node.id, node: original, nodeText: candidate.text });
      }
      const related = new Map<string, readonly string[]>();
      for (const row of rows) {
        const labels: string[] = [];
        for (const edge of edges) {
          const from = edge.fromKind === row.kind && edge.fromId === row.id;
          if (!from && !(edge.toKind === row.kind && edge.toId === row.id)) continue;
          const kind = from ? edge.toKind : edge.fromKind, id = from ? edge.toId : edge.fromId;
          const node = kind === 'node' ? nodesById.get(id) : undefined;
          const source = kind === 'source' ? sourcesById.get(id) : undefined;
          if (node && nodeInScope(node)) labels.push(node.title);
          if (source && sourceInScope(source)) labels.push(source.title ?? source.canonicalUri ?? source.id);
        }
        // Protect all displayed endpoint meaning before the presentation cap.
        for (const label of labels) assertJudgmentInput(label);
        related.set(`${row.kind}:${row.id}`, Object.freeze([...new Set(labels)].slice(0, 8)));
      }
      check();
      const plan = await prepareAnswerEvidenceRelevanceBatches({ query, candidates }, {
        signal, timeoutMs: Math.max(1, deadlineAt - Date.now()), assertCurrent: check,
      });
      check();
      const byReference = new Map(candidates.map((candidate, index) => [candidate.reference, rows[index]!]));
      const accepted = plan.accepted.map((reading) => ({ ...byReference.get(reading.reference)!, probability: reading.probability }))
        .sort((left, right) => right.probability - left.probability || left.id.localeCompare(right.id));
      let spans = new Map<string, readonly LocalAnswerExcerptSpan[]>();
      if (request.mode === 'packet' && accepted.some((row) => row.source)) {
        const excerpts = prepareAnswerSourceExcerptBatches(store, query, accepted.flatMap((row) => row.source
          ? [{ source: row.source, context: 'Select exact evidence for the original task and its work scope.' }] : []), guard, signal);
        excerpts.start(); check();
        spans = await excerpts.read(new Set(accepted.filter((row) => row.source).map((row) => row.id)));
        excerpts.assertCurrent(); check();
      }
      const result = Object.freeze(accepted.map((row) => Object.freeze({ ...row,
        ...(request.mode === 'packet' && row.source ? { spans: spans.get(row.id) ?? Object.freeze([]) } : {}) })));
      check();
      return { accepted: result, assertCurrent,
        relatedLabels(kind: 'source' | 'node', id: string) { assertCurrent(); return related.get(`${kind}:${id}`) ?? Object.freeze([]); } };
    }, undefined, callerSignal);
  } catch (error) {
    if (error instanceof JudgmentInputError || error instanceof Held) throw error;
    if (error instanceof KnowledgeAnswerExcerptHeldError) throw new Held(error.reason);
    if (error instanceof KnowledgeSourceQualityHeldError) throw new Held(error.reason === 'aborted' ? 'aborted' : 'stale');
    if (error instanceof KnowledgeAnswerQualityHeldError) throw new Held(error.reason === 'uncertain' ? 'unsettled'
      : error.reason === 'budget' || error.reason === 'aborted' || error.reason === 'stale' || error.reason === 'malformed' ? error.reason : 'unavailable');
    throw new Held('unavailable');
  }
}
