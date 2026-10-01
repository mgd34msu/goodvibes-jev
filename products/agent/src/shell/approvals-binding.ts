/**
 * approvals-binding.ts, the two things an interactive session does with
 * approvals, in one place, because they used to be one and are no longer.
 *
 * ── Two sources, one list ─────────────────────────────────────────────────
 *
 * A permission ask raised on this surface is posted to the adopted daemon and
 * prompted here; the daemon's record is what every surface reads. Separately,
 * the local `ApprovalBroker` still receives asks handed over in-process by the
 * distributed-runtime bridge, and those are the ones that open a card on this
 * screen without a local prompt already handling them.
 *
 * So the session needs both wirings and they are not the same wiring:
 *
 *  • the BROKER SUBSCRIPTION drives the on-screen card (a live event, in this
 *    process, about an ask this process must render right now), and
 *  • the APPROVALS VIEW drives the LIST (what is waiting, across every
 *    surface, including the asks that never touched this process).
 *
 * Binding only the first is what made the list read "nothing pending" while
 * the owner had three asks waiting on the daemon.
 */
import type { SharedApprovalRecord } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { ApprovalBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { handleBrokerApprovalChange } from '../permissions/broker-approval.ts';
import type { PendingPermissionState } from './blocking-input.ts';
import { describeApprovalsUnavailable, type ApprovalsView } from '../runtime/client/approvals-view.ts';

export interface ApprovalsBindingOptions {
  readonly broker: ApprovalBroker;
  readonly approvalsView: ApprovalsView;
  readonly render: () => void;
  readonly getPending: () => PendingPermissionState | null;
  readonly setPending: (next: PendingPermissionState | null) => void;
}

export interface ApprovalsBinding {
  /** Every ask waiting for this owner: the daemon's record plus this process's. */
  readonly listApprovals: () => readonly SharedApprovalRecord[];
  /**
   * The honest line when the daemon's record could not be read, or null when
   * it was. Consumers that render a count MUST print this alongside it, a
   * short count and a complete one are indistinguishable otherwise.
   */
  readonly describeApprovalsUnavailable: () => string | null;
}

export function bindApprovals(options: ApprovalsBindingOptions): ApprovalsBinding {
  // Clears our own resolved card and opens one for a broker-originated ask no
  // local prompt is handling, see permissions/broker-approval.ts.
  options.broker.subscribe((approval) => handleBrokerApprovalChange({
    approval,
    broker: options.broker,
    render: options.render,
    getPending: options.getPending,
    setPending: options.setPending,
  }));
  // Keep the list current against the daemon's record for as long as this
  // session is on screen. The refresh is unref'd and single-flighted; the
  // runtime graph's dispose() stops it.
  options.approvalsView.start();

  return {
    listApprovals: () => options.approvalsView.snapshot().approvals,
    describeApprovalsUnavailable: () => describeApprovalsUnavailable(options.approvalsView.snapshot()),
  };
}
