/**
 * Workspace checkpoints, shown in a session's Checkpoints tab (design doc
 * "Navigation map": "A checkpoint belongs to a session") and, when no session
 * exists, as the Work view's workspace checkpoints detail.
 *
 * Rows list checkpoints newest first; picking one shows its diff against the
 * working tree or another checkpoint (checkpoints.diff's `b`), with restore.
 * Moved from the old Checkpoints view with its rules intact: restore is a
 * destructive rewrite of the workspace files, so it always confirms, first fetching a
 * non-destructive restorePreview that names the files and mints the single-use
 * token the restore is authorized with (a failed preview falls back to an
 * explicit confirm:true; NOT_FOUND reports the checkpoint as gone). A refused
 * restore is reported as refused, never as done. create's noop ("tree
 * unchanged") is information, not an error.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, History, RotateCcw } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { WorkspaceCheckpoint } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import {
  CHECKPOINT_NOOP_MESSAGE,
  formatBytes,
  kindLabel,
  restoreConfirmMessage,
  restoreConfirmTitle,
  restoreConfirmMessageWithPreview,
  retentionLabel,
  sortCheckpointsNewestFirst,
} from '../../lib/checkpoints';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { errorCode, formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { CodeFrame, DetailSection, EmptyState, Facts, SkeletonRows } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { Row, RowList } from '../../components/ui/Row';
import { Select } from '../../components/ui/Select';
import { whenLabel } from './work-items';
import { nonEmpty } from '../../lib/non-empty';

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'NOT_FOUND';
}

export function CheckpointsPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isPhone = useIsPhoneViewport();
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState('');
  // '' compares against the working tree; another id compares two checkpoints.
  const [compareToId, setCompareToId] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [restoringId, setRestoringId] = useState('');

  const list = useQuery({
    queryKey: queryKeys.checkpoints,
    queryFn: () => sdk.operator.checkpoints.list(),
  });
  const checkpoints = useMemo(() => sortCheckpointsNewestFirst(list.data?.checkpoints ?? []), [list.data]);
  const selected = useMemo(() => checkpoints.find((c) => c.id === selectedId) ?? null, [checkpoints, selectedId]);
  const compareOptions = useMemo(() => checkpoints.filter((c) => c.id !== selectedId), [checkpoints, selectedId]);

  useEffect(() => {
    if (compareToId && !checkpoints.some((c) => c.id === compareToId)) setCompareToId('');
  }, [checkpoints, compareToId]);

  const diff = useQuery({
    queryKey: [...queryKeys.checkpoints, selectedId, 'diff', compareToId || 'working-tree'],
    queryFn: () => sdk.operator.checkpoints.diff(compareToId ? { a: selectedId, b: compareToId } : { a: selectedId }),
    enabled: Boolean(selectedId),
  });

  const create = useMutation({
    mutationFn: () => {
      const trimmed = labelDraft.trim();
      return sdk.operator.checkpoints.create({ kind: 'manual', label: trimmed ? trimmed : undefined });
    },
    onSuccess: async (result) => {
      if (result.noop) {
        toast({ title: 'No checkpoint created', description: CHECKPOINT_NOOP_MESSAGE, tone: 'info' });
        return;
      }
      setLabelDraft('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.checkpoints });
      const created = result.checkpoint;
      if (created) {
        setSelectedId(created.id);
        toast({ title: 'Checkpoint created', description: created.label || created.id, tone: 'success' });
      }
    },
    onError: (error: unknown) => {
      toast({ title: 'Failed to create checkpoint', description: formatError(error), tone: 'danger' });
    },
  });

  const restore = useMutation({
    mutationFn: ({ checkpoint, confirmToken }: { checkpoint: WorkspaceCheckpoint; confirmToken?: string }) =>
      sdk.operator.checkpoints.restore(confirmToken ? { id: checkpoint.id, confirmToken } : { id: checkpoint.id, confirm: true }),
    onSuccess: async (result, { checkpoint }) => {
      if (result.refused || result.result === null) {
        toast({
          title: 'Restore not performed',
          description: result.refusal?.reason ?? 'The daemon refused the restore because it was not confirmed.',
          tone: 'warning',
        });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.checkpoints });
      toast({ title: 'Workspace restored', description: checkpoint.label || checkpoint.id, tone: 'success' });
    },
    onError: (error: unknown, { checkpoint }) => {
      toast({
        title: isNotFound(error) ? 'Checkpoint no longer exists' : 'Restore failed',
        description: isNotFound(error)
          ? `"${checkpoint.label || checkpoint.id}" was not found; it may have been garbage-collected.`
          : formatError(error),
        tone: 'danger',
      });
    },
  });

  async function handleRestore(checkpoint: WorkspaceCheckpoint): Promise<void> {
    let confirmToken: string | undefined;
    let description = restoreConfirmMessage();
    try {
      const preview = await sdk.operator.checkpoints.restorePreview({ id: checkpoint.id });
      confirmToken = preview.token;
      description = restoreConfirmMessageWithPreview(preview.preview);
    } catch (error) {
      if (isNotFound(error)) {
        toast({
          title: 'Checkpoint no longer exists',
          description: `"${checkpoint.label || checkpoint.id}" was not found; it may have been garbage-collected.`,
          tone: 'danger',
        });
        return;
      }
    }
    const ok = await confirm.ask({
      title: restoreConfirmTitle(checkpoint),
      description,
      confirmLabel: 'Restore',
      tone: 'danger',
    });
    if (!ok) return;
    setRestoringId(checkpoint.id);
    restore.mutate({ checkpoint, confirmToken });
  }

  async function handleCreate(): Promise<void> {
    if (isPhone) {
      const ok = await confirm.ask({
        title: 'Create a checkpoint?',
        description: labelDraft.trim()
          ? `Saves the workspace as “${labelDraft.trim()}”.`
          : 'Saves the current workspace as a checkpoint.',
        confirmLabel: 'Snapshot',
      });
      if (!ok) return;
    }
    create.mutate();
  }

  if (selected) {
    const compareTarget = compareToId ? compareOptions.find((c) => c.id === compareToId) ?? null : null;
    const compareLabel = compareToId ? (nonEmpty(compareTarget?.label) ?? compareToId) : 'the working tree';
    return (
      <div className="work-checkpoints" aria-label="Checkpoint detail">
        {confirm.element}
        <div>
          <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden="true" />} onClick={() => setSelectedId('')}>
            All checkpoints
          </Button>
        </div>
        <div className="work-checkpoints__head">
          <h4 className="work-checkpoints__title">{selected.label || selected.id}</h4>
          <Button
            icon={<RotateCcw aria-hidden="true" />}
            onClick={() => void handleRestore(selected)}
            disabled={restore.isPending && restoringId === selected.id}
            title="Restore the workspace to this checkpoint (destructive: confirms first)"
          >
            {restore.isPending && restoringId === selected.id ? 'Restoring…' : 'Restore this checkpoint'}
          </Button>
        </div>
        <Facts
          items={[
            { label: 'Kind', value: kindLabel(selected.kind) },
            { label: 'Retention', value: retentionLabel(selected.retentionClass) },
            { label: 'Size', value: formatBytes(selected.sizeBytes) },
            { label: 'Created', value: whenLabel(selected.createdAt) },
            { label: 'Commit', value: <span className="work-mono">{selected.commit.slice(0, 12) || 'unknown'}</span> },
            { label: 'Parent', value: selected.parentId ?? '' },
          ]}
        />
        <DetailSection
          title={`Diff against ${compareLabel}`}
          actions={(
            <Select
              aria-label="Compare checkpoint to"
              value={compareToId}
              onChange={setCompareToId}
              placement="bottom-end"
              options={[{ value: '', label: 'Working tree' }, ...compareOptions.map((c) => ({ value: c.id, label: c.label || c.id }))]}
            />
          )}
        >
          {diff.isPending && <SkeletonRows count={3} label="Loading diff" />}
          {diff.isError && (isNotFound(diff.error)
            ? <p className="work-prose" role="note">This checkpoint no longer exists (it may have been garbage-collected).</p>
            : (
              <p className="dv-notice dv-notice--bad" role="alert">
                {formatError(diff.error)}
                {' '}
                <Button size="sm" variant="ghost" onClick={() => void diff.refetch()}>Retry</Button>
              </p>
            ))}
          {diff.data && !diff.isError && (
            <>
              {diff.data.diff.files.length === 0 ? (
                <p className="work-prose" role="note">
                  {compareToId ? 'No file differences between these checkpoints.' : 'No file differences from the working tree.'}
                </p>
              ) : (
                <p className="work-prose">
                  {diff.data.diff.files.length} file{diff.data.diff.files.length === 1 ? '' : 's'} changed: {diff.data.diff.files.join(', ')}
                </p>
              )}
              {diff.data.diff.unifiedDiff && <CodeFrame label="Diff">{diff.data.diff.unifiedDiff}</CodeFrame>}
            </>
          )}
        </DetailSection>
      </div>
    );
  }

  return (
    <div className="work-checkpoints" aria-label="Checkpoints">
      {confirm.element}
      <form
        className="work-checkpoints__create"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <Input
          aria-label="Checkpoint label"
          placeholder="Checkpoint label (optional)"
          value={labelDraft}
          onChange={(e) => setLabelDraft(e.target.value)}
          disabled={create.isPending}
        />
        <Button type="submit" icon={<Camera aria-hidden="true" />} disabled={create.isPending} title="Create a checkpoint of the current workspace">
          {create.isPending ? 'Snapshotting…' : 'Snapshot'}
        </Button>
      </form>

      {list.isPending && <SkeletonRows count={3} label="Loading checkpoints" />}
      {list.isError && (
        <p className="dv-notice dv-notice--bad" role="alert">
          Could not load checkpoints: {formatError(list.error)}
          {' '}
          <Button size="sm" variant="ghost" onClick={() => void list.refetch()}>Retry</Button>
        </p>
      )}
      {list.isSuccess && checkpoints.length === 0 && (
        <EmptyState icon={<History />} action={<Button onClick={() => void handleCreate()}>Snapshot now</Button>}>
          Checkpoints of the workspace appear here, made by hand or automatically per turn.
        </EmptyState>
      )}
      {checkpoints.length > 0 && (
        <RowList aria-label="Checkpoints">
          {checkpoints.map((checkpoint) => (
            <Row
              key={checkpoint.id}
              title={checkpoint.label || checkpoint.id}
              meta={[kindLabel(checkpoint.kind), retentionLabel(checkpoint.retentionClass), whenLabel(checkpoint.createdAt)].filter(Boolean).join(' · ')}
              trailing={<span className="dv-value">{formatBytes(checkpoint.sizeBytes)}</span>}
              onSelect={() => { setSelectedId(checkpoint.id); setCompareToId(''); }}
            />
          ))}
        </RowList>
      )}
    </div>
  );
}
