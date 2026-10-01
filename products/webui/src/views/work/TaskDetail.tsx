/**
 * A runtime task (tasks.*) in the Work view's detail pane. Statuses render
 * verbatim, with no invented progress or ETA. Cancel is offered only when the
 * task reports itself cancellable; retry only for a failed or cancelled task
 * (TaskManager.retryTask's own guard). On a phone both confirm first, naming
 * the task.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, XCircle } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { RuntimeTaskSummary } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError, isSessionClosedError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { DetailPane, Facts } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { StatusDot } from '../../components/ui/StatusDot';
import { whenLabel } from './work-items';

function friendlyError(error: unknown): string {
  if (isSessionClosedError(error)) return 'That session is closed. The task can no longer be actioned.';
  return formatError(error);
}

export function TaskDetail({ task, onClose }: { task: RuntimeTaskSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isPhone = useIsPhoneViewport();
  const confirm = useConfirm();

  const cancel = useMutation({
    mutationFn: (taskId: string) => sdk.operator.tasks.cancel(taskId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      toast({ title: 'Task cancelled', tone: 'info' });
    },
    onError: (error: unknown) => toast({ title: 'Cancel failed', description: friendlyError(error), tone: 'danger' }),
  });
  const retry = useMutation({
    mutationFn: (taskId: string) => sdk.operator.tasks.retry(taskId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      toast({ title: 'Task retried', tone: 'success' });
    },
    onError: (error: unknown) => toast({ title: 'Retry failed', description: friendlyError(error), tone: 'danger' }),
  });

  async function handleCancel(): Promise<void> {
    if (isPhone && !(await confirm.ask({
      title: 'Cancel this task?',
      target: task.title || task.id,
      description: 'It stops now and is marked cancelled.',
      confirmLabel: 'Cancel task',
      cancelLabel: 'Keep running',
      tone: 'danger',
    }))) return;
    cancel.mutate(task.id);
  }

  async function handleRetry(): Promise<void> {
    if (isPhone && !(await confirm.ask({ title: 'Retry this task?', target: task.title || task.id, description: 'It runs again as a new attempt.', confirmLabel: 'Retry' }))) return;
    retry.mutate(task.id);
  }

  const canRetry = task.status === 'failed' || task.status === 'cancelled';
  const tone = task.status === 'failed' ? 'bad' : task.status === 'running' ? 'live' : task.status === 'blocked' ? 'warn' : task.status === 'completed' ? 'ok' : 'idle';

  return (
    <DetailPane
      title={task.title || task.id}
      status={<span className="work-status"><StatusDot tone={tone} />{task.status}</span>}
      meta={`Task · ${task.kind}`}
      onClose={onClose}
      closeLabel="Close task"
      actions={(
        <>
          {task.cancellable && (
            <Button size="sm" icon={<XCircle aria-hidden="true" />} disabled={cancel.isPending} onClick={() => void handleCancel()}>
              {cancel.isPending ? 'Cancelling…' : 'Cancel task'}
            </Button>
          )}
          {canRetry && (
            <Button size="sm" icon={<RotateCcw aria-hidden="true" />} disabled={retry.isPending} onClick={() => void handleRetry()}>
              {retry.isPending ? 'Retrying…' : 'Retry'}
            </Button>
          )}
        </>
      )}
    >
      {confirm.element}
      {task.error && <p className="dv-notice dv-notice--bad" role="alert">{task.error}</p>}
      <Facts
        items={[
          { label: 'Owner', value: task.owner },
          { label: 'Kind', value: task.kind },
          { label: 'Queued', value: whenLabel(task.queuedAt) },
          { label: 'Started', value: task.startedAt ? whenLabel(task.startedAt) : '' },
          { label: 'Ended', value: task.endedAt ? whenLabel(task.endedAt) : '' },
          { label: 'Parent task', value: task.parentTaskId ?? '' },
          { label: 'Task id', value: <span className="work-mono">{task.id}</span> },
        ]}
      />
    </DetailPane>
  );
}
