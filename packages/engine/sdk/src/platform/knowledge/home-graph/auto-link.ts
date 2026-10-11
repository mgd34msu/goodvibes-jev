import { sameKnowledgeRecord } from '../store-record-representation.js';
import { assertKnowledgeArrayExtras, prepareKnowledgeRecordAdmission } from '../store-record-snapshot.js';
import { assertJudgmentInput, captureOwnedJson } from '../../gate/judgment-input.js';
import { snapshotNodeInput } from '../activation/projection.js';
import { assertKnowledgeExtractionInput } from '../extraction-policy.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { captureKnowledgeSourceReferences, knowledgeSourceJudgmentUris } from '../source-structural-references.js';
import { guardKnowledgeEdgeInput } from '../store-edge-writes.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeEdgeRecord, KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { buildHomeGraphMetadata, edgeIsActive, isGeneratedPageSource } from './helpers.js';
import { readHomeGraphState, type HomeGraphState } from './state.js';
import { projectHomeGraphQualityInput } from './quality/projection.js';
import { createHomeGraphAutoLinkReader, HomeGraphAutoLinkHeldError as Held, type AutoLinkReadingInput } from './auto-link/reader.js';

export interface HomeGraphAutoLinkResult {
  readonly edge: KnowledgeEdgeRecord;
  readonly node: KnowledgeNodeRecord;
  readonly relation: string;
  /** Compatibility field: no legacy point score or confidence is manufactured. */
  readonly score: number;
  readonly reasons: readonly string[];
}
interface AutoLinkContext {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly state: HomeGraphState;
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
}
interface AutoLinkSourceInput extends AutoLinkContext {
  readonly source: KnowledgeSourceRecord;
  readonly extraction?: KnowledgeExtractionRecord | undefined;
}
interface AutoLinkSourcesInput extends AutoLinkContext {
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
}

