/**
 * HunkCommentSheet, the explicit legacy touch-first composer for a comment attached to ONE diff hunk.
 *
 * Mirrors ConfirmSheet's idiom (bottom sheet on a phone, centered dialog on desktop,
 * focus trap, Escape/backdrop cancel) but carries a textarea instead of a yes/no: it
 * shows exactly which change is being commented on (file + line ranges + the hunk
 * excerpt) so the operator is never guessing, then sends the comment as a steer/
 * follow-up to the session. Presentational-with-state: it owns only the draft text and
 * the composer-key handling; the PARENT owns the mutation (the same sessions.steer /
 * sessions.followUp path after authoritative legacy classification) and passes
 * back `pending` / `error` / a `mode` label so this sheet stays free of any wire concern.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Textarea } from '../../components/ui/Field';
import { shouldSubmitComposerKey } from '../../lib/composer-keys';
import { formatRange, hunkExcerpt, hunkNewRange, hunkOldRange, type DiffHunk } from '../../lib/unified-diff';
import '../../styles/components/session-changes.css';

export interface HunkCommentSheetProps {
  open: boolean;
  filePath: string;
  hunk: DiffHunk;
  /** Trust-in-labels: how/when the diff was captured (e.g. the checkpoint label + age). */
  capturedLabel: string;
  /** 'steer' while an agent is bound, else 'followUp' (queues a turn), mirrors SteerComposer. */
  mode: 'steer' | 'followUp';
  pending: boolean;
  error?: string | null;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}

export function HunkCommentSheet({
  open,
  filePath,
  hunk,
  capturedLabel,
  mode,
  pending,
  error,
  onSubmit,
  onCancel,
}: HunkCommentSheetProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formId = useId();
  const [text, setText] = useState('');

  useEffect(() => {
    if (open) setText('');
  }, [open]);

  if (!open) return null;

  const newRange = formatRange(hunkNewRange(hunk));
  const oldRange = formatRange(hunkOldRange(hunk));
  const actionLabel = mode === 'steer' ? 'Send steer' : 'Queue follow-up';

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const comment = text.trim();
    if (!comment || pending) return;
    onSubmit(comment);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitComposerKey(event)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Comment on this change"
      className="hunk-sheet"
      initialFocusRef={textareaRef}
      footer={(
        <>
          <Button variant="secondary" className="hunk-sheet__cancel" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            className="hunk-sheet__send"
            disabled={pending || !text.trim()}
            aria-label={actionLabel}
            icon={<SendHorizontal aria-hidden="true" />}
          >
            {pending ? 'Sending…' : mode === 'steer' ? 'Steer' : 'Queue'}
          </Button>
        </>
      )}
    >
      <div className="hunk-sheet__context">
        <span className="hunk-sheet__path">{filePath}</span>
        <span className="hunk-sheet__lines">new {newRange} · old {oldRange}</span>
      </div>
      <p className="hunk-sheet__captured">{capturedLabel}</p>

      <pre className="hunk-sheet__excerpt" aria-label="Selected change">{hunkExcerpt(hunk)}</pre>

      <form id={formId} className="hunk-sheet__form" onSubmit={submit}>
        <Textarea
          ref={textareaRef}
          className="hunk-sheet__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={mode === 'steer'
            ? 'What should the agent do about this change?'
            : 'Queue a follow-up about this change…'}
          rows={3}
          aria-label="Comment on the selected change"
          aria-keyshortcuts="Enter"
          onKeyDown={handleKeyDown}
        />
        <p className="hunk-sheet__mode" role="status">
          {mode === 'steer'
            ? 'Sent to the running agent right away.'
            : 'No active agent: queues a follow-up turn.'}
        </p>
        {error && <p className="hunk-sheet__error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
