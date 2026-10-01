/**
 * Approve, deny, claim and cancel for the Work view's approval detail, and the
 * push-notification hand-off (#approval-action=…&approval-id=…).
 *
 * Moved from the old Approvals view unchanged in behavior: a partial hunk
 * approval sends an index array only (the daemon computes the edit), and every
 * toast reports what the daemon RECORDED (the response's `recorded` block), not
 * what was sent. See lib/approvals.ts.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sdk } from '../../lib/goodvibes';
import type { ApprovalApproveInput } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { refetchAfterDecision } from '../../lib/approval-refresh';
import { isDurableRememberTier, recordedAnswerDelivered, recordedReasonStored, recordedRememberTier } from '../../lib/approvals';
import { parseApprovalActionFromHash, stripApprovalActionFragment } from '../../lib/push/approval-action-link';
import { formatError, isSessionClosedError } from '../../lib/errors';
import { useToast } from '../../lib/toast';

/** What an approve action carries beyond the id. */
export interface ApprovalApproveRequest {
  readonly id: string;
  readonly selectedHunks?: readonly number[];
  /** The remember tier picked (undefined = just this once). */
  readonly rememberTier?: string;
  /** Exec-prompt answer text feeding the waiting command. */
  readonly answer?: string;
  /** How many hunks the request has, to word a partial approval. */
  readonly totalHunks?: number;
}

function friendlyError(error: unknown): string {
  if (isSessionClosedError(error)) return 'That session is closed. The approval can no longer be actioned.';
  return formatError(error);
}

export function useApprovalActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const approve = useMutation({
    mutationFn: ({ id, selectedHunks, rememberTier, answer }: ApprovalApproveRequest) => {
      const input: ApprovalApproveInput = {
        ...(selectedHunks && selectedHunks.length > 0 ? { selectedHunks } : {}),
        ...(rememberTier ? { rememberTier, remember: true } : {}),
        ...(answer !== undefined ? { modifiedArgs: { answer } } : {}),
      };
      return sdk.operator.approvals.approve(id, Object.keys(input).length > 0 ? input : undefined);
    },
    onSuccess: async (result, variables) => {
      await refetchAfterDecision(queryClient, queryKeys.approvals);
      const selectedCount = variables.selectedHunks?.length ?? 0;
      const isPartial = selectedCount > 0
        && variables.totalHunks !== undefined
        && selectedCount < variables.totalHunks;
      const title = isPartial ? `Approved ${selectedCount} of ${variables.totalHunks} hunks` : 'Approved';
      const recordedTier = recordedRememberTier(result);
      if (variables.rememberTier) {
        if (recordedTier) {
          if (isDurableRememberTier(recordedTier)) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.permissionRules });
          }
          toast({ title, description: `Remembered (${recordedTier}): matching asks will not prompt again.`, tone: 'success' });
        } else {
          toast({ title, description: 'The daemon did not record the remember request, this decision applied once.', tone: 'info' });
        }
        return;
      }
      if (variables.answer !== undefined) {
        toast(recordedAnswerDelivered(result)
          ? { title: 'Answer sent', description: 'The reply is feeding the waiting command.', tone: 'success' }
          : { title, description: 'The daemon did not record the answer. The command was approved without input and may stop on its prompt.', tone: 'info' });
        return;
      }
      toast({ title, tone: 'success' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Approve failed', description: friendlyError(error), tone: 'danger' });
    },
  });

  const deny = useMutation({
    // The one optional reason rides both wire fields (note + reason).
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      sdk.operator.approvals.deny(id, reason ? { note: reason, reason } : undefined),
    onSuccess: async (result, variables) => {
      await refetchAfterDecision(queryClient, queryKeys.approvals);
      toast(variables.reason && recordedReasonStored(result)
        ? { title: 'Denied', description: 'Reason fed back with the denial.', tone: 'info' }
        : { title: 'Denied', tone: 'info' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Deny failed', description: friendlyError(error), tone: 'danger' });
    },
  });

  const claim = useMutation({
    mutationFn: (id: string) => sdk.operator.approvals.claim(id),
    onSuccess: async () => {
      await refetchAfterDecision(queryClient, queryKeys.approvals);
      toast({ title: 'Claimed', tone: 'info' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Claim failed', description: friendlyError(error), tone: 'danger' });
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) => sdk.operator.approvals.cancel(id),
    onSuccess: async () => {
      await refetchAfterDecision(queryClient, queryKeys.approvals);
      toast({ title: 'Cancelled', tone: 'info' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Cancel failed', description: friendlyError(error), tone: 'danger' });
    },
  });

  // Push-notification action hand-off: an "Allow"/"Deny" tap opens the app at
  // #approval-action=…&approval-id=… (the service worker cannot approve itself).
  // This authenticated surface completes the real call on mount, once; the
  // fragment is scrubbed so a reload does not re-fire it.
  const handoffDoneRef = useRef(false);
  const approveRef = useRef(approve.mutate);
  const denyRef = useRef(deny.mutate);
  useLayoutEffect(() => {
    approveRef.current = approve.mutate;
    denyRef.current = deny.mutate;
  });
  useEffect(() => {
    if (handoffDoneRef.current) return;
    const intent = parseApprovalActionFromHash(window.location.hash);
    if (!intent) return;
    handoffDoneRef.current = true;
    stripApprovalActionFragment();
    if (intent.action === 'approve') approveRef.current({ id: intent.approvalId });
    else denyRef.current({ id: intent.approvalId });
  }, []);

  return { approve, deny, claim, cancel };
}

export type ApprovalActions = ReturnType<typeof useApprovalActions>;
