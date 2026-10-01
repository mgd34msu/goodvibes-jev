/**
 * SessionChanges, the session review COCKPIT: every changed file the session made in one
 * scrollable multibuffer (DiffMultibuffer), each hunk a tap target with three actions.
 *
 * DAEMON SURFACE: sessions.changes.get (SDK 1.6.1) returns a session's aggregate workspace
 * diff, joined over the workspace checkpoints stamped with that session's id, the net
 * change from before the session's earliest stamped checkpoint to its latest. That is the
 * PRIMARY, default source. A session with no stamped checkpoints answers honestly with
 * `checkpointCount: 0` and an empty diff, rendered as an explicit "no captured changes"
 * state with a one-tap workspace-scoped fallback (checkpoints.list + checkpoints.diff),
 * never a blank panel. Both modes parse their unified diff with parseUnifiedDiff.
 *
 * PER-HUNK ACTIONS (HunkActionSheet, opened by tapping a hunk):
 *   - APPROVE, mark the hunk reviewed. Purely client-side progress tracking (a
 *     reviewed/total indicator); no wire call, resets on refresh (honest, a refreshed diff
 *     is a new capture).
 *   - COMMENT & STEER, the existing flow: HunkCommentSheet composes a comment sent through
 *     the same steer path (sessions.steer when an agent is bound, sessions.followUp
 *     otherwise), prefixed with a structured context block naming the file/ranges/excerpt.
 *   - REJECT & REVERT, checkpoints.revertHunkPreview → render exactly what would be
 *     reverted → confirm → checkpoints.revertHunk with the minted confirm token. A stale
 *     hunk (preview applies:false, or a 409 CONFLICT on apply) renders the honest conflict
 *     state and refreshes the diff, NEVER a partial apply.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { WorkspaceCheckpoint, CheckpointsRevertHunkPreviewResult } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError, isConflictError, isMethodUnavailableError, isSessionClosedError } from '../../lib/errors';
import { formatRelative } from '../../lib/object';
import { sortCheckpointsNewestFirst, kindLabel } from '../../lib/checkpoints';
import { buildHunkCommentSteer, hunkToPatch, parseUnifiedDiff, type DiffFile, type DiffHunk } from '../../lib/unified-diff';
import { DiffMultibuffer, hunkReviewKey, type HunkReviewStatus } from '../../components/diff/DiffMultibuffer';
import { SkeletonBlock } from '../../components/feedback/SkeletonBlock';
import { ErrorState } from '../../components/feedback/ErrorState';
import { HunkCommentSheet } from './HunkCommentSheet';
import { HunkActionSheet } from './HunkActionSheet';
import { HunkRevertSheet, type HunkRevertPhase } from './HunkRevertSheet';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { Select } from '../../components/ui/Select';
import { StatusDot } from '../../components/ui/StatusDot';
import '../../styles/components/session-changes.css';

interface SessionChangesProps {
  sessionId: string;
  /** True while an agent is bound and the session is open, steer is available. */
  canSteer: boolean;
  /** True when the session is closed, comments queue as follow-ups, never steer. */
  closed: boolean;
  streamPaused?: boolean;
}

interface HunkTarget {
  file: DiffFile;
  hunk: DiffHunk;
}

type SendState = 'idle' | 'sending' | 'delivered' | 'failed';
/** 'session' (default, primary) reads sessions.changes.get. 'workspace' (explicit
 * secondary/fallback) reads the checkpoint-baseline picker. */
type ViewMode = 'session' | 'workspace';

