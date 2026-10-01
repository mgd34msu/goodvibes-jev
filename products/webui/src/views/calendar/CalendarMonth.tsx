/**
 * The Month layout: a Monday-first month grid drawn with hairlines, events as
 * small text lines. Seven equal columns with min-width 0, so a long title
 * ellipsizes instead of widening the page (nothing scrolls sideways at 390).
 */
import { useMemo } from 'react';
import { monthGrid, toIsoDate } from '../../components/ui/DateField';

export interface MonthEvent {
  id: string;
  title: string;
  start: string;
}

export interface CalendarMonthProps {
  /** Any date inside the month to show. */
  month: Date;
  events: readonly MonthEvent[];
  selectedId: string;
  onSelect: (eventId: string) => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** The local date (YYYY-MM-DD) an event starts on. */
export function eventDayKey(start: string): string {
  const parsed = new Date(start);
  return Number.isNaN(parsed.getTime()) ? start.slice(0, 10) : toIsoDate(parsed);
}

export function CalendarMonth({ month, events, selectedId, onSelect }: CalendarMonthProps) {
  const days = useMemo(() => monthGrid(month), [month]);
  const byDay = useMemo(() => {
    const map = new Map<string, MonthEvent[]>();
    for (const event of events) {
      const key = eventDayKey(event.start);
      const list = map.get(key);
      if (list) list.push(event);
      else map.set(key, [event]);
    }
    return map;
  }, [events]);
  const todayKey = toIsoDate(new Date());
  const label = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="cal-month" role="grid" aria-label={label} data-testid="calendar-month">
      <div className="cal-month__week cal-month__weekdays" role="row">
        {WEEKDAYS.map((name) => (
          <span key={name} role="columnheader" className="cal-month__weekday">{name}</span>
        ))}
      </div>
      {Array.from({ length: 6 }, (_, week) => (
        <div key={week} className="cal-month__week" role="row">
          {days.slice(week * 7, week * 7 + 7).map((day) => {
            const key = toIsoDate(day);
            const inMonth = day.getMonth() === month.getMonth();
            const dayEvents = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                role="gridcell"
                className={['cal-month__cell', inMonth ? '' : 'cal-month__cell--outside'].filter(Boolean).join(' ')}
              >
                <span
                  className={['cal-month__day', key === todayKey ? 'cal-month__day--today' : ''].filter(Boolean).join(' ')}
                  aria-label={day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                >
                  {day.getDate()}
                </span>
                {dayEvents.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    className={['cal-month__event', event.id === selectedId ? 'cal-month__event--selected' : ''].filter(Boolean).join(' ')}
                    aria-current={event.id === selectedId || undefined}
                    title={event.title}
                    onClick={() => onSelect(event.id)}
                  >
                    {event.title}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
