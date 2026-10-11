import {
  captureJudgmentPort,
  JudgmentAuthorityRetiredError,
  JudgmentPortMissingError,
  type JudgmentPortCapture,
} from '@goodvibes-jev/engine/errors';
import { mapLimit, toJson } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import { retainStrictJudgmentJson } from '../gate/judgment-result.js';
import { knowledgeScopeSelection } from './batteries/scope-selection.js';
import { knowledgeSourceJudgmentUris } from './source-structural-references.js';
import { DEFAULT_KNOWLEDGE_SPACE_ID, getKnowledgeSpaceId, getExplicitKnowledgeSpaceId, resolveKnowledgeSpaceScope, type KnowledgeSpaceScopeInput } from './spaces.js';
import { knowledgeIssueMatchesScope, knowledgeNodeMatchesScope, knowledgeSourceMatchesScope } from './scope-records.js';
import { knowledgeRawRepresentation, knowledgeRecordVersion, sameKnowledgeRecord } from './store-record-representation.js';
import { KnowledgeRecordAdmissionHeldError } from './store-record-snapshot.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeEdgeRecord, KnowledgeExtractionRecord, KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { KnowledgeWebGapRepairHeldError } from './semantic/web-gap-repair/types.js';
import { captureStrictRepairJson, prepareRepairJudgmentResult } from './semantic/web-gap-repair/admission.js';

export class KnowledgeScopeSelectionHeldError extends Error {
  override readonly name = 'KnowledgeScopeSelectionHeldError';
  constructor(readonly reason: 'unavailable' | 'uncertain' | 'malformed' | 'stale' | 'aborted' | 'budget') {
    super(`Knowledge scope selection held: ${reason}.`);
  }
}

export interface KnowledgeScopeSelectionOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly assertPreparedInputCurrent?: (() => void) | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly kinds?: readonly ('source' | 'node' | 'issue')[] | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly nodeIds?: readonly string[] | undefined;
  readonly issueIds?: readonly string[] | undefined;
}

export interface KnowledgeScopeSelection {
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly source: (record: KnowledgeSourceRecord) => boolean;
  readonly node: (record: KnowledgeNodeRecord) => boolean;
  readonly issue: (record: KnowledgeIssueRecord) => boolean;
  readonly retainEdges: (records: readonly KnowledgeEdgeRecord[], window?: KnowledgeScopeEdgeWindow) => () => void;
  readonly assertCurrent: () => void;
}

export interface KnowledgeScopeEdgeWindow {
  readonly sourceIds?: readonly string[];
  readonly nodeIds?: readonly string[];
  readonly incidentTo?: readonly { readonly kind: 'source' | 'node'; readonly id: string }[];
  readonly includeUnselectedEndpoints?: boolean;
}

type ScopeRecord =
  | { readonly kind: 'source'; readonly record: KnowledgeSourceRecord }
  | { readonly kind: 'node'; readonly record: KnowledgeNodeRecord }
  | { readonly kind: 'issue'; readonly record: KnowledgeIssueRecord };

// These are consumed content, not record IDs, clocks, confidence or authority receipts.
const CONTENT_FIELDS = ['semanticKind', 'factKind', 'entityKind', 'value', 'evidence', 'labels', 'subject',
  'markdown', 'text', 'searchText', 'content', 'description', 'tags', 'tag', 'scope', 'cls',
  'manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'batteryPowered', 'batteryType',
  'manualRequired', 'documentation', 'documentationUrl', 'documentation_url', 'sourceUrl', 'source_url',
  'deviceClass', 'device_class', 'entryType', 'entry_type', 'attributes', 'homeAssistant',
  'gapKind', 'query', 'reason', 'resolution', 'path', 'filePath', 'folderPath', 'url',
  'project', 'projects', 'capability', 'capabilities', 'feature', 'features', 'repo', 'repository', 'repositories',
  'provider', 'providers', 'service', 'services', 'env', 'environment', 'environments', 'owner', 'owners'];

function content(value: ScopeRecord) {
  const record = value.record;
  const meaning = Object.fromEntries(CONTENT_FIELDS.filter(key => record.metadata[key] !== undefined)
    .map(key => [key, record.metadata[key]]));
  switch (value.kind) {
    case 'source': return { kind: value.kind, content: { title: value.record.title, summary: value.record.summary,
      description: value.record.description, sourceType: value.record.sourceType, tags: value.record.tags,
      folderPath: value.record.folderPath, ...knowledgeSourceJudgmentUris(value.record), meaning } };
    case 'node': return { kind: value.kind, content: { title: value.record.title, summary: value.record.summary,
      kind: value.record.kind, aliases: value.record.aliases, meaning } };
    case 'issue': return { kind: value.kind, content: { code: value.record.code, message: value.record.message, meaning } };
  }
}

