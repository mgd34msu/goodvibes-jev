/**
 * HunkActionSheet, the touch-first action chooser for ONE reviewed hunk in the session
 * review cockpit. Tapping a hunk in the multibuffer opens this; it names the change (file
 * + line ranges + excerpt) and offers the three cockpit actions as full-width ≥44px sheet
 * buttons, so a phone review is thumb-driven:
 *   - APPROVE, mark this hunk reviewed (purely client-side progress tracking; toggles back
 *     to "Mark reviewed" when already approved). No wire call.
 *   - COMMENT & STEER, hand off to the existing HunkCommentSheet / steer-follow-up flow.
 *   - REJECT & REVERT, hand off to the revert preview → confirm → checkpoints.revertHunk
 *     flow (HunkRevertSheet).
 *
 * Presentational only: it renders when `open` and calls the handler the parent supplies.
 * Bottom sheet on a phone, centered dialog on desktop, focus trap + Escape/backdrop cancel
 *, the same idiom as ConfirmSheet / HunkCommentSheet.
 */
import { Check, MessageSquare, Undo2 } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { formatRange, hunkExcerpt, hunkNewRange, hunkOldRange, type DiffHunk } from '../../lib/unified-diff';
import '../../styles/components/session-changes.css';

export interface HunkActionSheetProps {
  open: boolean;
  filePath: string;
  hunk: DiffHunk;
  /** True when this hunk is already marked reviewed, the Approve button toggles it off. */
  reviewed: boolean;
  /** Before host classification, discovery names only the comment, never a promised dispatch mode. */
  commentMode: 'steer' | 'followUp' | 'discover';
  onApprove: () => void;
  onComment: () => void;
  onReject: () => void;
  onCancel: () => void;
}

export function HunkActionSheet({
  open,
  filePath,
  hunk,
  reviewed,
  commentMode,
  onApprove,
  onComment,
  onReject,
  onCancel,
}: HunkActionSheetProps) {
  if (!open) return null;

  const newRange = formatRange(hunkNewRange(hunk));
  const oldRange = formatRange(hunkOldRange(hunk));

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Review this change"
      className="hunk-sheet"
      footer={<Button variant="secondary" className="hunk-actions__cancel" onClick={onCancel}>Cancel</Button>}
    >
      <div className="hunk-sheet__context">
        <span className="hunk-sheet__path">{filePath}</span>
        <span className="hunk-sheet__lines">new {newRange} · old {oldRange}</span>
      </div>
      <pre className="hunk-sheet__excerpt" aria-label="Selected change">{hunkExcerpt(hunk)}</pre>

      <div className="hunk-actions gv-choice-list">
        <button type="button" className="gv-choice hunk-actions__btn hunk-actions__btn--approve" onClick={onApprove}>
          <Check aria-hidden="true" />
          <span className="gv-choice__label">{reviewed ? 'Marked reviewed: undo' : 'Approve (mark reviewed)'}</span>
        </button>
        <button type="button" className="gv-choice hunk-actions__btn" onClick={onComment}>
          <MessageSquare aria-hidden="true" />
          <span className="gv-choice__label">{commentMode === 'discover' ? 'Comment on this change' : commentMode === 'steer' ? 'Comment & steer' : 'Comment & queue follow-up'}</span>
        </button>
        <button type="button" className="gv-choice hunk-actions__btn hunk-actions__btn--reject" onClick={onReject}>
          <Undo2 aria-hidden="true" />
          <span className="gv-choice__label">Reject & revert this hunk</span>
        </button>
      </div>
    </Dialog>
  );
}
