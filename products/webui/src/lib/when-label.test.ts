import { describe, expect, test } from 'bun:test';
import { whenLabel } from './when-label';

const NOW = Date.parse('2026-09-30T12:00:00Z');

describe('whenLabel', () => {
  test('missing, zero and epoch times show nothing', () => {
    expect(whenLabel(undefined, NOW)).toBe('');
    expect(whenLabel(null, NOW)).toBe('');
    expect(whenLabel(0, NOW)).toBe('');
    expect(whenLabel(1000, NOW)).toBe('');
  });

  test('recent past reads as relative words', () => {
    expect(whenLabel(NOW - 10_000, NOW)).toBe('just now');
    expect(whenLabel(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(whenLabel(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(whenLabel(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });

  test('the near future reads as "in"', () => {
    expect(whenLabel(NOW + 3 * 86_400_000, NOW)).toBe('in 3d');
  });

  test('older than a week is a short date', () => {
    expect(whenLabel(Date.parse('2025-11-14T12:00:00Z'), NOW)).toBe('Nov 14, 2025');
    expect(whenLabel(Date.parse('2026-08-02T12:00:00Z'), NOW)).toBe('Aug 2');
  });
});
