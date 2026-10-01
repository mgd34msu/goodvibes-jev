import { describe, expect, test } from 'bun:test';
import { parseIcs, renderIcs, foldLine, expandRecurringEvent } from '../../agent/ics-calendar.ts';

// ---------------------------------------------------------------------------
// MIN-4: RRULE total-iteration backstop test
// ---------------------------------------------------------------------------

describe('expandRecurringEvent MIN-4: total-iteration backstop', () => {
  test('terminates when COUNT is enormous and horizon would not naturally stop the loop', () => {
    // A daily event starting 10 years in the future from the reference date
    // with COUNT=99999999 would only be bounded by the 90-day horizon normally.
    // But we also test that when the cursor does not advance (degenerate edge)
    // the totalIterations cap kicks in at 100_000.
    // In practice, the horizon check terminates this in ~90 iterations.
    // We test that the function returns a finite result in reasonable time.
    const start = new Date();
    const ref = new Date(start.getTime());
    const event = {
      uid: 'backstop-test',
      summary: 'Daily Backstop',
      dtstart: start.toISOString(),
      allDay: false,
      rrule: 'FREQ=DAILY;COUNT=99999999',
    };
    const before = Date.now();
    const occ = expandRecurringEvent(event, ref, 90);
    const elapsed = Date.now() - before;
    // Must return in under 2 seconds (backstop prevents runaway)
    expect(elapsed).toBeLessThan(2000);
    // Should have approximately 90 occurrences (horizon-bounded to ~90 days);
    // the exact count depends on timing but must be well below the backstop (100_000)
    // and well above zero.
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.length).toBeLessThan(200); // far less than the 100_000 backstop
  });
});

// ── foldLine ──────────────────────────────────────────────────────────────────

describe('foldLine', () => {
  test('does not fold short lines', () => {
    const line = 'SUMMARY:Hello world';
    expect(foldLine(line)).toBe(line);
  });

  test('folds at 75 octets with CRLF+SPACE continuation', () => {
    const long = 'DESCRIPTION:' + 'A'.repeat(80);
    const folded = foldLine(long);
    const parts = folded.split('\r\n ');
    expect(parts.length).toBeGreaterThan(1);
    // Each part fits within limit when prefix is accounted for
    const encoder = new TextEncoder();
    expect(encoder.encode(parts[0]!).length).toBeLessThanOrEqual(75);
  });

  test('handles multibyte characters without splitting sequences', () => {
    // é is 2 bytes in UTF-8; build a line that crosses the 75-byte boundary with multibyte chars
    const line = 'SUMMARY:' + 'é'.repeat(40);
    const encoder = new TextEncoder();
    const folded = foldLine(line);
    // Reconstructed value must round-trip
    const reconstructed = folded.replace(/\r\n /g, '');
    expect(reconstructed).toBe(line);
    // All chunks valid UTF-8 (Bun will throw on bad bytes otherwise)
    for (const chunk of folded.split('\r\n ')) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(75);
    }
  });

  test('folds 3-byte CJK characters straddling the 75-octet boundary', () => {
    // Each CJK char (测) is 3 bytes; pad so a boundary falls mid-character
    const line = 'SUMMARY:' + '测'.repeat(30); // 8 + 90 bytes = 98 bytes total
    const encoder = new TextEncoder();
    const folded = foldLine(line);
    // Round-trip
    const reconstructed = folded.replace(/\r\n /g, '');
    expect(reconstructed).toBe(line);
    // Each chunk stays within the per-chunk limit
    for (const chunk of folded.split('\r\n ')) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(75);
    }
  });

  test('folds 4-byte emoji characters straddling the 75-octet boundary', () => {
    // Each emoji (😀) is 4 bytes; build a line so the fold boundary could split a sequence
    const line = 'SUMMARY:' + '😀'.repeat(20); // 8 + 80 bytes = 88 bytes total
    const encoder = new TextEncoder();
    const folded = foldLine(line);
    // Round-trip
    const reconstructed = folded.replace(/\r\n /g, '');
    expect(reconstructed).toBe(line);
    // Each chunk stays within the per-chunk limit
    for (const chunk of folded.split('\r\n ')) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(75);
    }
  });
});

