import { toJson, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { snapshotNodeInput } from '../../activation/projection.js';
import type { KnowledgeObjectProfilePolicy } from '../../extensions.js';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from '../../home-graph/extension.js';
import { isActiveKnowledgeEdge } from '../../projection-utils.js';
import { getExplicitKnowledgeSpaceId, getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace } from '../../spaces.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord } from '../../types.js';
import type { EvidenceItem } from '../answer-common.js';
import { createSemanticWriteGuard } from '../primary-source-plan.js';
import { freezeSupport } from '../verification/projection.js';
import type { KnowledgeSemanticAnswerInput } from '../types.js';
import { readRecord, readString, readStringArray, uniqueStrings } from '../utils.js';
import { readAnswerObjectAlignment, snapshotAnswerObjectInput } from './reader.js';
import { KnowledgeAnswerObjectAlignmentHeldError as Held, type AnswerObjectCandidate } from './types.js';

// Exact schemas, not guesses based on kind substrings or a product-name shape.
const CORE_OBJECT_KINDS = new Set(['knowledge_entity', 'device', 'product', 'appliance', 'controller', 'service', 'provider', 'platform', 'tool', 'capability']);
const NON_OBJECT_KINDS = new Set(['fact', 'wiki_page', 'knowledge_gap', 'ha_device_passport']);
const CONTENT_KEYS = ['entityKind', 'value', 'evidence', 'labels', 'subject', 'markdown', 'text', 'searchText',
  'manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'domain', 'platform',
  'batteryPowered', 'batteryType', 'manualRequired', 'serial', 'firmware', 'installDate', 'purchaseDate', 'warrantyExpiration',
  'documentation', 'documentationUrl', 'documentation_url', 'sourceUrl', 'source_url', 'deviceClass', 'device_class',
  'entryType', 'entry_type', 'attributes', 'homeAssistant'];
function belongs(value: { readonly metadata?: Record<string, unknown> }, spaceId: string): boolean {
  const actual = getExplicitKnowledgeSpaceId(value);
  return typeof actual === 'string' && (actual === spaceId || (spaceId === 'homeassistant' && isHomeAssistantKnowledgeSpace(actual)));
}
function eligible(node: KnowledgeNodeRecord, kinds: ReadonlySet<string>): boolean {
  return node.status === 'active' && kinds.has(node.kind) && !NON_OBJECT_KINDS.has(node.kind)
    && !node.metadata.semanticKind && node.metadata.generatedKnowledgePage !== true && node.metadata.generatedProjection !== true;
}
function identity(node: KnowledgeNodeRecord) {
  return { kind: node.kind, title: node.title, summary: node.summary, aliases: node.aliases,
    ...Object.fromEntries(['manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'entityKind', 'subject', 'homeAssistant']
      .filter((key) => node.metadata[key] !== undefined).map((key) => [key, node.metadata[key]])) };
}
function content(node: KnowledgeNodeRecord, nodes: readonly KnowledgeNodeRecord[], references: ReadonlyMap<string, string>): Readonly<Record<string, JsonValue>> {
  const selected: Record<string, unknown> = Object.fromEntries(CONTENT_KEYS.filter((key) => node.metadata[key] !== undefined).map((key) => [key, node.metadata[key]]));
  for (const key of ['subject', 'targetHints'] as const) if (node[key] !== undefined) selected[`record${key}`] = node[key];
  const projectHint = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const hint = readRecord(value), id = readString(hint.id);
    const target = nodes.find((other) => other.id === id && other.status === 'active' && getKnowledgeSpaceId(other) === getKnowledgeSpaceId(node));
    // Only an actual local row proves this particular reference is bookkeeping.
    // Unknown caller IDs and semantic external identity fields retain preflight.
    if (!target) return hint;
    const { id: _id, ...meaning } = hint;
    return { ...meaning, reference: references.get(target.id), target: identity(target) };
  };
  for (const [key, value] of [['targetHints', node.metadata.targetHints], ['recordtargetHints', node.targetHints]] as const) {
    if (value !== undefined) selected[key] = Array.isArray(value) ? value.map(projectHint) : value;
  }
  const ids = uniqueStrings([readString(node.metadata.subjectId), ...readStringArray(node.metadata.subjectIds),
    ...readStringArray(node.metadata.linkedObjectIds), ...(node.subjectIds ?? []), ...(node.linkedObjectIds ?? [])]);
  if (ids.length) selected.subjects = ids.map((id) => {
    const target = nodes.find((other) => other.id === id && other.status === 'active' && getKnowledgeSpaceId(other) === getKnowledgeSpaceId(node));
    return target ? { reference: references.get(id), ...identity(target) } : { externalReference: id };
  });
  // Scan structured values before toJson can omit, stringify or truncate them.
  assertJudgmentInput(selected);
  const projected = toJson(selected);
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) throw new Held('malformed');
  return projected;
}

