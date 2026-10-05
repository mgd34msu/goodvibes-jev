/**
 * A fleet process in the Work view's detail pane: an agent, a review chain, a
 * workstream (with its task graph), a watcher, a background process, or an
 * observed external agent. Merges the old Fleet and Workstream details.
 *
 * Actions stay wire-backed only (lib/fleet.ts wireBackedActions): steer and
 * detach for a node with a live session, stop for a watcher, archive for a
 * finished subtree, restore from the archive. Every other capability flag
 * gets an honest note instead of a button. An observed external agent is
 * visibility only; it can be steered over a real tmux channel and never
 * stopped from here.
 *
 * A pending approval correlated to the node (the same correlation the daemon
 * uses to light up 'awaiting-approval') is shown as a row that opens that
 * approval, so an ask lives in exactly one place.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, OctagonX, SendHorizontal } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { ApprovalRecord, FleetProcessNode } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import {
  approvalsForNode,
  formatDurationMs,
  isObservedKind,
  isTerminalState,
  unbackedCapabilityNote,
  wireBackedActions,
} from '../../lib/fleet';
import { isTerminalApprovalStatus } from '../../lib/approvals';
import { compactJson } from '../../lib/object';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { NodeHeadline, NodeReviewSummary, NodeStallNote } from '../../components/fleet/NodeTells';
import { TaskGraphPanel } from '../../components/fleet/TaskGraphPanel';
import { PriceSourceNote } from '../../components/pricing/PriceSourceNote';
import { DetailPane, DetailSection, Disclosure, Facts } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Field, Textarea } from '../../components/ui/Field';
import { Row, RowList } from '../../components/ui/Row';
import { StatusDot } from '../../components/ui/StatusDot';
import { FleetSessionActions } from '../fleet/FleetSessionActions';
import { approvalTitle, attentionPhrase, fleetKindPhrase, fleetStatePhrase, fleetTone, knownCost, whenLabel } from './work-items';

export interface ProcessDetailProps {
  node: FleetProcessNode;
  archived: boolean;
  approvals: readonly ApprovalRecord[];
  /** Open another Work item (a correlated approval, a child). */
  onOpenItem: (key: string) => void;
  onClose: () => void;
  /** The node left the list (archived, restored). */
  onGone: () => void;
  /** Read the canonical contract tree while retaining this process control surface. */
  onOpenContract?: () => void;
}

function ObservedSteer({ node, observed }: { node: FleetProcessNode; observed: NonNullable<FleetProcessNode['observed']> }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState('');
  const steer = useMutation({
    mutationFn: (text: string) => sdk.operator.fleet.observed.steer(node.id, text),
    onSuccess: (result) => {
      if (result.queued) {
        toast({ title: 'Sent', description: 'Message delivered over the external session’s channel.', tone: 'success' });
        setDraft('');
      } else {
        toast({ title: 'Not delivered', description: result.reason ?? 'The daemon could not deliver this message.', tone: 'danger' });
      }
    },
    onError: (error: unknown) => {
      toast({ title: 'Steer failed', description: formatError(error), tone: 'danger' });
    },
  });

  return (
    <DetailSection title="External session">
      <p className="work-prose" role="note">
        An externally launched coding-agent session GoodVibes did not start; visibility only. It is never stoppable or
        interruptible from here.
      </p>
      <Facts
        items={[
          { label: 'Process id', value: String(observed.pid) },
          { label: 'Liveness', value: `${observed.liveness.state === 'active' ? 'Active' : 'Quiet'}: ${observed.liveness.detail}` },
        ]}
      />
      {observed.steer.kind === 'tmux' ? (
        <form
          className="work-steer__stack"
          aria-label="Observed foreign agent"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = draft.trim();
            if (trimmed) steer.mutate(trimmed);
          }}
        >
          <Field label={`Send to this session (tmux pane ${observed.steer.paneId})`}>
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message to send over this session's terminal"
              rows={2}
            />
          </Field>
          <div>
            <Button type="submit" icon={<SendHorizontal aria-hidden="true" />} disabled={steer.isPending || !draft.trim()}>
              {steer.isPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
      ) : (
        <p className="work-prose" role="note">{observed.steer.reason}</p>
      )}
    </DetailSection>
  );
}

