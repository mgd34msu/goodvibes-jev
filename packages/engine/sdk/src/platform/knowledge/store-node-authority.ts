import { knowledgeNodeMetadataView, carryKnowledgeRecordClocks, knowledgeRawRepresentation, normalizeKnowledgeStoredView, retainKnowledgeRepresentation, knowledgeDecisionStamp, knowledgeReviewStamp, prepareKnowledgeOwnedClocks } from './store-record-representation.js';
import { randomUUID } from 'node:crypto';
import type { KnowledgeNodeRecord } from './types.js';

/** An in-process capability, never inferred from producer metadata or a name. */
export interface KnowledgeNodeMutationContext {
  readonly authority: 'operator';
  readonly action: 'accept' | 'reject' | 'revise';
  readonly reviewer: string;
  readonly expectedNodeSnapshot: string;
  readonly facts?: Readonly<Record<string, unknown>> | undefined;
  readonly fieldCorrections?: readonly KnowledgeNodeFieldCorrection[] | undefined;
  /** An existing explicit side effect, not a review of confidence or the whole node. */
  readonly confidence?: number | undefined;
}

export interface KnowledgeNodeFieldCorrection {
  readonly path: readonly string[];
  readonly value: unknown;
}

const operatorMutations = new WeakSet<KnowledgeNodeMutationContext>();
const reviewFields = new Set(['review', 'reviewProvenance', 'reviewedFacts', 'operatorReview', 'nodeActivation', 'nodeObservation']);

export class KnowledgeNodeMutationHeldError extends Error {
  override readonly name = 'KnowledgeNodeMutationHeldError';
  constructor(readonly reason: 'operator-reviewed' | 'stale' | 'invalid-context', readonly nodeId: string) {
    super(reason === 'operator-reviewed'
      ? `Knowledge node ${nodeId} has an operator review; conflicting producer content was not written.`
      : reason === 'stale'
        ? `Knowledge node ${nodeId} changed before its operator mutation; refresh it before reviewing.`
        : `Knowledge node ${nodeId} requires an explicit in-process operator mutation context.`);
  }
}

/** Capture BEFORE an awaited operation. A serialized/caller-supplied lookalike is not a capability. */
export function createKnowledgeNodeOperatorMutation(
  node: KnowledgeNodeRecord,
  input: {
    readonly action: KnowledgeNodeMutationContext['action'];
    readonly reviewer?: string | undefined;
    readonly facts?: Record<string, unknown> | undefined;
    readonly fieldCorrections?: readonly KnowledgeNodeFieldCorrection[] | undefined;
    readonly confidence?: number | undefined;
  },
): KnowledgeNodeMutationContext {
  const facts = input.facts ? JSON.parse(JSON.stringify(input.facts)) as Record<string, unknown> : undefined;
  deepFreeze(facts);
  const fieldCorrections = input.fieldCorrections
    ? JSON.parse(JSON.stringify(input.fieldCorrections)) as KnowledgeNodeFieldCorrection[] : undefined;
  if (fieldCorrections && (input.action !== 'revise'
    || fieldCorrections.some(({ path }) => !validCorrectionPath(path)))) {
    throw new KnowledgeNodeMutationHeldError('invalid-context', node.id);
  }
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100)) {
    throw new KnowledgeNodeMutationHeldError('invalid-context', node.id);
  }
  deepFreeze(fieldCorrections);
  const context: KnowledgeNodeMutationContext = Object.freeze({
    authority: 'operator',
    action: input.action,
    reviewer: input.reviewer?.trim() || 'knowledge-review',
    expectedNodeSnapshot: stableJson(node),
    ...(facts ? { facts } : {}),
    ...(fieldCorrections ? { fieldCorrections } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  });
  operatorMutations.add(context);
  return context;
}

/** Only the current stored record may supply review fields to an ordinary write. */
export function mergeKnowledgeNodeMetadata(
  existing: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...knowledgeRawRepresentation(existing), ...withoutReviewFields(knowledgeRawRepresentation(input ?? {})) };
}

/** Legacy persisted review stamps remain protected; this never examines producer metadata. */
export function hasKnowledgeNodeOperatorReview(node: KnowledgeNodeRecord): boolean {
  const fields = readReviewedFields(node);
  if (fields) return fields.length > 0;
  const provenance = readRecord(node.metadata.reviewProvenance);
  const review = readRecord(node.metadata.review);
  return provenance.state === 'reviewed'
    || (typeof review.action === 'string'
      && ['accept', 'reject', 'edit', 'revise', 'forget', 'resolve', 'reopen'].includes(review.action)
      && typeof review.reviewer === 'string' && review.reviewer.trim().length > 0);
}