function skipped(source: KnowledgeSourceRecord): boolean {
  return isGeneratedPageSource(source) || source.metadata.homeGraphSourceKind === 'snapshot'
    || source.metadata.homeGraphSourceKind === 'generated-page';
}
function hasActiveSourceLink(sourceId: string, edges: readonly KnowledgeEdgeRecord[]): boolean {
  return edges.some((edge) => edgeIsActive(edge) && (
    (edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    || (edge.fromKind === 'node' && edge.toKind === 'source' && edge.toId === sourceId)));
}
function candidate(node: KnowledgeNodeRecord): boolean {
  return ['ha_device', 'ha_entity', 'ha_integration', 'ha_area', 'ha_room'].includes(node.kind);
}
function projectSource(store: KnowledgeStore, source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | undefined, admissions: { assertCurrent(): void }[]): unknown {
  assertKnowledgeExtractionInput(extraction ?? null);
  const original = snapshotNodeInput(source);
  const projected = { title: original.title, summary: original.summary, description: original.description,
    sourceType: original.sourceType, tags: original.tags, ...knowledgeSourceJudgmentUris(source),
    ...(extraction ? { extraction: { title: extraction.title, summary: extraction.summary, excerpt: extraction.excerpt,
      sections: extraction.sections, structure: extraction.structure, metadata: extraction.metadata } } : {}) };
  // Complete extractor containers and source fields, including protected tails,
  // are checked before the candidate list, transport cap or first model request.
  const proof = { source, extraction: extraction ?? null, proof: captureKnowledgeSourceReferences(store, source, extraction ?? null) };
  admissions.push(prepareKnowledgeRecordAdmission(store, 'source', source, proof));
  if (extraction) admissions.push(prepareKnowledgeRecordAdmission(store, 'extraction', extraction, proof));
  assertJudgmentInput(projected);
  return snapshotNodeInput(projected);
}
function currentContext(input: AutoLinkContext) {
  const original = { spaceId: input.spaceId, installationId: input.installationId, state: input.state,
    signal: input.signal, shouldStop: input.shouldStop };
  const state = input.state;
  const stateContent = JSON.stringify({ sources: state.sources, nodes: state.nodes, extractions: state.extractions, edges: state.edges });
  if (state.spaceId !== input.spaceId) throw new Held('stale');
  const sources = [...state.sources], nodes = [...state.nodes], extractions = [...state.extractions];
  let edges = [...state.edges];
  const content = JSON.stringify({ sources, nodes, extractions });
  const edgeVersion = (rows: readonly KnowledgeEdgeRecord[]) => JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  let edgeContent = edgeVersion(edges);
  const same = <T>(left: readonly T[], right: readonly T[]) => left.length === right.length && left.every((row, index) => row === right[index]);
  const assertCurrent = () => {
    if (original.signal?.aborted || original.shouldStop?.()) throw new Held('aborted');
    if (input.spaceId !== original.spaceId || input.installationId !== original.installationId
      || input.state !== original.state || input.signal !== original.signal || input.shouldStop !== original.shouldStop) throw new Held('stale');
    if (JSON.stringify({ sources: state.sources, nodes: state.nodes, extractions: state.extractions, edges: state.edges }) !== stateContent) throw new Held('stale');
    const now = readHomeGraphState(input.store, original.spaceId);
    // Reference identity detects equal-content ABA replacements; complete values
    // also detect in-place mutation, including identities never sent to a model.
    if (!same(now.sources, sources) || !same(now.nodes, nodes) || !same(now.extractions, extractions) || !(now.edges.length === edges.length && now.edges.every(edge => edges.includes(edge)))
      || JSON.stringify({ sources: now.sources, nodes: now.nodes, extractions: now.extractions }) !== content
      || edgeVersion(now.edges) !== edgeContent) throw new Held('stale');
  };
  assertCurrent();
  return { assertCurrent, acknowledge(edge: KnowledgeEdgeRecord) {
    edges = [...edges, edge]; edgeContent = edgeVersion(edges);
  } };
}

/** Preparation is read-only. Every source is screened before any selection starts. */
async function linkSources(input: AutoLinkSourcesInput): Promise<readonly HomeGraphAutoLinkResult[]> {
  const context = currentContext(input);
  const admissions: { assertCurrent(): void }[] = [];
  assertKnowledgeArrayExtras(input.sources);
  const sourceListSnapshot = captureOwnedJson(input.sources);
  const sourceList = [...input.sources];
  const assertCurrent = () => {
    context.assertCurrent();
    for (const admission of admissions) admission.assertCurrent();
    if (input.sources.length !== sourceList.length || input.sources.some((source, index) => source !== sourceList[index])
      || !sameKnowledgeRecord(input.sources, sourceListSnapshot)) throw new Held('stale');
  };
  const sourcePlans = sourceList.filter((source) => !skipped(source) && !hasActiveSourceLink(source.id, input.state.edges))
    .map((source) => {
      if (input.store.getSource(source.id) !== source || getKnowledgeSpaceId(source) !== input.spaceId
        || source.status === 'stale') throw new Held('stale');
      const extraction = input.extractionBySourceId.get(source.id);
      if ((input.store.getExtractionBySourceId(source.id) ?? undefined) !== extraction
        || (extraction && (extraction.sourceId !== source.id || getKnowledgeSpaceId(extraction) !== input.spaceId))) throw new Held('stale');
      return { source, extraction, projected: projectSource(input.store, source, extraction, admissions) };
    });
  const nodes = input.state.nodes.filter(candidate);
  // All candidates remain in the reading, including generic titles and close
  // siblings. Exact device/entity identities are evidence, never a bypass.
  const candidates = nodes.map((node, index) => {
    const entityIds = new Set(input.state.edges.filter((edge) => edgeIsActive(edge) && edge.fromKind === 'node'
      && edge.toKind === 'node' && edge.toId === node.id && edge.relation === 'belongs_to_device').map((edge) => edge.fromId));
    const entities = input.state.nodes.filter((entity) => entity.kind === 'ha_entity' && entityIds.has(entity.id));
    admissions.push(prepareKnowledgeRecordAdmission(input.store, 'node', node));
    for (const entity of entities) admissions.push(prepareKnowledgeRecordAdmission(input.store, 'node', entity));
    const projected = projectHomeGraphQualityInput(`device-${index + 1}`, node, entities, [], []);
    const identity = snapshotNodeInput(node.metadata);
    const subject = { ...projected.subject, modelId: identity.modelId, model_id: identity.model_id, vendor: identity.vendor };
    assertJudgmentInput(subject);
    return { reference: `candidate-${index + 1}`, subject, entities: projected.entities };
  });
  const plans = sourcePlans.map((plan) => ({ ...plan, reading: { source: plan.projected, candidates } satisfies AutoLinkReadingInput }));
  for (const plan of plans) assertJudgmentInput(plan.reading);
  if (!plans.length || !candidates.length) return [];
  if (plans.length > 128 || candidates.length > 128 || plans.length * (candidates.length + 1) > 512
    || plans.reduce((bytes, plan) => bytes + new TextEncoder().encode(JSON.stringify(plan.reading)).byteLength
      * (candidates.length + 1) + 4_096 * (candidates.length + 1), 0) > 16 * 1024 * 1024) throw new Held('budget');
  const reader = createHomeGraphAutoLinkReader();
  const check = () => { assertCurrent(); reader.assertCurrent();
    for (const plan of plans) if (input.extractionBySourceId.get(plan.source.id) !== plan.extraction) throw new Held('stale');
  };
  const selected: { source: KnowledgeSourceRecord; node: KnowledgeNodeRecord; relation: string }[] = [];
  for (const plan of plans) {
    const selection = await reader.read(plan.reading, { signal: input.signal, assertCurrent: check });
    check();
    if (selection) {
      const index = candidates.findIndex((candidate) => candidate.reference === selection.reference);
      if (index < 0) throw new Held('malformed');
      selected.push({ source: plan.source, node: nodes[index]!, relation: selection.relation });
    }
  }
  // A held later source can never leave earlier links behind. The commit guard
  // is checked inside upsertEdge after its init await, at the synchronous write.
  const linked: HomeGraphAutoLinkResult[] = [];
  for (const selection of selected) {
    check();
    const edge = await input.store.upsertEdge(guardKnowledgeEdgeInput({
      fromKind: 'source', fromId: selection.source.id, toKind: 'node', toId: selection.node.id,
      relation: selection.relation, weight: 1,
      metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, { linkStatus: 'active',
        linkMethod: 'homegraph-auto-link', autoLinkedAt: Date.now(), autoLinkReasons: ['settled-document-subject'] }),
    }, check));
    context.acknowledge(edge);
    linked.push({ edge, node: selection.node, relation: selection.relation, score: 0, reasons: ['settled-document-subject'] });
  }
  return linked;
}
export async function autoLinkHomeGraphSource(input: AutoLinkSourceInput): Promise<HomeGraphAutoLinkResult | undefined> {
  const original = { source: input.source, extraction: input.extraction, spaceId: input.spaceId, installationId: input.installationId,
    state: input.state, signal: input.signal, shouldStop: input.shouldStop };
  const check = () => { if (input.source !== original.source || input.extraction !== original.extraction
      || input.spaceId !== original.spaceId || input.installationId !== original.installationId || input.state !== original.state
      || input.signal !== original.signal || input.shouldStop !== original.shouldStop) throw new Held('stale');
    return original.shouldStop?.() ?? false; };
  return (await linkSources({ ...input, shouldStop: check, sources: [input.source],
    extractionBySourceId: new Map(input.extraction ? [[input.source.id, input.extraction]] : []) }))[0];
}
export function autoLinkHomeGraphSources(input: AutoLinkSourcesInput): Promise<readonly HomeGraphAutoLinkResult[]> {
  return linkSources(input);
}
