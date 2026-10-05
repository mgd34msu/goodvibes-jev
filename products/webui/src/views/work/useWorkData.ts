/**
 * Every read the Work view makes, in one place.
 *
 * Freshness follows the old views' rules: the fleet (and its archive and
 * best-of-N groups) polls at a slow safety cadence while the fleet
 * subscription is live and every 15 s when it is down; approvals push over
 * their own subscription (useApprovalUpdates) and poll only while that is
 * down; hosted sessions poll slowly while their stream is up. Tasks, the
 * session union and CI watches refresh from realtime invalidation and after
 * mutations. A daemon without a verb (METHOD_NOT_FOUND) degrades to "none",
 * never an error banner.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sdk } from '../../lib/goodvibes';
import type { FleetAttemptGroup } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { isMethodUnavailableError } from '../../lib/errors';
import { sortApprovalsNewestFirst } from '../../lib/approvals';
import { hostedSessionsFromListResult, sortHostedSessionsNewestFirst } from '../../lib/hosted-sessions';
import { sortUnionSessions, unionSessionsFromListResponse } from '../../lib/sessions-union';
import { useApprovalUpdates } from '../../hooks/useApprovalUpdates';
import { useContractList } from '../../hooks/useContracts';
import { readSessionList } from '../../hooks/useSessionLifecycle';
import type { ClientLifetime } from '../../lib/client-lifetime';
import type { CiWatch } from './work-items';

const FLEET_FALLBACK_POLL_MS = 15_000;
const FLEET_SAFETY_POLL_MS = 60_000;

export interface WorkDataOptions {
  contractScope: ClientLifetime;
  subscriptionActive: boolean;
  /** Read the fleet archive instead of hiding finished work. */
  archived: boolean;
  /** Include finished hosted sessions. */
  includeFinished: boolean;
  /** The hosted-session stream is live. */
  hostedStreamConnected: boolean;
}

export function useWorkData({ contractScope, subscriptionActive, archived, includeFinished, hostedStreamConnected }: WorkDataOptions) {
  const pollInterval = subscriptionActive ? FLEET_SAFETY_POLL_MS : FLEET_FALLBACK_POLL_MS;

  const contracts = useContractList(contractScope, includeFinished, !archived, subscriptionActive);

  const snapshot = useQuery({
    queryKey: queryKeys.fleet,
    queryFn: () => sdk.operator.fleet.snapshot(),
    refetchInterval: pollInterval,
  });
  const archivedList = useQuery({
    queryKey: queryKeys.fleetArchived,
    queryFn: () => sdk.operator.fleet.archivedList(),
    refetchInterval: pollInterval,
    enabled: archived,
  });
  const attempts = useQuery({
    queryKey: queryKeys.fleetAttempts,
    queryFn: () => sdk.operator.fleet.attempts.list(),
    refetchInterval: pollInterval,
    retry: false,
  });

  const approvalUpdates = useApprovalUpdates(true);
  const approvals = useQuery({
    queryKey: queryKeys.approvals,
    queryFn: () => sdk.operator.approvals.list(),
    refetchInterval: approvalUpdates.connected ? false : 15_000,
  });

  const sessions = useQuery({
    queryKey: queryKeys.sessionList(contractScope.revision),
    queryFn: ({ signal }) => readSessionList(contractScope, signal),
    gcTime: 0,
  });

  const hosted = useQuery({
    queryKey: queryKeys.hostedSessions(includeFinished),
    queryFn: () => sdk.operator.sessions.hosted.list({ includeTerminated: includeFinished }),
    refetchInterval: hostedStreamConnected ? 60_000 : 15_000,
    retry: false,
  });

  const tasks = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => sdk.operator.tasks.list(),
    retry: false,
  });

  const ciWatches = useQuery({
    queryKey: queryKeys.ciWatches,
    queryFn: () => sdk.operator.ci.watches.list(),
    retry: false,
  });

  const contractRecords = useMemo(() => archived || contracts.isError ? [] : contracts.data?.contracts ?? [], [archived, contracts.isError, contracts.data]);
  const attemptGroups: readonly FleetAttemptGroup[] = useMemo(
    () => (attempts.isError ? [] : attempts.data?.groups ?? []),
    [attempts.data, attempts.isError],
  );
  const nodes = useMemo(
    () => (archived ? archivedList.data?.nodes : snapshot.data?.nodes) ?? [],
    [archived, archivedList.data, snapshot.data],
  );
  const liveNodes = useMemo(() => snapshot.data?.nodes ?? [], [snapshot.data]);
  const approvalRecords = useMemo(() => sortApprovalsNewestFirst(approvals.data?.approvals ?? []), [approvals.data]);
  const sessionRecords = useMemo(() => sortUnionSessions(unionSessionsFromListResponse(sessions.data)), [sessions.data]);
  const hostedRecords = useMemo(
    () => sortHostedSessionsNewestFirst(hostedSessionsFromListResult(hosted.data)),
    [hosted.data],
  );
  const taskRecords = useMemo(() => tasks.data?.tasks ?? [], [tasks.data]);
  const watchRecords: readonly CiWatch[] = useMemo(() => ciWatches.data?.watches ?? [], [ciWatches.data]);

  /** Sources that failed for a reason other than a missing verb, for one quiet notice each. */
  const failures = [
    { label: archived ? 'the archive' : 'the fleet', query: archived ? archivedList : snapshot },
    { label: 'approvals', query: approvals },
    { label: 'sessions', query: sessions },
    { label: 'hosted sessions', query: hosted },
    { label: 'tasks', query: tasks },
    { label: 'CI watches', query: ciWatches },
    ...(!archived ? [{ label: 'contracts', query: contracts }] : []),
  ].filter(({ label, query }) => query.isError && (label === 'contracts' || !isMethodUnavailableError(query.error)));

  // A hosted list answer without a `sessions` array (an unmodeled verb, an older
  // daemon) is "could not be read", never an empty list.
  const hostedUnreadable = hosted.isSuccess
    && !(Boolean(hosted.data) && typeof hosted.data === 'object' && Array.isArray((hosted.data as { sessions?: unknown }).sessions));

  const firstLoad = (archived ? archivedList.isPending : snapshot.isPending) && approvals.isPending;

  return {
    contracts,
    contractRecords,
    snapshot,
    archivedList,
    approvals,
    sessions,
    hosted,
    tasks,
    ciWatches,
    attemptGroups,
    nodes,
    liveNodes,
    approvalRecords,
    sessionRecords,
    hostedRecords,
    taskRecords,
    watchRecords,
    failures,
    hostedUnreadable,
    firstLoad,
    truncated: !archived && snapshot.isSuccess && snapshot.data.truncated
      ? { shown: snapshot.data.nodes.length, total: snapshot.data.totalCount }
      : null,
  };
}
