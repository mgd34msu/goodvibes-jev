import { describe, it, expect } from 'bun:test';
import { describePowerStatus } from '../../renderer/power-status.ts';

function state(overrides: {
  keepAwakeEnabled?: boolean;
  keepAwakeNote?: string | null;
  workHeld?: boolean;
  workReasons?: readonly string[];
}) {
  return {
    work: {
      held: overrides.workHeld ?? false,
      reasons: overrides.workReasons ?? [],
      grantedClasses: [],
      deniedClasses: [],
      heldSince: null,
      capMinutes: 180,
      capExpiresAt: null,
      capExpired: false,
    },
    keepAwake: {
      enabled: overrides.keepAwakeEnabled ?? false,
      note: overrides.keepAwakeNote ?? null,
      held: overrides.keepAwakeEnabled ?? false,
      grantedClasses: [],
      deniedClasses: [],
    },
  };
}

describe('describePowerStatus', () => {
  it('shows nothing when idle and keep-awake is off', () => {
    expect(describePowerStatus(state({}))).toBeNull();
  });

  it('shows the keep-awake note when the owner toggle is on', () => {
    expect(describePowerStatus(state({ keepAwakeEnabled: true }))).toBe('sleep disabled (keep-awake)');
  });

  it('appends the honest lid-switch split note when the OS denied that class', () => {
    const note = 'idle sleep blocked; lid-close suspend is controlled by your OS here';
    expect(describePowerStatus(state({ keepAwakeEnabled: true, keepAwakeNote: note })))
      .toBe(`sleep disabled, ${note}`);
  });

  it('shows the real work-hold reasons while automatic inhibition holds', () => {
    expect(describePowerStatus(state({ workHeld: true, workReasons: ['a turn is running'] })))
      .toBe('held: a turn is running');
  });

  it('joins multiple concurrent work-hold reasons', () => {
    expect(describePowerStatus(state({ workHeld: true, workReasons: ['a turn is running', 'agent agent-1 is active'] })))
      .toBe('held: a turn is running; agent agent-1 is active');
  });

  it('keep-awake takes priority over an automatic work hold', () => {
    expect(describePowerStatus(state({ keepAwakeEnabled: true, workHeld: true, workReasons: ['a turn is running'] })))
      .toBe('sleep disabled (keep-awake)');
  });

  it('shows nothing when work.held is true but reasons is empty (defensive)', () => {
    expect(describePowerStatus(state({ workHeld: true, workReasons: [] }))).toBeNull();
  });
});
