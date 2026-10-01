/**
 * approval-action-link.ts, the app side of a push "Allow"/"Deny" tap.
 *
 * When the operator taps an action button on an approval notification, the
 * service worker opens the app at `/?view=approvals-tasks#approval-action=<a>&
 * approval-id=<id>` (see notification-link.ts). This module reads that fragment
 * and scrubs it, so the authenticated ApprovalsTasksView can run the real
 * approvals.approve/deny call, the mutation the service worker itself cannot
 * make. Pure over `window.location`, unit-testable, and consistent with the
 * pairing hand-off's fragment discipline.
 */

export type ApprovalNotificationAction = 'approve' | 'deny';

export interface ApprovalActionIntent {
  action: ApprovalNotificationAction;
  approvalId: string;
}

const ACTION_KEY = 'approval-action';
const ID_KEY = 'approval-id';

/** Read an approve/deny intent out of a URL hash, or null when none is present. */
export function parseApprovalActionFromHash(hash: string): ApprovalActionIntent | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const action = params.get(ACTION_KEY);
  const approvalId = params.get(ID_KEY)?.trim() ?? '';
  if ((action === 'approve' || action === 'deny') && approvalId.length > 0) {
    return { action, approvalId };
  }
  return null;
}

/**
 * Remove the approval-action keys from the current URL's fragment via
 * history.replaceState, preserving path, query, and any other fragment keys.
 */
export function stripApprovalActionFragment(): void {
  if (typeof window === 'undefined') return;
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(rawHash);
  if (!params.has(ACTION_KEY) && !params.has(ID_KEY)) return;
  params.delete(ACTION_KEY);
  params.delete(ID_KEY);
  const remaining = params.toString();
  const url = `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}
