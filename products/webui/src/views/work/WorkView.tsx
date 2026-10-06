/**
 * Work: everything running for you and everything that needs you, on one
 * page (design doc "Data views" and "Navigation map"). It replaces the
 * Sessions, Hosted, Fleet, Approvals and tasks, Workstream, CI and Checkpoints
 * pages; their old links redirect here (lib/router.ts).
 *
 * Layout: the data-view template. Header "Work" with the one-line count and
 * "New" as the one primary action; a filter row with the kind Segmented (All,
 * Sessions, Agents, Processes), a search field and a Show select (active,
 * with finished, the fleet archive); then a list and detail split. The list
 * is "Needs you" first (approvals, input asks, pick-a-winner, merge
 * conflicts), then Running, then Finished when shown. On desktop the first
 * item that needs you opens in the detail by itself; the detail folds the
 * sidebar to its rail while it is open.
 *
 * Deep links: a push notification's `#approval-action=…` completes the
 * decision on mount (useApprovalActions); `#fleet-node=…` opens that process.
 * `?tab=checkpoints` (the old Checkpoints page) opens the first session on its
 * Checkpoints tab, or the workspace checkpoints when there is no session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, History, Inbox, RefreshCw, Search } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import type { WorkTab } from '../../lib/router';
import { WORK } from '../../components/shell/nav';
import { parseFleetFocusFromHash, stripFleetFocusFragment } from '../../lib/push/fleet-focus-link';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { riskTone } from '../../lib/approvals';
import {
  DataPage,
  DetailPane,
  Disclosure,
  EmptyState,
  ListDetail,
  RowGroup,
  SkeletonRows,
} from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Input } from '../../components/ui/Field';
import { Row } from '../../components/ui/Row';
import { Segmented } from '../../components/ui/Segmented';
import { Select } from '../../components/ui/Select';
import { StatusDot } from '../../components/ui/StatusDot';
import { PHONE_QUERY, useMediaQuery } from '../../components/ui/overlay';
import { ApprovalDetail } from './ApprovalDetail';
import { AttemptGroupDetail } from './AttemptGroupDetail';
import { CheckpointsPanel } from './CheckpointsPanel';
import { CiWatchDetail } from './CiWatchDetail';
import { HostedSessionDetail, useHostedAttachment } from './HostedSessionDetail';
import { NewWorkMenu } from './NewWorkMenu';
import { useContractScope } from '../../hooks/useContracts';
import type { ClientLifetime } from '../../lib/client-lifetime';
import { ContractDetail } from './ContractDetail';
import { ProcessDetail } from './ProcessDetail';
import { SessionDetail, type SessionTab } from './SessionDetail';
import { TaskDetail } from './TaskDetail';
import { useApprovalActions } from './useApprovalActions';
import { useWorkData } from './useWorkData';
import { buildWorkItems, groupWorkItems, workSummary, type WorkItem, type WorkKind } from './work-items';
import '../../styles/components/work.css';
import { nonEmpty } from '../../lib/non-empty';

/** The workspace checkpoints detail, for when no session exists. */
const WORKSPACE_CHECKPOINTS_KEY = 'workspace:checkpoints';

type ShowScope = 'active' | 'finished' | 'archived';

export interface WorkViewProps {
  tab?: string;
  onTabChange: (tab: WorkTab) => void;
  /** The fleet subscription is live (the poll recedes to a safety cadence). */
  subscriptionActive?: boolean;
  /** The session-update stream is paused (steer confirmations may lag). */
  streamPaused?: boolean;
  /** Open a session in the Chat view. */
  onOpenSession?: (sessionId: string) => void;
}

function kindFromTab(tab: string | undefined): WorkKind | 'all' {
  if (tab === 'sessions' || tab === 'checkpoints') return 'sessions';
  if (tab === 'agents' || tab === 'processes') return tab;
  return 'all';
}

