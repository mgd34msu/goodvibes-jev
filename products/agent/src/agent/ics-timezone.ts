/**
 * ics-timezone.ts, Dependency-free IANA timezone conversion using Intl.
 *
 * Converts between wall-clock date-time strings and UTC milliseconds using
 * Intl.DateTimeFormat with the target timezone. The approach:
 *
 *   1. Treat the wall-clock string as a UTC candidate instant.
 *   2. Format that candidate in the target timezone using Intl.DateTimeFormat.
 *   3. Measure the offset (delta between what Intl says the local time is vs.
 *      what we fed in).
 *   4. Correct the candidate by that delta.
 *   5. Iterate once more to handle DST boundaries where step 3 may land on
 *      the wrong side of the transition.
 *
 * Handles all three RFC 5545 DTSTART forms:
 *   - UTC ('...Z'):    caller should not call this; pass through as-is.
 *   - Floating (no TZID): kept as local/unzoned, caller treats as UTC.
 *   - TZID-qualified:  converted here to a correct UTC instant.
 *
 * Unknown or unsupported TZID values fall back to treating the wall-clock as
 * UTC (offset = 0). This is documented behaviour, not silent corruption.
 */

// ──────────────────────────────────────────────────────────────────
// Intl formatter cache
// ──────────────────────────────────────────────────────────────────

// Maps TZID → Intl.DateTimeFormat (reuse across calls in a session)
const fmtCache = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Returns a cached Intl.DateTimeFormat for the given IANA timezone, or null
 * if the timezone is unknown/unsupported by this runtime.
 */
function getFormatter(tzid: string): Intl.DateTimeFormat | null {
  if (fmtCache.has(tzid)) return fmtCache.get(tzid)!;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    fmtCache.set(tzid, fmt);
    return fmt;
  } catch {
    // Unknown TZID, Intl throws RangeError for invalid timezone names
    fmtCache.set(tzid, null);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Core conversion helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Parse a wall-clock string "YYYY-MM-DDTHH:MM:SS" into component parts.
 * Returns null if the string does not match the expected form.
 */
function parseWallClock(wallClock: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
} | null {
  const m = wallClock.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return {
    year: parseInt(m[1]!, 10),
    month: parseInt(m[2]!, 10),
    day: parseInt(m[3]!, 10),
    hour: parseInt(m[4]!, 10),
    minute: parseInt(m[5]!, 10),
    second: parseInt(m[6]!, 10),
  };
}

/**
 * Format a UTC instant (ms) as its wall-clock representation in the given
 * IANA timezone, returning "YYYY-MM-DDTHH:MM:SS".
 *
 * Uses the cached Intl.DateTimeFormat. Returns null if the formatter is
 * unavailable (unknown TZID).
 */
export function utcMsToWallClock(utcMs: number, tzid: string): string | null {
  const fmt = getFormatter(tzid);
  if (!fmt) return null;

  // Intl.DateTimeFormat.formatToParts gives us named fields.
  const parts = fmt.formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';

  // hour12: false gives '00'-'23' for midnight through 11pm; some runtimes
  // return '24' for midnight, normalise to '00'.
  let hour = get('hour');
  if (hour === '24') hour = '00';

  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
}

/**
 * Convert a wall-clock date-time string ("YYYY-MM-DDTHH:MM:SS") in the given
 * IANA timezone to a UTC timestamp (milliseconds since epoch).
 *
 * Algorithm (offset-derivation trick with one DST correction pass):
 *   1. Treat wallClock as UTC candidate: candidateMs = Date.parse(wallClock + 'Z')
 *   2. Ask Intl what the local time in tzid IS at that candidateMs → localAtCandidate
 *   3. delta = candidateMs - Date.parse(localAtCandidate + 'Z')
 *   4. correctedMs = candidateMs + delta
 *   5. Verify: ask Intl what local time correctedMs is → should equal wallClock.
 *      If not (DST gap/fold), use correctedMs anyway (it's the closest valid instant).
 *
 * Falls back to treating wallClock as UTC (returns Date.parse(wallClock + 'Z'))
 * when:
 *   - The TZID is unknown to Intl (not a valid IANA name)
 *   - The wallClock string cannot be parsed
 * The fallback is documented: callers see this as offset=0 (UTC treatment).
 */
export function wallClockToUtcMs(wallClock: string, tzid: string): number {
  const parsed = parseWallClock(wallClock);
  if (!parsed) {
    // Malformed wall-clock, return as UTC
    return Date.parse(`${wallClock}Z`);
  }

  const fmt = getFormatter(tzid);
  if (!fmt) {
    // Unknown TZID, fall back to UTC treatment (documented)
    return Date.parse(`${wallClock}Z`);
  }

  // seed candidate from raw wall-clock treated as UTC
  const candidateMs = Date.UTC(
    parsed.year, parsed.month - 1, parsed.day,
    parsed.hour, parsed.minute, parsed.second,
  );

  // first-pass offset correction (used as the gap fallback)
  const firstLocal = utcMsToWallClock(candidateMs, tzid);
  if (!firstLocal) return candidateMs;
  const firstLocalParsed = parseWallClock(firstLocal);
  if (!firstLocalParsed) return candidateMs;
  const firstDelta = candidateMs - Date.UTC(
    firstLocalParsed.year, firstLocalParsed.month - 1, firstLocalParsed.day,
    firstLocalParsed.hour, firstLocalParsed.minute, firstLocalParsed.second,
  );
  const firstCorrected = candidateMs + firstDelta;

  // iterate to a fixed point (converges <=3 passes for every valid wall-clock,
  // incl. DST-transition-day post-transition hours)
  let guess = firstCorrected;
  for (let i = 0; i < 5; i++) {
    const local = utcMsToWallClock(guess, tzid);
    if (!local) return guess;
    if (local === wallClock) return guess; // exact valid instant
    const lp = parseWallClock(local);
    if (!lp) return guess;
    const delta = candidateMs - Date.UTC(
      lp.year, lp.month - 1, lp.day,
      lp.hour, lp.minute, lp.second,
    );
    if (delta === 0) return guess;
    guess += delta;
  }
  // no fixed point => nonexistent spring-forward gap; return first-pass corrected
  // (conventional forward-shift: 02:30 NY -> 03:30 EDT = 07:30Z), preserving the gap tests
  return firstCorrected;
}

