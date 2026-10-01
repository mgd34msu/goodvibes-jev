/**
 * SessionRewind, the session-detail REWIND surface (rewind.plan / rewind.apply, SDK 1.6.1).
 *
 * A terraform-style dry-run/apply flow: pick a recent turn anchor (or the session's most
 * recent checkpoint) and a scope (files / conversation / both) → rewind.plan previews
 * EXACTLY what restoring would change (which checkpoint, how many files; how many messages
 * would be dropped) and mints a single-use confirm token → a confirm sheet → rewind.apply
 * consumes the token, restores, and returns a receipt (the REWIND_APPLIED payload) whose
 * `undo` block records how to reverse it.
 *
 * HONEST PARTS: rewind.plan reports a part with no store wired on this runtime as
 * unavailable (in the plan's `warnings` and/or the part's `available:false`) rather than
 * faking it, the files scope is live; the conversation scope may report unavailable, and
 * this renders that verbatim. The receipt's undo point: the file restore's pre-restore
 * safety checkpoint is reversible from the browser (checkpoints.restore); the conversation
 * snapshot id is shown but has no browser-side restore verb (an honest note, never a
 * fabricated button).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { RewindApplyResult } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { companionMessagesFromListResponse } from '../../lib/companion-chat';
import { turnAnchorsFromMessages } from '../../lib/rewind';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { SkeletonBlock } from '../../components/feedback/SkeletonBlock';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import { StatusDot } from '../../components/ui/StatusDot';
import '../../styles/components/session-rewind.css';

type RewindScope = 'files' | 'conversation' | 'both';

interface SessionRewindProps {
  sessionId: string;
  /** True when the session is closed, rewind still previews/applies against its history. */
  closed?: boolean;
}

const SCOPES: { value: RewindScope; label: string }[] = [
  { value: 'both', label: 'Files + conversation' },
  { value: 'files', label: 'Files only' },
  { value: 'conversation', label: 'Conversation only' },
];

