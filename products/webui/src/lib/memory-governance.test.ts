import { describe, expect, test } from 'bun:test';
import {
  clampUsedPct,
  formatMb,
  memoryTierBadgeClass,
  memoryTierLabel,
  readMemoryGovernanceSnapshot,
  tripwireLine,
} from './memory-governance';

const WIRE_SNAPSHOT = {
  tier: 'elevated',
  budgetMb: 1024,
  rssMb: 700,
  heapUsedMb: 300,
  heapTotalMb: 512,
  usedPct: 68.4,
  refusingExpensiveWork: false,
  caches: [
    { id: 'embeddings', name: 'Embeddings', entries: 10, estimatedBytes: 2048 },
    { id: 'sessions', name: 'Session index', entries: 3 },
  ],
  pausedJobs: ['knowledge.reindex'],
  tripwire: { armed: true, sustainedSec: 30, rateMbPerSec: 2.5 },
  thresholds: { elevatedPct: 60, highPct: 80, criticalPct: 95 },
};

describe('memory-governance helpers', () => {
  test('memoryTierLabel gives every tier a distinct label', () => {
    const labels = (['normal', 'elevated', 'high', 'critical'] as const).map(memoryTierLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('memoryTierBadgeClass reuses the existing .badge tone vocabulary', () => {
    expect(memoryTierBadgeClass('normal')).toBe('neutral');
    expect(memoryTierBadgeClass('elevated')).toBe('info');
    expect(memoryTierBadgeClass('high')).toBe('warning');
    expect(memoryTierBadgeClass('critical')).toBe('bad');
  });

  test('formatMb rounds and labels, never fabricating a value for a non-number', () => {
    expect(formatMb(512)).toBe('512 MB');
    expect(formatMb(511.6)).toBe('512 MB');
    expect(formatMb(undefined)).toBe('—');
    expect(formatMb(Number.NaN)).toBe('—');
  });

  test('clampUsedPct keeps the bar fill within 0-100 even for an over-budget sample', () => {
    expect(clampUsedPct(42)).toBe(42);
    expect(clampUsedPct(0)).toBe(0);
    expect(clampUsedPct(137)).toBe(100);
    expect(clampUsedPct(-5)).toBe(0);
    expect(clampUsedPct(Number.NaN)).toBe(0);
  });

  test('tripwireLine carries the armed rate and duration, and differs when not armed', () => {
    const armed = tripwireLine({ armed: true, sustainedSec: 45, rateMbPerSec: 3.2 });
    expect(armed).toContain('3.2');
    expect(armed).toContain('45');
    expect(tripwireLine({ armed: false, sustainedSec: 0, rateMbPerSec: 0 })).not.toBe(armed);
  });
});

describe('readMemoryGovernanceSnapshot: defensive wire parse', () => {
  test('a full schema-shaped payload parses verbatim', () => {
    const parsed = readMemoryGovernanceSnapshot(WIRE_SNAPSHOT);
    expect(parsed).not.toBeNull();
    expect(parsed?.tier).toBe('elevated');
    expect(parsed?.budgetMb).toBe(1024);
    expect(parsed?.caches).toHaveLength(2);
    expect(parsed?.caches[1]?.estimatedBytes).toBeUndefined();
    expect(parsed?.pausedJobs).toEqual(['knowledge.reindex']);
    expect(parsed?.tripwire.armed).toBe(true);
    expect(parsed?.thresholds.criticalPct).toBe(95);
  });

  test('a 200-with-empty-body answer parses to null (honest cannot-read), never a crash', () => {
    expect(readMemoryGovernanceSnapshot({})).toBeNull();
    expect(readMemoryGovernanceSnapshot(null)).toBeNull();
    expect(readMemoryGovernanceSnapshot('ok')).toBeNull();
    expect(readMemoryGovernanceSnapshot([])).toBeNull();
  });

  test('a payload missing a load-bearing number (rssMb) parses to null', () => {
    const { rssMb: _rssMb, ...withoutRss } = WIRE_SNAPSHOT;
    expect(readMemoryGovernanceSnapshot(withoutRss)).toBeNull();
  });

  test('an unknown tier value parses to null rather than an invented severity', () => {
    expect(readMemoryGovernanceSnapshot({ ...WIRE_SNAPSHOT, tier: 'apocalyptic' })).toBeNull();
  });

  test('decorative fields degrade individually: missing caches/pausedJobs/tripwire never sink the snapshot', () => {
    const parsed = readMemoryGovernanceSnapshot({
      tier: 'normal', budgetMb: 100, rssMb: 10, heapUsedMb: 5, usedPct: 10,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.caches).toEqual([]);
    expect(parsed?.pausedJobs).toEqual([]);
    expect(parsed?.tripwire).toEqual({ armed: false, sustainedSec: 0, rateMbPerSec: 0 });
  });
});
