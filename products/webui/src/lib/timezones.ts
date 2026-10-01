/**
 * timezones.ts, pure helpers for the `daemon.timezone` picker.
 *
 * `daemon.timezone` (schema-domain-daemon-location.ts on the SDK side) is an
 * IANA timezone name the daemon reckons calendar days in; empty means UTC.
 * The picker offers a SEARCHABLE list over the real supported set
 * (`Intl.supportedValuesOf('timeZone')`) rather than a free-text box, plus an
 * explicit "UTC (unset)" entry that writes the empty string.
 */

export const UNSET_TIMEZONE_VALUE = '';
export const UNSET_TIMEZONE_LABEL = 'UTC (unset)';

let cachedZones: readonly string[] | null = null;

/** Every IANA zone name this runtime knows about, sorted for a stable list. */
export function listTimezoneNames(): readonly string[] {
  cachedZones ??= [...Intl.supportedValuesOf('timeZone')].sort((a, b) => a.localeCompare(b));
  return cachedZones;
}

/**
 * True for the unset (UTC) value or any IANA name `Intl` actually recognizes.
 * Mirrors the SDK's own `daemon.timezone` `validate()` exactly
 * (schema-domain-daemon-location.ts), this is a client-side pre-check only;
 * the daemon's config.set remains the authoritative validator.
 */
export function isValidTimezoneName(value: string): boolean {
  if (value.trim().length === 0) return true;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Case-insensitive substring filter over the supported zone list. Empty query returns everything. */
export function filterTimezoneNames(query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  if (!q) return listTimezoneNames();
  return listTimezoneNames().filter((zone) => zone.toLowerCase().includes(q));
}