function ItemRow({ item, selected, onSelect }: { item: WorkItem; selected: boolean; onSelect: () => void }) {
  return (
    <Row
      className={item.depth > 0 ? 'work-row work-row--child' : 'work-row'}
      selected={selected}
      onSelect={onSelect}
      leading={(
        <span className="work-row__lead" style={item.depth > 0 ? { marginLeft: `${Math.min(item.depth, 4) * 16}px` } : undefined}>
          <StatusDot tone={item.tone} />
        </span>
      )}
      title={item.title}
      meta={(
        <>
          <span className="work-row__status" data-attention-reason={item.attentionReason}>{item.status}</span>
          {item.meta ? ` · ${item.meta}` : ''}
        </>
      )}
      trailing={item.value ? <span className="dv-value">{item.value}</span> : undefined}
      aria-label={`${item.title}, ${item.status}`}
    />
  );
}

export function WorkView(props: WorkViewProps) {
  const contractScope = useContractScope();
  // Reset selection and drafts synchronously on identity change. A remembered
  // contract id must never be replayed against a newly signed-in account.
  return <WorkViewContent key={contractScope.revision} {...props} contractScope={contractScope} />;
}

function WorkViewContent({ contractScope, tab, onTabChange, subscriptionActive = true, streamPaused = false, onOpenSession }: WorkViewProps & { contractScope: ClientLifetime }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const phone = useMediaQuery(PHONE_QUERY);
  const kind = kindFromTab(tab);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ShowScope>('active');
  const [archiving, setArchiving] = useState(false);

  // A needs-input push opens the app at #fleet-node=<id>: read it once, then scrub it.
  const [initialFocus] = useState(() => (typeof window !== 'undefined' ? parseFleetFocusFromHash(window.location.hash) : null));
  useEffect(() => {
    if (initialFocus) stripFleetFocusFragment();
  }, [initialFocus]);

  const [selectedKey, setSelectedKey] = useState<string>(() => (initialFocus ? `fleet:${initialFocus.nodeId}` : ''));
  // After the person closes a detail, the first needs-you item does not reopen by itself.
  const dismissedRef = useRef(Boolean(initialFocus));
  const [sessionTab, setSessionTab] = useState<SessionTab>(tab === 'checkpoints' ? 'checkpoints' : 'transcript');

  const selectedHostedId = selectedKey.startsWith('hosted:') ? selectedKey.slice('hosted:'.length) : null;
  const [hostedStreamConnected, setHostedStreamConnected] = useState(false);
  const data = useWorkData({
    contractScope,
    subscriptionActive,
    archived: scope === 'archived',
    includeFinished: scope !== 'active',
    hostedStreamConnected,
  });
  const closeDetail = useCallback(() => {
    dismissedRef.current = true;
    setSelectedKey('');
  }, []);
  const hostedAttachment = useHostedAttachment(selectedHostedId, data.hostedRecords, closeDetail);
  useEffect(() => {
    setHostedStreamConnected(hostedAttachment.streamConnected);
  }, [hostedAttachment.streamConnected]);

  const approvalActions = useApprovalActions();

  const items = useMemo(() => buildWorkItems({
    contracts: data.contractRecords,
    approvals: scope === 'archived' ? [] : data.approvalRecords,
    nodes: data.nodes,
    attemptGroups: scope === 'archived' ? [] : data.attemptGroups,
    sessions: scope === 'archived' ? [] : data.sessionRecords,
    hosted: scope === 'archived' ? [] : data.hostedRecords,
    tasks: scope === 'archived' ? [] : data.taskRecords,
    ciWatches: scope === 'archived' ? [] : data.watchRecords,
    archived: scope === 'archived',
  }), [scope, data.contractRecords, data.approvalRecords, data.nodes, data.attemptGroups, data.sessionRecords, data.hostedRecords, data.taskRecords, data.watchRecords]);
  const groups = useMemo(() => groupWorkItems(items, kind, query), [items, kind, query]);
  const selectedItem = useMemo(() => items.find((item) => item.key === selectedKey) ?? null, [items, selectedKey]);

  const openItem = useCallback((key: string) => {
    setSelectedKey(key);
    if (key.startsWith('session:')) setSessionTab((current) => (tab === 'checkpoints' ? 'checkpoints' : current));
  }, [tab]);

  // Desktop: the first item that needs you opens by itself, until the person closes a detail.
  useEffect(() => {
    if (phone || selectedKey || dismissedRef.current) return;
    const first = groups.needs[0];
    if (first) setSelectedKey(first.key);
  }, [phone, selectedKey, groups.needs]);

  // The old Checkpoints page: a session's Checkpoints tab, or the workspace checkpoints.
  const checkpointsHandled = useRef(false);
  useEffect(() => {
    if (tab !== 'checkpoints' || checkpointsHandled.current || !data.sessions.isFetched) return;
    checkpointsHandled.current = true;
    const firstSession = items.find((item) => item.type === 'session');
    setSessionTab('checkpoints');
    setSelectedKey(firstSession ? firstSession.key : WORKSPACE_CHECKPOINTS_KEY);
  }, [tab, items, data.sessions.isFetched]);

  const archiveFinished = async () => {
    setArchiving(true);
    try {
      const result = await sdk.operator.fleet.archiveFinished();
      toast({
        title: result.archivedCount > 0
          ? `Archived ${result.archivedCount} finished process${result.archivedCount === 1 ? '' : 'es'}`
          : 'No fully finished processes to archive',
        tone: 'info',
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
    } catch (error) {
      toast({ title: 'Archive failed', description: formatError(error), tone: 'danger' });
    } finally {
      setArchiving(false);
    }
  };

  const refreshAll = () => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.contracts }),
      data.snapshot.refetch(),
      data.approvals.refetch(),
      data.sessions.refetch(),
      data.hosted.refetch(),
      data.tasks.refetch(),
      data.ciWatches.refetch(),
      ...(scope === 'archived' ? [data.archivedList.refetch()] : []),
    ]);
  };

  const detail = (() => {
    if (selectedKey === WORKSPACE_CHECKPOINTS_KEY) {
      return (
        <DetailPane title="Workspace checkpoints" meta="Snapshots of the workspace tree" onClose={closeDetail} closeLabel="Close checkpoints">
          <CheckpointsPanel />
        </DetailPane>
      );
    }
    if (!selectedKey) return null;
    const [type, ...rest] = selectedKey.split(':');
    const id = rest.join(':');
    switch (type) {
      case 'contract':
        return <ContractDetail key={id} id={id} lifetime={contractScope} live={subscriptionActive} onClose={closeDetail}
          onOpenProcess={data.liveNodes.some((node) => node.kind === 'contract' && node.id === `contract:${id}`)
            ? () => openItem(`fleet:contract:${id}`) : undefined} />;
      case 'approval': {
        const record = data.approvalRecords.find((a) => a.id === id);
        return record ? <ApprovalDetail key={record.id} record={record} actions={approvalActions} onClose={closeDetail} onOpenSession={onOpenSession} /> : null;
      }
      case 'fleet': {
        const node = data.nodes.find((n) => n.id === id) ?? data.liveNodes.find((n) => n.id === id);
        return node ? (
          <ProcessDetail
            key={node.id}
            node={node}
            archived={scope === 'archived'}
            approvals={data.approvalRecords}
            onOpenItem={openItem}
            onClose={closeDetail}
            onGone={closeDetail}
            onOpenContract={node.kind === 'contract' && node.id.startsWith('contract:') ? () => openItem(node.id) : undefined}
          />
        ) : null;
      }
      case 'attempt-group': {
        const group = data.attemptGroups.find((g) => g.groupId === id);
        return group ? <AttemptGroupDetail key={group.groupId} group={group} onClose={closeDetail} /> : null;
      }
      case 'session': {
        const record = data.sessionRecords.find((s) => s.id === id);
        return record ? (
          <SessionDetail
            key={record.id}
            record={record}
            agents={data.liveNodes.filter((n) => n.sessionRef?.sessionId === record.id)}
            tab={sessionTab}
            onTabChange={setSessionTab}
            streamPaused={streamPaused}
            onOpenItem={openItem}
            onOpenInChat={onOpenSession}
            onClose={closeDetail}
          />
        ) : null;
      }
      case 'hosted': {
        const row = data.hostedRecords.find((h) => h.id === id);
        return <HostedSessionDetail attachment={hostedAttachment} fallbackTitle={nonEmpty(row?.title) ?? id} onClose={closeDetail} />;
      }
      case 'task': {
        const task = data.taskRecords.find((t) => t.id === id);
        return task ? <TaskDetail key={task.id} task={task} onClose={closeDetail} /> : null;
      }
      case 'ci-watch': {
        const watch = data.watchRecords.find((w) => w.id === id);
        return watch ? <CiWatchDetail key={watch.id} watch={watch} onClose={closeDetail} onOpenSession={onOpenSession} /> : null;
      }
      default:
        return null;
    }
  })();

  const pendingApprovals = data.approvalRecords.filter((a) => a.status === 'pending' || a.status === 'claimed');
  const showFinished = scope !== 'active';
  const nothingAtAll = !data.firstLoad && (scope === 'archived' || !data.contracts.isFetching) && data.failures.length === 0 && groups.needs.length === 0 && groups.running.length === 0
    && (!showFinished || groups.finished.length === 0);

  const list = (
    <>
      {data.failures.map(({ label, query: failed }) => (
        <p key={label} className="dv-notice dv-notice--bad work-notice" role="alert">
          Could not load {label}: {formatError(failed.error)}
          {' '}
          <Button size="sm" variant="ghost" onClick={() => void failed.refetch()}>Retry</Button>
        </p>
      ))}
      {kind === 'sessions' && data.hostedUnreadable && (
        <p className="dv-notice work-notice" role="note">
          The daemon answered the hosted session list in a shape this client does not understand, so hosted sessions are not shown.
        </p>
      )}
      {data.truncated && (
        <p className="dv-notice work-notice" role="note">
          Showing {data.truncated.shown} of {data.truncated.total} processes: the daemon caps the fleet snapshot at 2000.
        </p>
      )}

      {!data.firstLoad && scope !== 'archived' && data.contracts.isPending && data.contracts.isFetching && <SkeletonRows count={2} label="Loading contracts" />}
      {data.firstLoad && <SkeletonRows count={6} label="Loading work" />}

      {!data.firstLoad && groups.needs.length > 0 && (
        <RowGroup label="Needs you" count={groups.needs.length}>
          {groups.needs.map((item) => (
            <ItemRow key={item.key} item={item} selected={item.key === selectedKey} onSelect={() => openItem(item.key)} />
          ))}
        </RowGroup>
      )}

      {!data.firstLoad && groups.running.length > 0 && (
        <RowGroup label="Running" count={groups.running.length}>
          {groups.running.map((item) => (
            <ItemRow key={item.key} item={item} selected={item.key === selectedKey} onSelect={() => openItem(item.key)} />
          ))}
        </RowGroup>
      )}

      {!data.firstLoad && showFinished && groups.finished.length > 0 && (
        <RowGroup label={scope === 'archived' ? 'Archived' : 'Finished'} count={groups.finished.length}>
          {groups.finished.map((item) => (
            <ItemRow key={item.key} item={item} selected={item.key === selectedKey} onSelect={() => openItem(item.key)} />
          ))}
        </RowGroup>
      )}

      {nothingAtAll && (
        query.trim() ? (
          <EmptyState icon={<Search />} action={<Button onClick={() => setQuery('')}>Clear search</Button>}>
            Nothing here matches “{query.trim()}”.
          </EmptyState>
        ) : scope === 'archived' ? (
          <EmptyState icon={<Archive />} action={<Button onClick={() => setScope('active')}>Show active work</Button>}>
            Finished processes you archive stay browsable here.
          </EmptyState>
        ) : (
          <EmptyState icon={<Inbox />} action={<Button onClick={() => setScope('finished')}>Show finished work</Button>}>
            Sessions, agents and processes appear here while they run, and anything waiting on you shows first.
          </EmptyState>
        )
      )}

      {!data.firstLoad && (
        <div className="work-list-footer">
          {kind !== 'agents' && (
            <Button
              size="sm"
              variant="ghost"
              icon={<History aria-hidden="true" />}
              onClick={() => { dismissedRef.current = true; setSessionTab('checkpoints'); setSelectedKey(WORKSPACE_CHECKPOINTS_KEY); }}
            >
              Workspace checkpoints
            </Button>
          )}
          {scope !== 'archived' && (
            <Button size="sm" variant="ghost" icon={<Archive aria-hidden="true" />} disabled={archiving} onClick={() => void archiveFinished()}>
              {archiving ? 'Archiving…' : 'Archive finished processes'}
            </Button>
          )}
        </div>
      )}

      {!data.firstLoad && pendingApprovals.length > 1 && (
        <Disclosure summary="Approvals by category and risk">
          <ApprovalBreakdown records={pendingApprovals} />
        </Disclosure>
      )}
    </>
  );

  return (
    <DataPage
      title={WORK.label}
      description={data.firstLoad ? WORK.description : workSummary(items.filter((i) => scope === 'archived' || i.group !== 'finished'))}
      action={<NewWorkMenu lifetime={contractScope} onCreated={(key) => { dismissedRef.current = true; setSelectedKey(key); }} />}
      filters={(
        <>
          <Segmented<WorkTab>
            label="Kind of work"
            value={kind === 'all' ? 'all' : kind}
            options={WORK.tabs.map((t) => ({ value: t.tab as WorkTab, label: t.label }))}
            onChange={(next) => onTabChange(next)}
          />
          <div className="dv-filters__search">
            <Input
              type="search"
              className="gv-input--search"
              aria-label="Search work"
              placeholder="Search work"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="dv-filters__end">
            <Select<ShowScope>
              aria-label="Show"
              value={scope}
              onChange={(next) => { setScope(next); if (selectedKey.startsWith('fleet:') || selectedKey.startsWith('contract:')) setSelectedKey(''); }}
              placement="bottom-end"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'finished', label: 'Active and finished' },
                { value: 'archived', label: 'Archive' },
              ]}
            />
            <IconButton label="Refresh" icon={<RefreshCw />} onClick={refreshAll} />
          </div>
        </>
      )}
    >
      <ListDetail
        list={list}
        detail={detail}
        detailOpen={Boolean(detail)}
        onCloseDetail={closeDetail}
        listLabel="Work items"
        detailLabel={selectedItem ? selectedItem.title : 'Detail'}
        backLabel="All work"
      />
    </DataPage>
  );
}

