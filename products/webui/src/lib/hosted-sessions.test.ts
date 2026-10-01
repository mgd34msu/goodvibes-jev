import { describe, expect, test } from 'bun:test';
import {
  effectiveDetachPolicyLabel,
  hostedAttachResultFrom,
  hostedAttachedClientCount,
  hostedSessionFromResult,
  hostedSessionsFromListResult,
  hostedStatusLabel,
  hostedStatusTone,
  hostedTerminationLabel,
  isThisClientAttached,
  sortHostedSessionsNewestFirst,
} from './hosted-sessions';
import type { HostedSessionRecord } from './goodvibes';

const RECORD: HostedSessionRecord = {
  id: 'hosted-1',
  workspaceRoot: '/home/operator/project',
  title: 'Refactor',
  status: 'running',
  detachPolicy: null,
  effectiveDetachPolicy: 'survive',
  attachedClients: ['client-a'],
  createdAt: 1,
  updatedAt: 2,
  turnCount: 1,
  messageCount: 2,
  restoredFromDisk: false,
  contractIds: [],
};

describe('hostedSessionsFromListResult: honesty bar', () => {
  test('reads the sessions array from a well-formed response', () => {
    expect(hostedSessionsFromListResult({ sessions: [RECORD] })).toEqual([RECORD]);
  });

  test('degrades to [] for an unmodeled response (the mock/older-daemon {} fallback)', () => {
    expect(hostedSessionsFromListResult({})).toEqual([]);
    expect(hostedSessionsFromListResult(undefined)).toEqual([]);
    expect(hostedSessionsFromListResult(null)).toEqual([]);
    expect(hostedSessionsFromListResult('nonsense')).toEqual([]);
  });
});

describe('hostedAttachResultFrom: honesty bar', () => {
  test('reads session + history from a well-formed response', () => {
    const result = hostedAttachResultFrom({ session: RECORD, history: [{ role: 'user', content: 'hi' }] });
    expect(result.session).toEqual(RECORD);
    expect(result.history).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('degrades to a null session and empty history for an unmodeled response', () => {
    expect(hostedAttachResultFrom({})).toEqual({ session: null, history: [] });
    expect(hostedAttachResultFrom(undefined)).toEqual({ session: null, history: [] });
  });
});

describe('hostedSessionFromResult', () => {
  test('reads the session off a create/detach/kill result', () => {
    expect(hostedSessionFromResult({ session: RECORD })).toEqual(RECORD);
  });

  test('null for an unmodeled response', () => {
    expect(hostedSessionFromResult({})).toBeNull();
    expect(hostedSessionFromResult(undefined)).toBeNull();
  });
});

describe('sortHostedSessionsNewestFirst', () => {
  test('sorts by updatedAt (falling back to createdAt) descending', () => {
    const a = { ...RECORD, id: 'a', updatedAt: 1 };
    const b = { ...RECORD, id: 'b', updatedAt: 3 };
    const c = { ...RECORD, id: 'c', updatedAt: 0, createdAt: 2 };
    expect(sortHostedSessionsNewestFirst([a, b, c]).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('status labels/tones', () => {
  test('known statuses get the expected tone', () => {
    expect(hostedStatusTone('running')).toBe('ok');
    expect(hostedStatusTone('idle')).toBe('neutral');
    expect(hostedStatusTone('terminated')).toBe('bad');
    expect(hostedStatusTone('mystery-future-status')).toBe('neutral');
  });

  test('status label renders verbatim, never blank', () => {
    expect(hostedStatusLabel('running')).toBe('running');
    expect(hostedStatusLabel('  ').trim().length).toBeGreaterThan(0);
  });
});

describe('effectiveDetachPolicyLabel: never a guess', () => {
  test('kill and survive get distinct labels', () => {
    expect(effectiveDetachPolicyLabel('kill')).not.toBe(effectiveDetachPolicyLabel('survive'));
  });

  test('an unrecognized policy is named verbatim, not silently mapped to one of the two known ones', () => {
    expect(effectiveDetachPolicyLabel('future-policy')).toContain('future-policy');
  });
});

describe('hostedTerminationLabel', () => {
  test('null when the session is not terminated', () => {
    expect(hostedTerminationLabel({ status: 'running', terminatedReason: undefined })).toBeNull();
  });

  test('every known termination reason maps to a human line', () => {
    const reasons = ['detached', 'killed', 'daemon-shutdown', 'restart-unresumable', 'retired', 'evicted'] as const;
    for (const reason of reasons) {
      const label = hostedTerminationLabel({ status: 'terminated', terminatedReason: reason });
      expect(label).not.toBeNull();
    }
    const labels = reasons.map((reason) => hostedTerminationLabel({ status: 'terminated', terminatedReason: reason }));
    expect(new Set(labels).size).toBe(reasons.length);
  });

  test('an unrecognized reason still renders verbatim rather than being dropped', () => {
    expect(hostedTerminationLabel({ status: 'terminated', terminatedReason: 'some-future-reason' })).toContain('some-future-reason');
  });

  test('no reason recorded still yields a label', () => {
    expect(hostedTerminationLabel({ status: 'terminated', terminatedReason: undefined })).not.toBeNull();
  });
});

describe('attached-client helpers', () => {
  test('hostedAttachedClientCount counts the array', () => {
    expect(hostedAttachedClientCount({ attachedClients: ['a', 'b'] })).toBe(2);
    expect(hostedAttachedClientCount({ attachedClients: [] })).toBe(0);
  });

  test('isThisClientAttached', () => {
    expect(isThisClientAttached({ attachedClients: ['a', 'b'] }, 'a')).toBe(true);
    expect(isThisClientAttached({ attachedClients: ['a', 'b'] }, 'c')).toBe(false);
  });
});
