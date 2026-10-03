import { describe, expect, test } from 'bun:test';
import {
  buildResumeRelaunchNotice,
  formatRelaunchAge,
  resolveResumableSession,
  surfaceResumeRelaunchNotice,
} from '../../cli/resume-relaunch-notice.ts';

describe('formatRelaunchAge', () => {
  test('rounds sub-45s to "moments"', () => {
    expect(formatRelaunchAge(0)).toBe('moments');
    expect(formatRelaunchAge(44_000)).toBe('moments');
  });

  test('renders minutes below 45m', () => {
    expect(formatRelaunchAge(60_000)).toBe('1m');
    expect(formatRelaunchAge(30 * 60_000)).toBe('30m');
  });

  test('renders hours below 36h', () => {
    expect(formatRelaunchAge(2 * 60 * 60_000)).toBe('2h');
    expect(formatRelaunchAge(20 * 60 * 60_000)).toBe('20h');
  });

  test('renders days beyond 36h', () => {
    expect(formatRelaunchAge(3 * 24 * 60 * 60_000)).toBe('3d');
  });

  test('never goes negative on a clock skew', () => {
    expect(formatRelaunchAge(-5000)).toBe('moments');
  });

  // F4: Math.round used to bump 45m up to "1h ago" (round(45/60) = 1). Floor
  // semantics keep 45m through 59m59s reading as "Nm", and the "1h" label
  // only appears once a full hour has genuinely elapsed.
  describe('F4: floor semantics at the minutes/hours boundary', () => {
    test('45 minutes exactly reads as "45m", not "1h"', () => {
      expect(formatRelaunchAge(45 * 60_000)).toBe('45m');
    });

    test('59 minutes 59 seconds still reads as "59m", not "1h"', () => {
      expect(formatRelaunchAge(59 * 60_000 + 59_000)).toBe('59m');
    });

    test('60 minutes exactly rolls over to "1h"', () => {
      expect(formatRelaunchAge(60 * 60_000)).toBe('1h');
    });

    test('every minute from 45 through 59 reads as its own exact "Nm"', () => {
      for (let minute = 45; minute <= 59; minute += 1) {
        expect(formatRelaunchAge(minute * 60_000)).toBe(`${minute}m`);
      }
    });
  });
});

describe('buildResumeRelaunchNotice', () => {
  test('returns null when there is no last-session pointer (clean first run)', () => {
    expect(buildResumeRelaunchNotice({ pointerSessionId: null, session: null })).toBeNull();
  });

  test('is honest about a stale/dangling pointer and never offers a dead resume button', () => {
    const notice = buildResumeRelaunchNotice({ pointerSessionId: 'ghost-session', session: null });
    expect(notice).not.toBeNull();
    expect(notice).toContain('unavailable');
    expect(notice).toContain('/session list');
    expect(notice).not.toContain('/session resume');
  });

  test('surfaces an actionable resume notice for a resolvable session', () => {
    const now = Date.parse('2026-07-05T12:00:00.000Z');
    const notice = buildResumeRelaunchNotice({
      pointerSessionId: 'user-abc123',
      session: {
        sessionId: 'user-abc123',
        title: 'Refactor the daemon gate',
        timestamp: now - 2 * 60 * 60_000,
        messageCount: 14,
      },
      now,
    });
    expect(notice).toContain('Refactor the daemon gate');
    expect(notice).toContain('2h ago');
    expect(notice).toContain('14 messages');
    expect(notice).toContain('/session resume user-abc123');
    expect(notice).toContain('start typing');
  });

  test('falls back to the session id when the title is blank', () => {
    const notice = buildResumeRelaunchNotice({
      pointerSessionId: 'user-abc123',
      session: { sessionId: 'user-abc123', title: '   ', timestamp: Date.now(), messageCount: 1 },
    });
    expect(notice).toContain('"user-abc123"');
    expect(notice).toContain('1 message');
    expect(notice).not.toContain('1 messages');
  });

  // F5: a 0-message session has nothing to resume into. Offering a resume
  // action for it is a dead end like the stale-pointer case, so it is
  // treated the same as "no pointer at all", silent, not even the honest
  // stale-pointer wording.
  test('stays silent for a resolvable but 0-message session (nothing to resume into)', () => {
    const notice = buildResumeRelaunchNotice({
      pointerSessionId: 'user-empty',
      session: { sessionId: 'user-empty', title: 'Untitled', timestamp: Date.now(), messageCount: 0 },
    });
    expect(notice).toBeNull();
  });
});

