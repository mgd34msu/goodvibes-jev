import { describe, expect, test } from 'bun:test';
import { workstreamFailureNotification } from '@/core/workstream-notification.ts';

const rich = { metadataOnly: false };
describe('contract desktop notification facts', () => {
  test('the cancellation event is distinct from failure even when its reason sounds like a failure', () => {
    const notice = workstreamFailureNotification({ type: 'CONTRACT_CANCELLED', reason: 'failed checks; the owner stopped work', filesModified: 2 }, rich);
    expect(notice.title).toBe('GoodVibes: workstream cancelled');
    expect(notice.body).toBe('Cancelled: failed checks; the owner stopped work');
  });
  test('a failure reason that starts with cancellation stays a failure', () => {
    const notice = workstreamFailureNotification({ type: 'CONTRACT_FAILED', reason: 'Cancelled upstream operation', failureKind: 'other' }, rich);
    expect(notice.title).toBe('GoodVibes: workstream failed');
    expect(notice.body).toBe('Failed: Cancelled upstream operation');
  });
  test('turn budget reads the actual typed limit and source, with no reason parsing', () => {
    const notice = workstreamFailureNotification({ type: 'CONTRACT_FAILED', reason: 'unrelated prose', failureKind: 'max_turns', turnLimit: 50, turnLimitSource: 'policy-bound' }, rich);
    expect(notice.title).toContain('turn budget');
    expect(notice.body).toContain('50 turns');
    expect(notice.body).toContain('policy cap');
    expect(notice.body).not.toContain('unrelated prose');
  });
  test('transport classification uses a static reason', () => {
    expect(workstreamFailureNotification({ type: 'CONTRACT_FAILED', reason: 'private raw error', failureKind: 'transport' }, rich).body).toBe('Failed: transient transport error');
  });
  test('the public failure kinds are accepted without inventing a review score', () => {
    for (const failureKind of ['planning', 'budget', 'owner-rejected', 'judgment-unavailable', 'zombie', 'other'] as const) {
      const notice = workstreamFailureNotification({ type: 'CONTRACT_FAILED', reason: 'A requirement was not met', failureKind }, { ...rich, task: 'Repair notification delivery' });
      expect(notice.title).toBe('Workstream failed: Repair notification delivery');
      expect(notice.body).toBe('Failed: A requirement was not met');
      expect(JSON.stringify(notice)).not.toMatch(/chain|WRFC|last review/);
    }
  });
  test('missing or restricted privacy never reads the task or reason getters', () => {
    for (const metadataOnly of [undefined, true]) {
      let privateReads = 0;
      const notice = workstreamFailureNotification({ type: 'CONTRACT_FAILED', failureKind: 'other', get reason() { privateReads++; throw new Error('private'); } }, {
        metadataOnly, get task() { privateReads++; throw new Error('private'); },
      });
      expect(privateReads).toBe(0);
      expect(notice).toEqual({ title: 'GoodVibes: workstream failed', body: 'Failed' });
    }
  });
});
