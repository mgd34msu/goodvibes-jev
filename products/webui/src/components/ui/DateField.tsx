import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPosition, useOutsidePress } from './overlay';
import '../../styles/components/ui.css';

export interface DateFieldProps {
  /**
   * `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when `time` is set (the same strings
   * the browser's date and datetime-local inputs use), or '' for no value.
   */
  value: string;
  onChange: (value: string) => void;
  /** Also take a time of day (24-hour HH:MM). */
  time?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parse `YYYY-MM-DD` into a local date, or null. */
export function parseIsoDate(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  return date;
}

/**
 * Normalize typed text into the field's value string, or null when it does not
 * parse. Accepts `YYYY-MM-DD`, and with `time`, a space or a `T` before `HH:MM`.
 */
export function normalizeDateText(text: string, time: boolean): string | null {
  const trimmed = text.trim();
  if (!time) return parseIsoDate(trimmed) ? trimmed : null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(trimmed);
  if (!match || !parseIsoDate(match[1])) return null;
  const hours = match[2] === undefined ? 9 : Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return `${match[1]}T${pad(hours)}:${pad(minutes)}`;
}

function display(value: string): string {
  return value.replace('T', ' ');
}

/** The Monday-first grid of dates covering `month` (always six weeks). */
export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/**
 * A date (or date and time) field: type the date, or open a glass month grid
 * from the calendar button. No browser date widget (design doc "Fields").
 *
 * Keyboard in the grid: arrows move a day or a week, PageUp and PageDown move a
 * month, Home and End jump to the week's ends, Enter picks, Escape closes.
 */
export function DateField({
  value,
  onChange,
  time = false,
  id,
  required,
  disabled,
  placeholder,
  className,
  ...aria
}: DateFieldProps) {
  const autoId = useId();
  const gridId = `${autoId}-grid`;
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const position = useFloatingPosition(open, wrapRef, popRef, 'bottom-start');
  useOutsidePress(open, [wrapRef, popRef], () => setOpen(false));

  const datePart = value.slice(0, 10);
  const timePart = time ? (value.slice(11, 16) || '09:00') : '';
  const selected = parseIsoDate(datePart);
  const [focusDate, setFocusDate] = useState<Date>(() => selected ?? new Date());
  const month = useMemo(() => new Date(focusDate.getFullYear(), focusDate.getMonth(), 1), [focusDate]);
  const days = useMemo(() => monthGrid(month), [month]);
  const todayIso = toIsoDate(new Date());

  useEffect(() => {
    if (!open) return;
    const target = popRef.current?.querySelector<HTMLButtonElement>(`[data-date="${toIsoDate(focusDate)}"]`);
    target?.focus({ preventScroll: true });
  }, [open, focusDate]);

  const openGrid = () => {
    if (disabled) return;
    setFocusDate(selected ?? new Date());
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const pick = (date: Date) => {
    const iso = toIsoDate(date);
    onChange(time ? `${iso}T${timePart}` : iso);
    setDraft(null);
    close(true);
  };

  const shift = (days: number, months = 0) => {
    setFocusDate((d) => new Date(d.getFullYear(), d.getMonth() + months, d.getDate() + days));
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowLeft': event.preventDefault(); shift(-1); break;
      case 'ArrowRight': event.preventDefault(); shift(1); break;
      case 'ArrowUp': event.preventDefault(); shift(-7); break;
      case 'ArrowDown': event.preventDefault(); shift(7); break;
      case 'PageUp': event.preventDefault(); shift(0, -1); break;
      case 'PageDown': event.preventDefault(); shift(0, 1); break;
      case 'Home': event.preventDefault(); shift(-((focusDate.getDay() + 6) % 7)); break;
      case 'End': event.preventDefault(); shift(6 - ((focusDate.getDay() + 6) % 7)); break;
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(true); break;
      default:
    }
  };

  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div
      ref={wrapRef}
      className={['gv-date', disabled ? 'gv-date--disabled' : '', className ?? ''].filter(Boolean).join(' ')}
    >
      <input
        id={id}
        className="gv-input gv-date__input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder ?? (time ? 'YYYY-MM-DD HH:MM' : 'YYYY-MM-DD')}
        value={draft ?? display(value)}
        required={required}
        disabled={disabled}
        aria-label={aria['aria-label']}
        aria-describedby={aria['aria-describedby']}
        aria-invalid={aria['aria-invalid'] ?? (draft !== null && draft !== '' && normalizeDateText(draft, time) === null)}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (text.trim() === '') {
            onChange('');
            return;
          }
          const normalized = normalizeDateText(text, time);
          if (normalized !== null) onChange(normalized);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && event.altKey) {
            event.preventDefault();
            openGrid();
          }
        }}
      />
      <button
        ref={buttonRef}
        type="button"
        className="gv-date__button"
        aria-label={`Choose ${aria['aria-label'] ? aria['aria-label'].toLowerCase() : 'a date'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? gridId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openGrid())}
      >
        <CalendarDays aria-hidden="true" />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popRef}
          id={gridId}
          role="dialog"
          aria-label={monthLabel}
          data-gv-layer=""
          className="glass gv-popover gv-date__popover"
          onKeyDown={onGridKeyDown}
          style={position ? { top: position.top, left: position.left } : { top: -9999, left: -9999 }}
        >
          <div className="gv-date__head">
            <button type="button" className="gv-date__nav" aria-label="Previous month" onClick={() => shift(0, -1)}>
              <ChevronLeft aria-hidden="true" />
            </button>
            <span className="gv-date__month" aria-live="polite">{monthLabel}</span>
            <button type="button" className="gv-date__nav" aria-label="Next month" onClick={() => shift(0, 1)}>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className="gv-date__grid" role="grid" aria-label={monthLabel}>
            <div className="gv-date__week" role="row">
              {WEEKDAYS.map((d) => <span key={d} role="columnheader" className="gv-date__weekday">{d}</span>)}
            </div>
            {Array.from({ length: 6 }, (_, week) => (
              <div key={week} className="gv-date__week" role="row">
                {days.slice(week * 7, week * 7 + 7).map((day) => {
                  const iso = toIsoDate(day);
                  const inMonth = day.getMonth() === month.getMonth();
                  const isSelected = iso === datePart;
                  const isFocus = iso === toIsoDate(focusDate);
                  return (
                    <span key={iso} role="gridcell" aria-selected={isSelected}>
                      <button
                        type="button"
                        data-date={iso}
                        tabIndex={isFocus ? 0 : -1}
                        className={[
                          'gv-date__day',
                          inMonth ? '' : 'gv-date__day--outside',
                          isSelected ? 'gv-date__day--selected' : '',
                          iso === todayIso ? 'gv-date__day--today' : '',
                        ].filter(Boolean).join(' ')}
                        aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                        onClick={() => pick(day)}
                        onFocus={() => { if (!isFocus) setFocusDate(day); }}
                      >
                        {day.getDate()}
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
