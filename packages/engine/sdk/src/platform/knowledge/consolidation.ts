import { createHash } from 'node:crypto';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { consolidationReading } from './batteries/consolidation.js';
import type { MemoryClass, MemoryRegistry, MemoryScope } from '../state/index.js';
import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
} from './types.js';
import {
  coerceStringArray,
  isSourcePastRefreshWindow,
  mergeTags,
  summarizeCompact,
  usageWindowCutoff,
} from './shared.js';

export interface KnowledgeConsolidationContext {
  readonly store: KnowledgeStore;
  readonly memoryRegistry: Pick<MemoryRegistry, 'add' | 'getStore'>;
  readonly syncReviewedMemory: () => Promise<void>;
}

interface CandidateDecisionInput {
  readonly decidedBy?: string | undefined;
  readonly memoryClass?: string | undefined;
  readonly scope?: string | undefined;
  readonly detail?: string | undefined;
}

const decisions = new WeakMap<KnowledgeStore, Map<string, Promise<KnowledgeConsolidationCandidateRecord>>>();

/** Serialize refreshes and decisions for a subject, including operator/auto races. */
function queueCandidate(context: KnowledgeConsolidationContext, key: string, operation: () => Promise<KnowledgeConsolidationCandidateRecord>): Promise<KnowledgeConsolidationCandidateRecord> {
  const queue = decisions.get(context.store) ?? new Map<string, Promise<KnowledgeConsolidationCandidateRecord>>();
  decisions.set(context.store, queue);
  const previous = queue.get(key);
  const next = Promise.resolve(previous).catch(() => undefined).then(operation);
  queue.set(key, next);
  return next.finally(() => { if (queue.get(key) === next) queue.delete(key); });
}

function candidateKey(candidate: Pick<KnowledgeConsolidationCandidateRecord, 'candidateType' | 'subjectKind' | 'subjectId'>): string {
  return JSON.stringify([candidate.candidateType, candidate.subjectKind, candidate.subjectId]);
}

async function queueDecision(context: KnowledgeConsolidationContext, id: string, decision: 'accept' | 'reject' | 'supersede', input: CandidateDecisionInput, automatic = false): Promise<KnowledgeConsolidationCandidateRecord> {
  await context.store.init();
  const candidate = context.store.getConsolidationCandidate(id);
  if (!candidate) throw new Error(`Unknown knowledge consolidation candidate: ${id}`);
  return queueCandidate(context, candidateKey(candidate), () => applyDecision(context, id, decision, input, automatic));
}

export function decideKnowledgeConsolidationCandidate(context: KnowledgeConsolidationContext, id: string, decision: 'accept' | 'reject' | 'supersede', input: CandidateDecisionInput = {}): Promise<KnowledgeConsolidationCandidateRecord> {
  return queueDecision(context, id, decision, input);
}