export function SessionRewind({ sessionId }: SessionRewindProps) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<RewindScope>('both');
  const [anchorTurnId, setAnchorTurnId] = useState('');
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [receipt, setReceipt] = useState<NonNullable<RewindApplyResult['receipt']> | null>(null);

  const messages = useQuery({
    queryKey: queryKeys.sessionMessages(sessionId),
    queryFn: () => sdk.operator.sessions.messages.list(sessionId),
  });

  const anchors = useMemo(
    () => turnAnchorsFromMessages(companionMessagesFromListResponse(messages.data)),
    [messages.data],
  );

  const plan = useMutation({
    mutationFn: () => sdk.operator.rewind.plan({ sessionId, scope, ...(anchorTurnId ? { turnId: anchorTurnId } : {}) }),
  });

  const apply = useMutation({
    mutationFn: (token: string) =>
      sdk.operator.rewind.apply({ sessionId, scope, ...(anchorTurnId ? { turnId: anchorTurnId } : {}), confirmToken: token }),
    onSuccess: async (result) => {
      if (result.receipt) {
        setReceipt(result.receipt);
        plan.reset();
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessionMessages(sessionId) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessionChanges(sessionId) });
      }
    },
  });

  const undoFiles = useMutation({
    mutationFn: (restoreCheckpointId: string) =>
      sdk.operator.checkpoints.restore({ id: restoreCheckpointId, safetyCheckpoint: true, confirm: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessionChanges(sessionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.checkpoints });
    },
  });

  function resetFlow(): void {
    plan.reset();
    apply.reset();
    setReceipt(null);
  }

  const planData = plan.data ?? null;
  const applyRefused = apply.data?.refused;

  return (
    <section className="session-rewind">
      <p className="session-rewind__intro">
        Roll this session back to an earlier turn. Preview what would change, then restore the files, the
        conversation, or both.
      </p>

      <div className="session-rewind__body">
        <div className="session-rewind__controls">
          <Field label="Scope" className="session-rewind__field">
            <Select<RewindScope>
              value={scope}
              onChange={(next) => { setScope(next); resetFlow(); }}
              aria-label="Rewind scope"
              options={SCOPES}
            />
          </Field>
          <Field label="Anchor" className="session-rewind__field">
            <Select
              value={anchorTurnId}
              onChange={(next) => { setAnchorTurnId(next); resetFlow(); }}
              aria-label="Rewind turn anchor"
              disabled={messages.isPending}
              options={[
                { value: '', label: 'Most recent checkpoint (no turn)' },
                ...anchors.map((a) => ({ value: a.turnId, label: a.label || a.turnId })),
              ]}
            />
          </Field>
        </div>

        {messages.isPending && <SkeletonBlock variant="text" lines={2} />}
        {anchors.length === 0 && messages.isSuccess && (
          <p className="session-rewind__note" role="note">
            No turn-anchored messages retained for this session, you can still rewind to its most recent checkpoint.
          </p>
        )}

        <Button
          className="session-rewind__preview-btn"
          disabled={plan.isPending}
          onClick={() => { setReceipt(null); apply.reset(); plan.mutate(); }}
        >
          {plan.isPending ? 'Previewing…' : 'Preview rewind'}
        </Button>

        {plan.isError && <p className="session-rewind__error" role="alert">{formatError(plan.error)}</p>}

        {planData && !receipt && (
          <div className="session-rewind__plan" role="group" aria-label="Rewind plan preview">
            <h4 className="session-rewind__plan-title">This rewind would change</h4>
            <ul className="session-rewind__plan-list">
              {(scope === 'files' || scope === 'both') && (
                <li>
                  <strong>Files:</strong>{' '}
                  {planData.files?.available
                    ? `restore ${planData.files.affectedFileCount} file${planData.files.affectedFileCount === 1 ? '' : 's'} from checkpoint "${planData.files.checkpointLabel ?? planData.files.checkpointId ?? 'nearest'}"`
                    : 'unavailable on this runtime: no workspace checkpoint store is wired.'}
                </li>
              )}
              {(scope === 'conversation' || scope === 'both') && (
                <li>
                  <strong>Conversation:</strong>{' '}
                  {planData.conversation?.available
                    ? `drop ${planData.conversation.messagesToDrop} message${planData.conversation.messagesToDrop === 1 ? '' : 's'}, keep ${planData.conversation.messagesRemaining}`
                    : 'unavailable on this runtime: no conversation store is wired for a rewind here.'}
                </li>
              )}
            </ul>
            {planData.warnings.length > 0 && (
              <ul className="banner warning session-rewind__warnings" role="note">
                {planData.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <Button
              variant="danger"
              className="session-rewind__apply-btn"
              icon={<Undo2 size={16} aria-hidden="true" />}
              onClick={() => setConfirmApply(true)}
            >
              Rewind to this point…
            </Button>
          </div>
        )}

        {apply.isError && <p className="session-rewind__error" role="alert">{formatError(apply.error)}</p>}
        {applyRefused && (
          <p className="session-rewind__error" role="alert">
            {apply.data?.refusal?.reason ?? 'The rewind was refused, preview it again to mint a fresh confirmation.'}
          </p>
        )}

        {receipt && (
          <div className="session-rewind__receipt" role="status">
            <h4 className="session-rewind__receipt-title">Rewind applied</h4>
            <ul className="session-rewind__plan-list">
              {receipt.files && (
                <li>
                  <strong>Files:</strong>{' '}
                  {receipt.files.restored
                    ? `restored ${receipt.files.restoredFileCount} file${receipt.files.restoredFileCount === 1 ? '' : 's'}${receipt.files.removedFileCount ? `, removed ${receipt.files.removedFileCount}` : ''}`
                    : 'not restored'}
                </li>
              )}
              {receipt.conversation && (
                <li>
                  <strong>Conversation:</strong>{' '}
                  {receipt.conversation.rewound
                    ? `dropped ${receipt.conversation.droppedMessages} message${receipt.conversation.droppedMessages === 1 ? '' : 's'}`
                    : 'not rewound'}
                </li>
              )}
            </ul>
            {receipt.warnings.length > 0 && (
              <ul className="banner warning session-rewind__warnings" role="note">
                {receipt.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}

            <div className="session-rewind__undo">
              <strong>Undo point recorded.</strong>{' '}
              {receipt.undo.files ? (
                <Button
                  size="sm"
                  className="session-rewind__undo-btn"
                  disabled={undoFiles.isPending}
                  onClick={() => setConfirmUndo(true)}
                >
                  {undoFiles.isPending ? 'Undoing…' : 'Undo the file restore'}
                </Button>
              ) : (
                <span>No file undo point (nothing was restored).</span>
              )}
              {receipt.undo.conversation && (
                <p className="session-rewind__note" role="note">
                  The conversation rewind is kept as a snapshot
                  ({receipt.undo.conversation.undoSnapshotId}), but this page can&apos;t restore a conversation. Use
                  the terminal app to reverse it.
                </p>
              )}
            </div>
            {undoFiles.isError && <p className="session-rewind__error" role="alert">{formatError(undoFiles.error)}</p>}
            {undoFiles.isSuccess && (
              <p className="session-rewind__ok" role="status">
                <StatusDot tone="ok" />
                File restore undone.
              </p>
            )}
          </div>
        )}
      </div>

      {confirmApply && planData && (
        <ConfirmDialog
          open
          tone="danger"
          title="Rewind this session?"
          target={`Scope: ${scope}${anchorTurnId ? ` · turn ${anchorTurnId}` : ' · most recent checkpoint'}`}
          description="The chosen scope goes back to this point, and an undo point is kept so you can reverse it."
          confirmLabel="Rewind"
          onConfirm={() => {
            setConfirmApply(false);
            if (planData.token) apply.mutate(planData.token);
          }}
          onCancel={() => setConfirmApply(false)}
        />
      )}

      {confirmUndo && receipt?.undo.files && (
        <ConfirmDialog
          open
          tone="danger"
          title="Undo the file restore?"
          target={`Restore checkpoint ${receipt.undo.files.restoreCheckpointId}`}
          description="The files go back to how they were just before the rewind."
          confirmLabel="Undo"
          onConfirm={() => {
            const id = receipt.undo.files?.restoreCheckpointId;
            setConfirmUndo(false);
            if (id) undoFiles.mutate(id);
          }}
          onCancel={() => setConfirmUndo(false)}
        />
      )}
    </section>
  );
}
