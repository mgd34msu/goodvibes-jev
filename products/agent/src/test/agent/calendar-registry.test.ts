import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentCalendarRegistry } from '../../agent/calendar-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempRegistry(): AgentCalendarRegistry {
  const root = makeProjectTempDir('goodvibes-agent-calendar');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  return AgentCalendarRegistry.fromShellPaths(shellPaths);
}

describe('AgentCalendarRegistry', () => {
  test('creates, lists, gets, and deletes events', () => {
    const reg = tempRegistry();
    const event = reg.create({
      title: 'Sprint Review',
      start: '2024-03-15T14:00:00Z',
      end: '2024-03-15T15:00:00Z',
      location: 'Conference Room A',
    });

    expect(event.id).toBe('sprint-review');
    expect(event.allDay).toBe(false);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('sprint-review')?.title).toBe('Sprint Review');

    const deleted = reg.delete('sprint-review');
    expect(deleted.id).toBe('sprint-review');
    expect(reg.list()).toHaveLength(0);
  });

  test('allocates a unique id when title slug already exists', () => {
    const reg = tempRegistry();
    const e1 = reg.create({ title: 'Planning', start: '2024-01-01' });
    const e2 = reg.create({ title: 'Planning', start: '2024-02-01' });
    expect(e1.id).toBe('planning');
    expect(e2.id).toBe('planning-2');
  });

  test('rejects events with secret-looking values', () => {
    const reg = tempRegistry();
    expect(() => reg.create({
      title: 'Bad Event',
      start: '2024-01-01',
      notes: 'api_key=super-secret-value',
    })).toThrow('secret-looking');
  });

  test('throws on missing title or start', () => {
    const reg = tempRegistry();
    expect(() => reg.create({ title: '', start: '2024-01-01' })).toThrow('title is required');
    expect(() => reg.create({ title: 'Event', start: '' })).toThrow('start is required');
  });

  test('upcoming returns events within range, sorted by start', () => {
    const reg = tempRegistry();
    // Use a fixed "today" reference: set a well-known future date
    // Inject events: one tomorrow and one next month
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const nextMonth = new Date(now.getTime() + 32 * 86_400_000);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const nextMonthStr = nextMonth.toISOString().slice(0, 10);

    reg.create({ title: 'Near Event', start: tomorrowStr });
    reg.create({ title: 'Far Event', start: nextMonthStr });

    const upcoming7 = reg.upcoming(7);
    expect(upcoming7.some((e) => e.title === 'Near Event')).toBe(true);
    expect(upcoming7.some((e) => e.title === 'Far Event')).toBe(false);

    const upcoming60 = reg.upcoming(60);
    expect(upcoming60.some((e) => e.title === 'Far Event')).toBe(true);
  });

  test('importIcs imports events from iCalendar content', () => {
    const reg = tempRegistry();
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:import-test@example.com',
      'SUMMARY:Imported Meeting',
      'DTSTART:20250101T100000Z',
      'DTEND:20250101T110000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const result = reg.importIcs(ics);
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.secretSkipped).toBe(0);
    expect(result.imported[0]!.title).toBe('Imported Meeting');
    expect(result.imported[0]!.sourceProvenance).toBe('import-test@example.com');
    expect(reg.list()).toHaveLength(1);
  });

  test('importIcs skips (not throws) events with secret-looking values', () => {
    const reg = tempRegistry();
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:secret-test@test',
      'SUMMARY:Normal Event',
      'DESCRIPTION:api_key=leaked-value',
      'DTSTART:20250101T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    // Per-event secret scan must skip, not abort the whole batch.
    const result = reg.importIcs(ics);
    expect(result.imported).toHaveLength(0);
    expect(result.secretSkipped).toBe(1);
    expect(result.skipped).toBe(0);
    expect(reg.list()).toHaveLength(0);
  });

  test('MIN-1: importIcs skips events whose UID alone looks like a secret', () => {
    // UID field is now included in the assertNoSecretLikeText scan.
    // A UID containing a secret-like pattern (e.g. api_key=...) must be rejected.
    const reg = tempRegistry();
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      // UID itself contains a secret-looking value
      'UID:api_key=sk-abc123def456ghi789jkl',
      'SUMMARY:Clean Title',
      'DTSTART:20250101T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = reg.importIcs(ics);
    expect(result.imported).toHaveLength(0);
    expect(result.secretSkipped).toBe(1);
  });

  test('importIcs mixed batch: clean + duplicate + secret-bearing', () => {
    const reg = tempRegistry();
    // Pre-seed a duplicate by importing it first so sourceProvenance is stored.
    const seedIcs = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:dup@test',
      'SUMMARY:Duplicate Event',
      'DTSTART:20250601T090000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    reg.importIcs(seedIcs);

    const ics = [
      'BEGIN:VCALENDAR',
      // Clean event, should be imported.
      'BEGIN:VEVENT',
      'UID:clean@test',
      'SUMMARY:Clean Event',
      'DTSTART:20250615T100000Z',
      'END:VEVENT',
      // Duplicate, same UID as pre-seeded event, should be skipped.
      'BEGIN:VEVENT',
      'UID:dup@test',
      'SUMMARY:Duplicate Event',
      'DTSTART:20250601T090000Z',
      'END:VEVENT',
      // Secret-bearing, should be skipped with secretSkipped++.
      'BEGIN:VEVENT',
      'UID:secret@test',
      'SUMMARY:Secret Mtg',
      'DESCRIPTION:api_key=leaked-value',
      'DTSTART:20250620T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const result = reg.importIcs(ics);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]!.title).toBe('Clean Event');
    expect(result.skipped).toBe(1);
    expect(result.secretSkipped).toBe(1);
    // Registry has the pre-seeded + the one clean import.
    expect(reg.list()).toHaveLength(2);
  });

  test('exportIcs round-trips events through iCalendar format', () => {
    const reg = tempRegistry();
    reg.create({ title: 'Export Test', start: '2025-06-01T09:00:00Z', end: '2025-06-01T10:00:00Z' });
    const ics = reg.exportIcs();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('Export Test');
    // Re-import into a fresh registry to verify round-trip
    const reg2 = tempRegistry();
    const { imported } = reg2.importIcs(ics);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.title).toBe('Export Test');
  });

  test('exportIcs with destPath writes file and refuses to overwrite', () => {
    const reg = tempRegistry();
    reg.create({ title: 'Export Guard', start: '2025-07-01' });
    const dir = makeProjectTempDir('cal-export-test');
    const destPath = join(dir, 'out.ics');
    // First write: should succeed
    reg.exportIcs(undefined, destPath);
    // Second write: same path, should throw
    expect(() => reg.exportIcs(undefined, destPath)).toThrow('already exists');
  });

  test('delete throws on unknown id', () => {
    const reg = tempRegistry();
    expect(() => reg.delete('nonexistent-id')).toThrow('Unknown calendar event');
  });

  test('snapshot events are sorted by start date', () => {
    const reg = tempRegistry();
    reg.create({ title: 'Later', start: '2025-03-01' });
    reg.create({ title: 'Earlier', start: '2025-01-01' });
    const list = reg.list();
    expect(list[0]!.title).toBe('Earlier');
    expect(list[1]!.title).toBe('Later');
  });
});
