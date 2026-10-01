/**
 * TimezonePicker, the typed editor for `daemon.timezone`.
 *
 * A searchable select over the real supported IANA zone set
 * (`Intl.supportedValuesOf('timeZone')`, via lib/timezones.ts), not a
 * free-text box: every writable value is a name the runtime itself
 * recognizes, plus an explicit "UTC (unset)" entry that writes the empty
 * string (the schema's default, meaning UTC).
 *
 * Commits immediately on selection, same as the other schema-driven enum/
 * select controls in SettingsField. Kit controls: a search field that narrows
 * the kit Select's option list.
 */
import { useMemo, useState } from 'react';
import { filterTimezoneNames, UNSET_TIMEZONE_LABEL, UNSET_TIMEZONE_VALUE } from '../../lib/timezones';
import { Input } from '../ui/Field';
import { Select } from '../ui/Select';

export interface TimezonePickerProps {
  /** Current effective value ('' for unset/UTC, else an IANA zone name). */
  readonly value: string;
  readonly disabled?: boolean;
  readonly onCommit: (value: string) => void;
}

export function TimezonePicker({ value, disabled, onCommit }: TimezonePickerProps) {
  const [query, setQuery] = useState('');
  const zones = useMemo(() => filterTimezoneNames(query), [query]);

  const selectedIsUnset = value === UNSET_TIMEZONE_VALUE;
  const selectedIsListed = zones.includes(value);

  return (
    <div className="timezone-picker" data-testid="timezone-picker">
      <Input
        type="search"
        className="settings-field-input timezone-picker-search"
        aria-label="Search timezones"
        placeholder="Search timezones…"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
      />
      {/* The selected value must always resolve to a real option, or the
          control would read as a DIFFERENT effective zone than what is
          actually configured. Pin it in even when the current search query
          filters it out of the list. */}
      <Select
        className="settings-field-select timezone-picker-select"
        aria-label="daemon.timezone"
        value={value}
        disabled={disabled}
        options={[
          { value: UNSET_TIMEZONE_VALUE, label: UNSET_TIMEZONE_LABEL },
          ...(!selectedIsUnset && !selectedIsListed ? [{ value, label: value }] : []),
          ...zones.map((zone) => ({ value: zone, label: zone })),
        ]}
        onChange={onCommit}
      />
    </div>
  );
}
