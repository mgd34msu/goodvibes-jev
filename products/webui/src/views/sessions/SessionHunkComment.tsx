/** Selected diff text is display-only. The native host resolves and captures its own evidence. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  nativeSelectedDiffSelectorSchema,
  selectNativeDiffHunk,
  type NativeSelectedDiffSelector,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { formatError } from '../../lib/errors';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from '../../lib/client-lifetime';
import { hunkToPatch, parseUnifiedDiff } from '../../lib/unified-diff';
import { NativeIntakeForm } from '../work/NativeIntakeForm';
import { HunkCommentSheet, type HunkCommentSheetProps } from './HunkCommentSheet';
import { SessionContinuation, type NativeSessionContinuationBinding } from './SessionContinuation';

export interface SessionHunkCommentSelection {
  kind: 'session' | 'workspace';
  baselineId?: string;
  unifiedDiff: string;
  /** Host-written digest returned by the exact diff read; available on HTTP LAN too. */
  revision?: string;
  fileIndex: number;
  hunkIndex: number;
}
interface SessionHunkCommentProps extends HunkCommentSheetProps {
  sessionId: string;
  closed: boolean;
  selection: SessionHunkCommentSelection;
}

function CommentDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return <Dialog open title="Comment on this change" className="hunk-sheet" onClose={onClose}
    footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>{children}</Dialog>;
}

export function SessionHunkComment(props: SessionHunkCommentProps) {
  const lifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);
  const [origin] = useState(() => ({ lifetime, sessionId: props.sessionId }));
  if (origin.lifetime !== lifetime || origin.sessionId !== props.sessionId)
    return <CommentDialog onClose={props.onCancel}><p role="alert">The selected connection or session changed. Close this comment and select the change again. Saved originals remain available under their original connection.</p></CommentDialog>;
  return <SessionContinuation sessionId={props.sessionId} closed={props.closed}
    renderPending={content => <CommentDialog onClose={props.onCancel}>{content}</CommentDialog>}
    renderNative={binding => <NativeHunkComment {...props} binding={binding} />}>
    <HunkCommentSheet {...props} />
  </SessionContinuation>;
}

function NativeHunkComment({ binding, selection, filePath, hunk, capturedLabel, closed, onCancel }: SessionHunkCommentProps & { binding: NativeSessionContinuationBinding }) {
  const [prepared, setPrepared] = useState<{ selector: NativeSelectedDiffSelector; preview: string; selection: SessionHunkCommentSelection }>();
  const [error, setError] = useState<{ selection: SessionHunkCommentSelection; message: string }>();
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      // Shared strict segmentation prevents a tolerant display parser from selecting a
      // different file/hunk. The digest is only an exact-read precondition, not authority.
      const preview = selectNativeDiffHunk(selection.unifiedDiff, selection.fileIndex, selection.hunkIndex);
      const parsed = parseUnifiedDiff(preview);
      if (parsed.length !== 1 || parsed[0].hunks.length !== 1 || parsed[0].path !== filePath ||
        hunkToPatch(parsed[0].hunks[0]) !== hunkToPatch(hunk))
        throw new Error('The displayed change no longer matches the complete selected hunk. Close and refresh the diff.');
      const revision = selection.revision;
      if (!revision) throw new Error('The host did not provide a source revision for this diff. Close and refresh the changes.');
      const common = { revision, fileIndex: selection.fileIndex, hunkIndex: selection.hunkIndex };
      let selector: NativeSelectedDiffSelector;
      if (selection.kind === 'workspace') {
        if (!selection.baselineId) throw new Error('The workspace diff baseline is missing. Close and refresh the diff.');
        selector = { kind: 'workspace', baselineId: selection.baselineId, ...common };
      } else selector = { kind: 'session', ...common };
      if (!controller.signal.aborted && isClientLifetimeCurrent(binding.lifetime)) setPrepared({ selector: nativeSelectedDiffSelectorSchema.parse(selector), preview, selection });
    }).catch((cause: unknown) => { if (!controller.signal.aborted && isClientLifetimeCurrent(binding.lifetime)) setError({ selection, message: formatError(cause) }); });
    return () => controller.abort();
  }, [binding.lifetime, selection, filePath, hunk]);
  return <CommentDialog onClose={onCancel}>
    <div className="hunk-sheet__context"><span className="hunk-sheet__path">{filePath}</span></div>
    <p className="hunk-sheet__captured">{capturedLabel}</p>
    <p>The host verifies this selected change and saves its complete hunk separately from your exact original comment and completed conversation. Jev decides whether the comment needs work or a conversation reply.</p>
    {error?.selection === selection ? <p role="alert">Selected change unavailable: {error.message} Nothing was sent.</p> : prepared?.selection === selection ? <>
      <pre className="hunk-sheet__excerpt" aria-label="Selected change">{prepared.preview}</pre>
      <NativeIntakeForm lifetime={binding.lifetime} continuationSessionId={binding.sessionId}
        projectId={binding.projectId} selectedDiff={prepared.selector} closed={closed} />
    </> : <p role="status">Preparing the selected change…</p>}
  </CommentDialog>;
}
