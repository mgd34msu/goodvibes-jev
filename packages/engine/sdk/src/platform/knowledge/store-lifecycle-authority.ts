import { randomUUID } from 'node:crypto';
import type { KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeRefinementTaskState } from './types.js';

export function isTerminalRefinementState(state: KnowledgeRefinementTaskState): boolean {
  return state === 'cancelled' || state === 'closed' || state === 'suppressed';
}

/** Only an explicit review caller may reopen the same issue lifecycle. */
export interface KnowledgeIssueOperatorMutation {
  readonly expectedIssueSnapshot: string;
}
const operatorMutations = new WeakSet<KnowledgeIssueOperatorMutation>();
const protectedFields = new Set(['review', 'suppression', 'issueLifecycle']);

export function createKnowledgeIssueOperatorMutation(issue: KnowledgeIssueRecord): KnowledgeIssueOperatorMutation {
  const mutation = Object.freeze({ expectedIssueSnapshot: JSON.stringify(issue) });
  operatorMutations.add(mutation);
  return mutation;
}

export function assertKnowledgeIssueOperatorMutation(
  existing: KnowledgeIssueRecord | null | undefined,
  mutation: KnowledgeIssueOperatorMutation,
): void {
  if (!operatorMutations.has(mutation) || !existing || JSON.stringify(existing) !== mutation.expectedIssueSnapshot) {
    throw new Error('Knowledge issue changed before its explicit review; refresh it before reviewing.');
  }
}

/** A changed content fingerprint starts a new lifecycle, never reuses its review. */
export function prepareKnowledgeIssueUpsert(
  existing: KnowledgeIssueRecord | undefined,
  input: KnowledgeIssueUpsertInput,
  mutation?: KnowledgeIssueOperatorMutation,
  replaceMetadata = false,
): { readonly preserve: boolean; readonly status: KnowledgeIssueRecord['status']; readonly metadata: Record<string, unknown> } {
  if (mutation) assertKnowledgeIssueOperatorMutation(existing, mutation);
  const lifecycle = readRecord(existing?.metadata.issueLifecycle);
  const incomingLifecycle = readRecord(input.metadata?.issueLifecycle);
  const previous = readFingerprint(existing?.metadata.subjectFingerprint);
  const next = readFingerprint(input.metadata?.subjectFingerprint);
  const changed = Boolean(previous && next && previous !== next);
  const retired = readStrings(lifecycle.retiredFingerprints);
  // A captured old record cannot undo a later review/reopen, even when both
  // lifecycles happen to have status open. Sparse producer inputs have no token.
  // Pre-token persisted snapshots cannot prove they observed an operator reopen.
  // Current repair callers carry the token read with the issue; a genuinely new
  // content fingerprint is still a separate lifecycle rather than a freeze.
  const unversionedResolution = !changed && input.status === 'resolved' && existing?.status === 'open'
    && typeof readRecord(existing.metadata.review).action === 'string'
    && typeof lifecycle.id === 'string' && incomingLifecycle.id !== lifecycle.id;
  const stale = !mutation && (unversionedResolution
    || (typeof incomingLifecycle.id === 'string' && incomingLifecycle.id !== lifecycle.id)
    || (changed && next !== undefined && retired.includes(next)));
  if (existing && (stale || (!mutation && existing.status === 'resolved' && !changed))) {
    return { preserve: true, status: existing.status, metadata: existing.metadata };
  }
  const metadata = { ...(replaceMetadata ? {} : existing?.metadata), ...withoutProtectedFields(input.metadata) };
  // Compensation replaces ordinary fields exactly, but cannot supply authority.
  for (const key of protectedFields) {
    if (existing?.metadata[key] !== undefined) metadata[key] = existing.metadata[key];
  }
  if (changed || mutation) {
    delete metadata.review;
    delete metadata.suppression;
    delete metadata.resolution;
  }
  if (mutation) {
    if (input.metadata?.review !== undefined) metadata.review = input.metadata.review;
    if (input.metadata?.suppression !== undefined) metadata.suppression = input.metadata.suppression;
  }
  metadata.issueLifecycle = {
    id: changed || mutation || typeof lifecycle.id !== 'string' ? randomUUID() : lifecycle.id,
    retiredFingerprints: changed && previous && existing?.status === 'resolved' ? [...new Set([...retired, previous])] : retired,
  };
  return {
    preserve: false,
    status: input.status ?? (changed ? 'open' : existing?.status ?? 'open'),
    metadata,
  };
}

function withoutProtectedFields(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !protectedFields.has(key)));
}
function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function readFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
