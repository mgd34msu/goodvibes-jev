import type { ConversationManager } from '../core/conversation';
import type { PermissionRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { SessionSnapshot } from '@/runtime/index.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import { readConversationMessageSnapshots } from '../core/conversation-message-snapshot.ts';
import type { DaemonRepairPrompt } from './daemon-repair-prompt.ts';

export type PendingPermissionState = PermissionRequest & {
  resolve: (approved: boolean, remember?: boolean) => void;
};

export type BlockingInputHandlerOptions = {
  data: string;
  pendingPermission: PendingPermissionState | null;
  /** The sessionId of the offered recovery snapshot, or null when none is pending. Callers key consumeRecovery/removeRecoveryPoint to this exact id, see BlockingInputHandlerResult.recoveryPending. */
  recoveryPending: string | null;
  /**
   * The one-touch daemon repair offer, when this launch made one. A
   * self-contained controller (shell/daemon-repair-prompt.ts) rather than a
   * state field plus callbacks: it owns the awaiting-answer state, the wording
   * and the follow-up, so nothing here has to be threaded back out.
   */
  daemonRepairPrompt: DaemonRepairPrompt | null;
  abortTurn: () => void;
  conversation: ConversationManager;
  systemMessageRouter: SystemMessageRouter;
  render: () => void;
  /** The prompted "yes, resume it" primitive (SDK consumeRecovery): loads the recovery snapshot and retires its file in one operation, only once the load actually succeeds. The caller keys this to the offered snapshot's sessionId. */
  consumeRecovery: () => SessionSnapshot | null;
  /** The prompted "no, and remove it" primitive (SDK removeRecoveryPoint): clears the recovery snapshot without loading it. The caller keys this to the offered snapshot's sessionId. */
  removeRecoveryPoint: () => void;
};

export type BlockingInputHandlerResult = {
  handled: boolean;
  pendingPermission: PendingPermissionState | null;
  recoveryPending: string | null;
  // Deliberately no daemonRepairPrompt: the controller owns its own
  // awaiting-answer state, so unlike the fields above there is nothing for the
  // shell to carry back and reassign.
};

export function handleBlockingShellInput(
  options: BlockingInputHandlerOptions,
): BlockingInputHandlerResult {
  const {
    data,
    pendingPermission,
    recoveryPending,
    daemonRepairPrompt,
    abortTurn,
    conversation,
    systemMessageRouter,
    render,
    consumeRecovery,
    removeRecoveryPoint,
  } = options;

  if (pendingPermission) {
    const req = pendingPermission;
    const key = data.toLowerCase().trim();

    if (key === 'y') {
      req.resolve(true, false);
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    if (key === 'a') {
      req.resolve(true, true);
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    if (key === 'n' || data === '\x1b' || data === '\x03') {
      req.resolve(false, false);
      abortTurn();
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    render();
    return { handled: true, pendingPermission, recoveryPending };
  }

  if (recoveryPending) {
    if (data === '\x12') {
      // consumeRecovery only retires the snapshot file once the load actually
      // succeeds, a bad read leaves it on disk instead of silently
      // destroying data that was never actually recovered.
      const recovery = consumeRecovery();
      if (recovery) {
        conversation.fromJSON({ messages: readConversationMessageSnapshots(recovery.messages) });
        systemMessageRouter.high('[Recovery] Session restored.');
      } else {
        systemMessageRouter.high('[Recovery] Failed to restore saved data.');
      }
      render();
      return { handled: true, pendingPermission: null, recoveryPending: null };
    }

    if (data === '\x1b' || data === '\x03') {
      systemMessageRouter.high('[Recovery] Discarded recovery data.');
      removeRecoveryPoint();
      render();
      return { handled: true, pendingPermission: null, recoveryPending: null };
    }

    systemMessageRouter.high('[Recovery] Ignored saved session; starting a new prompt.');
    removeRecoveryPoint();
    render();
    return { handled: false, pendingPermission: null, recoveryPending: null };
  }

  // One-touch daemon repair: 'y' repairs, EVERY other key declines, default
  // no, matching the workspace prompt below and every other boot-time offer.
  // Declining changes nothing whatsoever and is remembered for the rest of the
  // session, so the question is asked once and never turn after turn.
  if (daemonRepairPrompt?.pending()) {
    daemonRepairPrompt.answer(data);
    return { handled: true, pendingPermission: null, recoveryPending };
  }

  // The first-start workspace question is a selection modal now
  // (shell/workspace-registration-question.ts): it receives only the keys aimed
  // at it, so nothing here waits on a question the screen does not show.
  return { handled: false, pendingPermission, recoveryPending };
}
