/**
 * Shared data hooks for the Library tabs. The page header needs the Review count
 * while the Review tab needs the rows themselves, so both read the same query
 * keys (react-query dedupes them into one request).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  invokeMethod,
  sdk,
  type MemoryRecord,
  type MemoryUpdateReviewInput,
} from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { firstArray, firstString } from '../../lib/object';

/** A value that follows `value` after it has been stable for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function useReviewQueue() {
  return useQuery({
    queryKey: queryKeys.memoryReviewQueue,
    queryFn: () => sdk.operator.memory.reviewQueue({ limit: 50 }),
  });
}

export function useConsolidationReceipts() {
  return useQuery({
    queryKey: queryKeys.memoryConsolidationReceipts,
    queryFn: () => sdk.operator.memory.consolidation.receipts(),
  });
}

export function useKnowledgeCandidates() {
  return useQuery({
    queryKey: queryKeys.knowledgeCandidates,
    queryFn: () => invokeMethod('knowledge.candidates.list', { limit: 50 }),
  });
}

/** Candidates that still wait for a decision (anything not yet decided). */
export function isUndecidedCandidate(status: string): boolean {
  return status === 'pending' || status === 'unknown' || status === '';
}

export function candidateItems(data: unknown): unknown[] {
  return firstArray(data, ['candidates']);
}

/** Delete and review-save mutations shared by the Memory and Review tabs. */
export function useMemoryRecordMutations() {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['memory'] });
  };
  const remove = useMutation({
    mutationFn: (record: MemoryRecord) => sdk.operator.memory.delete(record.id),
    onSuccess: invalidate,
  });
  const saveReview = useMutation({
    mutationFn: ({ id, input }: { id: string; input: MemoryUpdateReviewInput }) =>
      sdk.operator.memory.updateReview(id, input),
    onSuccess: invalidate,
  });
  return { remove, saveReview };
}

/** "fact" -> "Fact", "cross-scope-duplicate" -> "Cross scope duplicate". */
export function sentence(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

export function includesText(haystack: readonly (string | undefined)[], needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return haystack.some((part) => part?.toLowerCase().includes(n));
}

/**
 * How many rows the Review tab holds: queued records, pending consolidation
 * proposals and undecided knowledge candidates. The tab label shows exactly this,
 * so the number always equals the rows a person finds there.
 */
export function useReviewCount(): number {
  const queue = useReviewQueue();
  const receipts = useConsolidationReceipts();
  const candidates = useKnowledgeCandidates();
  const queued = queue.data?.records.length ?? 0;
  const proposals = receipts.data?.pendingProposals.length ?? 0;
  const undecided = candidateItems(candidates.data)
    .filter((c) => isUndecidedCandidate(firstString(c, ['status']) || 'unknown')).length;
  return queued + proposals + undecided;
}

/** A status word from the daemon to a StatusDot tone. Unknown words stay idle. */
export function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'info' | 'idle' {
  const s = status.toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'ok', 'ready', 'accepted', 'done', 'healthy'].includes(s)) return 'ok';
  if (['failed', 'error', 'rejected', 'blocked', 'cancelled'].includes(s)) return 'bad';
  if (['running', 'queued', 'pending', 'in_progress', 'in-progress', 'indexing'].includes(s)) return 'info';
  if (['stale', 'warning', 'degraded', 'superseded'].includes(s)) return 'warn';
  return 'idle';
}