async function applyDecision(context: KnowledgeConsolidationContext, id: string, decision: 'accept' | 'reject' | 'supersede', input: CandidateDecisionInput, automatic: boolean): Promise<KnowledgeConsolidationCandidateRecord> {
  await context.store.init();
  const candidate = context.store.getConsolidationCandidate(id);
  if (!candidate) throw new Error(`Unknown knowledge consolidation candidate: ${id}`);
  if (automatic && (candidate.status !== 'open' || candidate.metadata.judgmentOutcome !== 'act' || candidate.metadata.classOutcome !== 'act')) return candidate;
  if (decision === 'accept' && candidate.status === 'accepted') return candidate;
  if (decision === 'accept' && typeof candidate.metadata.subjectFingerprint === 'string' && candidate.metadata.subjectFingerprint !== subjectSnapshot(context, candidate.subjectId)) throw new Error('Knowledge candidate is stale; refresh it before accepting.');
  const decidedAt = Date.now();
  let acceptedMemoryId: string | undefined;
  if (decision === 'accept' && candidate.candidateType === 'memory-promotion') {
    const record = context.store.getItem(candidate.subjectId);
    if (!record?.source && !record?.node) throw new Error('Knowledge candidate source is missing; no memory was written.');
    await context.memoryRegistry.getStore().init();
    if (typeof candidate.metadata.subjectFingerprint === 'string' && candidate.metadata.subjectFingerprint !== subjectSnapshot(context, candidate.subjectId)) throw new Error('Knowledge candidate changed before its memory write.');
    const summary = summarizeCompact(candidate.title, 160) ?? candidate.title;
    const detail = input.detail
      ?? candidate.summary
      ?? record?.source?.summary
      ?? record?.node?.summary
      ?? summary;
    const tags = mergeTags(
      candidate.evidence,
      record?.source?.tags,
      record?.node?.aliases,
      coerceStringArray(candidate.metadata.tags),
    );
    // Provenance recovers a write that committed before candidate persistence
    // failed, so replay does not add a second memory for the same decision.
    const existingMemory = context.memoryRegistry.getStore().retrieve({ provenanceKinds: ['event'] }).find((entry) => entry.provenance.some((link) => link.kind === 'event' && link.ref === candidate.id));
    const memory = existingMemory ?? await context.memoryRegistry.add({
      cls: (input.memoryClass ?? candidate.suggestedMemoryClass ?? 'fact') as MemoryClass,
      scope: (input.scope ?? candidate.suggestedScope ?? 'project') as MemoryScope,
      summary,
      detail,
      tags,
      provenance: [
        ...(record?.source?.sessionId ? [{ kind: 'session' as const, ref: record.source.sessionId }] : []),
        { kind: 'event', ref: candidate.id, label: 'knowledge consolidation candidate' },
        { kind: 'event', ref: candidate.subjectId, label: `knowledge ${candidate.subjectKind}` },
      ],
      review: {
        state: automatic ? 'fresh' : 'reviewed',
        confidence: Math.max(0, Math.min(100, Math.round(candidate.score))),
        ...(!automatic ? { reviewedAt: decidedAt, reviewedBy: input.decidedBy } : {}),
      },
    });
    acceptedMemoryId = memory.id;
  }
  const decided = await context.store.upsertConsolidationCandidate({
    id: candidate.id,
    candidateType: candidate.candidateType,
    subjectKind: candidate.subjectKind,
    subjectId: candidate.subjectId,
    title: candidate.title,
    summary: candidate.summary,
    score: candidate.score,
    evidence: candidate.evidence,
    suggestedMemoryClass: input.memoryClass ?? candidate.suggestedMemoryClass,
    suggestedScope: input.scope ?? candidate.suggestedScope,
    status: decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'superseded',
    decidedAt,
    decidedBy: input.decidedBy,
    metadata: {
      ...candidate.metadata,
      decisionAuthority: automatic ? 'automatic' : 'operator',
      ...(acceptedMemoryId ? { acceptedMemoryId } : {}),
    },
  });
  if (acceptedMemoryId) await context.syncReviewedMemory();
  return decided;
}

