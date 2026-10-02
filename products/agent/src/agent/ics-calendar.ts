/**
 * ics-calendar.ts, Dependency-free iCalendar (RFC 5545) parse and render.
 *
 * RRULE boundary: only FREQ=DAILY, FREQ=WEEKLY, and FREQ=MONTHLY are expanded.
 * COUNT and UNTIL (DATE and DATE-TIME forms) are honoured. INTERVAL, BYDAY,
 * BYMONTHDAY, EXDATE, and all other recurrence keywords are NOT processed,
 * occurrences that would require them are silently omitted. Callers should
 * treat the `rrule` field as informational for any rule that includes those
 * keywords. Expansion is capped at 90 days from the reference date passed to
 * `expandRecurringEvent`.
 *
 * Timezone handling:
 *   - UTC form (DTSTART:...Z): stored and emitted in UTC. No conversion needed.
 *   - Floating form (no TZID): treated as UTC for comparison purposes (existing
 *     behaviour, documented). Emitted without Z suffix.
 *   - TZID-qualified form: converted to a correct UTC instant via Intl-based
 *     offset derivation (see ics-timezone.ts). The TZID and original wall-clock
 *     are stored and re-emitted on render so round-trips preserve zone identity.
 *     Note: we emit DTSTART;TZID=Zone:YYYYMMDDTHHMMSS without a VTIMEZONE block.
 *     Tolerant readers (Google Calendar, Apple Calendar, Outlook) accept TZID
 *     without VTIMEZONE when the name is a valid IANA zone identifier; conformant
 *     strict readers may reject it. This is a documented limitation.
 */

import { wallClockToUtcMs, utcMsToWallClock } from './ics-timezone.ts';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

export interface IcsEvent {
  /** UID property value */
  readonly uid: string;
  /** SUMMARY text (unescaped) */
  readonly summary: string;
  /** DESCRIPTION text (unescaped), if present */
  readonly description?: string;
  /** LOCATION text (unescaped), if present */
  readonly location?: string;
  /**
   * DTSTART as an ISO-8601 string.
   * All-day events use YYYY-MM-DD form.
   * UTC events use YYYY-MM-DDTHH:MM:SSZ form.
   * TZID-qualified events use YYYY-MM-DDTHH:MM:SS (wall-clock, no Z suffix).
   * Floating events (no TZID, no Z) use YYYY-MM-DDTHH:MM:SS (treated as UTC).
   */
  readonly dtstart: string;
  /**
   * DTEND as an ISO-8601 string, if present.
   * Follows same convention as dtstart.
   */
  readonly dtend?: string;
  /** True when DTSTART is a DATE (all-day) value */
  readonly allDay: boolean;
  /** TZID parameter from DTSTART, if any */
  readonly tzid?: string;
  /**
   * Corrected UTC instant (ms since epoch) for the DTSTART.
   * Populated for TZID-qualified events via Intl-based offset derivation.
   * Undefined for all-day events, UTC events (use Date.parse(dtstart) instead),
   * and floating events.
   */
  readonly dtstartUtcMs?: number;
  /** Raw RRULE string, if any */
  readonly rrule?: string;
}

// ──────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Unfold continuation lines: CRLF (or bare LF) followed by a single space or
 * tab is a logical-line continuation per RFC 5545 §3.1.
 */
function unfoldLines(content: string): string {
  return content.replace(/\r?\n[ \t]/g, '');
}

/** Split content into logical lines after unfolding. */
function logicalLines(content: string): string[] {
  return unfoldLines(content).split(/\r?\n/);
}

/** Unescape RFC 5545 text-value escapes: \\n → newline, \\\\ → \\, \\; → ;, \\, → , */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\;/g, ';')
    .replace(/\\,/g, ',')
    .replace(/\\\\/g, '\\');
}

/** Escape text for iCalendar output. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Fold a single content line at 75 octets (UTF-8 bytes), continuing with
 * CRLF + SPACE per RFC 5545 §3.1.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let offset = 0;
  let firstChunk = true;
  while (offset < bytes.length) {
    const limit = firstChunk ? 75 : 74; // first line has no leading space
    // Slice at limit, then back off if we'd split a multi-byte sequence.
    let end = Math.min(offset + limit, bytes.length);
    while (end > offset + 1 && (bytes[end]! & 0xc0) === 0x80) end--;
    chunks.push(decoder.decode(bytes.slice(offset, end)));
    offset = end;
    firstChunk = false;
  }
  return chunks.join('\r\n ');
}

/**
 * Parse a DTSTART / DTEND value string (with optional TZID parameter).
 * Returns { iso, allDay, tzid, utcMs }.
 *
 * Supported value forms:
 *   DATE:          YYYYMMDD
 *   DATE-TIME:     YYYYMMDDTHHMMSS   (local / TZID)
 *   DATE-TIME UTC: YYYYMMDDTHHMMSSZ
 *
 * When a TZID is present, utcMs is set to the correctly converted UTC instant
 * using Intl-based offset derivation. For unknown TZIDs, utcMs falls back to
 * treating the wall-clock as UTC (documented limitation).
 */