/** Decide only authority. Automatic activation policy remains at the existing gate. */
export function resolveKnowledgeNodeOperatorMutation(
  candidate: KnowledgeNodeRecord,
  existing: KnowledgeNodeRecord | undefined,
  mutation: KnowledgeNodeMutationContext | undefined,
  now: number,
): { status: KnowledgeNodeRecord['status']; metadata: Record<string, unknown> } | undefined {
  // Merges carry canonical originals until the record is retained. Authority
  // comparisons must see the same numeric compatibility view as stored nodes.
  candidate = { ...candidate, metadata: knowledgeNodeMetadataView(knowledgeRawRepresentation(candidate.metadata)) };
  if (mutation !== undefined) {
    if (!operatorMutations.has(mutation) || mutation.authority !== 'operator'
      || !['accept', 'reject', 'revise'].includes(mutation.action)) {
      throw new KnowledgeNodeMutationHeldError('invalid-context', candidate.id);
    }
    if (!existing || candidate.id !== existing.id || stableJson(existing) !== mutation.expectedNodeSnapshot) {
      throw new KnowledgeNodeMutationHeldError('stale', candidate.id);
    }
    if (mutation.fieldCorrections && reviewedContentSnapshot(candidate) !== reviewedContentSnapshot({ ...applyFieldCorrections(existing, mutation.fieldCorrections), confidence: mutation.confidence ?? existing.confidence })) {
      throw new KnowledgeNodeMutationHeldError('invalid-context', candidate.id);
    }
    if (mutation.confidence !== undefined && candidate.confidence !== mutation.confidence) {
      throw new KnowledgeNodeMutationHeldError('invalid-context', candidate.id);
    }
    const priorFields = readReviewedFields(existing);
    const fullReview = hasKnowledgeNodeOperatorReview(existing) && !priorFields;
    const fields = mutation.fieldCorrections && !fullReview
      ? mergeReviewedFields(priorFields, mutation.fieldCorrections) : undefined;
    if (fields?.some(({ path, value }) => stableJson({ value: readPath(candidate, path) }) !== stableJson({ value }))) {
      throw new KnowledgeNodeMutationHeldError('invalid-context', candidate.id);
    }
    const status = mutation.action === 'accept' ? 'active' : mutation.action === 'reject' ? 'stale' : existing.status;
    // Revision is an explicit review of the NEW content. Never carry old facts or
    // an old acceptance stamp onto the replacement, even from the trusted input.
    const metadata = withoutReviewFields(knowledgeRawRepresentation(candidate.metadata));
    if (existing.metadata.nodeObservation !== undefined) metadata.nodeObservation = existing.metadata.nodeObservation;
    const unreviewed = fields?.length === 0;
    return {
      status,
      metadata: {
        ...metadata,
        ...(mutation.facts ? { reviewedFacts: mutation.facts } : {}),
        review: knowledgeReviewStamp(now, { id: randomUUID(), action: mutation.action, reviewer: mutation.reviewer, authority: 'operator',
          ...(fields ? { scope: 'fields', fields } : { scope: 'node' }),
        }),
        reviewProvenance: knowledgeDecisionStamp(now, {
          state: unreviewed ? (status === 'draft' ? 'pending-review' : 'explicit') : 'reviewed',
          reviewer: mutation.reviewer,
          ...(fields ? { scope: 'fields', fields: fields.map(({ path }) => path) } : { scope: 'node' }),
          reason: unreviewed ? `operator issue update by ${mutation.reviewer}; status '${status}' retained; no node fields reviewed` : fields
            ? `reviewed fields: ${fields.map(({ path }) => path.join('.')).join(', ')} by ${mutation.reviewer}`
            : `reviewed: operator ${mutation.action} by ${mutation.reviewer}; status '${status}'`,
        }),
      },
    };
  }
  if (!existing || !hasKnowledgeNodeOperatorReview(existing)) return undefined;
  const fields = readReviewedFields(existing);
  if (fields) {
    if (fieldReviewIdentity(candidate) !== fieldReviewIdentity(existing)
      || fields.some(({ path, value }) => stableJson({ value: readPath(candidate, path) }) !== stableJson({ value }))) {
      throw new KnowledgeNodeMutationHeldError('operator-reviewed', existing.id);
    }
    // This receipt reviews ONLY the named fields, never the status or other content.
    // The ordinary activation gate remains responsible for automatic status.
    return undefined;
  }
  if (reviewedContentSnapshot(candidate) !== reviewedContentSnapshot(existing)) {
    throw new KnowledgeNodeMutationHeldError('operator-reviewed', existing.id);
  }
  // Idempotent producer writes cannot refresh, erase or replace the review.
  return { status: existing.status, metadata: existing.metadata };
}

/** Protect cache state from aliases to input metadata and mutable getNode results. */
export function retainKnowledgeNodeRecord(record: KnowledgeNodeRecord, clockOrigin?: KnowledgeNodeRecord): KnowledgeNodeRecord {
  if (clockOrigin) carryKnowledgeRecordClocks(clockOrigin, record);
  const raw = normalizeKnowledgeStoredView(knowledgeRawRepresentation(record));
  const detached = retainKnowledgeRepresentation({ ...normalizeKnowledgeStoredView(record),
    metadata: knowledgeNodeMetadataView(raw.metadata) }, raw);
  deepFreeze(detached);
  return detached;
}

