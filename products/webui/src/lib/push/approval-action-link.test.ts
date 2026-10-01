/**
 * approval-action-link.ts, fragment parse + history cleanup for a push
 * "Allow"/"Deny" hand-off.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { parseApprovalActionFromHash, stripApprovalActionFragment } from './approval-action-link';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('parseApprovalActionFromHash', () => {
  test('reads an approve intent', () => {
    expect(parseApprovalActionFromHash('#approval-action=approve&approval-id=apr-1')).toEqual({
      action: 'approve',
      approvalId: 'apr-1',
    });
  });

  test('reads a deny intent', () => {
    expect(parseApprovalActionFromHash('#approval-action=deny&approval-id=apr-2')).toEqual({
      action: 'deny',
      approvalId: 'apr-2',
    });
  });

  test('decodes an encoded approval id', () => {
    expect(parseApprovalActionFromHash('#approval-action=approve&approval-id=a%2Fb')).toEqual({
      action: 'approve',
      approvalId: 'a/b',
    });
  });

  test('returns null for an unknown action, a missing id, or an unrelated hash', () => {
    expect(parseApprovalActionFromHash('#approval-action=snooze&approval-id=apr-1')).toBeNull();
    expect(parseApprovalActionFromHash('#approval-action=approve')).toBeNull();
    expect(parseApprovalActionFromHash('#view=chat')).toBeNull();
    expect(parseApprovalActionFromHash('')).toBeNull();
  });
});

describe('stripApprovalActionFragment', () => {
  test('removes only the approval-action keys, keeping path, query, and other fragment keys', () => {
    window.history.replaceState(null, '', '/?view=approvals-tasks#view=chat&approval-action=approve&approval-id=apr-1');
    stripApprovalActionFragment();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?view=approvals-tasks');
    expect(window.location.hash).toBe('#view=chat');
    expect(parseApprovalActionFromHash(window.location.hash)).toBeNull();
  });

  test('clears the fragment entirely when the action keys were the only ones', () => {
    window.history.replaceState(null, '', '/?view=approvals-tasks#approval-action=deny&approval-id=apr-1');
    stripApprovalActionFragment();
    expect(window.location.hash).toBe('');
  });

  test('is a no-op when there is no action fragment', () => {
    window.history.replaceState(null, '', '/?view=approvals-tasks');
    stripApprovalActionFragment();
    expect(window.location.search).toBe('?view=approvals-tasks');
  });
});