export async function refreshKnowledgeConsolidationCandidates(
  context: KnowledgeConsolidationContext,
  limit = 24,
): Promise<KnowledgeConsolidationCandidateRecord[]> {
  await context.store.init();
  await context.syncReviewedMemory();
  const usageStats = await buildUsageStats(context);
  const proposals: KnowledgeConsolidationCandidateRecord[] = [];
  // A request budget, not a worth threshold. Usage records arrive newest first.
  const readingLimit = Math.min(64, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 24));
  let readings = 0;

  for (const [key, stats] of usageStats.entries()) {
    const separator = key.indexOf(':');
    const subjectKind = key.slice(0, separator) as KnowledgeConsolidationCandidateRecord['subjectKind'];
    const subjectId = key.slice(separator + 1);
    if (subjectKind === 'issue') continue;
    const item = context.store.getItem(subjectId);
    if (!item?.source && !item?.node) continue;
    const subjectTitle = item.source?.title ?? item.source?.canonicalUri ?? item.node?.title ?? subjectId;
    const subjectSummary = item.source?.summary ?? item.node?.summary ?? item.source?.description;
    const relationCount = subjectKind === 'source'
      ? context.store.edgesFor('source', subjectId).length
      : context.store.edgesFor('node', subjectId).length;
    const candidateType: KnowledgeConsolidationCandidateRecord['candidateType'] =
      item.node?.kind === 'memory' && item.node.status === 'stale'
        ? 'memory-review'
        : subjectKind === 'source' && isSourcePastRefreshWindow(item.source!)
          ? 'source-refresh'
          : 'memory-promotion';
    const settled = context.store.getConsolidationCandidateBySubject(subjectKind, subjectId, candidateType);
    if (settled && settled.status !== 'open') { proposals.push(settled); continue; }
    if (readings >= readingLimit) break;
    const snapshot = subjectSnapshot(context, subjectId);
    const state = {
      subject: { title: subjectTitle, summary: subjectSummary ?? '', kind: item.node?.kind ?? item.source?.sourceType ?? 'unknown', status: item.node?.status ?? item.source?.status ?? 'unknown', trust: 'untrusted-reference-material', reviewState: typeof item.node?.metadata.reviewState === 'string' ? item.node.metadata.reviewState : 'unreviewed' },
      usage: { count: stats.count, usageKinds: [...stats.usageKinds], sessionCount: stats.sessionIds.size, lastUsedAt: new Date(stats.lastUsedAt).toISOString(), relationCount },
    };
    assertJudgmentInput(state);
    readings += 1;
    const run = await consolidationReading.run(judgmentPort('engine.knowledge.consolidation'), state, { site: 'engine.knowledge.consolidation' });
    const { keep, memory_class: memoryClass } = run.readings;
    if (subjectSnapshot(context, subjectId) !== snapshot) {
      run.recordAction('held: subject changed during judgment');
      continue;
    }
    if (keep.verdict !== 'yes') {
      run.recordAction(`no candidate: ${keep.verdict} (${keep.outcome})`);
      continue;
    }
    const score = Math.round(keep.probability * 100);
    const evidence = mergeTags(
      [
        `used ${stats.count} time(s) in the last 30 days`,
        `observed via ${stats.usageKinds.size} usage pattern(s)`,
        `linked to ${relationCount} graph relation(s)`,
      ],
      subjectKind === 'source' ? item.source?.tags : item.node?.aliases,
    ).slice(0, 8);
    const candidate = await queueCandidate(context, candidateKey({ candidateType, subjectKind, subjectId }), async () => {
      // A person may have decided while the model was reading. Preserve the
      // complete terminal record, including their class, evidence and provenance.
      const latest = context.store.getConsolidationCandidateBySubject(subjectKind, subjectId, candidateType);
      if (latest && latest.status !== 'open') return latest;
      if (subjectSnapshot(context, subjectId) !== snapshot) throw new Error('Knowledge subject changed before candidate staging.');
      return context.store.upsertConsolidationCandidate({
        candidateType,
        subjectKind,
        subjectId,
        title: subjectTitle,
        summary: subjectSummary,
        score,
        evidence,
        suggestedMemoryClass: memoryClass.choice,
        suggestedScope: 'project',
        metadata: {
          usageCount: stats.count,
          lastUsedAt: stats.lastUsedAt,
          usageKinds: [...stats.usageKinds],
          relationCount,
          judgmentDecisionId: run.result.decisionId,
          judgmentOutcome: keep.outcome,
          classOutcome: memoryClass.outcome,
          subjectFingerprint: snapshot,
        },
      });
    });
    run.recordAction(candidate.status === 'open' ? `queued for ${keep.outcome === 'act' && memoryClass.outcome === 'act' ? 'eligible promotion' : 'operator review'}` : `preserved operator decision: ${candidate.status}`);
    proposals.push(candidate);
  }

  // Missing, uncertain or changed subjects do not revoke a prior operator
  // decision or silently supersede an open review candidate.

  return proposals
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, readingLimit);
}