function references(record: ScopeRecord): readonly { readonly kind: 'source' | 'node'; readonly id: string }[] {
  const metadata = record.record.metadata;
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(strings) : [];
  const sources = [...strings(record.kind === 'source' ? undefined : record.record.sourceId),
    ...strings(metadata.sourceId), ...strings(metadata.sourceIds)];
  const nodes = [...strings(record.kind === 'issue' ? record.record.nodeId : undefined),
    ...strings(metadata.nodeId), ...strings(metadata.subjectId), ...strings(metadata.subjectIds), ...strings(metadata.linkedObjectIds),
    ...(metadata.sourceDiscovery && typeof metadata.sourceDiscovery === 'object' && 'linkedObjectIds' in metadata.sourceDiscovery
      ? strings(metadata.sourceDiscovery.linkedObjectIds) : []),
    ...(Array.isArray(metadata.targetHints) ? metadata.targetHints.flatMap(hint => hint && typeof hint === 'object' && 'id' in hint ? strings(hint.id) : []) : [])];
  return [...[...new Set(sources)].map(id => ({ kind: 'source' as const, id })),
    ...[...new Set(nodes)].map(id => ({ kind: 'node' as const, id }))];
}

/** One complete operation keeps observations live through its final consumption.
 * IDs enforce membership locally; semantic negatives never become a new namespace.
 */