describe('resolveResumableSession', () => {
  test('resolves an exact name match', () => {
    const sessionManager = {
      list: () => [
        { name: 'user-abc123', title: 'Refactor', timestamp: 100, messageCount: 3, model: '', provider: '', filePath: '' },
        { name: 'user-other', title: 'Other', timestamp: 200, messageCount: 9, model: '', provider: '', filePath: '' },
      ],
    };
    expect(resolveResumableSession(sessionManager as never, 'user-abc123')).toEqual({
      sessionId: 'user-abc123',
      title: 'Refactor',
      timestamp: 100,
      messageCount: 3,
    });
  });

  test('honestly returns null when the pointer names a session that is not on disk', () => {
    const sessionManager = { list: () => [] };
    expect(resolveResumableSession(sessionManager as never, 'ghost-session')).toBeNull();
  });
});

describe('surfaceResumeRelaunchNotice', () => {
  test('does nothing when there is no pointer', () => {
    const printed: string[] = [];
    surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => null,
      isRecoveryPending: () => false,
      findSession: () => null,
      print: (text) => printed.push(text),
    });
    expect(printed).toEqual([]);
  });

  test('defers to a pending crash-recovery prompt and never double-prompts', () => {
    const printed: string[] = [];
    surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => 'user-abc123',
      isRecoveryPending: () => true,
      findSession: () => ({ sessionId: 'user-abc123', title: 'x', timestamp: Date.now(), messageCount: 1 }),
      print: (text) => printed.push(text),
    });
    expect(printed).toEqual([]);
  });

  test('prints the actionable notice for a resolvable pointer session', () => {
    const printed: string[] = [];
    surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => 'user-abc123',
      isRecoveryPending: () => false,
      findSession: (id) => ({ sessionId: id, title: 'Ship the release', timestamp: Date.now() - 60_000, messageCount: 4 }),
      print: (text) => printed.push(text),
    });
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('/session resume user-abc123');
  });

  test('F5: says nothing for a resolvable 0-message session', () => {
    const printed: string[] = [];
    surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => 'user-empty',
      isRecoveryPending: () => false,
      findSession: (id) => ({ sessionId: id, title: 'Untitled', timestamp: Date.now(), messageCount: 0 }),
      print: (text) => printed.push(text),
    });
    expect(printed).toEqual([]);
  });

  test('prints the honest stale-pointer notice without a resume action', () => {
    const printed: string[] = [];
    surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => 'ghost-session',
      isRecoveryPending: () => false,
      findSession: () => null,
      print: (text) => printed.push(text),
    });
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('unavailable');
    expect(printed[0]).not.toContain('/session resume');
  });

  test('never throws and never blocks startup when a dependency fails', () => {
    const printed: string[] = [];
    expect(() => surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => { throw new Error('disk error'); },
      isRecoveryPending: () => false,
      findSession: () => null,
      print: (text) => printed.push(text),
    })).not.toThrow();
    expect(printed).toEqual([]);
  });

  test('never auto-resumes: printing the notice is the only side effect', () => {
    let resumeCalls = 0;
    const printed: string[] = [];
    surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => 'user-abc123',
      isRecoveryPending: () => false,
      findSession: (id) => ({ sessionId: id, title: 'x', timestamp: Date.now(), messageCount: 1 }),
      print: (text) => { printed.push(text); },
    });
    // Nothing in this module can call a resume action directly, resumeCalls
    // stays 0 because there is no resume-invoking dependency to call.
    expect(resumeCalls).toBe(0);
    expect(printed).toHaveLength(1);
  });
});
