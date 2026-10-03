/**
 * broker-approval, render a broker-originated approval ask as a real
 * agent-terminal permission card.
 *
 * The shared ApprovalBroker (constructed once in runtime/services.ts,
 * @goodvibes-jev/engine/sdk/platform/control-plane) publishes every ask this
 * agent process raises: local tool-call asks (which carry a `localPrompt`,
 * see bootstrap-core.ts's PermissionManager construction, which opens its
 * own card through permissionPromptRef.requestPermission), plus asks with no
 * local prompt attached at all, e.g. one raised by another attached command-
 * authority surface (webui, a channel like Telegram via approval-reply.ts)
 * against this same broker instance. Before this module existed, the second
 * kind was invisible in the agent terminal: the ask sat pending with no
 * surface to answer it here.
 *
 * A local ask's own prompt is opened by the broker immediately AFTER it
 * publishes (see ApprovalBroker.requestApproval), so the open here is
 * deferred one microtask and re-checks: if a card (the local one, or another
 * broker card) is already up, it does nothing, only a genuinely unhandled
 * ask surfaces. The card's resolve answers the broker directly via
 * resolveApproval, so an agent-terminal decision on a broker-originated ask
 * reaches every waiter on that record, including a tool call blocked on it
 * in this same process, and any other surface polling/watching the record.
 *
 * Deliberately narrower than the TUI's broker-approval-card.ts: this product's
 * PendingPermissionState (shell/blocking-input.ts) has no hunk-selection, no
 * typed-reply modes, and no CI fix-session concept (the agent does not own
 * build/fix/review worktrees, see DisabledAgentWorktreeRegistry in
 * runtime/services.ts), so none of that TUI-only machinery is ported here.
 */

import type { PendingPermissionState } from '../shell/blocking-input.ts';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';

/** The broker seam this module answers through, a subset of ApprovalBroker. */
export interface BrokerApprovalBroker {
  getApproval(approvalId: string): { readonly status: string; readonly request: PermissionPromptRequest } | null;
  resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly remember?: boolean;
      readonly actor: string;
      readonly actorSurface?: string;
    },
  ): Promise<unknown>;
}

export interface BrokerApprovalChangeParams {
  readonly approval: {
    readonly id: string;
    readonly callId: string;
    readonly status: string;
    readonly request: PermissionPromptRequest;
  };
  readonly getPending: () => PendingPermissionState | null;
  readonly setPending: (pending: PendingPermissionState | null) => void;
  readonly broker: BrokerApprovalBroker;
  readonly render: () => void;
  /** Defers the open (default queueMicrotask); injectable so tests run it synchronously. */
  readonly defer?: (callback: () => void) => void;
}

const isActiveStatus = (status: string): boolean => status === 'pending' || status === 'claimed';

/**
 * React to one broker approval change: clear the active card when ITS
 * approval resolves (answered here, elsewhere, or expired), or open a card
 * for a newly-pending broker-originated ask that no local prompt is handling.
 */
export function handleBrokerApprovalChange(params: BrokerApprovalChangeParams): void {
  const { approval, getPending, setPending, broker, render } = params;
  const defer = params.defer ?? queueMicrotask;
  const active = isActiveStatus(approval.status);

  const pending = getPending();
  if (pending && pending.callId === approval.callId) {
    // This is the card already on screen, clear it once its approval
    // resolves, whichever surface (or expiry) resolved it.
    if (!active) { setPending(null); render(); }
    return;
  }
  if (!active) return;

  defer(() => {
    if (getPending()) return; // a local card (or another broker card) is already up
    const current = broker.getApproval(approval.id);
    if (!current || !isActiveStatus(current.status)) return;
    setPending({
      ...current.request,
      resolve: (approved: boolean, remember = false) => {
        void broker.resolveApproval(approval.id, {
          approved,
          remember,
          actor: 'agent',
          actorSurface: 'agent',
        }).catch(() => {});
      },
    } as PendingPermissionState);
    render();
  });
}