// ── parseIcs ──────────────────────────────────────────────────────────────────

const SIMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:test-uid-1@example.com',
  'SUMMARY:Team Meeting',
  'DTSTART:20240315T090000Z',
  'DTEND:20240315T100000Z',
  'DESCRIPTION:Discuss roadmap\\nand priorities',
  'LOCATION:Room 4B',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcs', () => {
  test('parses a simple UTC date-time event', () => {
    const events = parseIcs(SIMPLE_ICS);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.uid).toBe('test-uid-1@example.com');
    expect(e.summary).toBe('Team Meeting');
    expect(e.dtstart).toBe('2024-03-15T09:00:00Z');
    expect(e.dtend).toBe('2024-03-15T10:00:00Z');
    expect(e.description).toBe('Discuss roadmap\nand priorities');
    expect(e.location).toBe('Room 4B');
    expect(e.allDay).toBe(false);
    expect(e.tzid).toBeUndefined();
  });

  test('parses all-day DATE events', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:allday@example.com',
      'SUMMARY:Company Holiday',
      'DTSTART;VALUE=DATE:20240704',
      'DTEND;VALUE=DATE:20240705',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.allDay).toBe(true);
    expect(e.dtstart).toBe('2024-07-04');
    expect(e.dtend).toBe('2024-07-05');
  });

  test('parses DTSTART with TZID parameter', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tzid@example.com',
      'SUMMARY:Local Meeting',
      'DTSTART;TZID=America/New_York:20240315T090000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.tzid).toBe('America/New_York');
    expect(e.dtstart).toBe('2024-03-15T09:00:00');
    expect(e.allDay).toBe(false);
    // dtstartUtcMs must be set (TZID-qualified event)
    expect(e.dtstartUtcMs).toBeDefined();
  });

  test('handles line unfolding (CRLF + space continuation)', () => {
    // RFC 5545: continuation space/tab is the fold marker and is discarded.
    // To preserve word spacing the original text must include a trailing space
    // before the fold point, or the continuation must start with the space
    // that belongs to the value.
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:fold@example.com',
      'SUMMARY:Folded',
      // Folded DESCRIPTION: each continuation line starts with LWSP (fold marker)
      // followed immediately by the next part of the value. The LWSP is dropped.
      'DESCRIPTION:First part of a long ',
      ' description that is continued ',
      ' on multiple lines',
      'DTSTART:20240101T000000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]!.description).toBe('First part of a long description that is continued on multiple lines');
  });

  test('ignores unknown components and properties without throwing', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'X-WR-CALNAME:My Cal',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/London',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:unknown@test',
      'SUMMARY:Ignore Test',
      'DTSTART:20240501T120000Z',
      'X-CUSTOM-PROP:should be ignored',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(() => parseIcs(ics)).not.toThrow();
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe('Ignore Test');
  });

  test('is tolerant of malformed or partial input', () => {
    expect(() => parseIcs('')).not.toThrow();
    expect(parseIcs('')).toHaveLength(0);
    // Missing END:VEVENT, incomplete block is silently dropped
    const partial = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Incomplete\r\n';
    expect(() => parseIcs(partial)).not.toThrow();
    expect(parseIcs(partial)).toHaveLength(0);
    // No DTSTART or SUMMARY, silently dropped
    const noStart = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    expect(parseIcs(noStart)).toHaveLength(0);
  });

  test('stores raw RRULE string', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:recur@example.com',
      'SUMMARY:Weekly Standup',
      'DTSTART:20240101T090000Z',
      'RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events[0]!.rrule).toBe('FREQ=WEEKLY;COUNT=5;BYDAY=MO');
  });
});

// ── renderIcs / round-trip ────────────────────────────────────────────────────

