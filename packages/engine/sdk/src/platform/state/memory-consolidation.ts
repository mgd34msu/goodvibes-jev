/**
 * memory-consolidation.ts, idle-time memory consolidation policy (HOISTED to the SDK).
 *
 * PROVENANCE. Promoted verbatim (semantics-preserving) from the agent surface
 * (`src/agent/memory-consolidation.ts`) so every consumer shares ONE
 * consolidation contract with injectable I/O, rather than each re-deriving it.
 * The only surface-coupled part, the record writes, is expressed as an
 * injected `MemoryConsolidationRegistry` seam; `MemoryRegistry` satisfies it
 * structurally.
 *
 * Whether two records are duplicates, a contradiction or unrelated is read by
 * Jev (batteries/memory-alignment.ts); which pairs are compared, which record
 * survives and every write stay code.
 *
 * The pass performs only REVERSIBLE operations on existing records: it merges
 * duplicate records into a survivor and marks the losers stale (never deletes),
 * and it decays never-referenced, aged records (lowering confidence, then marking
 * stale once the confidence floor is crossed). Anything that would require a NEW
 * standing memory or a destructive delete is emitted as a PROPOSAL routed to the
 * existing confirmation-gated path, this pass never silently writes a new memory
 * or deletes a record. Every run returns a RECEIPT describing exactly what it
 * merged, archived, decayed, and proposed.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { alignmentContent, memoryAgreement, memoryAlignment } from './batteries/memory-alignment.js';
import type { MemoryRecord, MemoryReviewPatch, MemoryScope } from './memory-store.js';
import type { ResolvedMemoryConsolidationConfig } from './memory-consolidation-config.js';

/** Honest per-memory usage signal consumed by the decay ordering. */
export interface MemoryConsolidationUsageSignal {
  readonly injectedCount: number;
  readonly referencedCount: number;
  readonly lastReferencedAt: number | null;
}

/** Lookup of the usage signal for a memory id; undefined when never instrumented. */
export type MemoryConsolidationUsageLookup = (memoryId: string) => MemoryConsolidationUsageSignal | undefined;

export type MemoryConsolidationTrigger = 'idle' | 'schedule' | 'manual';

/**
 * The record-mutation seam the pass writes through. Structural, so a concrete
 * MemoryRegistry (or any equivalent wrapper) satisfies it and the policy stays
 * decoupled from the store implementation. Only reversible writes are used:
 * `review` (mark stale / lower confidence) and `update` (merge tag unions).
 */
export interface MemoryConsolidationRegistry {
  getAll(): readonly MemoryRecord[];
  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null;
  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null;
}

export interface MemoryConsolidationInput {
  readonly memoryRegistry: MemoryConsolidationRegistry;
  readonly config: ResolvedMemoryConsolidationConfig;
  readonly now: number;
  readonly trigger: MemoryConsolidationTrigger;
  readonly idle: boolean;
  /** Optional usage instrumentation. When present, never-referenced records decay first. */
  readonly usageLookup?: MemoryConsolidationUsageLookup;
  /**
   * Optional deterministic random-suffix seam for the receipt `runId`. Defaults
   * to `Math.random()`-derived. Injected only so tests can assert a stable id;
   * production leaves it unset for the same behavior as the agent original.
   */
  readonly randomSuffix?: () => string;
}

export interface MemoryConsolidationMergeEntry {
  readonly survivorId: string;
  readonly duplicateIds: readonly string[];
  readonly scope: string;
  readonly cls: string;
}

export interface MemoryConsolidationArchiveEntry {
  readonly id: string;
  readonly reason: string;
  readonly previousConfidence: number;
}

export interface MemoryConsolidationDecayEntry {
  readonly id: string;
  readonly fromConfidence: number;
  readonly toConfidence: number;
  readonly referencedCount: number;
}

export interface MemoryConsolidationProposal {
  readonly kind: 'contradiction' | 'cross-scope-duplicate' | 'stale-delete';
  readonly ids: readonly string[];
  readonly route: string;
  readonly reason: string;
}

