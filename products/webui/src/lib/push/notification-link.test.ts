import { describe, expect, test } from 'bun:test';
import { linkForNotification } from './notification-link';

describe('linkForNotification', () => {
  test('an approval push deep-links to the approvals view', () => {
    expect(linkForNotification({ kind: 'approval', approvalId: 'apr-1' })).toBe('/?view=approvals-tasks');
  });

  test('an explicit in-app url is honored', () => {
    expect(linkForNotification({ url: '/?view=sessions' })).toBe('/?view=sessions');
  });

  test('an off-site (non-relative) url is refused, falling back to the app root', () => {
    expect(linkForNotification({ url: 'https://evil.example/phish' })).toBe('/');
  });

  test('unknown / empty data falls back to the app root, never a dead tap', () => {
    expect(linkForNotification({})).toBe('/');
    expect(linkForNotification(undefined)).toBe('/');
    expect(linkForNotification(null)).toBe('/');
  });

  test('an Allow/Deny action tap carries the action + approval id in the fragment', () => {
    expect(linkForNotification({ kind: 'approval', approvalId: 'apr-1' }, 'approve')).toBe(
      '/?view=approvals-tasks#approval-action=approve&approval-id=apr-1',
    );
    expect(linkForNotification({ kind: 'approval', approvalId: 'apr-1' }, 'deny')).toBe(
      '/?view=approvals-tasks#approval-action=deny&approval-id=apr-1',
    );
  });

  test('a body tap (no action) still deep-links to the plain approvals view', () => {
    expect(linkForNotification({ kind: 'approval', approvalId: 'apr-1' })).toBe('/?view=approvals-tasks');
  });

  test('an unknown action, or an approval with no id, falls back to the plain view', () => {
    expect(linkForNotification({ kind: 'approval', approvalId: 'apr-1' }, 'snooze')).toBe('/?view=approvals-tasks');
    expect(linkForNotification({ kind: 'approval' }, 'approve')).toBe('/?view=approvals-tasks');
  });

  test('the approval id is url-encoded in the fragment', () => {
    expect(linkForNotification({ kind: 'approval', approvalId: 'a/b c' }, 'approve')).toBe(
      '/?view=approvals-tasks#approval-action=approve&approval-id=a%2Fb%20c',
    );
  });

  test('a needs-input push deep-links to the Fleet view focused on the node + session', () => {
    expect(linkForNotification({ kind: 'needs-input', nodeId: 'agent-7', sessionId: 's-1' })).toBe(
      '/?view=fleet#fleet-node=agent-7&fleet-session=s-1',
    );
  });

  test('a needs-input push with no session id still focuses the node', () => {
    expect(linkForNotification({ kind: 'needs-input', nodeId: 'agent-7' })).toBe(
      '/?view=fleet#fleet-node=agent-7',
    );
  });

  test('a needs-input push with no node id opens the Fleet view rather than a dead tap', () => {
    expect(linkForNotification({ kind: 'needs-input' })).toBe('/?view=fleet');
  });

  test('the needs-input node + session ids are url-encoded in the fragment', () => {
    expect(linkForNotification({ kind: 'needs-input', nodeId: 'a/b', sessionId: 'x y' })).toBe(
      '/?view=fleet#fleet-node=a%2Fb&fleet-session=x%20y',
    );
  });
});