/** Low-level compensation is not permission to overwrite a concurrent operator decision. */
export function prepareKnowledgeNodeReplacement(
  record: KnowledgeNodeRecord,
  existing: KnowledgeNodeRecord | undefined,
  mutation: KnowledgeNodeMutationContext | undefined,
  now: number,
  trustedRestoration = false,
): KnowledgeNodeRecord {
  const metadata = withoutReviewFields(knowledgeRawRepresentation(record.metadata));
  if (trustedRestoration) {
    for (const key of ['nodeActivation', 'nodeObservation']) if (record.metadata[key] !== undefined) metadata[key] = record.metadata[key];
  }
  for (const key of reviewFields) {
    if (trustedRestoration && ['nodeActivation', 'nodeObservation'].includes(key)) continue;
    if (existing?.metadata[key] !== undefined) metadata[key] = existing.metadata[key];
  }
  // Preserve a genuine old automatic stamp during compensation. It conveys no
  // operator authority. An incoming reviewed stamp must pass the trusted seam.
  const provenance = readRecord(record.metadata.reviewProvenance);
  if (!hasKnowledgeNodeOperatorReview(record) && typeof provenance.state === 'string') {
    metadata.reviewProvenance = record.metadata.reviewProvenance;
    if (record.status !== 'active') {
      delete metadata.nodeActivation;
      if (record.metadata.nodeActivation !== undefined) metadata.nodeActivation = record.metadata.nodeActivation;
    }
  }
  const candidate = { ...record, metadata,
    ...(mutation && existing ? { createdAt: existing.createdAt, updatedAt: now } : {}),
  };
  const reviewed = resolveKnowledgeNodeOperatorMutation(candidate, existing, mutation, now);
  if (mutation && existing) prepareKnowledgeOwnedClocks(candidate, existing, now);
  if (reviewed && existing && mutation === undefined) return existing;
  return retainKnowledgeNodeRecord(reviewed ? { ...candidate, ...reviewed } : candidate, candidate);
}

function validCorrectionPath(path: readonly string[]): boolean {
  return (path.length === 1 && ['title', 'summary'].includes(path[0]!))
    || (path.length === 2 && path[0] === 'metadata' && typeof path[1] === 'string'
      && !reviewFields.has(path[1]) && !['__proto__', 'prototype', 'constructor'].includes(path[1]));
}

function readReviewedFields(node: KnowledgeNodeRecord): readonly KnowledgeNodeFieldCorrection[] | undefined {
  const review = readRecord(node.metadata.review);
  if (review.scope !== 'fields' || review.action !== 'revise' || review.authority !== 'operator'
    || typeof review.id !== 'string' || !Array.isArray(review.fields)) return undefined;
  const fields = review.fields as KnowledgeNodeFieldCorrection[];
  return fields.every((field) => field && Array.isArray(field.path) && validCorrectionPath(field.path)) ? fields : undefined;
}

function mergeReviewedFields(
  previous: readonly KnowledgeNodeFieldCorrection[] | undefined,
  changes: readonly KnowledgeNodeFieldCorrection[],
): KnowledgeNodeFieldCorrection[] {
  const fields = new Map((previous ?? []).map((field) => [JSON.stringify(field.path), field]));
  for (const field of changes) fields.set(JSON.stringify(field.path), field);
  return [...fields.values()];
}

function applyFieldCorrections(node: KnowledgeNodeRecord, fields: readonly KnowledgeNodeFieldCorrection[]): KnowledgeNodeRecord {
  const updated = { ...node, metadata: { ...node.metadata } };
  for (const { path, value } of fields) {
    if (path[0] === 'metadata') updated.metadata[path[1]!] = value;
    else (updated as unknown as Record<string, unknown>)[path[0]!] = value;
  }
  return updated;
}

function readPath(node: KnowledgeNodeRecord, path: readonly string[]): unknown {
  const record = path.length === 1 ? node as unknown as Record<string, unknown> : node.metadata;
  const key = path[path.length - 1]!;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function fieldReviewIdentity(node: KnowledgeNodeRecord): string {
  const metadata = node.metadata;
  const homeAssistant = readRecord(metadata.homeAssistant);
  return stableJson({ id: node.id, kind: node.kind, slug: node.slug,
    knowledgeSpaceId: metadata.knowledgeSpaceId, namespace: metadata.namespace,
    semanticKind: metadata.semanticKind, factKind: metadata.factKind,
    subject: metadata.subject, subjectIds: metadata.subjectIds,
    linkedObjectIds: metadata.linkedObjectIds, targetHints: metadata.targetHints,
    installationId: homeAssistant.installationId, objectId: homeAssistant.objectId, objectKind: homeAssistant.objectKind,
  });
}

function reviewedContentSnapshot(node: KnowledgeNodeRecord): string {
  return stableJson({
    kind: node.kind, slug: node.slug, title: node.title, summary: node.summary ?? '',
    aliases: [...node.aliases].sort(), status: node.status, confidence: node.confidence,
    sourceId: node.sourceId ?? '', metadata: withoutReviewFields(node.metadata),
  });
}

function withoutReviewFields(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !reviewFields.has(key)));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stableJson(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  function stable(entry: unknown): string {
    if (Array.isArray(entry)) return `[${entry.map(stable).join(',')}]`;
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(entry);
  }
  return stable(normalized);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
