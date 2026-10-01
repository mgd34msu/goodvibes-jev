/**
 * approval-refresh.ts, refetch the approvals list after a decision so what the
 * list shows was read AFTER the decision landed.
 *
 * `invalidateQueries` alone is not enough. When a list fetch is already in
 * flight and the query has no data yet, react-query joins that fetch instead of
 * starting a new one (it only cancels and restarts a running fetch when there is
 * data to fall back on). That fetch was sent before the decision, so it answers
 * with the approval still pending, and nothing refetches until the next poll.
 * The push-notification "Allow"/"Deny" hand-off hits exactly this: it decides on
 * mount, while the view's first list load is still running.
 *
 * Cancelling first drops the pre-decision fetch (its state reverts), and the
 * invalidation then starts a fresh one.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';

export async function refetchAfterDecision(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}
