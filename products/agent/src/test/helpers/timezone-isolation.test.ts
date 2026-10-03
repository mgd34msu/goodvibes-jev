import { expect, test } from 'bun:test';

// This is the same Date/Intl boundary used by the timestamp-bearing golden
// renderers. The calendar ordering suite temporarily selects New York.
test('the Agent preload gives timezone-changing tests a concrete UTC value to restore', () => {
  const original = process.env.TZ;
  expect(original).toBe('UTC');
  const september = new Date('2026-09-29T15:30:00Z');
  const january = new Date('2027-01-15T07:47:56Z');
  try {
    process.env.TZ = 'America/New_York';
    expect(september.getHours()).toBe(11);
    expect(january.getHours()).toBe(2);
  } finally {
    process.env.TZ = original;
  }
  expect(new Date(september).getHours()).toBe(15);
  expect(new Date(january).getHours()).toBe(7);
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
});