export interface AnswerObjectProvenance {
  readonly nodeId: string;
  readonly callerContext: boolean;
  readonly evidence: readonly { readonly kind: 'source' | 'node'; readonly id: string }[];
  readonly factIds: readonly string[];
  readonly edges: readonly KnowledgeEdgeRecord[];
}
/** Prepare before ANY answer request, then read once with the selected evidence/fact context.
 * linkedObjects are context candidates (HomeGraph's search-derived collection),
 * never explicit selected targets or an operator-authorization channel.
 */
export function prepareAnswerLinkedObjects(store: KnowledgeStore, spaceId: string, input: KnowledgeSemanticAnswerInput,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[], signal?: AbortSignal) {
  const guard = createSemanticWriteGuard(store, signal);
  const assertCurrent = () => {
    try { guard.assertCurrent(); } catch { throw new Held(signal?.aborted ? 'aborted' : 'stale'); }
  };
  assertCurrent();
  guard.watch('answer-object-question', () => input.query);
  const profileSnapshot = snapshotNodeInput(objectProfiles);
  guard.watch('object-profile-declarations', () => objectProfiles, profileSnapshot);
  const supplied = snapshotNodeInput(input.linkedObjects ?? []);
  guard.watch('caller-object-context', () => input.linkedObjects ?? [], supplied);
  // The standalone semantic service has always supported the built-in HA
  // namespace without constructing a HomeGraphService. Use its exact extension
  // declaration here, never its object-scope or repair-subject preferences.
  const builtins = () => spaceId === 'homeassistant' || isHomeAssistantKnowledgeSpace(spaceId)
    ? HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles ?? [] : [];
  const builtinSnapshot = snapshotNodeInput(builtins());
  guard.watch('builtin-object-profile-declarations', builtins, builtinSnapshot);
  const kinds = new Set([...CORE_OBJECT_KINDS, ...[...profileSnapshot, ...builtinSnapshot].flatMap((profile) => profile.subjectKinds)]);
  // Capture excluded/absent rows as well: activation, operator review or a new
  // equally plausible object after the read invalidates the prepared universe.
  const currentNodes = store.listNodes(Number.MAX_SAFE_INTEGER).filter((node) => belongs(node, spaceId));
  const nodes = currentNodes.map((node) => snapshotNodeInput(node));
  guard.watch('answer-object-universe', () => store.listNodes(Number.MAX_SAFE_INTEGER).filter((node) => belongs(node, spaceId)), nodes);
  const sources = store.listSources(Number.MAX_SAFE_INTEGER).filter((source) => belongs(source, spaceId)).map((source) => snapshotNodeInput(source));
  guard.watch('answer-object-sources', () => store.listSources(Number.MAX_SAFE_INTEGER).filter((source) => belongs(source, spaceId)), sources);
  const nodeIds = new Set(nodes.map((node) => node.id)), sourceIds = new Set(sources.map((source) => source.id));
  const pertinent = (edge: KnowledgeEdgeRecord) => (edge.fromKind === 'node' && nodeIds.has(edge.fromId))
    || (edge.toKind === 'node' && nodeIds.has(edge.toId)) || (edge.fromKind === 'source' && sourceIds.has(edge.fromId))
    || (edge.toKind === 'source' && sourceIds.has(edge.toId));
  const edges = store.listEdges().filter(pertinent).map((edge) => snapshotNodeInput(edge));
  guard.watch('answer-object-graph', () => store.listEdges().filter(pertinent), edges);
  for (const suppliedNode of supplied) {
    if (!belongs(suppliedNode, spaceId) || !eligible(suppliedNode, kinds)) continue;
    const current = nodes.find((node) => node.id === suppliedNode.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(suppliedNode)) throw new Held('stale');
  }
  const candidates = nodes.filter((node) => eligible(node, kinds));
  const references = new Map(nodes.map((node, index) => [node.id, `context-${index + 1}`]));
  candidates.forEach((node, index) => references.set(node.id, `object-${index + 1}`));
  const sourceReferences = new Map(sources.map((source, index) => [source.id, `context-${nodes.length + index + 1}`]));
  const byReference = new Map(candidates.map((node) => [references.get(node.id)!, currentNodes.find((current) => current.id === node.id)!]));
  const callerIds = new Set(supplied.filter((node) => belongs(node, spaceId) && eligible(node, kinds)).map((node) => node.id));
  const candidateEdges = (node: KnowledgeNodeRecord) => edges.filter((edge) => {
    if (!isActiveKnowledgeEdge(edge) || getKnowledgeSpaceId(edge) !== getKnowledgeSpaceId(node)) return false;
    const other = edge.fromKind === 'node' && edge.fromId === node.id ? { kind: edge.toKind, id: edge.toId }
      : edge.toKind === 'node' && edge.toId === node.id ? { kind: edge.fromKind, id: edge.fromId } : undefined;
    const target = other?.kind === 'node' ? nodes.find((row) => row.id === other.id)
      : other?.kind === 'source' ? sources.find((row) => row.id === other.id) : undefined;
    return Boolean(target && getKnowledgeSpaceId(target) === getKnowledgeSpaceId(node));
  });
  const projected: AnswerObjectCandidate[] = candidates.map((node) => ({ reference: references.get(node.id)!, kind: node.kind,
    title: node.title, summary: node.summary, aliases: node.aliases, content: content(node, nodes, references), associations: [
      ...(callerIds.has(node.id) ? [{ origin: 'caller-context' as const }] : []),
      ...candidateEdges(node).map((edge) => {
        const from = edge.fromKind === 'node' && edge.fromId === node.id;
        const kind = from ? edge.toKind : edge.fromKind, id = from ? edge.toId : edge.fromId;
        return { origin: 'graph' as const, reference: (kind === 'node' ? references : sourceReferences).get(id), relation: edge.relation };
      }),
    ] }));
  const snapshot = snapshotAnswerObjectInput({ query: input.query, candidates: projected });
  assertCurrent();
  let result: Promise<{ readonly linkedObjects: readonly KnowledgeNodeRecord[]; readonly provenance: readonly AnswerObjectProvenance[] }> | undefined;
  return {
    assertCurrent,
    read(evidence: readonly EvidenceItem[], facts: readonly KnowledgeNodeRecord[]) {
      assertCurrent();
      if (result) return result;
      for (const row of [...facts, ...evidence.flatMap((item) => item.node ? [item.node] : [])]) {
        if (!belongs(row, spaceId)) continue;
        guard.watch(`alignment-context-node:${row.id}`, () => store.getNode(row.id), snapshotNodeInput(row));
      }
      for (const source of evidence.flatMap((item) => item.source ? [item.source] : [])) {
        if (!belongs(source, spaceId)) continue;
        guard.watch(`alignment-context-source:${source.id}`, () => store.getSource(source.id), snapshotNodeInput(source));
      }
      const factIdsFor = (node: KnowledgeNodeRecord) => facts.filter((fact) => getKnowledgeSpaceId(fact) === getKnowledgeSpaceId(node)
        && ([...(fact.subjectIds ?? []), ...(fact.linkedObjectIds ?? []),
          ...readStringArray(fact.metadata.subjectIds), ...readStringArray(fact.metadata.linkedObjectIds)].includes(node.id)
          || candidateEdges(node).some((edge) => edge.fromKind === 'node' && edge.fromId === fact.id && edge.relation === 'describes'))).map((fact) => fact.id);
      const evidenceFor = (node: KnowledgeNodeRecord) => evidence.filter((item) => getKnowledgeSpaceId(item.node ?? item.source) === getKnowledgeSpaceId(node)
        && (item.node?.id === node.id
          || (item.source && readStringArray(readRecord(item.source.metadata.sourceDiscovery).linkedObjectIds).includes(node.id))
          || candidateEdges(node).some((edge) => (edge.fromKind === item.kind && edge.fromId === item.id)
            || (edge.toKind === item.kind && edge.toId === item.id)))).map((item) => ({ kind: item.kind, id: item.id }));
      const provenance = new Map(candidates.map((node) => [node.id, freezeSupport({ nodeId: node.id, callerContext: callerIds.has(node.id),
        evidence: evidenceFor(node), factIds: factIdsFor(node), edges: candidateEdges(node) })]));
      const enriched = snapshot.candidates.map((candidate) => {
        const record = byReference.get(candidate.reference)!, associations = provenance.get(record.id)!;
        return { ...candidate, associations: [...candidate.associations,
          ...associations.evidence.map(({ kind, id }) => ({ origin: 'evidence' as const, reference: (kind === 'node' ? references : sourceReferences).get(id) })),
          ...associations.factIds.map((id) => ({ origin: 'fact' as const, reference: references.get(id) })),
        ] };
      });
      result = readAnswerObjectAlignment({ query: snapshot.query, candidates: enriched }, { signal, assertCurrent }).then((plan) => {
        assertCurrent();
        const linkedObjects = plan.accepted.map((reading) => byReference.get(reading.reference)!);
        return { linkedObjects, provenance: linkedObjects.map((node) => provenance.get(node.id)!) };
      });
      return result;
    },
  };
}
export type PreparedAnswerLinkedObjects = ReturnType<typeof prepareAnswerLinkedObjects>;
