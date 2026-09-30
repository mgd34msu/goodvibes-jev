import { captureKnowledgeSourceReferences } from './source-structural-references.js';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { nodeServingWithoutReview } from './activation/battery.js';
import { snapshotNodeInput, activationMeaning, activationSubjectIds, type ActivationSubject, activationContent, activationEvidenceHash, activationSourceIds, projectNodeActivation, type ActivationEvidence } from './activation/projection.js';
import { readNodeActivations } from './activation/reader.js';
import { KnowledgeNodeActivationHeldError as Held, NODE_ACTIVATION_LIMITS as LIMITS, type KnowledgeNodeActivationOptions } from './activation/types.js';
import { supportHash } from './semantic/verification/projection.js';
import { getKnowledgeNodeObservation, prepareKnowledgeNodeObservation, type ObservedEvidence, type resolveKnowledgeNodeObservation } from './store-node-observation.js';
import { retainKnowledgeNodeRecord } from './store-node-authority.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeNodeRecord, KnowledgeNodeUpsertInput } from './types.js';

export interface KnowledgePreparedNodeWrites { readonly count: number; }
export interface NodeMutationDraft {
  readonly input: KnowledgeNodeUpsertInput;
  readonly existing: KnowledgeNodeRecord | undefined;
  readonly record: KnowledgeNodeRecord;
  readonly now: number;
  readonly authority: boolean;
  readonly restoration?: (() => void) | undefined;
  readonly observation?: ReturnType<typeof resolveKnowledgeNodeObservation>;
}
interface PreparedNode extends NodeMutationDraft { readonly observationEvidence?: ObservedEvidence | undefined; readonly evidence: readonly ActivationEvidence[]; readonly evidenceHash: string; readonly subjects: readonly ActivationSubject[]; readonly observed: ReturnType<typeof getKnowledgeNodeObservation>; }
interface PreparedPass { readonly store: KnowledgeStore; readonly scope: object; readonly nodes: readonly PreparedNode[]; readonly written: Set<number>; readonly committed: Map<string, KnowledgeNodeRecord>; readonly port: JudgmentPort | undefined; readonly model: string | undefined; readonly signal?: AbortSignal | undefined; readonly expires: number; }
const retainedWrites = new WeakMap<KnowledgeNodeRecord, { readonly store: KnowledgeStore; readonly scope: object; readonly check: () => void }>();
/** Only an exact locally committed object can authorize compensation, never a serialized receipt. */
export function knowledgeNodeRestorationGuard(store: KnowledgeStore, record: KnowledgeNodeRecord, scope: object): (() => void) | undefined {
  const saved = retainedWrites.get(record);
  return saved?.scope === scope ? saved.check : undefined;
}
const prepared = new WeakMap<KnowledgePreparedNodeWrites, PreparedPass>();
function currentPort(): JudgmentPort | undefined { try { return judgmentPort(nodeServingWithoutReview.name); } catch { return undefined; } }
function evidenceFor(store: KnowledgeStore, record: KnowledgeNodeRecord): ActivationEvidence[] {
  return activationSourceIds(record).map((id) => ({ id, source: store.getSource(id), extraction: store.getExtractionBySourceId(id) }));
}
function unchanged(draft: NodeMutationDraft): boolean {
  return Boolean(draft.existing && supportHash(activationContent(draft.record)) === supportHash(activationContent(draft.existing)));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export async function prepareNodeActivationPass(store: KnowledgeStore, drafts: readonly NodeMutationDraft[], options: KnowledgeNodeActivationOptions, ownerConfidenceFloor: number | undefined, scope: object): Promise<KnowledgePreparedNodeWrites> {
  if (drafts.length > LIMITS.nodes) throw new Held('budget');
  const identities = new Map<string, string>();
  for (const { record } of drafts) {
    const key = JSON.stringify([record.kind, record.slug]);
    const previous = identities.get(key);
    if (previous && previous !== record.id) throw new Held('stale');
    identities.set(key, record.id);
  }
  const proposed = new Map(drafts.map((draft) => [draft.record.id, draft.record]));
  let localBytes = 0;
  const nodes = drafts.map((draft) => {
    const actualEvidence = draft.authority || draft.observation || draft.restoration ? [] : evidenceFor(store, draft.record);
    const references = actualEvidence.map(({ source, extraction }) => captureKnowledgeSourceReferences(store, source, extraction));
    const evidence = snapshotNodeInput(actualEvidence);
    const observed = draft.authority || draft.observation || draft.restoration ? undefined : getKnowledgeNodeObservation(draft.existing, draft.record);
    observed?.assertCurrent();
    const subjects = draft.authority || draft.observation || draft.restoration ? [] : snapshotNodeInput(activationSubjectIds(draft.record).map((id) => ({ id, node: store.getNode(id) })));
    localBytes += new TextEncoder().encode(JSON.stringify({ input: draft.input, evidence, subjects })).byteLength;
    if (localBytes > LIMITS.bytes * 4) throw new Held('budget');
    return { ...draft, references, evidence, evidenceHash: supportHash({ evidence, subjects: subjects.map(({ id, node }) => ({ id,
      content: proposed.has(id) ? activationContent(proposed.get(id)!) : node ? activationContent(node) : null })), observed: observed?.record }), subjects, observed };
  });
  const requests: ReturnType<typeof projectNodeActivation>[] = [];
  const requestIndices = new Map<number, number>();
  const direct = nodes.map((draft, index): KnowledgeNodeRecord | undefined => {
    const { input, existing, record, observation } = draft;
    if (draft.restoration) { draft.restoration(); return record; }
    if (draft.authority) return record;
    if (observation && existing && (input.status ?? 'active') === existing.status && unchanged(draft)) return existing;
    if (observation) return retainKnowledgeNodeRecord({ ...record, status: input.status ?? 'active', metadata: { ...record.metadata, nodeActivation: undefined,
      nodeObservation: { version: 1, origin: observation.origin },
      reviewProvenance: { state: 'explicit', reason: `Observed ${observation.origin} projection; untrusted origin retained; no synthesized claim or operator review`, decidedAt: draft.now } } });
    if (input.status === 'stale' || input.status === 'draft' || (existing?.status === 'stale' && input.status !== 'active')) {
      if (existing?.status === 'active' && supportHash(activationMeaning(existing)) !== supportHash(activationMeaning(record))) {
        throw new Held('replacement-requires-review');
      }
      if (existing?.status === record.status && unchanged(draft) && record.metadata.reviewProvenance !== undefined) return existing;
      return retainKnowledgeNodeRecord({ ...record, status: input.status ?? 'stale', metadata: { ...record.metadata, nodeActivation: undefined,
        reviewProvenance: { state: input.status === 'draft' ? 'pending-review' : 'explicit', reason: `Explicit non-serving status '${input.status ?? 'stale'}'`, decidedAt: draft.now } } });
    }
    const receipt = existing?.metadata.nodeActivation;
    if (existing?.status === 'active' && unchanged(draft)
      && (!isRecord(receipt) || receipt.evidenceHash === draft.evidenceHash)) return existing;
    // Both projection and complete protected-input preflight run for every selected
    // synthesized candidate before the reader can send the first request.
    const projection = projectNodeActivation(record, draft.evidence, draft.subjects.map((subject) => ({ ...subject,
      node: proposed.get(subject.id) ?? subject.node })), draft.observed, draft.references);
    requestIndices.set(index, requests.length); requests.push(projection);
    return undefined;
  });
  const port = currentPort(), model = port?.model;
  const readings = await readNodeActivations(requests, options);
  const resolved = nodes.map((draft, index): PreparedNode => {
    if (direct[index]) {
      const record = direct[index]!;
      return { ...draft, record, observationEvidence: draft.observation ? prepareKnowledgeNodeObservation(record, draft.observation) : undefined };
    }
    const measured = readings[requestIndices.get(index)!]!;
    const reading = measured.outcome === 'accepted' && ownerConfidenceFloor !== undefined && draft.record.confidence < ownerConfidenceFloor
      ? { ...measured, outcome: 'pending-review' as const, reason: 'owner-confidence-floor' as const } : measured;
    if (reading.outcome !== 'accepted' && (draft.existing?.status === 'active' || options.requireAccepted)) throw new Held(reading.reason === 'missing-evidence' && draft.existing?.metadata.nodeObservation !== undefined ? 'observation-revalidation' : reading.reason ?? 'uncertain');
    const accepted = reading.outcome === 'accepted';
    const record = retainKnowledgeNodeRecord({ ...draft.record, status: accepted ? 'active' : 'draft', metadata: { ...draft.record.metadata,
      reviewProvenance: { state: accepted ? 'auto-accepted' : 'pending-review',
        reason: accepted ? 'Settled serving-without-review judgment; untrusted origin retained; not an operator review'
          : `Pending review: serving judgment ${reading.reason ?? 'uncertain'}`, decidedAt: draft.now },
      nodeActivation: { battery: nodeServingWithoutReview.name, version: nodeServingWithoutReview.version, ...reading,
        ownerConfidenceFloor, candidateHash: supportHash(activationContent(draft.record)), evidenceHash: draft.evidenceHash,
        evidence: draft.evidence.map(({ id, source, extraction }) => ({ sourceId: id, sourceHash: supportHash(source),
          extractionId: extraction?.id, extractionHash: supportHash(extraction) })),
        subjects: draft.subjects.map(({ id, node }) => ({ nodeId: id, nodeHash: supportHash(node) })) },
    } });
    return { ...draft, record };
  });
  const token = Object.freeze({ count: resolved.length });
  prepared.set(token, { store, scope, nodes: resolved, written: new Set(), committed: new Map(), port, model, signal: options.signal, expires: Date.now() + 30_000 });
  assertPreparedNodeWrites(store, token, scope);
  return token;
}
/** Synchronous revalidation at the actual commit boundary; copied JSON has no authority. */
export function assertPreparedNodeWrites(store: KnowledgeStore, token: KnowledgePreparedNodeWrites, scope: object): void {
  const pass = prepared.get(token);
  if (!pass || pass.scope !== scope) throw new Held('malformed');
  if (pass.signal?.aborted) throw new Held('aborted');
  if (Date.now() > pass.expires) throw new Held('stale');
  if (currentPort() !== pass.port || pass.port?.model !== pass.model) throw new Held('stale');
  for (const [index, draft] of pass.nodes.entries()) {
    const sameSlug = store.getNodeByKindAndSlug(draft.record.kind, draft.record.slug);
    if (sameSlug && sameSlug.id !== draft.record.id) throw new Held('stale');
    const current = draft.input.id ? store.getNode(draft.input.id) : store.getNodeByKindAndSlug(draft.input.kind, draft.input.slug);
    if (supportHash(current ?? null) !== supportHash(pass.committed.get(draft.record.id) ?? draft.existing ?? null)
      || (!draft.authority && !draft.observation && !draft.restoration && activationEvidenceHash(evidenceFor(store, draft.record)) !== activationEvidenceHash(draft.evidence))) throw new Held('stale');
    for (const subject of draft.subjects) {
      if (supportHash(store.getNode(subject.id)) !== supportHash(pass.committed.get(subject.id) ?? subject.node)) throw new Held('stale');
    }
    draft.restoration?.();
    draft.observed?.assertCurrent();
    if (!pass.written.has(index)) draft.observation?.assertCurrent();
  }
}
export function preparedNodeWrite(store: KnowledgeStore, token: KnowledgePreparedNodeWrites, index: number, scope: object): PreparedNode {
  assertPreparedNodeWrites(store, token, scope);
  const pass = prepared.get(token)!;
  if (!Number.isInteger(index) || !pass.nodes[index] || pass.written.has(index)) throw new Held('stale');
  const draft = pass.nodes[index]!;
  return { ...draft, existing: pass.committed.get(draft.record.id) ?? draft.existing };
}
export function markPreparedNodeWritten(token: KnowledgePreparedNodeWrites, index: number): void {
  const pass = prepared.get(token)!, draft = pass.nodes[index]!;
  pass.written.add(index); pass.committed.set(draft.record.id, draft.record);
  // Optional compensation evidence must never introduce a failure after SQL/cache commit.
  try {
    const sources = snapshotNodeInput(evidenceFor(pass.store, draft.record));
    const subjects = snapshotNodeInput(activationSubjectIds(draft.record).map((id) => ({ id, node: pass.store.getNode(id) })));
    retainedWrites.set(draft.record, { store: pass.store, scope: pass.scope, check: () => {
      if (activationEvidenceHash(evidenceFor(pass.store, draft.record)) !== activationEvidenceHash(sources)
        || subjects.some(({ id, node }) => supportHash(pass.store.getNode(id)) !== supportHash(node))) throw new Held('stale');
      draft.observation?.checkEvidence();
    } });
  } catch { /* This record cannot be used as a prepared compensation capability. */ }
}