function parseDateValue(
  value: string,
  tzid?: string,
): { iso: string; allDay: boolean; tzid?: string; utcMs?: number } {
  const trimmed = value.trim();
  // All-day: pure 8-digit date
  if (/^\d{8}$/.test(trimmed)) {
    const iso = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
    return { iso, allDay: true };
  }
  // Date-time forms: YYYYMMDDTHHMMSS[Z]
  const m = trimmed.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const isUtc = m[7] === 'Z';
    const utcSuffix = isUtc ? 'Z' : '';
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${utcSuffix}`;
    if (isUtc) {
      // UTC form: no TZID, utcMs derivable directly from iso
      return { iso, allDay: false };
    }
    if (tzid) {
      // TZID-qualified: convert wall-clock to correct UTC instant
      const utcMs = wallClockToUtcMs(iso, tzid);
      return { iso, allDay: false, tzid, utcMs };
    }
    // Floating: no TZID, no Z suffix, treated as UTC for comparison
    return { iso, allDay: false };
  }
  // Fallback: return as-is
  return { iso: trimmed, allDay: false, tzid };
}

/**
 * Parse a property line into name, params map, and value.
 * Handles "DTSTART;TZID=America/New_York:20240101T090000" etc.
 */
function parsePropLine(line: string): { name: string; params: Map<string, string>; value: string } | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = head.split(';');
  const name = (parts[0] ?? '').toUpperCase();
  const params = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i]!.indexOf('=');
    if (eq >= 0) {
      params.set(parts[i]!.slice(0, eq).toUpperCase(), parts[i]!.slice(eq + 1));
    }
  }
  return { name, params, value };
}

// ──────────────────────────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────────────────────────

/**
 * Parse iCalendar text into an array of IcsEvent objects.
 *
 * Tolerant of: unknown component types, unknown properties, missing DTEND,
 * malformed property lines, and non-standard line endings.
 */
export function parseIcs(content: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  const lines = logicalLines(content);

  let inVevent = false;
  let uid = '';
  let summary = '';
  let description: string | undefined;
  let location: string | undefined;
  let dtstart = '';
  let dtend: string | undefined;
  let allDay = false;
  let tzid: string | undefined;
  let dtstartUtcMs: number | undefined;
  let rrule: string | undefined;
  let depth = 0; // tracks nested BEGIN/END for unknown components

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^BEGIN:/i.test(line)) {
      const component = line.slice(6).toUpperCase();
      if (component === 'VEVENT') {
        inVevent = true;
        depth = 0;
        uid = '';
        summary = '';
        description = undefined;
        location = undefined;
        dtstart = '';
        dtend = undefined;
        allDay = false;
        tzid = undefined;
        dtstartUtcMs = undefined;
        rrule = undefined;
      } else if (inVevent) {
        depth++; // nested component inside VEVENT (e.g. VALARM)
      }
      continue;
    }

    if (/^END:/i.test(line)) {
      const component = line.slice(4).toUpperCase();
      if (component === 'VEVENT') {
        if (dtstart && summary) {
          events.push({
            uid: uid || dtstart,
            summary,
            description,
            location,
            dtstart,
            dtend,
            allDay,
            tzid: tzid || undefined,
            dtstartUtcMs,
            rrule,
          });
        }
        inVevent = false;
      } else if (inVevent && depth > 0) {
        depth--;
      }
      continue;
    }

    if (!inVevent || depth > 0) continue;

    const prop = parsePropLine(line);
    if (!prop) continue;

    switch (prop.name) {
      case 'UID': {
        uid = prop.value.trim();
        break;
      }
      case 'SUMMARY': {
        summary = unescapeText(prop.value);
        break;
      }
      case 'DESCRIPTION': {
        description = unescapeText(prop.value);
        break;
      }
      case 'LOCATION': {
        location = unescapeText(prop.value);
        break;
      }
      case 'DTSTART': {
        const paramTzid = prop.params.get('TZID');
        const parsed = parseDateValue(prop.value, paramTzid);
        dtstart = parsed.iso;
        allDay = parsed.allDay;
        tzid = parsed.tzid;
        dtstartUtcMs = parsed.utcMs;
        break;
      }
      case 'DTEND': {
        const paramTzid = prop.params.get('TZID');
        const parsed = parseDateValue(prop.value, paramTzid);
        dtend = parsed.iso;
        break;
      }
      case 'RRULE': {
        rrule = prop.value.trim();
        break;
      }
      // All other properties are silently ignored.
    }
  }

  return events;
}

// ──────────────────────────────────────────────────────────────────
// RRULE expansion (simple subset only)
// ──────────────────────────────────────────────────────────────────

/**
 * Parse RRULE string into parts map.
 * Example: "FREQ=WEEKLY;COUNT=5;BYDAY=MO" → { FREQ: 'WEEKLY', COUNT: '5', BYDAY: 'MO' }
 */
function parseRrule(rrule: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0) map.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  return map;
}

/** Add `n` months to UTC-based year/month/day components (returns new ms). */
function addMonthsToMs(utcMs: number, n: number): number {
  const d = new Date(utcMs);
  const target = d.getUTCMonth() + n;
  d.setUTCMonth(target);
  return d.getTime();
}

/** Parse UNTIL value (DATE or DATE-TIME, local or UTC). Returns a Date or null. */
function parseUntil(until: string): Date | null {
  const v = until.trim();
  if (/^\d{8}$/.test(v)) {
    return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`);
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const suffix = 'Z'; // floating UNTIL coerced to UTC for expansion (RFC 5545 §3.3.10 compliance note)
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${suffix}`);
  }
  return null;
}

/**
 * Convert an IcsEvent dtstart to a UTC timestamp (ms since epoch).
 *
 * Priority:
 *   1. dtstartUtcMs (pre-computed during parse, TZID-qualified events)
 *   2. All-day events: UTC noon on the date (stable anchor)
 *   3. UTC events (dtstart ends with Z): Date.parse
 *   4. Floating events (no Z, no TZID): treated as UTC
 */
function eventStartMs(event: IcsEvent): number | null {
  if (event.dtstartUtcMs !== undefined) return event.dtstartUtcMs;
  if (event.allDay) {
    const d = new Date(`${event.dtstart}T12:00:00Z`);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  // TZID-qualified wall-clock without a pre-computed utcMs (e.g. a synthetic
  // endEvent constructed from event.dtend): convert wall-clock → UTC via Intl.
  if (event.tzid && !event.dtstart.endsWith('Z')) {
    return wallClockToUtcMs(event.dtstart, event.tzid);
  }
  const normalized = event.dtstart.endsWith('Z') || event.dtstart.includes('+')
    ? event.dtstart
    : `${event.dtstart}Z`;
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/** Format a UTC ms timestamp to ISO string matching allDay convention. */
function utcMsToIso(utcMs: number, allDay: boolean): string {
  const d = new Date(utcMs);
  if (allDay) {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }
  return d.toISOString().replace('.000', '');
}

/**
 * Format a UTC ms timestamp as a wall-clock ISO string in the given IANA timezone.
 * Returns "YYYY-MM-DDTHH:MM:SS" (no Z suffix) for use as a TZID-qualified DTSTART.
 * Falls back to UTC ISO string if the timezone is unavailable.
 */
function utcMsToTzWallClock(utcMs: number, tzid: string): string {
  const wc = utcMsToWallClock(utcMs, tzid);
  return wc ?? new Date(utcMs).toISOString().replace('.000Z', 'Z');
}

/**
 * Expand a recurring event into individual occurrences for the next
 * `horizonDays` days from `referenceDate`.
 *
 * Only FREQ=DAILY, FREQ=WEEKLY, and FREQ=MONTHLY with optional COUNT / UNTIL
 * are supported. INTERVAL defaults to 1. Any other RRULE keywords
 * (BYDAY, BYMONTHDAY, EXDATE, etc.) are present on the rule but NOT
 * processed, their presence does not cause an error, but the expansion will
 * not reflect their constraints.
 *
 * Returns an empty array for any rule with FREQ other than those three.
 *
 * Timezone-correct stepping (TZID-qualified events):
 *   Each occurrence is stepped by computing the NEXT wall-clock time in the
 *   event's timezone (e.g. DAILY 09:00 NY stays 09:00 NY across DST). This
 *   means the UTC instant shifts by one hour across a DST boundary, which
 *   is the correct behaviour.
 */
export function expandRecurringEvent(event: IcsEvent, referenceDate: Date, horizonDays = 90): IcsEvent[] {
  if (!event.rrule) return [];
  const parts = parseRrule(event.rrule);
  const freq = parts.get('FREQ')?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return [];

  // If the rule contains keywords we cannot faithfully expand, return only the
  // single base occurrence so callers get accurate data rather than wrong dates.
  const UNSUPPORTED_PARTS = ['BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYWEEKNO', 'BYYEARDAY', 'BYSETPOS', 'BYHOUR', 'BYMINUTE', 'WKST'] as const;
  if (UNSUPPORTED_PARTS.some((key) => parts.has(key))) {
    return [{ ...event }];
  }

  const interval = Math.max(1, parseInt(parts.get('INTERVAL') ?? '1', 10) || 1);
  const maxCount = parts.has('COUNT') ? Math.max(1, parseInt(parts.get('COUNT')!, 10) || 1) : Infinity;
  const until = parts.has('UNTIL') ? parseUntil(parts.get('UNTIL')!) : null;

  const horizonEnd = new Date(referenceDate.getTime() + horizonDays * 86_400_000);

  const startMs = eventStartMs(event);
  if (startMs === null) return [];

  // Duration offset between dtstart and dtend (ms)
  let durationMs = 0;
  if (event.dtend) {
    const endEvent = { ...event, dtstart: event.dtend, dtstartUtcMs: undefined, tzid: event.tzid };
    const endMs = eventStartMs(endEvent);
    if (endMs !== null) durationMs = endMs - startMs;
  }

  const results: IcsEvent[] = [];
  let cursorMs = startMs;
  let count = 0;
  let totalIterations = 0;
  const MAX_TOTAL_ITERATIONS = 100_000;

  while (count < maxCount) {
    // MIN-4: hard backstop on total loop iterations (independent of cursor monotonicity)
    if (totalIterations++ >= MAX_TOTAL_ITERATIONS) break;
    // Enforce UNTIL boundary
    if (until && cursorMs > until.getTime()) break;
    // Enforce horizon
    if (cursorMs > horizonEnd.getTime()) break;
    // Only include occurrences from referenceDate onward
    if (cursorMs >= referenceDate.getTime()) {
      let occStart: string;
      if (event.tzid && !event.allDay) {
        // Emit as wall-clock in the event's timezone (no Z)
        occStart = utcMsToTzWallClock(cursorMs, event.tzid);
      } else {
        occStart = utcMsToIso(cursorMs, event.allDay);
      }
      const occEnd = durationMs > 0
        ? (event.tzid && !event.allDay
          ? utcMsToTzWallClock(cursorMs + durationMs, event.tzid)
          : utcMsToIso(cursorMs + durationMs, event.allDay))
        : event.dtend;
      results.push({ ...event, dtstart: occStart, dtend: occEnd, dtstartUtcMs: cursorMs });
      count++;
    }

    // Advance cursor in the event's timezone (DST-correct stepping)
    if (event.tzid && !event.allDay) {
      cursorMs = advanceTzMs(cursorMs, event.tzid, freq, interval);
    } else if (freq === 'DAILY') {
      cursorMs += interval * 86_400_000;
    } else if (freq === 'WEEKLY') {
      cursorMs += interval * 7 * 86_400_000;
    } else {
      cursorMs = addMonthsToMs(cursorMs, interval);
    }

    // Safety: bail after 10000 iterations regardless
    if (count > 10000) break;
  }

  return results;
}

/**
 * Advance a UTC ms instant by the given frequency/interval stepping IN the
 * specified IANA timezone. This keeps wall-clock time stable across DST:
 *   - DAILY: get next-day wall-clock at same H:M:S in tzid, convert back to UTC.
 *   - WEEKLY: same but 7 days later.
 *   - MONTHLY: advance the month component of the wall-clock, keep H:M:S.
 *
 * Falls back to fixed-ms arithmetic when the timezone is unavailable.
 */
function advanceTzMs(utcMs: number, tzid: string, freq: string, interval: number): number {
  const wc = utcMsToWallClock(utcMs, tzid);
  if (!wc) {
    // Unknown TZID fallback
    if (freq === 'DAILY') return utcMs + interval * 86_400_000;
    if (freq === 'WEEKLY') return utcMs + interval * 7 * 86_400_000;
    return addMonthsToMs(utcMs, interval);
  }

  const m = wc.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return utcMs + 86_400_000; // unexpected format

  let year = parseInt(m[1]!, 10);
  let month = parseInt(m[2]!, 10); // 1-12
  let day = parseInt(m[3]!, 10);
  const hour = parseInt(m[4]!, 10);
  const minute = parseInt(m[5]!, 10);
  const second = parseInt(m[6]!, 10);

  if (freq === 'DAILY') {
    // Increment day; handle month/year overflow via Date
    const next = new Date(Date.UTC(year, month - 1, day + interval * 1, hour, minute, second));
    const nextWc = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    return wallClockToUtcMs(nextWc, tzid);
  }

  if (freq === 'WEEKLY') {
    const next = new Date(Date.UTC(year, month - 1, day + interval * 7, hour, minute, second));
    const nextWc = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    return wallClockToUtcMs(nextWc, tzid);
  }

  // MONTHLY: advance month, keep day/time (clamp to month end)
  month += interval;
  year += Math.floor((month - 1) / 12);
  month = ((month - 1) % 12) + 1;
  // Clamp day to end of target month
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  day = Math.min(day, daysInMonth);
  const nextWc = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  return wallClockToUtcMs(nextWc, tzid);
}

// ──────────────────────────────────────────────────────────────────
// Renderer
// ──────────────────────────────────────────────────────────────────

/** Format a Date as iCalendar DATE value: YYYYMMDD */
function formatIcsDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Format an ISO string as iCalendar DATE-TIME UTC value: YYYYMMDDTHHMMSSZ */
function formatIcsDateTimeUtc(iso: string): string {
  const normalized = iso.endsWith('Z') ? iso : `${iso}Z`;
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return iso.replace(/[-:]/g, '').replace(' ', 'T');
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}

/**
 * Format a wall-clock ISO string ("YYYY-MM-DDTHH:MM:SS") as compact iCalendar
 * local form: YYYYMMDDTHHMMSS (no Z suffix, for use with TZID parameter).
 */
function formatIcsDateTimeLocal(iso: string): string {
  // iso is already in "YYYY-MM-DDTHH:MM:SS" form (no Z)
  return iso.replace(/[-:]/g, '').replace(' ', 'T').replace('Z', '');
}

/** Produce a folded iCalendar content line from a name=value pair. */
function icsLine(name: string, value: string, params?: string): string {
  const head = params ? `${name};${params}` : name;
  return foldLine(`${head}:${value}`);
}

/**
 * Render an array of IcsEvent objects into a valid VCALENDAR string.
 *
 * Text properties are escaped and lines are folded at 75 octets per RFC 5545.
 *
 * DTSTART rendering rules:
 *   - All-day: VALUE=DATE form (YYYYMMDD), no TZID.
 *   - UTC (dtstart ends with Z): YYYYMMDDTHHMMSSZ.
 *   - TZID-qualified: DTSTART;TZID=Zone:YYYYMMDDTHHMMSS (wall-clock, no Z).
 *     Note: emitted without VTIMEZONE block. Tolerant readers accept this;
 *     strict RFC 5545 readers may reject it (documented limitation).
 *   - Floating: YYYYMMDDTHHMMSS (no Z, no TZID).
 */
export function renderIcs(events: readonly IcsEvent[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'PRODID:-//GoodVibes Agent//Calendar//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const event of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(icsLine('UID', escapeText(event.uid)));
    lines.push(icsLine('SUMMARY', escapeText(event.summary)));

    if (event.allDay) {
      // All-day: strip dashes and emit as DATE
      const raw = event.dtstart.replace(/-/g, '');
      lines.push(icsLine('DTSTART', raw, 'VALUE=DATE'));
      if (event.dtend) {
        lines.push(icsLine('DTEND', event.dtend.replace(/-/g, ''), 'VALUE=DATE'));
      }
    } else if (event.tzid) {
      // TZID-qualified: emit wall-clock local time with TZID parameter.
      // The dtstart field already holds the wall-clock (no Z suffix) from parse.
      const localCompact = formatIcsDateTimeLocal(event.dtstart);
      lines.push(icsLine('DTSTART', localCompact, `TZID=${event.tzid}`));
      if (event.dtend) {
        const endCompact = formatIcsDateTimeLocal(event.dtend);
        lines.push(icsLine('DTEND', endCompact, `TZID=${event.tzid}`));
      }
    } else {
      // UTC or floating: emit with Z suffix (or as-is for floating)
      lines.push(icsLine('DTSTART', formatIcsDateTimeUtc(event.dtstart)));
      if (event.dtend) {
        lines.push(icsLine('DTEND', formatIcsDateTimeUtc(event.dtend)));
      }
    }

    if (event.description) {
      lines.push(icsLine('DESCRIPTION', escapeText(event.description)));
    }
    if (event.location) {
      lines.push(icsLine('LOCATION', escapeText(event.location)));
    }
    if (event.rrule) {
      lines.push(icsLine('RRULE', event.rrule));
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map((l) => `${l}\r\n`).join('');
}
