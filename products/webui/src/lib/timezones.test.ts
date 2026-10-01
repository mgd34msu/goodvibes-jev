import { describe, expect, test } from 'bun:test';
import {
  filterTimezoneNames,
  isValidTimezoneName,
  listTimezoneNames,
} from './timezones';

describe('listTimezoneNames', () => {
  test('returns a non-empty, sorted list of real IANA zone names', () => {
    const zones = listTimezoneNames();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain('America/New_York');
    expect(zones).toContain('Europe/London');
    const sorted = [...zones].sort((a, b) => a.localeCompare(b));
    expect(zones).toEqual(sorted);
  });
});

describe('filterTimezoneNames', () => {
  test('an empty query returns the full list', () => {
    expect(filterTimezoneNames('')).toEqual(listTimezoneNames());
    expect(filterTimezoneNames('   ')).toEqual(listTimezoneNames());
  });

  test('filters case-insensitively by substring', () => {
    const results = filterTimezoneNames('new_york');
    expect(results).toContain('America/New_York');
    expect(results.every((z) => z.toLowerCase().includes('new_york'))).toBe(true);

    const upper = filterTimezoneNames('NEW_YORK');
    expect(upper).toEqual(results);
  });

  test('a query matching nothing returns an empty list, not the full list', () => {
    expect(filterTimezoneNames('not-a-real-zone-xyz')).toEqual([]);
  });
});

describe('isValidTimezoneName', () => {
  test('the empty (unset/UTC) value is valid', () => {
    expect(isValidTimezoneName('')).toBe(true);
    expect(isValidTimezoneName('   ')).toBe(true);
  });

  test('a real IANA name is valid', () => {
    expect(isValidTimezoneName('America/New_York')).toBe(true);
    expect(isValidTimezoneName('Europe/London')).toBe(true);
    expect(isValidTimezoneName('UTC')).toBe(true);
  });

  test('a nonsense zone name is invalid', () => {
    expect(isValidTimezoneName('Not/A_Real_Zone')).toBe(false);
    expect(isValidTimezoneName('banana')).toBe(false);
  });
});
