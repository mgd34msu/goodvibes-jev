import { describe, expect, test } from 'bun:test';
import { buildResumeNotice, describeContractOutcome, mostRecentContract } from '../../runtime/resume-notice.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';

describe('recorded contract outcomes', () => {
  test.each(['passed', 'failed', 'cancelled'] as const)('%s remains distinct', status => {
    expect(describeContractOutcome(contractFixture({ status }))).toBe(status);
  });
  test('active recovered work is interrupted, and latest completed/created record wins', () => {
    const active = contractFixture({ id: 'active', status: 'awaiting-owner', completedAt: undefined, createdAt: 3000 });
    const failed = contractFixture({ id: 'failed', status: 'failed', createdAt: 1000, completedAt: 2000 });
    expect(describeContractOutcome(active)).toBe('interrupted');
    expect(mostRecentContract([failed, active])).toBe(active);
    expect(mostRecentContract([])).toBeNull();
  });
});

describe('buildResumeNotice', () => {
  test('nothing to report (no session, no checkpoints, no chain history, no recovery snapshot) prints no notice', () => {
    expect(buildResumeNotice({
      turnCount: null,
      lastSessionId: null,
      checkpointCount: null,
      lastContractOutcome: null,
      memoryAvailable: false,
    })).toBeNull();
  });

  test('session only: reports turns and 0 checkpoints, leads with /resume and keeps the exact-id form secondary, no checkpoints/recall hint', () => {
    const notice = buildResumeNotice({
      turnCount: 5,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastContractOutcome: null,
      memoryAvailable: false,
    });
    expect(notice).toBe('Previous session found: 5 turns, 0 checkpoints: /resume to continue (or /session resume abc123 directly)');
  });

  test('session + checkpoints: adds the /checkpoints hint', () => {
    const notice = buildResumeNotice({
      turnCount: 1,
      lastSessionId: 'abc123',
      checkpointCount: 3,
      lastContractOutcome: null,
      memoryAvailable: false,
    });
    expect(notice).toBe('Previous session found: 1 turn, 3 checkpoints: /resume to continue (or /session resume abc123 directly) · /checkpoints to browse');
  });

  test('session + checkpoints + chain history: adds the last-chain clause', () => {
    const notice = buildResumeNotice({
      turnCount: 4,
      lastSessionId: 'abc123',
      checkpointCount: 2,
      lastContractOutcome: 'cancelled',
      memoryAvailable: false,
    });
    expect(notice).toBe(
      'Previous session found: 4 turns, 2 checkpoints, last workstream: cancelled: /resume to continue (or /session resume abc123 directly) · /checkpoints to browse',
    );
  });

  test('memory available adds the /recall hint', () => {
    const notice = buildResumeNotice({
      turnCount: 1,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastContractOutcome: null,
      memoryAvailable: true,
    });
    expect(notice).toBe('Previous session found: 1 turn, 0 checkpoints: /resume to continue (or /session resume abc123 directly) · /recall for memory');
  });

  test('no chain history means no chain clause at all (not a fabricated "none")', () => {
    const notice = buildResumeNotice({
      turnCount: 1,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastContractOutcome: null,
      memoryAvailable: false,
    });
    expect(notice).not.toContain('last chain');
  });

  test('checkpoint manager unavailable (null, not zero): no checkpoint claim and no /checkpoints hint', () => {
    const notice = buildResumeNotice({
      turnCount: 2,
      lastSessionId: 'abc123',
      checkpointCount: null,
      lastContractOutcome: null,
      memoryAvailable: false,
    });
    expect(notice).toBe('Previous session found: 2 turns: /resume to continue (or /session resume abc123 directly)');
    expect(notice).not.toContain('checkpoint');
  });

  test('no session but checkpoints and chain history exist: leads with "Workspace history found", no /session resume hint', () => {
    const notice = buildResumeNotice({
      turnCount: null,
      lastSessionId: null,
      checkpointCount: 4,
      lastContractOutcome: 'passed',
      memoryAvailable: false,
    });
    expect(notice).toBe('Workspace history found: 4 checkpoints, last workstream: passed: /checkpoints to browse');
    expect(notice).not.toContain('/session resume');
  });

  test('no session, checkpoint manager available but zero checkpoints, no chain history, no recovery snapshot: nothing to report', () => {
    expect(buildResumeNotice({
      turnCount: null,
      lastSessionId: null,
      checkpointCount: 0,
      lastContractOutcome: null,
      memoryAvailable: false,
    })).toBeNull();
  });

  // ── recovery snapshots (deliberately absent from this notice) ────────────
  //
  // A crash-recovery snapshot used to get a clause here. It now gets an
  // explicit ask-then-retire modal instead (runtime/recovery-prompt.ts), so
  // this notice must not mention one, two announcements of the same snapshot
  // is not more honest than one, it is just noisier, and the passive clause
  // was the half that could not actually restore anything.

  test('the notice has no recovery-snapshot vocabulary at all, whatever the state', () => {
    const notice = buildResumeNotice({
      turnCount: 5,
      lastSessionId: 'abc123',
      checkpointCount: 2,
      lastContractOutcome: 'passed',
      memoryAvailable: true,
    });
    expect(notice).not.toContain('recovery');
    expect(notice).not.toContain('snapshot');
  });

});