export async function runKnowledgeConsolidation(
  context: KnowledgeConsolidationContext,
  kind: Extract<KnowledgeConsolidationReportRecord['kind'], 'light-consolidation' | 'deep-consolidation'>,
  input: { readonly limit?: number | undefined; readonly autoPromote: boolean },
): Promise<KnowledgeConsolidationReportRecord> {
  const limit = Math.max(1, input.limit ?? 24);
  const candidates = await refreshKnowledgeConsolidationCandidates(context, limit);
  let accepted = 0;
  let rejected = 0;
  let superseded = 0;
  if (input.autoPromote) {
    for (const candidate of candidates) {
      if (candidate.candidateType !== 'memory-promotion' || candidate.status !== 'open') continue;
      if (candidate.metadata.judgmentOutcome !== 'act' || candidate.metadata.classOutcome !== 'act') continue;
      if (candidate.metadata.subjectFingerprint !== subjectSnapshot(context, candidate.subjectId)) continue;
      const decided = await queueDecision(context, candidate.id, 'accept', {
        decidedBy: 'knowledge.deep-consolidation',
        memoryClass: candidate.suggestedMemoryClass,
        scope: candidate.suggestedScope,
      }, true);
      if (decided.status === 'accepted') accepted += 1;
    }
  }
  const current = context.store.listConsolidationCandidates(1_000);
  for (const candidate of current) {
    if (candidate.status === 'rejected') rejected += 1;
    if (candidate.status === 'superseded') superseded += 1;
  }
  const openCount = current.filter((entry) => entry.status === 'open').length;
  return context.store.upsertConsolidationReport({
    kind,
    title: kind === 'light-consolidation' ? 'Light Consolidation Report' : 'Deep Consolidation Report',
    summary: kind === 'light-consolidation'
      ? `Reviewed ${candidates.length} high-signal knowledge subjects and refreshed the consolidation queue.`
      : `Reviewed ${candidates.length} high-signal knowledge subjects and auto-promoted only candidates whose worth and class readings reached act into durable memory.`,
    highlights: candidates.slice(0, 6).map((candidate) => `${candidate.title} (${candidate.candidateType}, score ${candidate.score})`),
    metrics: {
      candidateCount: candidates.length,
      openCount,
      acceptedCount: accepted,
      rejectedCount: rejected,
      supersededCount: superseded,
    },
    metadata: {
      autoPromote: input.autoPromote,
    },
  });
}

export async function syncReviewedKnowledgeMemory(context: { readonly syncReviewedMemory: () => Promise<void> }): Promise<void> {
  await context.syncReviewedMemory();
}

async function buildUsageStats(context: KnowledgeConsolidationContext, limit = 10_000): Promise<Map<string, {
  count: number;
  lastUsedAt: number;
  usageKinds: Set<string>;
  sessionIds: Set<string>;
}>> {
  const stats = new Map<string, {
    count: number;
    lastUsedAt: number;
    usageKinds: Set<string>;
    sessionIds: Set<string>;
  }>();
  const cutoff = usageWindowCutoff();
  for (const record of context.store.listUsageRecords(limit)) {
    if (record.createdAt < cutoff) continue;
    const key = `${record.targetKind}:${record.targetId}`;
    const current = stats.get(key) ?? {
      count: 0,
      lastUsedAt: 0,
      usageKinds: new Set<string>(),
      sessionIds: new Set<string>(),
    };
    current.count += 1;
    current.lastUsedAt = Math.max(current.lastUsedAt, record.createdAt);
    current.usageKinds.add(record.usageKind);
    if (record.sessionId) current.sessionIds.add(record.sessionId);
    stats.set(key, current);
  }
  return stats;
}

/** Exact content/provenance snapshot, not a semantic similarity guess. */
function subjectSnapshot(context: KnowledgeConsolidationContext, subjectId: string): string | null {
  const item = context.store.getItem(subjectId);
  if (!item?.source && !item?.node) return null;
  return createHash('sha256').update(JSON.stringify(item.source ?? item.node)).digest('hex');
}
