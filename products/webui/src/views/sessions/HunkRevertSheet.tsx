/**
 * HunkRevertSheet, the touch-first REJECT→REVERT surface for one hunk in the session
 * review cockpit. The parent runs the two-step daemon flow and hands this its phase:
 *
 *   1. previewing, checkpoints.revertHunkPreview is in flight (read-only; validates the
 *      hunk still reverse-applies and mints a single-use confirmToken).
 *   2. ready, the preview says it applies; this renders EXACTLY what would be reverted
 *      (the hunk itself) plus the preview's line-count stats, behind a Confirm.
 *   3. conflict, the honest stale state: the hunk no longer applies (preview applies:false
 *      OR a 409 CONFLICT on apply). Renders the daemon's human conflict string and a
 *      Refresh that re-reads the diff, NEVER a partial apply.
 *   4. applying, checkpoints.revertHunk is in flight (consumes the token).
 *   5. error, a non-conflict failure; Cancel only.
 *
 * Presentational only: bottom sheet on a phone, centered dialog on desktop, focus trap +
 * Escape/backdrop cancel, the ConfirmSheet / HunkCommentSheet idiom.
 */
import { RefreshCw, Undo2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { formatRange, hunkExcerpt, hunkNewRange, hunkOldRange, type DiffHunk } from '../../lib/unified-diff';
import type { CheckpointsRevertHunkPreviewResult } from '../../lib/goodvibes';
import '../../styles/components/session-changes.css';

export type HunkRevertPhase = 'previewing' | 'ready' | 'conflict' | 'applying' | 'error';

export interface HunkRevertSheetProps {
  open: boolean;
  filePath: string;
  hunk: DiffHunk;
  phase: HunkRevertPhase;
  /** The preview result when phase === 'ready', its stats drive the consequence line. */
  preview: CheckpointsRevertHunkPreviewResult | null;
  /** The daemon's human conflict string when phase === 'conflict'. */
  conflict: string | null;
  /** A non-conflict error message when phase === 'error'. */
  error: string | null;
  onConfirm: () => void;
  /** Re-read the diff after a stale conflict (the honest recovery, never a partial apply). */
  onRefresh: () => void;
  onCancel: () => void;
}

export function HunkRevertSheet({
  open,
  filePath,
  hunk,
  phase,
  preview,
  conflict,
  error,
  onConfirm,
  onRefresh,
  onCancel,
}: HunkRevertSheetProps) {
  if (!open) return null;

  const newRange = formatRange(hunkNewRange(hunk));
  const oldRange = formatRange(hunkOldRange(hunk));
  const applying = phase === 'applying';

  const footer = phase === 'conflict' ? (
    <>
      <Button variant="secondary" className="hunk-sheet__cancel" onClick={onCancel}>Close</Button>
      <Button variant="primary" className="hunk-sheet__send" onClick={onRefresh} icon={<RefreshCw aria-hidden="true" />}>
        Refresh diff
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" className="hunk-sheet__cancel" onClick={onCancel} disabled={applying}>Cancel</Button>
      <Button
        variant="danger"
        className="hunk-sheet__send hunk-sheet__send--danger"
        onClick={onConfirm}
        disabled={phase !== 'ready' || applying}
        icon={<Undo2 aria-hidden="true" />}
      >
        {applying ? 'Reverting…' : phase === 'previewing' ? 'Checking…' : 'Confirm revert'}
      </Button>
    </>
  );

  return (
    <Dialog
      open
      onClose={applying ? () => undefined : onCancel}
      title="Revert this hunk"
      role="alertdialog"
      className="hunk-sheet"
      footer={footer}
    >
      <div className="hunk-sheet__context">
        <span className="hunk-sheet__path">{filePath}</span>
        <span className="hunk-sheet__lines">new {newRange} · old {oldRange}</span>
      </div>

      <p className="hunk-sheet__captured">Reverting undoes exactly this change in your working files:</p>
      <pre className="hunk-sheet__excerpt" aria-label="Change that would be reverted">{hunkExcerpt(hunk)}</pre>

      {phase === 'previewing' && (
        <p className="hunk-sheet__mode" role="status">Checking whether this hunk still applies cleanly…</p>
      )}

      {phase === 'ready' && preview && (
        <p className="hunk-sheet__mode" role="status">
          Will remove {preview.addedLinesRemoved} added line{preview.addedLinesRemoved === 1 ? '' : 's'} and restore{' '}
          {preview.removedLinesRestored} removed line{preview.removedLinesRestored === 1 ? '' : 's'}. A safety checkpoint
          is taken first, so this revert is itself reversible.
        </p>
      )}

      {phase === 'conflict' && (
        <p className="hunk-sheet__conflict" role="alert">
          This hunk changed since it was captured: {conflict?.trim() ? conflict : 'it no longer applies cleanly'}. Nothing
          was reverted. Refresh the diff and try again.
        </p>
      )}

      {phase === 'error' && error && <p className="hunk-sheet__error" role="alert">{error}</p>}
    </Dialog>
  );
}
