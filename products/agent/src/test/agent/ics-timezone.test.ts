import { describe, expect, test } from 'bun:test';
import { wallClockToUtcMs, utcMsToWallClock } from '../../agent/ics-timezone.ts';

// ── wallClockToUtcMs ──────────────────────────────────────────────────────────

describe('wallClockToUtcMs', () => {
  describe('standard EST/EDT conversions', () => {
    test('winter (EST = UTC-5): 09:00 NY = 14:00Z', () => {
      const ms = wallClockToUtcMs('2026-01-15T09:00:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    });

    test('summer (EDT = UTC-4): 09:00 NY = 13:00Z', () => {
      const ms = wallClockToUtcMs('2026-07-15T09:00:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-07-15T13:00:00.000Z');
    });

    test('just before spring-forward (01:30 EST = 06:30Z)', () => {
      const ms = wallClockToUtcMs('2026-03-08T01:30:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-03-08T06:30:00.000Z');
    });

    test('day after spring-forward (03:30 EDT on Mar 9 = 07:30Z)', () => {
      // On Mar 9, EDT is fully in effect: UTC-4. 03:30 local = 07:30Z.
      const ms = wallClockToUtcMs('2026-03-09T03:30:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-03-09T07:30:00.000Z');
    });
  });

  describe('DST gap behavior (spring-forward, nonexistent wall-clock)', () => {
    // US 2026 spring-forward: clocks jump from 02:00 AM EST to 03:00 AM EDT
    // at 2026-03-08T07:00:00Z. The interval 02:00–03:00 AM NY does not exist.
    //
    // Accepted gap-resolution (pinned regression):
    //   The offset-derivation algorithm converges to the pre-transition UTC
    //   instant (correctedMs), which Intl maps to the first valid post-gap
    //   wall-clock time. For 02:30 AM NY this is 03:30 AM EDT = 07:30Z.
    //   This is the conventional "spring forward" behavior.
    test('gap 02:30 AM NY resolves to 03:30 AM EDT (07:30Z): pinned regression', () => {
      const ms = wallClockToUtcMs('2026-03-08T02:30:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    });

    test('gap 02:00 AM NY (start of gap) resolves to 03:00 AM EDT (07:00Z)', () => {
      const ms = wallClockToUtcMs('2026-03-08T02:00:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-03-08T07:00:00.000Z');
    });

    test('gap 02:59 AM NY (end of gap) resolves to 03:59 AM EDT (07:59Z)', () => {
      const ms = wallClockToUtcMs('2026-03-08T02:59:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-03-08T07:59:00.000Z');
    });
  });

  describe('DST fold behavior (fall-back, ambiguous wall-clock)', () => {
    // US 2026 fall-back: clocks repeat 01:00–02:00 AM on 2026-11-01.
    // 01:30 AM appears in both EDT (05:30Z) and EST (06:30Z).
    // Accepted fold-resolution: returns the pre-transition (EDT) instant.
    test('fold 01:30 AM NY (Nov 1) resolves to 01:30 EDT (05:30Z)', () => {
      const ms = wallClockToUtcMs('2026-11-01T01:30:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    });
  });

  describe('DST transition-day valid wall-clocks', () => {
    // US 2026 spring-forward occurs at 2026-03-08T07:00:00Z (02:00 AM EST -> 03:00 AM EDT).
    // Post-transition wall-clocks on the same day (03:00+) must use the EDT offset (UTC-4).
    test('2026-03-08T03:30 America/New_York -> 2026-03-08T07:30:00.000Z', () => {
      const ms = wallClockToUtcMs('2026-03-08T03:30:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    });

    test('2026-03-08T06:00 America/New_York -> 2026-03-08T10:00:00.000Z', () => {
      const ms = wallClockToUtcMs('2026-03-08T06:00:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-03-08T10:00:00.000Z');
    });

    test('2026-03-08T09:00 America/New_York -> 2026-03-08T13:00:00.000Z', () => {
      const ms = wallClockToUtcMs('2026-03-08T09:00:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    });

    // US 2026 fall-back: clocks repeat 01:00-02:00 on 2026-11-01.
    // Post-transition 03:30 must use EST (UTC-5).
    test('2026-11-01T03:30 America/New_York -> 2026-11-01T08:30:00.000Z', () => {
      const ms = wallClockToUtcMs('2026-11-01T03:30:00', 'America/New_York');
      expect(new Date(ms).toISOString()).toBe('2026-11-01T08:30:00.000Z');
    });
  });

  describe('unknown TZID fallback', () => {
    test('unknown TZID treats wall-clock as UTC (no throw)', () => {
      expect(() => wallClockToUtcMs('2026-01-15T09:00:00', 'Not/AReal_Timezone')).not.toThrow();
      const ms = wallClockToUtcMs('2026-01-15T09:00:00', 'Not/AReal_Timezone');
      expect(new Date(ms).toISOString()).toBe('2026-01-15T09:00:00.000Z');
    });
  });
});

// ── utcMsToWallClock ──────────────────────────────────────────────────────────

describe('utcMsToWallClock', () => {
  test('converts UTC instant to NY wall-clock (winter)', () => {
    // 2026-01-15T14:00:00Z = 09:00 EST
    const wc = utcMsToWallClock(Date.UTC(2026, 0, 15, 14, 0, 0), 'America/New_York');
    expect(wc).toBe('2026-01-15T09:00:00');
  });

  test('converts UTC instant to NY wall-clock (summer)', () => {
    // 2026-07-15T13:00:00Z = 09:00 EDT
    const wc = utcMsToWallClock(Date.UTC(2026, 6, 15, 13, 0, 0), 'America/New_York');
    expect(wc).toBe('2026-07-15T09:00:00');
  });

  test('returns null for unknown TZID', () => {
    const wc = utcMsToWallClock(Date.UTC(2026, 0, 1, 0, 0, 0), 'Not/AReal_Timezone');
    expect(wc).toBeNull();
  });
});