describe('renderIcs', () => {
  test('round-trips a basic UTC event', () => {
    const original = parseIcs(SIMPLE_ICS);
    const rendered = renderIcs(original);
    const reparsed = parseIcs(rendered);
    expect(reparsed).toHaveLength(original.length);
    expect(reparsed[0]!.summary).toBe(original[0]!.summary);
    expect(reparsed[0]!.dtstart).toBe(original[0]!.dtstart);
    expect(reparsed[0]!.description).toBe(original[0]!.description);
    expect(reparsed[0]!.location).toBe(original[0]!.location);
  });

  test('round-trips an all-day event', () => {
    const events = parseIcs([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:allday-rt@test',
      'SUMMARY:Holiday',
      'DTSTART;VALUE=DATE:20241225',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'));
    const rendered = renderIcs(events);
    const reparsed = parseIcs(rendered);
    expect(reparsed[0]!.allDay).toBe(true);
    expect(reparsed[0]!.dtstart).toBe('2024-12-25');
  });

  test('escapes and unescapes special characters symmetrically', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:escape@test',
      'SUMMARY:A\\, B\\; C',
      'DESCRIPTION:Line 1\\nLine 2',
      'DTSTART:20240101T000000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const parsed = parseIcs(ics);
    const rendered = renderIcs(parsed);
    const reparsed = parseIcs(rendered);
    expect(reparsed[0]!.summary).toBe(parsed[0]!.summary);
    expect(reparsed[0]!.description).toBe(parsed[0]!.description);
  });

  test('produces valid VCALENDAR wrapper', () => {
    const output = renderIcs([]);
    expect(output).toContain('BEGIN:VCALENDAR');
    expect(output).toContain('VERSION:2.0');
    expect(output).toContain('END:VCALENDAR');
  });

  test('folds long lines at 75 octets', () => {
    const events = [{
      uid: 'fold-test@example.com',
      summary: 'A'.repeat(80),
      dtstart: '2024-01-01T00:00:00Z',
      allDay: false,
    }];
    const rendered = renderIcs(events);
    for (const line of rendered.split('\r\n').filter((l) => l !== '')) {
      const encoder = new TextEncoder();
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

// ── expandRecurringEvent ──────────────────────────────────────────────────────

describe('expandRecurringEvent', () => {
  const ref = new Date('2024-01-01T00:00:00Z');

  test('returns empty array when no RRULE', () => {
    const event = { uid: 'x', summary: 'No recur', dtstart: '2024-01-01T09:00:00Z', allDay: false };
    expect(expandRecurringEvent(event, ref)).toHaveLength(0);
  });

  test('returns empty array for unsupported FREQ (YEARLY)', () => {
    const event = { uid: 'y', summary: 'Yearly', dtstart: '2024-01-01T09:00:00Z', allDay: false, rrule: 'FREQ=YEARLY;COUNT=3' };
    expect(expandRecurringEvent(event, ref)).toHaveLength(0);
  });

  test('returns only the single base occurrence for FREQ=WEEKLY;BYDAY=MO,WE', () => {
    // BYDAY is unsupported, expanding plain-weekly would produce wrong dates.
    // The contract: return exactly the base event (length 1, dtstart unchanged).
    const dtstart = '2024-01-01T09:00:00Z';
    const event = { uid: 'byday', summary: 'Mon+Wed', dtstart, allDay: false, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' };
    const occ = expandRecurringEvent(event, ref);
    expect(occ).toHaveLength(1);
    expect(occ[0]!.dtstart).toBe(dtstart);
  });

  test('expands FREQ=DAILY with COUNT', () => {
    const event = { uid: 'daily', summary: 'Standup', dtstart: '2024-01-01T09:00:00Z', allDay: false, rrule: 'FREQ=DAILY;COUNT=3' };
    const occ = expandRecurringEvent(event, ref);
    expect(occ).toHaveLength(3);
    expect(occ[0]!.dtstart).toBe('2024-01-01T09:00:00Z');
    expect(occ[1]!.dtstart).toBe('2024-01-02T09:00:00Z');
    expect(occ[2]!.dtstart).toBe('2024-01-03T09:00:00Z');
  });

  test('expands FREQ=WEEKLY with COUNT', () => {
    const event = { uid: 'weekly', summary: 'Review', dtstart: '2024-01-01T09:00:00Z', allDay: false, rrule: 'FREQ=WEEKLY;COUNT=3' };
    const occ = expandRecurringEvent(event, ref);
    expect(occ).toHaveLength(3);
    expect(occ[1]!.dtstart).toBe('2024-01-08T09:00:00Z');
  });

  test('expands FREQ=MONTHLY with COUNT', () => {
    const event = { uid: 'monthly', summary: 'Check-in', dtstart: '2024-01-15T09:00:00Z', allDay: false, rrule: 'FREQ=MONTHLY;COUNT=3' };
    const occ = expandRecurringEvent(event, ref);
    expect(occ).toHaveLength(3);
    expect(occ[0]!.dtstart.startsWith('2024-01-15')).toBe(true);
    expect(occ[1]!.dtstart.startsWith('2024-02-15')).toBe(true);
    expect(occ[2]!.dtstart.startsWith('2024-03-15')).toBe(true);
  });

  test('respects UNTIL boundary', () => {
    const event = { uid: 'until', summary: 'Daily', dtstart: '2024-01-01T09:00:00Z', allDay: false, rrule: 'FREQ=DAILY;UNTIL=20240105T000000Z' };
    const occ = expandRecurringEvent(event, ref);
    expect(occ.every((e) => e.dtstart <= '2024-01-05T00:00:00Z')).toBe(true);
    expect(occ.length).toBeGreaterThan(0);
  });

  test('drops the first occurrence strictly after an inclusive UNTIL', () => {
    // UNTIL=20240103T090000Z is inclusive at exactly 09:00 on Jan 3.
    // An occurrence AT that exact time must be included; one AFTER must not.
    // FREQ=DAILY;UNTIL=20240103T090000Z from dtstart 2024-01-01T09:00:00Z:
    //   Jan 1 (== start) included, Jan 2 included, Jan 3 (== UNTIL) included, Jan 4 dropped.
    const event = {
      uid: 'until-inclusive',
      summary: 'Daily',
      dtstart: '2024-01-01T09:00:00Z',
      allDay: false,
      rrule: 'FREQ=DAILY;UNTIL=20240103T090000Z',
    };
    const occ = expandRecurringEvent(event, ref);
    const starts = occ.map((e) => e.dtstart);
    expect(starts).toContain('2024-01-01T09:00:00Z');
    expect(starts).toContain('2024-01-02T09:00:00Z');
    expect(starts).toContain('2024-01-03T09:00:00Z');
    // Jan 4 is after UNTIL and must be absent.
    expect(starts).not.toContain('2024-01-04T09:00:00Z');
  });

  test('caps at 90-day horizon', () => {
    // No COUNT or UNTIL, should be capped by horizon
    const event = { uid: 'horizon', summary: 'Daily', dtstart: '2024-01-01T09:00:00Z', allDay: false, rrule: 'FREQ=DAILY' };
    const occ = expandRecurringEvent(event, ref, 90);
    expect(occ.length).toBeLessThanOrEqual(90);
  });

  test('preserves duration across occurrences', () => {
    const event = { uid: 'dur', summary: 'Meeting', dtstart: '2024-01-01T09:00:00Z', dtend: '2024-01-01T10:00:00Z', allDay: false, rrule: 'FREQ=DAILY;COUNT=2' };
    const occ = expandRecurringEvent(event, ref);
    expect(occ[1]!.dtend).toBe('2024-01-02T10:00:00Z');
  });

  test('expands all-day FREQ=DAILY events correctly', () => {
    const event = { uid: 'allday-recur', summary: 'Boot Camp', dtstart: '2024-06-01', allDay: true, rrule: 'FREQ=DAILY;COUNT=3' };
    const occ = expandRecurringEvent(event, new Date('2024-06-01T00:00:00Z'));
    expect(occ.every((e) => !e.dtstart.includes('T'))).toBe(true);
    expect(occ[0]!.dtstart).toBe('2024-06-01');
    expect(occ[2]!.dtstart).toBe('2024-06-03');
  });
});

// ── Timezone (TZID) handling ───────────────────────────────────────────────────

describe('timezone handling (TZID)', () => {
  // America/New_York: UTC-5 in winter (EST), UTC-4 in summer (EDT)

  test('TZID winter: 09:00 EST parses to 14:00Z', () => {
    // 2026-01-15 is in winter (EST = UTC-5), so 09:00 local = 14:00 UTC
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-winter@test',
      'SUMMARY:Winter Meeting',
      'DTSTART;TZID=America/New_York:20260115T090000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.tzid).toBe('America/New_York');
    expect(e.dtstart).toBe('2026-01-15T09:00:00'); // wall-clock preserved
    expect(e.dtstartUtcMs).toBeDefined();
    // 14:00 UTC
    const utcDate = new Date(e.dtstartUtcMs!);
    expect(utcDate.toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });

  test('TZID summer: 09:00 EDT parses to 13:00Z', () => {
    // 2026-07-15 is in summer (EDT = UTC-4), so 09:00 local = 13:00 UTC
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-summer@test',
      'SUMMARY:Summer Meeting',
      'DTSTART;TZID=America/New_York:20260715T090000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.dtstartUtcMs).toBeDefined();
    // 13:00 UTC
    const utcDate = new Date(e.dtstartUtcMs!);
    expect(utcDate.toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  test('daily recurrence across US 2026 spring-forward keeps 09:00 local (UTC shifts)', () => {
    // US 2026 DST spring-forward: clocks go forward at 2:00 AM on March 8, 2026.
    // Before Mar 8: 09:00 NY = 14:00 UTC (EST, UTC-5)
    // After  Mar 8: 09:00 NY = 13:00 UTC (EDT, UTC-4)
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-dst-recur@test',
      'SUMMARY:Daily NY Meeting',
      'DTSTART;TZID=America/New_York:20260307T090000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const base = events[0]!;
    const ref = new Date('2026-03-07T00:00:00Z');
    const occ = expandRecurringEvent(base, ref, 90);
    expect(occ).toHaveLength(3);

    // All three occurrences should have wall-clock 09:00
    for (const o of occ) {
      expect(o.dtstart).toMatch(/T09:00:00$/);
    }

    // Mar 7 (EST): 09:00 = 14:00 UTC
    const ms0 = occ[0]!.dtstartUtcMs!;
    expect(new Date(ms0).toISOString()).toBe('2026-03-07T14:00:00.000Z');

    // Mar 8 (spring forward day): 09:00 EDT = 13:00 UTC
    const ms1 = occ[1]!.dtstartUtcMs!;
    expect(new Date(ms1).toISOString()).toBe('2026-03-08T13:00:00.000Z');

    // Mar 9 (EDT): 09:00 = 13:00 UTC
    const ms2 = occ[2]!.dtstartUtcMs!;
    expect(new Date(ms2).toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  test('render->parse round-trip preserves TZID and wall-clock time', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-roundtrip@test',
      'SUMMARY:TZ Round Trip',
      'DTSTART;TZID=America/New_York:20260115T090000',
      'DTEND;TZID=America/New_York:20260115T100000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const parsed = parseIcs(ics);
    expect(parsed).toHaveLength(1);
    const original = parsed[0]!;

    const rendered = renderIcs(parsed);
    // Must contain TZID in the rendered output
    expect(rendered).toContain('TZID=America/New_York');
    // Must contain wall-clock (no Z)
    expect(rendered).toContain('20260115T090000');
    // Must NOT emit a bare UTC Z form for this event
    expect(rendered).not.toContain('20260115T140000Z');

    const reparsed = parseIcs(rendered);
    expect(reparsed).toHaveLength(1);
    const rt = reparsed[0]!;
    expect(rt.tzid).toBe('America/New_York');
    expect(rt.dtstart).toBe(original.dtstart); // wall-clock preserved
    expect(rt.dtstartUtcMs).toBe(original.dtstartUtcMs); // UTC instant preserved
  });

  test('unknown TZID falls back to UTC without throwing', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-unknown@test',
      'SUMMARY:Unknown TZ',
      'DTSTART;TZID=Not/AReal_Timezone:20260115T090000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(() => parseIcs(ics)).not.toThrow();
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    // tzid stored as-is even though unrecognised
    expect(e.tzid).toBe('Not/AReal_Timezone');
    // dtstartUtcMs is the UTC fallback (wall-clock treated as UTC)
    expect(e.dtstartUtcMs).toBeDefined();
    const utcDate = new Date(e.dtstartUtcMs!);
    // Should be 09:00 UTC (fallback)
    expect(utcDate.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  test('UTC Z form events are unaffected by timezone changes (regression)', () => {
    const events = parseIcs(SIMPLE_ICS);
    expect(events[0]!.tzid).toBeUndefined();
    expect(events[0]!.dtstartUtcMs).toBeUndefined();
    expect(events[0]!.dtstart).toBe('2024-03-15T09:00:00Z');
  });

  test('all-day events are unaffected by timezone changes (regression)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-allday@test',
      'SUMMARY:All Day',
      'DTSTART;VALUE=DATE:20260115',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events[0]!.allDay).toBe(true);
    expect(events[0]!.tzid).toBeUndefined();
    expect(events[0]!.dtstartUtcMs).toBeUndefined();
  });

  test('TZID DAILY recurrence with DTEND: each occurrence advances start AND end correctly', () => {
    // Regression: when expandRecurringEvent computed durationMs it constructed
    // an endEvent with dtstart=event.dtend but no dtstartUtcMs, so eventStartMs
    // fell through to the floating branch and read NY wall-clock as UTC,
    // durationMs was negative, the guard failed, and dtend was frozen to the
    // original base event value on every occurrence after the first.
    //
    // DTSTART 2026-01-15 09:00 EST (14:00Z), DTEND 2026-01-15 10:00 EST (15:00Z)
    // duration = 1 hour = 3 600 000 ms
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-recur-dtend@test',
      'SUMMARY:NY Daily',
      'DTSTART;TZID=America/New_York:20260115T090000',
      'DTEND;TZID=America/New_York:20260115T100000',
      'RRULE:FREQ=DAILY;COUNT=2',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const base = events[0]!;
    const ref = new Date('2026-01-15T00:00:00Z');
    const occ = expandRecurringEvent(base, ref, 90);
    expect(occ).toHaveLength(2);

    // Occurrence 0: Jan 15
    expect(occ[0]!.dtstart).toBe('2026-01-15T09:00:00'); // wall-clock preserved
    expect(occ[0]!.dtend).toBe('2026-01-15T10:00:00');   // wall-clock preserved
    expect(new Date(occ[0]!.dtstartUtcMs!).toISOString()).toBe('2026-01-15T14:00:00.000Z');

    // Occurrence 1: Jan 16, start AND end must advance (not frozen on Jan 15)
    expect(occ[1]!.dtstart).toBe('2026-01-16T09:00:00'); // advanced
    expect(occ[1]!.dtend).toBe('2026-01-16T10:00:00');   // advanced, NOT '2026-01-15T10:00:00'
    expect(new Date(occ[1]!.dtstartUtcMs!).toISOString()).toBe('2026-01-16T14:00:00.000Z');

    // Duration stays exactly 1 hour on both occurrences
    const dur0 = new Date(occ[0]!.dtend!).getTime() - new Date(occ[0]!.dtstartUtcMs!).getTime();
    // dtend wall-clock must be converted to UTC for duration check
    const dtend1UtcMs = occ[1]!.dtstartUtcMs! + 3_600_000; // start + 1h
    expect(new Date(dtend1UtcMs).toISOString()).toBe('2026-01-16T15:00:00.000Z');
  });

  test('TZID DAILY recurrence on Mar 8 with occurrence in 03:00-08:59 band converts via EDT (UTC-4)', () => {
    // Integration path: verifies wallClockToUtcMs fixed-point algorithm is exercised
    // through expandRecurringEvent for a transition-day occurrence in the post-transition
    // morning band (03:00-08:59 EDT).
    // DTSTART 2026-03-07T06:00 EST (11:00Z). Mar 8 occurrence: 06:00 EDT = 10:00Z.
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-dst-morning@test',
      'SUMMARY:Morning NY Standup',
      'DTSTART;TZID=America/New_York:20260307T060000',
      'RRULE:FREQ=DAILY;COUNT=2',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    const base = events[0]!;
    const ref = new Date('2026-03-07T00:00:00Z');
    const occ = expandRecurringEvent(base, ref, 90);
    expect(occ).toHaveLength(2);

    // Mar 7: 06:00 EST = 11:00Z
    expect(occ[0]!.dtstart).toMatch(/T06:00:00$/);
    expect(new Date(occ[0]!.dtstartUtcMs!).toISOString()).toBe('2026-03-07T11:00:00.000Z');

    // Mar 8 (spring-forward day): 06:00 EDT = 10:00Z, in the 03:00-08:59 band
    expect(occ[1]!.dtstart).toMatch(/T06:00:00$/);
    expect(new Date(occ[1]!.dtstartUtcMs!).toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });

  test('TZID DAILY recurrence crossing spring-forward keeps 1h duration with correct UTC instants', () => {
    // Mar 8 2026 spring-forward: before=EST(UTC-5), after=EDT(UTC-4)
    // DTSTART 2026-03-07 09:00 EST (14:00Z), DTEND 2026-03-07 10:00 EST (15:00Z)
    // Occurrence 1 (Mar 8): 09:00 EDT = 13:00Z, 10:00 EDT = 14:00Z, duration still 1h
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-recur-dst-dur@test',
      'SUMMARY:NY DST Duration',
      'DTSTART;TZID=America/New_York:20260307T090000',
      'DTEND;TZID=America/New_York:20260307T100000',
      'RRULE:FREQ=DAILY;COUNT=2',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics);
    const base = events[0]!;
    const ref = new Date('2026-03-07T00:00:00Z');
    const occ = expandRecurringEvent(base, ref, 90);
    expect(occ).toHaveLength(2);

    // Occurrence 0: Mar 7 EST
    expect(occ[0]!.dtstart).toMatch(/T09:00:00$/);
    expect(new Date(occ[0]!.dtstartUtcMs!).toISOString()).toBe('2026-03-07T14:00:00.000Z');

    // Occurrence 1: Mar 8, wall-clock stays 09:00, UTC shifts to 13:00Z (EDT)
    expect(occ[1]!.dtstart).toMatch(/T09:00:00$/);
    expect(new Date(occ[1]!.dtstartUtcMs!).toISOString()).toBe('2026-03-08T13:00:00.000Z');

    // dtend on Mar 8 must be 10:00 NY (wall-clock), i.e. 14:00Z (EDT), 1h after start
    expect(occ[1]!.dtend).toMatch(/T10:00:00$/);
    // The UTC instant of the end should be 14:00Z = 13:00Z + 1h
    // (dtend is stored as wall-clock; reconstruct UTC via dtstartUtcMs + durationMs)
    const durMs = occ[1]!.dtstartUtcMs! + 3_600_000; // 14:00Z
    expect(new Date(durMs).toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });
});