export function SessionChanges({ sessionId, canSteer, closed, streamPaused = false }: SessionChangesProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ViewMode>('session');
  const [baselineId, setBaselineId] = useState('');

  // Per-hunk client-review state (all keyed by hunkReviewKey, namespaced by path + header).
  const [reviewedKeys, setReviewedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [revertedKeys, setRevertedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [conflictKeys, setConflictKeys] = useState<ReadonlySet<string>>(() => new Set());

  // The three sheets: tap → action chooser; then either comment or revert.
  const [actionTarget, setActionTarget] = useState<HunkTarget | null>(null);
  const [commentTarget, setCommentTarget] = useState<(HunkTarget & { capturedLabel: string }) | null>(null);
  const [revertTarget, setRevertTarget] = useState<HunkTarget | null>(null);
  const [revertConflict, setRevertConflict] = useState<string | null>(null);

  const [sendState, setSendState] = useState<SendState>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);

  // ── Primary: sessions.changes.get, genuinely session-scoped ──────────────────
  const sessionChanges = useQuery({
    queryKey: queryKeys.sessionChanges(sessionId),
    queryFn: () => sdk.operator.sessions.changes.get(sessionId),
    enabled: mode === 'session',
  });
  const sessionChangesUnavailable = sessionChanges.isError && isMethodUnavailableError(sessionChanges.error);
  const sessionChangesFailed = sessionChanges.isError && !sessionChangesUnavailable;
  const sessionHasNoCapturedChanges = sessionChanges.isSuccess && sessionChanges.data.checkpointCount === 0;

  // ── Secondary/fallback: checkpoints.list + checkpoints.diff (workspace-wide) ──
  const list = useQuery({
    queryKey: queryKeys.checkpoints,
    queryFn: () => sdk.operator.checkpoints.list(),
    enabled: mode === 'workspace',
  });

  const checkpoints = useMemo(
    () => sortCheckpointsNewestFirst(list.data?.checkpoints ?? []),
    [list.data],
  );

  // Derive the effective baseline rather than defaulting via a setState-in-effect: the
  // user's explicit pick when it is still a live checkpoint, else the newest one. A chosen
  // baseline that GC'd out of the list falls back to the newest rather than querying a
  // dangling id, same behavior as the old effect, with no render cascade.
  const effectiveBaselineId = useMemo(() => {
    if (baselineId && checkpoints.some((c) => c.id === baselineId)) return baselineId;
    return checkpoints[0]?.id ?? '';
  }, [checkpoints, baselineId]);

  const baseline: WorkspaceCheckpoint | null = useMemo(
    () => checkpoints.find((c) => c.id === effectiveBaselineId) ?? null,
    [checkpoints, effectiveBaselineId],
  );

  const diff = useQuery({
    queryKey: [...queryKeys.checkpoints, effectiveBaselineId, 'diff', 'working-tree'],
    queryFn: () => sdk.operator.checkpoints.diff({ a: effectiveBaselineId }),
    enabled: mode === 'workspace' && Boolean(effectiveBaselineId),
  });

  const files = useMemo(() => {
    if (mode === 'session') {
      return sessionChanges.data && !sessionHasNoCapturedChanges ? parseUnifiedDiff(sessionChanges.data.unifiedDiff) : [];
    }
    return diff.data ? parseUnifiedDiff(diff.data.diff.unifiedDiff) : [];
  }, [mode, sessionChanges.data, sessionHasNoCapturedChanges, diff.data]);

  const capturedLabel = useMemo(() => {
    if (mode === 'session') {
      if (!sessionChanges.data) return "Session changes, aggregated over this session's own captured checkpoints.";
      if (sessionHasNoCapturedChanges) {
        return "No captured changes for this session, no workspace checkpoints have been stamped with this session's id.";
      }
      const { checkpointCount, from, to } = sessionChanges.data;
      return `Session changes across ${checkpointCount} checkpoint${checkpointCount === 1 ? '' : 's'} this session made (from "${from}" to "${to}"). Session-scoped: filtered to this session's own checkpoints only.`;
    }
    return baseline
      ? `Workspace changes since checkpoint "${baseline.label || baseline.id}" (${kindLabel(baseline.kind)}, ${formatRelative(baseline.createdAt)}), compared to the live working tree. Workspace-scoped (fallback), not filtered to this session.`
      : 'Workspace diff vs. the live working tree. Workspace-scoped (fallback), not filtered to this session.';
  }, [mode, sessionChanges.data, sessionHasNoCapturedChanges, baseline]);

  const mutationMode: 'steer' | 'followUp' = canSteer && !closed ? 'steer' : 'followUp';

  // ── Reviewed/total progress (client-side, over the CURRENT diff's hunks) ──────
  const reviewableKeys = useMemo(
    () => files.flatMap((f) => (f.binary ? [] : f.hunks.map((h) => hunkReviewKey(f.path, h)))),
    [files],
  );
  const totalHunks = reviewableKeys.length;
  const reviewedCount = useMemo(
    () => reviewableKeys.filter((k) => reviewedKeys.has(k)).length,
    [reviewableKeys, reviewedKeys],
  );

  function statusFor(file: DiffFile, hunk: DiffHunk): HunkReviewStatus | null {
    const key = hunkReviewKey(file.path, hunk);
    if (revertedKeys.has(key)) return 'reverted';
    if (conflictKeys.has(key)) return 'conflict';
    if (reviewedKeys.has(key)) return 'reviewed';
    return null;
  }

  function withKey(set: ReadonlySet<string>, key: string, add: boolean): Set<string> {
    const next = new Set(set);
    if (add) next.add(key); else next.delete(key);
    return next;
  }

  // ── Comment → steer/follow-up (existing flow) ─────────────────────────────────
  const send = useMutation({
    mutationFn: (body: string) => (
      mutationMode === 'steer'
        ? sdk.operator.sessions.steer(sessionId, { body })
        : sdk.operator.sessions.followUp(sessionId, { body })
    ),
    onSuccess: async () => {
      setSendState('delivered');
      setCommentTarget(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (error) => {
      setSendState('failed');
      setSendError(
        isSessionClosedError(error)
          ? 'This session is closed. Reopen it to continue.'
          : formatError(error),
      );
      if (isSessionClosedError(error)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      }
    },
  });

  // ── Reject → revert (preview + apply, honest conflict on stale) ───────────────
  const preview = useMutation({
    mutationFn: (target: HunkTarget) =>
      sdk.operator.checkpoints.revertHunkPreview({ path: target.file.path, hunk: hunkToPatch(target.hunk), sessionId }),
    onSuccess: (result, target) => {
      if (!(result.applies && result.token)) {
        setRevertConflict(result.conflict ?? 'this hunk no longer applies cleanly');
        setConflictKeys((s) => withKey(s, hunkReviewKey(target.file.path, target.hunk), true));
      }
    },
  });

  const apply = useMutation({
    mutationFn: (input: { target: HunkTarget; token: string }) =>
      sdk.operator.checkpoints.revertHunk({
        path: input.target.file.path,
        hunk: hunkToPatch(input.target.hunk),
        confirmToken: input.token,
        sessionId,
      }),
    onSuccess: async (result, input) => {
      const key = hunkReviewKey(input.target.file.path, input.target.hunk);
      if (result.receipt?.reverted) {
        setRevertedKeys((s) => withKey(s, key, true));
        setRevertTarget(null);
        await refreshActiveDiff();
      } else {
        // A confirmed call should not be refused; if it somehow is, surface it honestly.
        setRevertConflict(result.refusal?.reason ?? 'the revert was refused');
        setConflictKeys((s) => withKey(s, key, true));
      }
    },
    onError: (error, input) => {
      if (isConflictError(error)) {
        setRevertConflict(formatError(error));
        setConflictKeys((s) => withKey(s, hunkReviewKey(input.target.file.path, input.target.hunk), true));
      }
    },
  });

  async function refreshActiveDiff(): Promise<void> {
    setRevertedKeys(new Set());
    setConflictKeys(new Set());
    if (mode === 'session') await sessionChanges.refetch();
    else await diff.refetch();
  }

  const revertPhase: HunkRevertPhase = apply.isPending
    ? 'applying'
    : revertConflict
      ? 'conflict'
      : preview.isPending
        ? 'previewing'
        : apply.isError || preview.isError
          ? 'error'
          : preview.data?.applies && preview.data.token
            ? 'ready'
            : 'previewing';

  const revertPreview: CheckpointsRevertHunkPreviewResult | null = preview.data ?? null;
  const revertError = preview.isError
    ? formatError(preview.error)
    : apply.isError && !isConflictError(apply.error)
      ? formatError(apply.error)
      : null;

  // ── Action wiring ─────────────────────────────────────────────────────────────
  function openAction(file: DiffFile, hunk: DiffHunk): void {
    setActionTarget({ file, hunk });
  }

  function approve(): void {
    if (!actionTarget) return;
    const key = hunkReviewKey(actionTarget.file.path, actionTarget.hunk);
    setReviewedKeys((s) => withKey(s, key, !s.has(key)));
    setActionTarget(null);
  }

  function startComment(): void {
    if (!actionTarget) return;
    setSendError(null);
    setSendState('idle');
    setCommentTarget({ ...actionTarget, capturedLabel });
    setActionTarget(null);
  }

  function startRevert(): void {
    if (!actionTarget) return;
    const target = actionTarget;
    setActionTarget(null);
    setRevertConflict(null);
    preview.reset();
    apply.reset();
    setRevertTarget(target);
    preview.mutate(target);
  }

  function confirmRevert(): void {
    if (!revertTarget || !preview.data?.token) return;
    apply.mutate({ target: revertTarget, token: preview.data.token });
  }

  function cancelRevert(): void {
    setRevertTarget(null);
    setRevertConflict(null);
    preview.reset();
    apply.reset();
  }

  async function onRevertRefresh(): Promise<void> {
    cancelRevert();
    await refreshActiveDiff();
  }

  function submitComment(comment: string): void {
    if (!commentTarget) return;
    const body = buildHunkCommentSteer({
      filePath: commentTarget.file.path,
      hunk: commentTarget.hunk,
      capturedLabel: commentTarget.capturedLabel,
      comment,
    });
    setSendState('sending');
    setSendError(null);
    setLastSent(`${commentTarget.file.path} · ${mutationMode === 'steer' ? 'steered' : 'queued'}`);
    send.mutate(body);
  }

  const changedCount = files.length;
  const actionReviewed = actionTarget ? reviewedKeys.has(hunkReviewKey(actionTarget.file.path, actionTarget.hunk)) : false;

  return (
    <section className="session-changes">
      <div className="session-changes__body">
        <div className="session-changes__toolbar">
          {mode === 'session' ? (
            <Button
              size="sm"
              variant="ghost"
              className="session-changes__mode-toggle"
              onClick={() => setMode('workspace')}
              title="Older sessions did not tag their checkpoints, so this shows the whole workspace's checkpoint timeline instead"
            >
              View workspace changes
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="session-changes__mode-toggle" onClick={() => setMode('session')}>
                Back to session changes
              </Button>
              <div className="session-changes__baseline">
                <Field label="Baseline">
                  <Select
                    value={effectiveBaselineId}
                    onChange={setBaselineId}
                    aria-label="Diff baseline checkpoint"
                    disabled={!checkpoints.length}
                    options={checkpoints.map((c) => ({
                      value: c.id,
                      label: `${c.label || c.id} · ${kindLabel(c.kind)} · ${formatRelative(c.createdAt)}`,
                    }))}
                  />
                </Field>
              </div>
            </>
          )}
          <IconButton
            size="sm"
            className="session-changes__refresh"
            label={mode === 'session' ? 'Refresh session changes' : 'Refresh checkpoints and diff'}
            icon={<RefreshCw size={14} aria-hidden="true" />}
            onClick={() => { void refreshActiveDiff(); if (mode === 'workspace') void list.refetch(); }}
          />
        </div>

        {totalHunks > 0 && (
          <div className="session-changes__progress" role="status" aria-label="Review progress">
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>{reviewedCount} of {totalHunks} hunk{totalHunks === 1 ? '' : 's'} reviewed</span>
            <span className="session-changes__progress-bar" aria-hidden="true">
              <span
                className="session-changes__progress-fill"
                style={{ width: `${totalHunks ? Math.round((reviewedCount / totalHunks) * 100) : 0}%` }}
              />
            </span>
          </div>
        )}

        {lastSent && sendState === 'delivered' && (
          <p className="session-changes__sent" role="status">
            <StatusDot tone="ok" />
            Comment sent: {lastSent}.
          </p>
        )}
        {sendState === 'failed' && sendError && !commentTarget && (
          <p className="session-changes__send-error" role="alert">{sendError}</p>
        )}
        {streamPaused && (
          <div className="banner warning session-changes__stale" role="note">
            Live updates paused: this diff may lag the working tree until the stream reconnects.
          </div>
        )}

        {mode === 'session' && (
          <>
            {sessionChanges.isPending && <SkeletonBlock variant="text" lines={3} />}
            {sessionChangesFailed && (
              <ErrorState error={sessionChanges.error} onRetry={() => void sessionChanges.refetch()} title="Failed to load session changes" />
            )}
            {sessionChangesUnavailable && (
              <div className="session-changes__empty" role="note">
                <span>This daemon doesn&apos;t serve session-scoped changes yet.</span>
                <Button size="sm" className="session-changes__inline-link" onClick={() => setMode('workspace')}>
                  View workspace-wide changes instead
                </Button>
              </div>
            )}
            {sessionHasNoCapturedChanges && (
              <div className="session-changes__empty" role="note">
                <span>
                  No captured changes for this session. No workspace checkpoints have been tagged with this
                  session yet; older sessions never were.
                </span>
                <Button size="sm" className="session-changes__inline-link" onClick={() => setMode('workspace')}>
                  View workspace-wide changes instead
                </Button>
              </div>
            )}
            {sessionChanges.isSuccess && !sessionHasNoCapturedChanges && (
              <>
                <p className="session-changes__captured">{capturedLabel}</p>
                {changedCount === 0 && (
                  <div className="session-changes__empty" role="note">
                    No file differences in this session&apos;s captured checkpoints.
                  </div>
                )}
              </>
            )}
          </>
        )}

        {mode === 'workspace' && (
          <>
            {list.isPending && <SkeletonBlock variant="text" lines={3} />}
            {list.isError && (
              <ErrorState error={list.error} onRetry={() => void list.refetch()} title="Failed to load checkpoints" />
            )}
            {list.isSuccess && !checkpoints.length && (
              <div className="session-changes__empty" role="note">
                No workspace checkpoints yet. The daemon takes one for each turn and agent run, and you can create one
                from the session's Checkpoints tab. Without one there is no file diff to show.
              </div>
            )}

            {baseline && (
              <>
                <p className="session-changes__captured">{capturedLabel}</p>

                {diff.isPending && <SkeletonBlock variant="text" lines={5} />}
                {diff.isError && (
                  <ErrorState error={diff.error} onRetry={() => void diff.refetch()} title="Failed to load diff" />
                )}
                {diff.isSuccess && changedCount === 0 && (
                  <div className="session-changes__empty" role="note">
                    No file differences between this checkpoint and the working tree.
                  </div>
                )}
              </>
            )}
          </>
        )}

        {changedCount > 0 && (
          <DiffMultibuffer
            files={files}
            onHunkActivate={openAction}
            statusFor={statusFor}
            hunkCtaLabel="Review, comment, or revert"
            idPrefix="session-changes"
          />
        )}
      </div>

      {actionTarget && (
        <HunkActionSheet
          open
          filePath={actionTarget.file.path}
          hunk={actionTarget.hunk}
          reviewed={actionReviewed}
          commentMode={mutationMode}
          onApprove={approve}
          onComment={startComment}
          onReject={startRevert}
          onCancel={() => setActionTarget(null)}
        />
      )}

      {commentTarget && (
        <HunkCommentSheet
          open
          filePath={commentTarget.file.path}
          hunk={commentTarget.hunk}
          capturedLabel={commentTarget.capturedLabel}
          mode={mutationMode}
          pending={sendState === 'sending'}
          error={sendState === 'failed' ? sendError : null}
          onSubmit={submitComment}
          onCancel={() => { setCommentTarget(null); setSendState('idle'); setSendError(null); }}
        />
      )}

      {revertTarget && (
        <HunkRevertSheet
          open
          filePath={revertTarget.file.path}
          hunk={revertTarget.hunk}
          phase={revertPhase}
          preview={revertPreview}
          conflict={revertConflict}
          error={revertError}
          onConfirm={confirmRevert}
          onRefresh={() => void onRevertRefresh()}
          onCancel={cancelRevert}
        />
      )}
    </section>
  );
}
