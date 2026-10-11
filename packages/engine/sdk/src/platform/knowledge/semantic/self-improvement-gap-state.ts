import { knowledgeClockIso, knowledgeRawRepresentation } from '../store-record-representation.js';
import { KnowledgeSourceQualityHeldError } from '../source-quality.js';
import { prepareObservedKnowledgeNodeInput, upsertObservedKnowledgeNode } from '../store-node-observation.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeIssueRecord,
  KnowledgeIssueUpsertInput,
  KnowledgeNodeRecord,
} from '../types.js';
import {
  semanticMetadata,
} from './utils.js';

export const SELF_IMPROVEMENT_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

export async function suppressGap(
  store: KnowledgeStore,
  gap: KnowledgeNodeRecord,
  reason: string | undefined,
  spaceId: string,
  assertCurrent: () => void = () => {},
): Promise<void> {
  assertCurrent();
  const node = prepareObservedKnowledgeNodeInput(store, {
    id: gap.id,
    kind: gap.kind,
    slug: gap.slug,
    title: gap.title,
    summary: gap.summary,
    aliases: gap.aliases,
    status: 'stale',
    confidence: gap.confidence,
    sourceId: gap.sourceId,
    metadata: {
      ...knowledgeRawRepresentation(gap.metadata),
      repairStatus: 'not_applicable',
      repairReason: reason,
      repairedAt: knowledgeClockIso(Date.now()),
    },
  }, 'research-task', gap, () => { assertCurrent(); return store.getNode(gap.id); });
  const issues = store.listIssues(Number.MAX_SAFE_INTEGER).filter((entry) => entry.nodeId === gap.id && entry.status === 'open');
  const guard = () => {
    assertCurrent();
    for (const issue of issues) if (store.getIssue(issue.id) !== issue) throw new KnowledgeSourceQualityHeldError('stale');
  };
  await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
    nodes: [node], edges: [], issues: issues.map((issue) => resolvedIssueInput(issue, spaceId, reason ?? 'Gap was classified as not applicable.')),
    assertCurrent: guard,
  }));
}

export async function markGapRepairAttempt(
  store: KnowledgeStore,
  gap: KnowledgeNodeRecord,
  spaceId: string,
  details: {
    readonly status: string;
    readonly reason?: string | undefined;
    readonly query?: string | undefined;
    readonly acceptedSourceIds?: readonly string[] | undefined;
    readonly promotedFactCount?: number | undefined;
    readonly nextRepairAttemptAt?: number | undefined;
    readonly assertCurrent?: (() => void) | undefined;
  },
): Promise<KnowledgeNodeRecord> {
  // Only the locally generated retry clock is encoded. Explicit caller values
  // remain untouched and undergo complete raw admission on later reads.
  const nextRepairAttemptAt = details.nextRepairAttemptAt ?? (
    details.status === 'searched_no_sources' || details.status === 'failed' || details.status === 'deferred'
      ? knowledgeClockIso(Date.now() + SELF_IMPROVEMENT_RETRY_DELAY_MS)
      : undefined
  );
  const committed = await upsertObservedKnowledgeNode(store, {
    id: gap.id,
    kind: gap.kind,
    slug: gap.slug,
    title: gap.title,
    summary: gap.summary,
    aliases: gap.aliases,
    status: gap.status,
    confidence: gap.confidence,
    sourceId: gap.sourceId,
    metadata: {
      ...knowledgeRawRepresentation(gap.metadata),
      repairStatus: details.status,
      ...(details.reason ? { repairReason: details.reason } : {}),
      ...(details.query ? { repairQuery: details.query } : {}),
      ...((details.acceptedSourceIds?.length ?? 0) > 0 ? { acceptedSourceIds: details.acceptedSourceIds } : {}),
      ...(typeof details.promotedFactCount === 'number' ? { promotedFactCount: details.promotedFactCount } : {}),
      lastRepairAttemptAt: knowledgeClockIso(Date.now()),
      nextRepairAttemptAt,
      knowledgeSpaceId: spaceId,
    },
  }, 'research-task', gap, () => { details.assertCurrent?.(); return store.getNode(gap.id); });
  if (details.status === 'repaired') {
    for (const issue of store.listIssues(Number.MAX_SAFE_INTEGER).filter((entry) => entry.nodeId === gap.id && entry.status === 'open')) {
      await resolveIssue(store, issue, spaceId, details.reason ?? 'Gap was repaired with accepted source-backed evidence.');
    }
  }
  return committed;
}

async function resolveIssue(store: KnowledgeStore, issue: KnowledgeIssueRecord, spaceId: string, reason: string): Promise<void> {
  await store.upsertIssue(resolvedIssueInput(issue, spaceId, reason));
}

function resolvedIssueInput(issue: KnowledgeIssueRecord, spaceId: string, reason: string): KnowledgeIssueUpsertInput {
  return {
    id: issue.id,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    status: 'resolved',
    sourceId: issue.sourceId,
    nodeId: issue.nodeId,
    metadata: semanticMetadata(spaceId, {
      ...issue.metadata,
      resolution: {
        reason,
        resolvedBy: 'semantic-self-improvement',
        resolvedAt: Date.now(),
      },
    }),
  };
}