export interface MemoryConsolidationRunReceipt {
  readonly runId: string;
  readonly ranAt: string;
  readonly trigger: MemoryConsolidationTrigger;
  readonly idle: boolean;
  readonly scanned: number;
  readonly merged: readonly MemoryConsolidationMergeEntry[];
  readonly archived: readonly MemoryConsolidationArchiveEntry[];
  readonly decayed: readonly MemoryConsolidationDecayEntry[];
  readonly proposed: readonly MemoryConsolidationProposal[];
  readonly usageSignalAvailable: boolean;
  readonly note: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DELETE_PROPOSAL_AGE_DAYS = 90;

const SITE = 'state.memory-consolidation';

/**
 * Most record pairs one pass reads. Every pair costs one or two requests, so
 * the pass reads the pairs whose newer record is newest first (a new record
 * is the likeliest duplicate of an old one) and leaves the rest for later
 * passes.
 */
const MAX_PAIR_READINGS_PER_RUN = 60;

/** Pair readings in flight at once. */
const PAIR_CONCURRENCY = 8;

function verifiedRank(record: MemoryRecord): number {
  if (record.reviewState === 'reviewed') return 2;
  if (record.reviewState === 'fresh') return 1;
  return 0;
}

/** Active for consolidation purposes: fresh or reviewed only. Stale/contradicted are already resolved. */
function isActive(record: MemoryRecord): boolean {
  return record.reviewState === 'fresh' || record.reviewState === 'reviewed';
}

/** Prefer the newer, more-verified, higher-confidence record as the survivor. */
function chooseSurvivor(records: readonly MemoryRecord[]): MemoryRecord {
  return [...records].sort((left, right) => {
    if (verifiedRank(right) !== verifiedRank(left)) return verifiedRank(right) - verifiedRank(left);
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.updatedAt - left.updatedAt;
  })[0]!;
}

function usageSignalFor(
  lookup: MemoryConsolidationUsageLookup | undefined,
  id: string,
): MemoryConsolidationUsageSignal {
  return lookup?.(id) ?? { injectedCount: 0, referencedCount: 0, lastReferencedAt: null };
}

interface MergePlanResult {
  readonly merged: MemoryConsolidationMergeEntry[];
  readonly proposals: MemoryConsolidationProposal[];
  /** Ids consumed by a merge/contradiction this run, excluded from decay. */
  readonly touched: Set<string>;
}

export type MemoryPairRelation = 'duplicate' | 'contradiction' | 'unrelated';

/**
 * Candidate pairs, grouped structurally: only records of the same class are
 * compared (any scope, so cross-scope collisions surface). Within a class the
 * newest records pair first; at most MAX_PAIR_READINGS_PER_RUN pairs overall.
 */
function candidatePairs(active: readonly MemoryRecord[]): Array<readonly [MemoryRecord, MemoryRecord]> {
  const byClass = new Map<string, MemoryRecord[]>();
  for (const record of active) {
    const bucket = byClass.get(record.cls) ?? [];
    bucket.push(record);
    byClass.set(record.cls, bucket);
  }
  const pairs: Array<readonly [MemoryRecord, MemoryRecord]> = [];
  for (const bucket of byClass.values()) {
    const newestFirst = [...bucket].sort((left, right) => right.updatedAt - left.updatedAt);
    let taken = 0;
    for (let i = 0; i < newestFirst.length && taken < MAX_PAIR_READINGS_PER_RUN; i += 1) {
      for (let j = i + 1; j < newestFirst.length && taken < MAX_PAIR_READINGS_PER_RUN; j += 1) {
        pairs.push([newestFirst[i]!, newestFirst[j]!]);
        taken += 1;
      }
    }
  }
  return pairs
    .sort((left, right) => right[0].updatedAt - left[0].updatedAt || right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_PAIR_READINGS_PER_RUN);
}

/**
 * How two records relate, composed from two readings (see
 * batteries/memory-alignment.ts for the mapping): the aligner rules distinct
 * pairs out, then the agreement reading tells a duplicate from a
 * contradiction. Code acts on a yes only when the reading's outcome is act; a
 * conflict wins over a restatement, since a contradiction goes to a person.
 */
export async function classifyMemoryPair(a: MemoryRecord, b: MemoryRecord): Promise<MemoryPairRelation> {
  const port = judgmentPort(SITE);
  const aligned = await memoryAlignment.align(port, alignmentContent(a), alignmentContent(b), { site: SITE });
  if (aligned.alignment === 'distinct') {
    aligned.recordAction('unrelated');
    return 'unrelated';
  }
  const run = await memoryAgreement.run(port, { record_a: alignmentContent(a), record_b: alignmentContent(b) }, { site: SITE });
  const { restates, conflicts } = run.readings;
  const relation: MemoryPairRelation = conflicts.verdict === 'yes' && conflicts.outcome === 'act'
    ? 'contradiction'
    : restates.verdict === 'yes' && restates.outcome === 'act' ? 'duplicate' : 'unrelated';
  aligned.recordAction(relation);
  run.recordAction(relation);
  return relation;
}

const CURATOR_ROUTE = 'memory action:"curator" query:"consolidation"';

/**
 * Read candidate pairs and act on them: a same-scope duplicate is merged into
 * a survivor; a contradiction is resolved newer-verified-wins, else both
 * records are flagged contradicted and proposed for a person; any pair that
 * spans scopes is only proposed, never merged automatically.
 */
async function planAndApplyMerges(input: MemoryConsolidationInput, active: readonly MemoryRecord[]): Promise<MergePlanResult> {
  const proposals: MemoryConsolidationProposal[] = [];
  const touched = new Set<string>();
  /** Records marked stale or contradicted this run; they take part in no further pair. */
  const resolved = new Set<string>();
  const merges = new Map<string, { survivor: MemoryRecord; tags: Set<string>; duplicateIds: string[] }>();

  const pairs = candidatePairs(active);
  const relations = await mapLimit(pairs, PAIR_CONCURRENCY, ([a, b]) => classifyMemoryPair(a, b));

  pairs.forEach(([a, b], index) => {
    const relation = relations[index]!;
    if (relation === 'unrelated' || resolved.has(a.id) || resolved.has(b.id)) return;

    if (a.scope !== b.scope && relation === 'duplicate') {
      proposals.push({
        kind: 'cross-scope-duplicate',
        ids: [a.id, b.id],
        route: CURATOR_ROUTE,
        reason: 'Records in different scopes state the same fact; merging across scope needs review.',
      });
      // Enter the review queue WITHOUT blocking injection: these records do
      // not disagree (unlike a contradiction), so they stay usable, marking
      // them fresh re-prioritises them for the human review queue, which is
      // reviewState-derived. Touched so the receipt lists them honestly.
      for (const record of [a, b]) {
        if (record.reviewState !== 'fresh') {
          input.memoryRegistry.review(record.id, { state: 'fresh', reviewedBy: 'consolidation' });
        }
        touched.add(record.id);
      }
      return;
    }

    const survivor = chooseSurvivor([a, b]);
    const loser = survivor.id === a.id ? b : a;
    // A record that already absorbed others this run stays their survivor.
    if (merges.has(loser.id)) return;
    const sameScope = a.scope === b.scope;
    const supersedes = relation === 'contradiction' && sameScope
      && verifiedRank(survivor) >= verifiedRank(loser) && survivor.updatedAt > loser.updatedAt;

    if (relation === 'contradiction' && !supersedes) {
      const reason = sameScope
        ? 'Records disagree about the same fact and neither is a clearly-newer verified winner.'
        : 'Records in different scopes disagree about the same fact; resolving across scope needs review.';
      proposals.push({ kind: 'contradiction', ids: [survivor.id, loser.id], route: CURATOR_ROUTE, reason });
      // The proposal REACHES the review machinery: both disagreeing records
      // are marked contradicted (the existing review flag the merge/decay
      // paths also drive), which prioritises them in the review queue and
      // excludes them from injection until a human resolves through the
      // confirmation-gated review route. Nothing is deleted; the resolution
      // stays the human's.
      for (const id of [survivor.id, loser.id]) {
        input.memoryRegistry.review(id, { state: 'contradicted', staleReason: reason, reviewedBy: 'consolidation' });
        touched.add(id);
        resolved.add(id);
      }
      return;
    }

    const entry = merges.get(survivor.id);
    if (!entry && merges.size >= input.config.maxMergesPerRun) return;
    const merge = entry ?? { survivor, tags: new Set(survivor.tags), duplicateIds: [] };
    merges.set(survivor.id, merge);
    if (relation === 'duplicate') {
      for (const tag of loser.tags) merge.tags.add(tag);
      input.memoryRegistry.review(loser.id, {
        state: 'stale',
        staleReason: `Duplicate of ${survivor.id}; merged by idle consolidation.`,
        reviewedBy: 'consolidation',
      });
    } else {
      input.memoryRegistry.review(loser.id, {
        state: 'stale',
        staleReason: `Superseded by newer verified record ${survivor.id}; resolved by idle consolidation.`,
        reviewedBy: 'consolidation',
      });
    }
    merge.duplicateIds.push(loser.id);
    touched.add(loser.id);
    touched.add(survivor.id);
    resolved.add(loser.id);
  });

  const merged: MemoryConsolidationMergeEntry[] = [];
  for (const { survivor, tags, duplicateIds } of merges.values()) {
    if (tags.size !== survivor.tags.length) {
      input.memoryRegistry.update(survivor.id, { tags: [...tags] });
    }
    merged.push({ survivorId: survivor.id, duplicateIds, scope: survivor.scope, cls: survivor.cls });
  }
  return { merged, proposals, touched };
}

/**
 * Decay never-referenced, aged records, never-referenced first (that is what the
 * usage instrumentation feeds). A record's confidence drops by decayConfidenceStep;
 * once it would fall to/below archiveConfidenceFloor it is marked stale (archived).
 */
function applyDecay(
  input: MemoryConsolidationInput,
  active: readonly MemoryRecord[],
  touched: ReadonlySet<string>,
): { decayed: MemoryConsolidationDecayEntry[]; archived: MemoryConsolidationArchiveEntry[] } {
  const decayed: MemoryConsolidationDecayEntry[] = [];
  const archived: MemoryConsolidationArchiveEntry[] = [];
  const ageCutoff = input.now - input.config.decayAgeDays * DAY_MS;

  const candidates = active
    .filter((record) => !touched.has(record.id))
    .filter((record) => record.updatedAt <= ageCutoff)
    .map((record) => ({ record, usage: usageSignalFor(input.usageLookup, record.id) }))
    .filter((entry) => entry.usage.referencedCount === 0)
    .sort((left, right) => {
      const leftLast = left.usage.lastReferencedAt ?? 0;
      const rightLast = right.usage.lastReferencedAt ?? 0;
      if (leftLast !== rightLast) return leftLast - rightLast;
      return left.record.updatedAt - right.record.updatedAt;
    });

  for (const { record, usage } of candidates) {
    if (decayed.length + archived.length >= input.config.maxDecaysPerRun) break;
    const nextConfidence = record.confidence - input.config.decayConfidenceStep;
    if (nextConfidence <= input.config.archiveConfidenceFloor) {
      input.memoryRegistry.review(record.id, {
        state: 'stale',
        staleReason: `Never referenced since injection and aged past ${input.config.decayAgeDays}d; archived by idle consolidation.`,
        reviewedBy: 'consolidation',
      });
      archived.push({ id: record.id, reason: 'never-referenced-aged', previousConfidence: record.confidence });
    } else {
      input.memoryRegistry.review(record.id, {
        state: record.reviewState,
        confidence: nextConfidence,
        reviewedBy: 'consolidation',
      });
      decayed.push({
        id: record.id,
        fromConfidence: record.confidence,
        toConfidence: nextConfidence,
        referencedCount: usage.referencedCount,
      });
    }
  }

  return { decayed, archived };
}

/** Propose (never perform) deletion of long-stale records through the gated memory route. */
function planStaleDeleteProposals(
  input: MemoryConsolidationInput,
  records: readonly MemoryRecord[],
  used: number,
): MemoryConsolidationProposal[] {
  const proposals: MemoryConsolidationProposal[] = [];
  const cutoff = input.now - STALE_DELETE_PROPOSAL_AGE_DAYS * DAY_MS;
  for (const record of records) {
    if (used + proposals.length >= input.config.maxProposalsPerRun) break;
    if (record.reviewState !== 'stale') continue;
    if (record.updatedAt > cutoff) continue;
    proposals.push({
      kind: 'stale-delete',
      ids: [record.id],
      route: `memory action:"delete" id:"${record.id}" explicitUserRequest:"..."`,
      reason: `Stale for over ${STALE_DELETE_PROPOSAL_AGE_DAYS}d; propose removal through the confirmed delete route.`,
    });
  }
  return proposals;
}

export async function runMemoryConsolidation(input: MemoryConsolidationInput): Promise<MemoryConsolidationRunReceipt> {
  const all = input.memoryRegistry.getAll();
  const active = all.filter(isActive);

  const mergeResult = await planAndApplyMerges(input, active);
  const decayResult = applyDecay(input, active, mergeResult.touched);
  const proposals = [
    ...mergeResult.proposals,
    ...planStaleDeleteProposals(input, all, mergeResult.proposals.length),
  ].slice(0, input.config.maxProposalsPerRun);

  const suffix = input.randomSuffix ? input.randomSuffix() : Math.random().toString(36).slice(2, 8);
  const runId = `mcon-${input.now.toString(36)}-${suffix}`;
  return {
    runId,
    ranAt: new Date(input.now).toISOString(),
    trigger: input.trigger,
    idle: input.idle,
    scanned: all.length,
    merged: mergeResult.merged,
    archived: decayResult.archived,
    decayed: decayResult.decayed,
    proposed: proposals,
    usageSignalAvailable: input.usageLookup !== undefined,
    note: 'Idle consolidation performs only reversible merges (loser marked stale, not deleted) and never-referenced-first decay. New memories and deletes are proposed through the existing confirmation-gated routes, never written silently.',
  };
}