export function ProcessDetail({ node, archived, approvals, onOpenItem, onClose, onGone, onOpenContract }: ProcessDetailProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const backed = useMemo(() => wireBackedActions(node), [node]);
  const unbackedNote = useMemo(() => unbackedCapabilityNote(node), [node]);
  const pendingApprovals = useMemo(
    () => approvalsForNode(node, approvals).filter((a) => !isTerminalApprovalStatus(a.status)),
    [node, approvals],
  );
  const sessionId = node.sessionRef?.sessionId;
  const cost = knownCost(node);

  const invalidateFleet = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.fleet }),
      queryClient.invalidateQueries({ queryKey: queryKeys.fleetArchived }),
    ]);
  };

  const archiveNode = useMutation({
    mutationFn: (id: string) => sdk.operator.fleet.archive(id),
    onSuccess: async (result) => {
      if (result.archived) {
        toast({ title: `Archived (${result.count} node${result.count === 1 ? '' : 's'})`, tone: 'info' });
        onGone();
        await invalidateFleet();
      } else {
        toast({ title: 'Not archived', description: result.reason ?? 'The daemon refused to archive this subtree.', tone: 'danger' });
      }
    },
    onError: (error: unknown) => {
      toast({ title: 'Archive failed', description: formatError(error), tone: 'danger' });
    },
  });

  const restoreNode = useMutation({
    mutationFn: (id: string) => sdk.operator.fleet.unarchive(id),
    onSuccess: async (result) => {
      toast({
        title: result.restored > 0
          ? `Restored ${result.restored} node${result.restored === 1 ? '' : 's'} to the live fleet`
          : 'Nothing restored for this node',
        tone: 'info',
      });
      onGone();
      await invalidateFleet();
    },
    onError: (error: unknown) => {
      toast({ title: 'Restore failed', description: formatError(error), tone: 'danger' });
    },
  });

  const stopWatcher = useMutation({
    mutationFn: (watcherId: string) => sdk.operator.watchers.stop(watcherId),
    onSuccess: async () => {
      toast({ title: 'Stop requested', tone: 'info' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
    },
    onError: (error: unknown) => {
      toast({ title: 'Stop failed', description: formatError(error), tone: 'danger' });
    },
  });

  async function handleStop(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Stop this watcher?',
      target: node.label || node.id,
      description: 'It stops right away and reports nothing further.',
      confirmLabel: 'Stop',
      tone: 'danger',
    });
    if (ok) stopWatcher.mutate(node.id);
  }

  const statusWord = node.needsAttention
    ? attentionPhrase(node.needsAttention.reason)
    : fleetStatePhrase(node.state);

  const actions = (
    <>
      {archived && (
        <Button size="sm" icon={<ArchiveRestore aria-hidden="true" />} disabled={restoreNode.isPending} onClick={() => restoreNode.mutate(node.id)}>
          {restoreNode.isPending ? 'Restoring…' : 'Restore to live fleet'}
        </Button>
      )}
      {!archived && isTerminalState(node.state) && (
        <Button size="sm" icon={<Archive aria-hidden="true" />} disabled={archiveNode.isPending} onClick={() => archiveNode.mutate(node.id)}>
          {archiveNode.isPending ? 'Archiving…' : 'Archive'}
        </Button>
      )}
      {backed.has('stop') && (
        <Button size="sm" variant="danger" icon={<OctagonX aria-hidden="true" />} disabled={stopWatcher.isPending} onClick={() => void handleStop()}>
          {stopWatcher.isPending ? 'Stopping…' : 'Stop'}
        </Button>
      )}
    </>
  );

  return (
    <DetailPane
      title={node.label || node.id}
      status={(
        <span className="work-status" data-attention-reason={node.needsAttention?.reason}>
          <StatusDot tone={fleetTone(node)} />
          {statusWord.charAt(0).toUpperCase() + statusWord.slice(1)}
        </span>
      )}
      meta={[fleetKindPhrase(node.kind), whenLabel(node.startedAt) ? `started ${whenLabel(node.startedAt)}` : ''].filter(Boolean).join(' · ')}
      actions={actions}
      onClose={onClose}
      closeLabel="Close process"
    >
      {confirm.element}
      <NodeHeadline node={node} block />
      <NodeStallNote node={node} />
      {node.needsAttention?.detail && <p className="dv-notice" role="note">{node.needsAttention.detail}</p>}
      {node.task && <p className="work-prose">{node.task}</p>}

      {pendingApprovals.length > 0 && (
        <DetailSection title="Waiting on you">
          <RowList aria-label="Approvals for this process">
            {pendingApprovals.map((approval) => (
              <Row
                key={approval.id}
                leading={<StatusDot tone="warn" />}
                title={approvalTitle(approval)}
                meta={[`${approval.request.analysis.riskLevel} risk`, whenLabel(approval.createdAt)].filter(Boolean).join(' · ')}
                onSelect={() => onOpenItem(`approval:${approval.id}`)}
              />
            ))}
          </RowList>
        </DetailSection>
      )}

      {node.kind === 'observed-external' && node.observed && <ObservedSteer node={node} observed={node.observed} />}

      {(backed.has('steer') || backed.has('detach')) && sessionId && (
        <DetailSection title="Steer">
          <FleetSessionActions sessionId={sessionId} steerable={backed.has('steer')} detachable={backed.has('detach')} />
        </DetailSection>
      )}

      {unbackedNote && <p className="work-prose work-prose--quiet" role="note">{unbackedNote}</p>}

      <NodeReviewSummary node={node} />

      {node.currentActivity && (
        <DetailSection title="Current activity">
          <p className="work-prose">{node.currentActivity.toolName ? `${node.currentActivity.toolName}: ` : ''}{node.currentActivity.text}</p>
        </DetailSection>
      )}

      <Facts
        items={[
          { label: 'Elapsed', value: typeof node.elapsedMs === 'number' ? formatDurationMs(node.elapsedMs) : '' },
          { label: 'Model', value: node.model ? `${node.provider ? `${node.provider}/` : ''}${node.model}` : '' },
          {
            label: 'Cost',
            value: cost && !isObservedKind(node.kind) ? (
              <span className="work-cost">
                {cost}
                <PriceSourceNote provider={node.provider} model={node.model} costSource={node.costSource} pricingAsOf={node.pricingAsOf} />
              </span>
            ) : '',
          },
          { label: 'Session', value: sessionId ?? '' },
          { label: 'Agent', value: node.sessionRef?.agentId ?? '' },
        ]}
      />

      {onOpenContract && <Button variant="ghost" onClick={onOpenContract}>Contract evidence</Button>}

      {node.usage && (
        <DetailSection title="Usage">
          <Facts
            items={[
              { label: 'Input tokens', value: node.usage.inputTokens.toLocaleString() },
              { label: 'Output tokens', value: node.usage.outputTokens.toLocaleString() },
              { label: 'Cache read', value: node.usage.cacheReadTokens.toLocaleString() },
              { label: 'Cache write', value: node.usage.cacheWriteTokens.toLocaleString() },
              { label: 'Model calls', value: String(node.usage.llmCallCount) },
              { label: 'Turns', value: String(node.usage.turnCount) },
              { label: 'Tool calls', value: String(node.usage.toolCallCount) },
            ]}
          />
        </DetailSection>
      )}

      {node.kind === 'contract-group' && node.id.startsWith('group:') && (
        <TaskGraphPanel workstreamId={node.id.slice('group:'.length)} />
      )}

      <Disclosure summary="Raw node">
        <pre className="work-raw">{compactJson(node)}</pre>
      </Disclosure>
    </DetailPane>
  );
}