/** Category by risk counts for the pending approvals (the old approval-class matrix). */
function ApprovalBreakdown({ records }: { records: readonly import('../../lib/goodvibes').ApprovalRecord[] }) {
  const rows = useMemo(() => {
    const byCategory = new Map<string, Map<string, number>>();
    for (const record of records) {
      const category = record.request.category || 'uncategorized';
      const risk = record.request.analysis.riskLevel || 'unknown';
      const byRisk = byCategory.get(category) ?? new Map<string, number>();
      byRisk.set(risk, (byRisk.get(risk) ?? 0) + 1);
      byCategory.set(category, byRisk);
    }
    return [...byCategory.entries()].map(([category, byRisk]) => ({
      category,
      total: [...byRisk.values()].reduce((sum, n) => sum + n, 0),
      byRisk: [...byRisk.entries()].sort((a, b) => b[1] - a[1]),
    })).sort((a, b) => b.total - a.total);
  }, [records]);
  return (
    <table className="work-breakdown" aria-label="Approvals by category and risk">
      <tbody>
        {rows.map(({ category, total, byRisk }) => (
          <tr key={category}>
            <th scope="row">{category}</th>
            <td>
              {byRisk.map(([risk, count]) => (
                <span key={risk} className="work-breakdown__risk">
                  <StatusDot tone={riskTone(risk) === 'bad' ? 'bad' : riskTone(risk) === 'warning' ? 'warn' : 'idle'} />
                  {risk} {count}
                </span>
              ))}
            </td>
            <td className="dv-value">{total}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