export async function prepareKnowledgeScopeSelection(
  store: KnowledgeStore,
  scope: KnowledgeSpaceScopeInput = {},
  options: KnowledgeScopeSelectionOptions = {},
): Promise<KnowledgeScopeSelection> {
  const signal = options.signal, callerCurrent = options.assertCurrent, preparedCurrent = options.assertPreparedInputCurrent, shouldStop = options.shouldStop;
  const bounds = () => captureStrictRepairJson({ kinds: options.kinds, sourceIds: options.sourceIds, nodeIds: options.nodeIds, issueIds: options.issueIds });
  const boundSnapshot = bounds(), boundsVersion = knowledgeRecordVersion(boundSnapshot);
  const controller = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const scopeSnapshot = captureStrictRepairJson(scope);
  const scopeVersion = knowledgeRecordVersion(scopeSnapshot);
  let authority: JudgmentPortCapture | undefined;
  const observed: (() => void)[] = [];
  const fail = (error: unknown): never => {
    if (error instanceof JudgmentInputError || error instanceof KnowledgeScopeSelectionHeldError) throw error;
    if (signal?.aborted || shouldStop?.()) throw new KnowledgeScopeSelectionHeldError('aborted');
    throw new KnowledgeScopeSelectionHeldError(error instanceof JudgmentPortMissingError ? 'unavailable'
      : error instanceof JudgmentAuthorityRetiredError || error instanceof KnowledgeRecordAdmissionHeldError ? 'stale'
        : error instanceof KnowledgeWebGapRepairHeldError ? error.reason === 'stale' ? 'stale' : 'malformed' : 'unavailable');
  };
  let withLookup = (body: () => undefined) => body();
  let withRecordGenerations = (_checks: Iterable<() => void>, body: () => undefined) => body();
  const assertSynchronousCurrent = (check: (() => void) | undefined) => {
    try {
      const current: unknown = check?.();
      if (current !== undefined) {
        try { void Promise.resolve(current).catch(() => {}); } catch { /* A borrowed result cannot grant authority. */ }
        throw new KnowledgeScopeSelectionHeldError('stale');
      }
    } catch (error) {
      if (error instanceof JudgmentInputError || error instanceof KnowledgeScopeSelectionHeldError) throw error;
      throw new KnowledgeScopeSelectionHeldError('stale');
    }
  };
  const assertOriginalIdentity = () => {
    if (operationSignal.aborted || shouldStop?.()) throw new KnowledgeScopeSelectionHeldError('aborted');
    if (knowledgeRecordVersion(bounds()) !== boundsVersion || options.signal !== signal || options.assertCurrent !== callerCurrent
      || options.assertPreparedInputCurrent !== preparedCurrent || options.shouldStop !== shouldStop
      || knowledgeRecordVersion(captureStrictRepairJson(scope)) !== scopeVersion) throw new KnowledgeScopeSelectionHeldError('stale');
  };
  const assertInputIdentity = () => {
    assertOriginalIdentity();
    assertSynchronousCurrent(callerCurrent);
    assertOriginalIdentity();
  };
  const assertAuthorityCurrent = () => {
    if (authority) authority.assertCurrent(); else assertInputIdentity();
  };
  const assertInputCurrent = () => {
    store.assertRecordSnapshotFrame(() => {
      assertAuthorityCurrent(); withLookup(() => { withRecordGenerations(observed, () => { for (const check of observed) check(); }); });
    });
  };
  const assertCurrent = () => {
    try { assertInputCurrent(); }
    catch (error) { fail(error); }
  };
  assertCurrent();
  await store.init();
  assertCurrent();
  const sources = store.listSources(Number.MAX_SAFE_INTEGER);
  const nodes = store.listNodes(Number.MAX_SAFE_INTEGER);
  const issues = store.listIssues(Number.MAX_SAFE_INTEGER);
  const edges = store.listEdges();
  const sourceMap = new Map(sources.map(record => [record.id, record]));
  const nodeMap = new Map(nodes.map(record => [record.id, record]));
  const indexEdges = (edges: readonly KnowledgeEdgeRecord[]) => {
    const index = new Map<string, KnowledgeEdgeRecord[]>();
    for (const edge of edges) for (const key of new Set([`${edge.fromKind}:${edge.fromId}`, `${edge.toKind}:${edge.toId}`])) {
      const related = index.get(key) ?? []; related.push(edge); index.set(key, related);
    }
    return index;
  };
  const lookup = { sources: sourceMap, nodes: nodeMap, edges, edgeIndex: indexEdges(edges) };
  let frameLookup = lookup;
  withLookup = body => {
    const previous = frameLookup;
    const currentEdges = store.listEdges();
    frameLookup = { sources: new Map(store.listSources(Number.MAX_SAFE_INTEGER).map(record => [record.id, record])),
      nodes: new Map(store.listNodes(Number.MAX_SAFE_INTEGER).map(record => [record.id, record])),
      edges: currentEdges, edgeIndex: indexEdges(currentEdges) };
    try { return body(); } finally { frameLookup = previous; }
  };
  const records: ScopeRecord[] = [...sources.map(record => ({ kind: 'source' as const, record })),
    ...nodes.map(record => ({ kind: 'node' as const, record })), ...issues.map(record => ({ kind: 'issue' as const, record }))];
  const keyFor = (value: ScopeRecord): string => `${value.kind}:${value.record.id}`;
  const project = (value: ScopeRecord, inspectExtraction?: (extraction: KnowledgeExtractionRecord | null) => void) => {
    const projected = content(value);
    if (value.kind !== 'source') return projected;
    const extraction = store.getExtractionBySourceId(value.record.id);
    if (inspectExtraction) inspectExtraction(extraction);
    if (!extraction) return projected;
    if (!inspectExtraction) captureStrictRepairJson(extraction);
    const fields = [...CONTENT_FIELDS, 'sections', 'summary', 'title', 'excerpt'];
    const structure = Object.fromEntries(fields.filter(key => extraction.structure[key] !== undefined).map(key => [key, extraction.structure[key]]));
    return { kind: projected.kind, content: { ...projected.content, extraction: { format: extraction.format, title: extraction.title,
      summary: extraction.summary, excerpt: extraction.excerpt, sections: extraction.sections, structure } } };
  };
  const signatureInput = (value: ScopeRecord, inspectExtraction?: (extraction: KnowledgeExtractionRecord | null) => void) => ({
    kind: value.kind, id: value.record.id, status: value.record.status, space: getKnowledgeSpaceId(value.record),
    references: references(value), content: project(value, inspectExtraction),
  });
  const slotsMatch = (slots: { readonly assertCurrent: () => void }) => {
    try { slots.assertCurrent(); return true; } catch { return false; }
  };
  const retainSignature = (value: ScopeRecord) => {
    const recordSlots = retainStrictJudgmentJson(value.record, problem => new KnowledgeWebGapRepairHeldError(problem));
    let originalExtraction: KnowledgeExtractionRecord | null = null;
    let extractionSlots = retainStrictJudgmentJson<KnowledgeExtractionRecord | null>(originalExtraction, problem => new KnowledgeWebGapRepairHeldError(problem));
    captureStrictRepairJson(value.record);
    const originalInput = signatureInput(value, extraction => {
      originalExtraction = extraction;
      extractionSlots = retainStrictJudgmentJson(extraction, problem => new KnowledgeWebGapRepairHeldError(problem));
    });
    const version = knowledgeRecordVersion(captureStrictRepairJson(originalInput));
    const originalContent = originalInput.content.content;
    const originalUris = 'canonicalUri' in originalContent ? {
      url: originalContent.url, sourceUri: originalContent.sourceUri, canonicalUri: originalContent.canonicalUri,
    } : undefined;
    return (current: ScopeRecord) => {
      let unchanged = current.kind === value.kind && current.record === value.record && slotsMatch(recordSlots);
      if (!unchanged) captureStrictRepairJson(current.record);
      let observedExtraction: KnowledgeExtractionRecord | null = null;
      // Always execute the original projection, including its owning source
      // lookup and second extraction lookup, before considering the fast path.
      const input = signatureInput(current, extraction => {
        observedExtraction = extraction;
        const extractionUnchanged = extraction === originalExtraction && slotsMatch(extractionSlots);
        if (!extractionUnchanged) captureStrictRepairJson(extraction);
        unchanged = unchanged && extractionUnchanged;
      });
      const projectedContent = input.content.content;
      const urisUnchanged = originalUris === undefined || ('canonicalUri' in projectedContent
        && projectedContent.url === originalUris.url && projectedContent.sourceUri === originalUris.sourceUri
        && projectedContent.canonicalUri === originalUris.canonicalUri);
      if (unchanged && urisUnchanged && slotsMatch(recordSlots) && slotsMatch(extractionSlots)) return true;
      // Equal replacements and reordered object slots retain the original
      // value comparison. A fallback never becomes a new retained baseline.
      captureStrictRepairJson(current.record);
      captureStrictRepairJson(observedExtraction);
      return knowledgeRecordVersion(captureStrictRepairJson(input)) === version;
    };
  };
  const snapshots = new Map<string, ReturnType<typeof retainSignature>>();
  const readRecord = (value: ScopeRecord): ScopeRecord | undefined => {
    switch (value.kind) {
      case 'source': { const record = store.getSource(value.record.id); return record ? { kind: value.kind, record } : undefined; }
      case 'node': { const record = store.getNode(value.record.id); return record ? { kind: value.kind, record } : undefined; }
      case 'issue': { const record = store.getIssue(value.record.id); return record ? { kind: value.kind, record } : undefined; }
    }
  };
  const scopedChecks = new Map<string, Set<() => void>>();
  const addCheck = (key: string, check: () => void) => {
    observed.push(check); const checks = scopedChecks.get(key) ?? new Set(); checks.add(check); scopedChecks.set(key, checks);
    return check;
  };
  const retained = new Map<string, () => void>();
  type RecordSelector = Parameters<KnowledgeStore['getRecordGenerations']>[0][number];
  const generationSelectors = new Map<() => void, readonly RecordSelector[]>();
  let currentGenerations: ReadonlyMap<string, string | null> | undefined;
  const currentGeneration = (selector: RecordSelector) => {
    const key = `${selector.kind}:${selector.id}`;
    return currentGenerations?.has(key) ? currentGenerations.get(key)!
      : selector.kind === 'source' ? store.getSourceGeneration(selector.id) : store.getRecordGeneration(selector.kind, selector.id);
  };
  withRecordGenerations = (checks, body) => {
    const selectors = [...new Map([...checks].flatMap(check => generationSelectors.get(check) ?? [])
      .map(selector => [`${selector.kind}:${selector.id}`, selector] as const)).values()];
    const generations = store.getRecordGenerations(selectors), previous = currentGenerations;
    currentGenerations = new Map(selectors.map((selector, index) => [`${selector.kind}:${selector.id}`, generations[index]!]));
    try { return body(); } finally { currentGenerations = previous; }
  };
  const retain = (value: ScopeRecord) => {
    const key = keyFor(value);
    const previous = retained.get(key);
    if (previous) return previous;
    captureStrictRepairJson(value.record);
    const matchesSignature = retainSignature(value);
    snapshots.set(key, matchesSignature);
    const original = readRecord(value)?.record;
    const generation = (adopt = false) => {
      if (value.kind === 'issue') return undefined;
      if (!adopt) return currentGeneration({ kind: value.kind, id: value.record.id });
      const snapshot = value.kind === 'source' ? (() => { const source = store.getSourceSnapshot({ id: value.record.id });
        return { record: source.source, generation: source.generation }; })() : store.getRecordSnapshot('node', value.record.id);
      if (adopt && !sameKnowledgeRecord(value.record, snapshot.record)) {
        assertJudgmentInput(knowledgeRawRepresentation(value.record));
        throw new KnowledgeScopeSelectionHeldError('stale');
      }
      return snapshot.generation;
    };
    const originalGeneration = generation(true);
    const extractionGeneration = (adopt = false) => value.kind === 'source' ? (() => {
      const extraction = store.getExtractionBySourceId(value.record.id);
      if (!extraction) return null;
      if (!adopt) return currentGeneration({ kind: 'extraction', id: extraction.id });
      const snapshot = store.getRecordSnapshot('extraction', extraction.id);
      if (adopt && !sameKnowledgeRecord(extraction, snapshot.record)) {
        assertJudgmentInput(knowledgeRawRepresentation(extraction));
        throw new KnowledgeScopeSelectionHeldError('stale');
      }
      return snapshot.generation;
    })() : undefined;
    const originalExtractionGeneration = extractionGeneration(true);
    const check = addCheck(key, () => {
      const current = readRecord(value);
      if (!current || current.record !== original || generation() !== originalGeneration || extractionGeneration() !== originalExtractionGeneration || !matchesSignature(current)) throw new KnowledgeScopeSelectionHeldError('stale');
    });
    const extraction = value.kind === 'source' ? store.getExtractionBySourceId(value.record.id) : null;
    generationSelectors.set(check, [...(value.kind === 'issue' ? [] : [{ kind: value.kind, id: value.record.id }]),
      ...(extraction ? [{ kind: 'extraction' as const, id: extraction.id }] : [])]);
    retained.set(key, check); return check;
  };
  const membership = (value: ScopeRecord, scope: KnowledgeSpaceScopeInput, currentLookup = frameLookup) => {
    const relevant = [keyFor(value), ...(value.kind === 'issue' ? references(value).filter(ref => ref.kind === 'node').map(ref => `${ref.kind}:${ref.id}`) : [])];
    const relevantEdges = [...new Map(relevant.flatMap(key => currentLookup.edgeIndex.get(key) ?? []).map(edge => [edge.id, edge])).values()];
    const localLookup = { sources: currentLookup.sources, nodes: currentLookup.nodes, edges: relevantEdges };
    switch (value.kind) {
      case 'source': return knowledgeSourceMatchesScope(value.record, scope);
      case 'node': return knowledgeNodeMatchesScope(value.record, scope, localLookup);
      case 'issue': return knowledgeIssueMatchesScope(value.record, scope, localLookup);
    }
  };
  const boundedRecords = records.filter(value => {
    if (boundSnapshot.kinds && !boundSnapshot.kinds.includes(value.kind)) return false;
    const ids = value.kind === 'source' ? boundSnapshot.sourceIds : value.kind === 'node' ? boundSnapshot.nodeIds : boundSnapshot.issueIds;
    return !ids || ids.includes(value.record.id);
  });
  for (const value of boundedRecords) captureStrictRepairJson(value.record);
  const accepted = new Set<string>();
  const candidates = boundedRecords.filter(value => membership(value, scopeSnapshot));
  const candidateKeys = new Set(candidates.map(keyFor));
  type EdgeEndpoints = { readonly fromKind: string; readonly fromId: string; readonly toKind: string; readonly toId: string };
  const edgeInWindow = (edge: EdgeEndpoints, keys: ReadonlySet<string>) => keys.has(`${edge.fromKind}:${edge.fromId}`) && keys.has(`${edge.toKind}:${edge.toId}`);
  const potentialEdges = edges.filter(edge => edgeInWindow(edge, candidateKeys));
  const edgeVersion = (values: readonly KnowledgeEdgeRecord[]) => {
    const captured = captureStrictRepairJson(values);
    const extras = Object.fromEntries(Object.entries(captured).filter(([key]) => {
      const index = Number(key);
      return !Number.isInteger(index) || index < 0 || String(index) !== key || index >= captured.length;
    }));
    return knowledgeRecordVersion({ records: [...captured].sort((left, right) => left.id.localeCompare(right.id)), extras });
  };
  const potentialEdgeVersion = edgeVersion(potentialEdges);
  const originalEdgeGenerations = new Map<string, string | null>();
  let originalEdgeChanges: ReturnType<KnowledgeStore['getEdgeChangeSnapshots']> = [];
  store.assertRecordSnapshotFrame(() => {
    assertSynchronousCurrent(preparedCurrent);
    originalEdgeChanges = store.getEdgeChangeSnapshots();
    const physical = store.getEdgeSnapshots().filter(snapshot => snapshot.record && edgeInWindow(snapshot.record, candidateKeys));
    if (edgeVersion(physical.flatMap(snapshot => snapshot.record ? [snapshot.record] : [])) !== potentialEdgeVersion) throw new KnowledgeScopeSelectionHeldError('stale');
    for (const snapshot of physical) if (snapshot.record) originalEdgeGenerations.set(snapshot.record.id, snapshot.generation);
  });
  const relatedInputs = (value: ScopeRecord, currentLookup = frameLookup) => {
    const related = new Map<string, ScopeRecord>(), outside = new Map<string, string>();
    const refs = [...references(value), ...(value.kind === 'source' ? [] : (currentLookup.edgeIndex.get(keyFor(value)) ?? [])).flatMap(edge => [
      ...(edge.fromKind === 'source' || edge.fromKind === 'node' ? [{ kind: edge.fromKind, id: edge.fromId }] : []),
      ...(edge.toKind === 'source' || edge.toKind === 'node' ? [{ kind: edge.toKind, id: edge.toId }] : []),
    ])];
    for (const ref of refs) {
      const key = `${ref.kind}:${ref.id}`;
      const source = ref.kind === 'source' ? currentLookup.sources.get(ref.id) : undefined;
      const node = ref.kind === 'node' ? currentLookup.nodes.get(ref.id) : undefined;
      const other: ScopeRecord | undefined = source ? { kind: 'source', record: source } : node ? { kind: 'node', record: node } : undefined;
      if (!other || key === keyFor(value)) continue;
      // A new descendant claim is an output, rather than a subject's context.
      if (value.kind === 'node' && value.record.kind !== 'fact' && other.kind === 'node' && other.record.kind === 'fact'
        && !references(value).some(ref => ref.kind === other.kind && ref.id === other.record.id)) continue;
      if (membership(other, scopeSnapshot, currentLookup)) related.set(key, other);
      else outside.set(key, getKnowledgeSpaceId(other.record));
    }
    return { related, outside, version: knowledgeRecordVersion({ related: [...related.keys()].sort(), outside: [...outside].sort(([left], [right]) => left.localeCompare(right)) }) };
  };
  const prepareJobs = () => {
    for (const value of boundedRecords) {
      if (candidates.includes(value)) retain(value);
      const expected = membership(value, scopeSnapshot), ordinary = membership(value, {});
      addCheck(keyFor(value), () => {
        const current = readRecord(value);
        if (!current || membership(current, scopeSnapshot) !== expected
          || membership(current, {}) !== ordinary) throw new KnowledgeScopeSelectionHeldError('stale');
      });
    }
    const needsReading = (value: ScopeRecord) => getKnowledgeSpaceId(value.record) === DEFAULT_KNOWLEDGE_SPACE_ID
      && (value.kind !== 'node' || getExplicitKnowledgeSpaceId(value.record) !== null || membership(value, {}));
    const jobs = candidates.filter(needsReading).map(value => {
      const context = relatedInputs(value, lookup), related = context.related;
      const outsideRequestedScope = context.outside.size > 0;
      addCheck(keyFor(value), () => {
        const current = readRecord(value);
        if (!current || relatedInputs(current).version !== context.version) throw new KnowledgeScopeSelectionHeldError('stale');
      });
      for (const other of related.values()) {
        const check = retain(other); scopedChecks.get(keyFor(value))?.add(check);
      }
      const view = resolveKnowledgeSpaceScope(scopeSnapshot) === null ? 'all'
        : resolveKnowledgeSpaceScope(scopeSnapshot) === DEFAULT_KNOWLEDGE_SPACE_ID ? 'ordinary' : 'explicit';
      const candidateContent = project(value), relatedContent = [...related.values()].map(other => project(other));
      assertJudgmentInput({ view, candidate: candidateContent, related: relatedContent, associations: { outsideRequestedScope } });
      const state = { view, candidate: toJson(candidateContent), related: relatedContent.map(other => toJson(other)),
        associations: { outsideRequestedScope } };
      assertJudgmentInput(state);
      return { key: `${value.kind}:${value.record.id}`, state: captureStrictRepairJson(state) };
    });
    for (const value of candidates) if (!needsReading(value)) accepted.add(`${value.kind}:${value.record.id}`);
    return jobs;
  };
  let jobs: ReturnType<typeof prepareJobs> = [];
  store.assertRecordSnapshotFrame(() => { withLookup(() => { jobs = prepareJobs(); }); });
  if (jobs.length > 2_000) throw new KnowledgeScopeSelectionHeldError('budget');
  const assertRecordCurrent = (key: string) => {
    store.assertRecordSnapshotFrame(() => {
      assertAuthorityCurrent();
      withLookup(() => {
        const checks = scopedChecks.get(key) ?? [];
        withRecordGenerations(checks, () => { for (const check of checks) check(); });
      });
    });
  };
  try {
    assertCurrent();
    if (jobs.length) {
      authority = captureJudgmentPort(knowledgeScopeSelection.name, { signal: operationSignal, assertCurrent: assertInputIdentity, prepareResultCapture: prepareRepairJudgmentResult });
      let resultModel: string | undefined;
      await mapLimit(jobs, 4, async job => {
        let captured: ReturnType<typeof captureJudgmentPort> | undefined;
        store.assertRecordSnapshotFrame(() => {
          captured = captureJudgmentPort(knowledgeScopeSelection.name, { signal: operationSignal,
            assertCurrent: () => { assertRecordCurrent(job.key); },
            prepareResultCapture: prepareRepairJudgmentResult });
        });
        if (!captured) throw new KnowledgeScopeSelectionHeldError('stale');
        if (captured.identity !== authority?.identity) throw new KnowledgeScopeSelectionHeldError('stale');
        const run = await knowledgeScopeSelection.run(captured.port, job.state, { signal: captured.signal, site: knowledgeScopeSelection.name });
        captured.assertCurrent();
        if (resultModel !== undefined && resultModel !== run.result.model) throw new KnowledgeScopeSelectionHeldError('stale');
        resultModel = run.result.model;
        if (run.readings.included.outcome !== 'act' || run.readings.included.verdict === 'uncertain') throw new KnowledgeScopeSelectionHeldError('uncertain');
        if (run.readings.included.verdict === 'yes') accepted.add(job.key);
        run.recordAction(`scope content ${run.readings.included.verdict}; explicit namespace and effect authority unchanged`);
        captured.assertCurrent();
      });
    }
    assertCurrent();
  } catch (error) {
    try { fail(error); } finally { controller.abort(); }
  }
  const matches = (value: ScopeRecord) => {
    const { kind, record } = value;
    try {
      assertRecordCurrent(keyFor(value));
    } catch (error) { fail(error); }
    const key = `${kind}:${record.id}`, snapshot = snapshots.get(key);
    if (!snapshot) return false;
    if (!snapshot(value)) throw new KnowledgeScopeSelectionHeldError('stale');
    return accepted.has(key);
  };
  const selectedEdges = potentialEdges.filter(edge => edgeInWindow(edge, accepted));
  const retainEdges = (records: readonly KnowledgeEdgeRecord[], window: KnowledgeScopeEdgeWindow = {}) => {
    const inputVersion = edgeVersion(records), windowSnapshot = captureStrictRepairJson(window), windowVersion = knowledgeRecordVersion(windowSnapshot);
    const retainedRecords = retainStrictJudgmentJson(records, problem => new KnowledgeWebGapRepairHeldError(problem));
    const retainedWindow = retainStrictJudgmentJson(window, problem => new KnowledgeWebGapRepairHeldError(problem));
    const originalSlotsMatch = (retained: { readonly assertCurrent: () => void }) => {
      try { retained.assertCurrent(); return true; } catch { return false; }
    };
    const keys = new Set([...accepted].filter(key => key.startsWith('source:')
      ? !windowSnapshot.sourceIds || windowSnapshot.sourceIds.includes(key.slice('source:'.length))
      : key.startsWith('node:') && (!windowSnapshot.nodeIds || windowSnapshot.nodeIds.includes(key.slice('node:'.length)))));
    const incident = windowSnapshot.incidentTo ? new Set(windowSnapshot.incidentTo.map(reference => `${reference.kind}:${reference.id}`)) : undefined;
    if (incident && [...incident].some(key => !keys.has(key))) throw new KnowledgeScopeSelectionHeldError('stale');
    const openIncident = windowSnapshot.includeUnselectedEndpoints === true;
    if (openIncident && !incident?.size) throw new KnowledgeScopeSelectionHeldError('stale');
    const touchesIncident = (from: string, to: string) => !!incident && (incident.has(from) || incident.has(to));
    const includes = (edge: EdgeEndpoints) => edgeInWindow(edge, keys)
      && (!incident || incident.has(`${edge.fromKind}:${edge.fromId}`) || incident.has(`${edge.toKind}:${edge.toId}`));
    const topologyVersion = (values: readonly KnowledgeEdgeRecord[]) => knowledgeRecordVersion(values
      .filter(edge => touchesIncident(`${edge.fromKind}:${edge.fromId}`, `${edge.toKind}:${edge.toId}`))
      .map(edge => ({ id: edge.id, fromKind: edge.fromKind, fromId: edge.fromId, toKind: edge.toKind, toId: edge.toId }))
      .sort((left, right) => left.id.localeCompare(right.id)));
    const originalTopologyVersion = openIncident ? topologyVersion(edges) : undefined;
    const byId = new Map(selectedEdges.map(edge => [edge.id, edge]));
    for (const record of records) if (!includes(record) || !sameKnowledgeRecord(record, byId.get(record.id))) throw new KnowledgeScopeSelectionHeldError('stale');
    const original = potentialEdges.filter(includes), version = edgeVersion(original);
    const retainedEdges = retainStrictJudgmentJson(original, problem => new KnowledgeWebGapRepairHeldError(problem));
    const originalEdges = new Set(original);
    const cachedWindowMatches = () => {
      const current = store.listEdges().filter(includes);
      const currentEdges = new Set(current);
      if (originalSlotsMatch(retainedEdges) && originalEdges.size === original.length
        && current.length === original.length && currentEdges.size === originalEdges.size
        && original.every(edge => currentEdges.has(edge))) return true;
      return edgeVersion(current) === version;
    };
    const originalWindowGeneration = originalEdgeChanges.reduce((latest, change) => {
      const from = `${change.fromKind}:${change.fromId}`, to = `${change.toKind}:${change.toId}`;
      return (openIncident ? touchesIncident(from, to) : keys.has(from) && keys.has(to) && (!incident || touchesIncident(from, to)))
        && BigInt(change.generation) > BigInt(latest) ? change.generation : latest;
    }, '0');
    const current = () => {
      try {
        store.assertRecordSnapshotFrame(() => {
          assertAuthorityCurrent();
          if ((!originalSlotsMatch(retainedRecords) && edgeVersion(records) !== inputVersion)
            || (!originalSlotsMatch(retainedWindow) && knowledgeRecordVersion(captureStrictRepairJson(window)) !== windowVersion)
            || !cachedWindowMatches()
            || (openIncident && topologyVersion(store.listEdges()) !== originalTopologyVersion)
            || store.getEdgeWindowGeneration([...keys], incident ? [...incident] : undefined, openIncident) !== originalWindowGeneration) throw new KnowledgeScopeSelectionHeldError('stale');
          const physical = store.getEdgeGenerationSnapshots().filter(includes);
          const expectedIds = original.map(edge => edge.id).sort();
          if (knowledgeRecordVersion(physical.map(edge => edge.id).sort()) !== knowledgeRecordVersion(expectedIds)
            || physical.some(snapshot => originalEdgeGenerations.get(snapshot.id) !== snapshot.generation)) throw new KnowledgeScopeSelectionHeldError('stale');
        });
      } catch (error) { fail(error); }
    };
    current(); return current;
  };
  return Object.freeze({
    sources: Object.freeze(sources.filter(record => accepted.has(`source:${record.id}`))),
    nodes: Object.freeze(nodes.filter(record => accepted.has(`node:${record.id}`))),
    issues: Object.freeze(issues.filter(record => accepted.has(`issue:${record.id}`))),
    edges: Object.freeze(selectedEdges),
    source: (record: KnowledgeSourceRecord) => matches({ kind: 'source', record }),
    node: (record: KnowledgeNodeRecord) => matches({ kind: 'node', record }),
    issue: (record: KnowledgeIssueRecord) => matches({ kind: 'issue', record }),
    retainEdges,
    assertCurrent,
  });
}
