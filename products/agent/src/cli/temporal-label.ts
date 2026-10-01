/**
 * Human temporal labels for CLI record listings.
 *
 * CLI output that lists sessions, routines, principals, and other timestamped
 * records used to show a raw value (an ISO string or nothing) with no sense of
 * how recent it is. These helpers add a plain "how long ago" (or "in ...")
 * label ALONGSIDE the precise value, the precise value is never replaced,
 * because the exact timestamp still matters for records, correlation, and
 * scripting. `appendTemporalLabel` is the intended entry point: it keeps the
 * precise string the caller already renders and appends `(2 hours ago)`.
 *
 * Both an epoch-milliseconds number and an ISO/parseable date string are
 * accepted, since session summaries carry an epoch number while the local
 * record registries (routines, personas, skills, principals, ...) carry ISO
 * strings. Unparseable or absent input yields no label rather than a fabricated
 * one, honesty over a plausible-looking guess.
 */

/** Parse an epoch-ms number or a date string into epoch ms, or null when it is not a real instant. */
export function toEpochMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function unit(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * A plain relative label for an instant, e.g. "2 hours ago", "in 3 days",
 * "just now". Returns null when the input is not a real instant.
 *
 * Elapsed magnitudes are floored (not rounded) so a label never describes a
 * moment as further in the past than it truly is, the same anti-overstatement
 * rule the resume-relaunch age formatter follows. Future instants read "in N"
 * with the same tiers.
 */
export function formatTemporalLabel(
  value: number | string | null | undefined,
  now: number = Date.now(),
): string | null {
  const at = toEpochMs(value);
  if (at === null) return null;

  const deltaMs = now - at;
  const future = deltaMs < 0;
  const abs = Math.abs(deltaMs);

  if (abs < 10_000) return 'just now';

  const magnitude = ((): string => {
    if (abs < MINUTE) return unit(Math.floor(abs / 1000), 'second');
    if (abs < HOUR) return unit(Math.floor(abs / MINUTE), 'minute');
    if (abs < DAY) return unit(Math.floor(abs / HOUR), 'hour');
    if (abs < WEEK) return unit(Math.floor(abs / DAY), 'day');
    if (abs < MONTH) return unit(Math.floor(abs / WEEK), 'week');
    if (abs < YEAR) return unit(Math.floor(abs / MONTH), 'month');
    return unit(Math.floor(abs / YEAR), 'year');
  })();

  return future ? `in ${magnitude}` : `${magnitude} ago`;
}

/**
 * Append a parenthetical temporal label to a precise value string the caller
 * already renders. The precise value stays exactly as-is; the label is added
 * only when the instant parses. Example:
 *   appendTemporalLabel('2026-07-11T09:00:00.000Z', someEpochOrIso)
 *     -> '2026-07-11T09:00:00.000Z (2 hours ago)'
 */
export function appendTemporalLabel(
  precise: string,
  value: number | string | null | undefined,
  now: number = Date.now(),
): string {
  const label = formatTemporalLabel(value, now);
  return label ? `${precise} (${label})` : precise;
}
