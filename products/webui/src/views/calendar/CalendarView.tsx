/**
 * Calendar, the Calendar tab of Personal. Events (list/get/create) and ICS
 * import/export over the daemon's CalDAV-backed `calendar.*` verbs. Calendar is
 * a daemon/agent feature with no TUI command surface, the web UI is its first
 * screen.
 *
 * Layout: an agenda grouped by day (list) with the selected event's detail in
 * the right pane, or a month grid with the detail in a drawer. The Segmented
 * "Agenda / Month" in the filter row switches between them. "New event" is the
 * tab's one primary action; .ics export and import live in the "More" menu.
 *
 * HONESTY CONTRACT (three refusal shapes, each rendered distinctly, never folded
 * into a generic "error"):
 *  1. UNCONFIGURED, the daemon's 412 CALENDAR_NOT_CONFIGURED / CALENDAR_CREDENTIALS_MISSING.
 *     The operator has not brought their own CalDAV endpoint. Neutral, not a
 *     fault: a pointer to the config keys (`surfaces.calendar.caldavUrl` /
 *     `caldavUser` / `caldavPassword`) and one action that opens settings.
 *  2. NOT AVAILABLE, a 404 "unknown gateway method" or 501 "not invokable" refusal:
 *     this daemon build has no live calendar handler wired at all. Distinct from
 *     "unconfigured": the CAPABILITY itself is missing, not just its configuration.
 *  3. GENUINE ERROR, anything else (network failure, a malformed range, a CalDAV
 *     auth failure against a configured endpoint), an empty state with retry.
 * Never fabricate a fourth "it's just empty" reading for any of the three above.
 */
import { SyntheticEvent, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { sdk } from '../../lib/goodvibes';
import type { CalendarEventCreateInput, CalendarIcsImportInput } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import {
  formatError,
  isCalendarAuthFailedError,
  isCalendarUnconfiguredError,
  isMethodNotInvokableError,
  isMethodUnavailableError,
} from '../../lib/errors';
import ErrorBoundary from '../../components/feedback/ErrorBoundary';
import { DetailPane, EmptyState, RowGroup, SkeletonRows, ListDetail } from '../../components/data-view/DataView';
import {
  Button,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Row,
  Segmented,
  Sheet,
  Textarea,
  useMediaQuery,
  PHONE_QUERY,
} from '../../components/ui';
import { DateField, parseIsoDate, toIsoDate, monthGrid } from '../../components/ui/DateField';
import { PersonalNotice, PersonalPage } from '../personal/PersonalPage';
import { openSettingsSection } from '../personal/openSettings';
import { CalendarEventBody, useCalendarEventDetail } from './CalendarEventPeek';
import { CalendarMonth, eventDayKey } from './CalendarMonth';
import '../../styles/components/calendar.css';

type CalendarLayout = 'agenda' | 'month';

function isoDateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toRangeStartIso(dateOnly: string): string {
  return dateOnly ? `${dateOnly}T00:00:00.000Z` : '';
}

function toRangeEndIso(dateOnly: string): string {
  return dateOnly ? `${dateOnly}T23:59:59.999Z` : '';
}

function splitAttendees(value: string): string[] | undefined {
  const list = value.split(',').map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function downloadIcs(icsContent: string, filename: string): void {
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

interface CalendarNote {
  title: string;
  description: string;
  /** Settings section that fixes it, when settings can. */
  settings?: string;
}

/** Classify a calendar-surface error into one of the three honest outcomes. Returns
 * null for a genuine error (the caller falls back to a plain retry state). */
function unconfiguredNote(error: unknown): CalendarNote | null {
  if (isCalendarUnconfiguredError(error)) {
    return {
      title: 'Calendar isn’t configured',
      description: 'Add your calendar in Settings and your events show up here.',
      settings: 'all',
    };
  }
  if (isMethodUnavailableError(error) || isMethodNotInvokableError(error)) {
    return {
      title: 'Calendar isn’t available on this daemon yet',
      description: 'This daemon has no calendar service yet, and updating the daemon turns it on.',
      settings: 'about',
    };
  }
  if (isCalendarAuthFailedError(error)) {
    return {
      title: 'The calendar server refused the saved password',
      description: 'Replace the calendar password in Settings and your events show up here.',
      settings: 'all',
    };
  }
  return null;
}

function dayLabel(key: string): string {
  const date = parseIsoDate(key);
  if (!date) return key;
  const today = new Date();
  const todayKey = toIsoDate(today);
  const tomorrowKey = toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const text = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  if (key === todayKey) return `Today, ${text}`;
  if (key === tomorrowKey) return `Tomorrow, ${text}`;
  return text;
}

function timeLabel(start: string): string {
  const parsed = new Date(start);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The phone's one date-range button: "Oct 1 – 15" inside one month, "Sep 28 –
 * Oct 5" across months, with the year only when the range leaves this year.
 */
export function formatRangeLabel(from: string, to: string, now: Date = new Date()): string {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (!start && !end) return 'Any date';
  const year = now.getFullYear();
  const withYear = (start !== null && start.getFullYear() !== year) || (end !== null && end.getFullYear() !== year);
  const fmt = (date: Date, opts: Intl.DateTimeFormatOptions) => date.toLocaleDateString('en-US', opts);
  const monthDay: Intl.DateTimeFormatOptions = withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' };
  if (!end) return start ? `From ${fmt(start, monthDay)}` : 'Any date';
  if (!start) return `Until ${fmt(end, monthDay)}`;
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    if (start.getDate() === end.getDate()) return fmt(start, monthDay);
    const head = fmt(start, { month: 'short', day: 'numeric' });
    return withYear ? `${head} – ${end.getDate()}, ${end.getFullYear()}` : `${head} – ${end.getDate()}`;
  }
  return `${fmt(start, monthDay)} – ${fmt(end, monthDay)}`;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export interface CalendarViewProps {
  /** The Personal tab switcher; shown first in the filter row. */
  tabs?: ReactNode;
}

export function CalendarView({ tabs }: CalendarViewProps = {}) {
  const queryClient = useQueryClient();
  const phone = useMediaQuery(PHONE_QUERY);
  const [rangeOpen, setRangeOpen] = useState(false);

  const [layout, setLayout] = useState<CalendarLayout>('agenda');
  const [from, setFrom] = useState(() => isoDateOffset(0));
  const [to, setTo] = useState(() => isoDateOffset(14));
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [calendarId, setCalendarId] = useState('');
  const [selectedId, setSelectedId] = useState('');

  const [newOpen, setNewOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [attendees, setAttendees] = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [icsContent, setIcsContent] = useState('');

  const [notice, setNotice] = useState<{ tone?: 'bad'; body: ReactNode } | null>(null);

  const monthDays = useMemo(() => monthGrid(month), [month]);
  const rangeFromDate = layout === 'month' ? toIsoDate(monthDays[0]) : from;
  const rangeToDate = layout === 'month' ? toIsoDate(monthDays[monthDays.length - 1]) : to;
  const rangeFrom = toRangeStartIso(rangeFromDate);
  const rangeTo = toRangeEndIso(rangeToDate);
  const calendarFilter = calendarId.trim();

  const events = useQuery({
    queryKey: queryKeys.calendarEvents(rangeFrom, rangeTo, calendarId),
    queryFn: () => sdk.operator.calendar.events.list({
      from: rangeFrom || undefined,
      to: rangeTo || undefined,
      ...(calendarFilter ? { calendarId: calendarFilter } : {}),
      limit: layout === 'month' ? 250 : 100,
    }),
  });

  const detail = useCalendarEventDetail(selectedId, calendarFilter || undefined);

  const create = useMutation({
    mutationFn: () => {
      const input: CalendarEventCreateInput = {
        title: title.trim(),
        start,
        end,
        confirm: true,
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(splitAttendees(attendees) ? { attendees: splitAttendees(attendees) } : {}),
        ...(calendarFilter ? { calendarId: calendarFilter } : {}),
      };
      return sdk.operator.calendar.events.create(input);
    },
    onSuccess: async (result) => {
      setTitle('');
      setStart('');
      setEnd('');
      setLocation('');
      setDescription('');
      setAttendees('');
      setNewOpen(false);
      setNotice({ body: `Event created (id ${result.eventId}).` });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'events'] });
    },
  });

  const exportIcs = useMutation({
    mutationFn: () => sdk.operator.calendar.ics.export({
      from: rangeFrom || undefined,
      to: rangeTo || undefined,
      ...(calendarFilter ? { calendarId: calendarFilter } : {}),
    }),
    onSuccess: (result) => {
      downloadIcs(result.icsContent, `calendar-export-${rangeFromDate}-to-${rangeToDate}.ics`);
      setNotice({ body: `Exported ${String(result.eventCount)} event(s).` });
    },
    onError: (error) => {
      const note = unconfiguredNote(error);
      setNotice({ tone: 'bad', body: note ? `${note.title}. ${note.description}` : `Export failed: ${formatError(error)}` });
    },
  });

  const importIcs = useMutation({
    mutationFn: () => {
      const input: CalendarIcsImportInput = {
        icsContent,
        confirm: true,
        ...(calendarFilter ? { calendarId: calendarFilter } : {}),
      };
      return sdk.operator.calendar.ics.import(input);
    },
    onSuccess: async (result) => {
      setIcsContent('');
      setImportOpen(false);
      setNotice({
        body: (
          <div>
            <p>Imported {result.imported} event(s).</p>
            {result.errors.length > 0 && (
              <ul className="calendar-notice__errors">
                {result.errors.map((message, index) => <li key={index}>{message}</li>)}
              </ul>
            )}
          </div>
        ),
      });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'events'] });
    },
  });

  const items = events.data?.events;
  const sortedItems = useMemo(() => [...(items ?? [])].sort((a, b) => a.start.localeCompare(b.start)), [items]);
  const groups = useMemo(() => {
    const map = new Map<string, typeof sortedItems>();
    for (const item of sortedItems) {
      const key = eventDayKey(item.start);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()];
  }, [sortedItems]);
  const honestNote = events.error ? unconfiguredNote(events.error) : null;
  const createNote = create.error ? unconfiguredNote(create.error) : null;
  const importNote = importIcs.error ? unconfiguredNote(importIcs.error) : null;
  const working = !events.isPending && !events.error;

  function submitCreate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim() && start && end) create.mutate();
  }

  function submitImport(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (icsContent.trim()) importIcs.mutate();
  }

  function changeLayout(next: CalendarLayout) {
    setLayout(next);
    setSelectedId('');
  }

  function shiftMonth(delta: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
    setSelectedId('');
  }

  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const shortMonthLabel = month.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

  const layoutToggle = (
    <Segmented<CalendarLayout>
      label="Calendar layout"
      className="calendar-layout-toggle"
      value={layout}
      options={[{ value: 'agenda', label: 'Agenda' }, { value: 'month', label: 'Month' }]}
      onChange={changeLayout}
    />
  );

  const goToday = () => {
    setMonth(startOfMonth(new Date()));
    setSelectedId('');
  };

  const moreMenu = (
    <Menu
      label="More calendar actions"
      placement="bottom-end"
      trigger={(props) => <IconButton label="More calendar actions" icon={<MoreHorizontal />} {...props} />}
    >
      {phone && <MenuItem icon={<RefreshCw />} onSelect={() => void events.refetch()}>Refresh events</MenuItem>}
      {phone && layout === 'month' && <MenuItem onSelect={goToday}>Go to this month</MenuItem>}
      {phone && <MenuSeparator />}
      <MenuItem onSelect={() => exportIcs.mutate()} disabled={exportIcs.isPending || !working}>Export range as .ics</MenuItem>
      <MenuItem onSelect={() => setImportOpen(true)} disabled={Boolean(honestNote)}>Import .ics file content</MenuItem>
    </Menu>
  );

  const monthNav = (
    <div className="calendar-month-nav">
      <IconButton label="Previous month" icon={<ChevronLeft />} onClick={() => shiftMonth(-1)} />
      <span className="calendar-month-nav__label" aria-live="polite">{phone ? shortMonthLabel : monthLabel}</span>
      <IconButton label="Next month" icon={<ChevronRight />} onClick={() => shiftMonth(1)} />
      {!phone && (
        <Button variant="ghost" size="sm" onClick={goToday}>
          Today
        </Button>
      )}
    </div>
  );

  const rangeLabel = formatRangeLabel(from, to);
  const calendarLabel = calendarFilter || 'Default calendar';

  // Phone: one compact row (layout toggle, one date-range button, the more menu),
  // so the agenda starts near the top of the screen. The range and the calendar
  // choice live in a sheet.
  const filters = phone ? (
    <div className="calendar-phone-controls">
      {layoutToggle}
      {layout === 'agenda' ? (
        <Button
          variant="outline"
          className="calendar-range-button"
          icon={<CalendarDays aria-hidden="true" />}
          onClick={() => setRangeOpen(true)}
          aria-label={`Date range ${rangeLabel}, ${calendarLabel}. Change`}
          aria-haspopup="dialog"
        >
          <span className="calendar-range-button__text">{rangeLabel}</span>
        </Button>
      ) : monthNav}
      {moreMenu}
    </div>
  ) : (
    <>
      {layoutToggle}
      {layout === 'agenda' ? (
        <>
          <DateField value={from} onChange={setFrom} aria-label="Range start" />
          <DateField value={to} onChange={setTo} aria-label="Range end" />
        </>
      ) : monthNav}
      <Input
        className="calendar-filter-calendar"
        value={calendarId}
        onChange={(event) => setCalendarId(event.target.value)}
        placeholder="Default calendar"
        aria-label="Logical calendar id"
      />
      <div className="dv-filters__end">
        <IconButton label="Refresh events" icon={<RefreshCw />} onClick={() => void events.refetch()} />
        {moreMenu}
      </div>
    </>
  );

  const action = honestNote
    ? undefined
    : <Button variant="primary" icon={<Plus />} onClick={() => setNewOpen(true)}>New event</Button>;

  const noticeNode = notice ? <PersonalNotice tone={notice.tone}>{notice.body}</PersonalNotice> : null;

  let content: ReactNode;
  if (events.isPending) {
    content = <SkeletonRows count={6} label="Loading events" />;
  } else if (honestNote) {
    content = (
      <EmptyState
        icon={<CalendarDays />}
        title={honestNote.title}
        role="status"
        action={honestNote.settings
          ? <Button variant="outline" onClick={() => openSettingsSection(honestNote.settings ?? 'general')}>
              {honestNote.settings === 'about' ? 'Update daemon' : 'Open settings'}
            </Button>
          : undefined}
      >
        {honestNote.description}
      </EmptyState>
    );
  } else if (events.error) {
    content = (
      <EmptyState
        icon={<AlertCircle />}
        title="Events failed to load"
        role="status"
        action={<Button variant="outline" onClick={() => void events.refetch()}>Try again</Button>}
      >
        {formatError(events.error)}
      </EmptyState>
    );
  } else if (layout === 'month') {
    content = (
      <>
        {noticeNode}
        <CalendarMonth month={month} events={sortedItems} selectedId={selectedId} onSelect={setSelectedId} />
      </>
    );
  } else if (sortedItems.length === 0) {
    content = (
      <>
        {noticeNode}
        <EmptyState
          icon={<CalendarDays />}
          title="No events in this range"
          action={<Button variant="outline" onClick={() => setNewOpen(true)}>New event</Button>}
        >
          Try a wider date range, or add the first event.
        </EmptyState>
      </>
    );
  } else {
    const list = (
      <>
        {noticeNode}
        <div data-testid="calendar-agenda">
          {groups.map(([key, dayItems]) => (
            <RowGroup key={key} label={dayLabel(key)} count={dayItems.length}>
              {dayItems.map((item) => (
                <Row
                  key={item.id}
                  className="calendar-event-row"
                  title={item.title}
                  meta={item.location}
                  selected={item.id === selectedId}
                  onSelect={() => setSelectedId(item.id)}
                  trailing={<span className="dv-value">{timeLabel(item.start)}</span>}
                />
              ))}
            </RowGroup>
          ))}
        </div>
      </>
    );
    content = (
      <ListDetail
        mode="peek"
        list={list}
        detailOpen={Boolean(selectedId)}
        onCloseDetail={() => setSelectedId('')}
        listLabel="Events"
        detailLabel="Event detail"
        backLabel="All events"
        detail={(
          <DetailPane title={detail.data?.title ?? 'Event'} onClose={() => setSelectedId('')} closeLabel="Close event">
            <CalendarEventBody detail={detail} />
          </DetailPane>
        )}
      />
    );
  }

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <EmptyState icon={<AlertCircle />} title="Calendar view failed" action={<Button variant="outline" onClick={reset}>Try again</Button>}>
          {formatError(err)}
        </EmptyState>
      )}
    >
      <PersonalPage tabs={tabs} filters={filters} action={action}>
        {content}
      </PersonalPage>

      <Drawer
        open={layout === 'month' && Boolean(selectedId)}
        onClose={() => setSelectedId('')}
        label="Event detail"
        title={detail.data?.title ?? 'Event'}
      >
        <div className="calendar-drawer-body">
          <CalendarEventBody detail={detail} />
        </div>
      </Drawer>

      <Sheet open={phone && rangeOpen} onClose={() => setRangeOpen(false)} label="Date range">
        <div className="calendar-range-sheet">
          <h2 className="calendar-range-sheet__title">Date range</h2>
          <div className="personal-form__split">
            <Field label="From">
              <DateField value={from} onChange={setFrom} aria-label="Range start" />
            </Field>
            <Field label="To">
              <DateField value={to} onChange={setTo} aria-label="Range end" />
            </Field>
          </div>
          <Field label="Calendar" help="Leave empty for the default calendar.">
            <Input
              value={calendarId}
              onChange={(event) => setCalendarId(event.target.value)}
              placeholder="Default calendar"
              aria-label="Logical calendar id"
            />
          </Field>
          <Button variant="primary" className="calendar-range-sheet__done" onClick={() => setRangeOpen(false)}>Done</Button>
        </div>
      </Sheet>

      <Dialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New event"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form="calendar-new-event"
              disabled={create.isPending || !title.trim() || !start || !end}
              aria-busy={create.isPending}
            >
              {create.isPending ? 'Creating…' : 'Create event'}
            </Button>
          </>
        )}
      >
        <form id="calendar-new-event" className="personal-form" onSubmit={submitCreate}>
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </Field>
          <div className="personal-form__split">
            <Field label="Start">
              <DateField time value={start} onChange={setStart} required />
            </Field>
            <Field label="End">
              <DateField time value={end} onChange={setEnd} required />
            </Field>
          </div>
          <Field label="Location">
            <Input value={location} onChange={(event) => setLocation(event.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </Field>
          <Field label="Attendees" help="Separate addresses with commas.">
            <Input value={attendees} onChange={(event) => setAttendees(event.target.value)} />
          </Field>
          {createNote ? (
            <div className="dv-notice" role="status"><span>{createNote.title}. {createNote.description}</span></div>
          ) : create.error ? (
            <div className="dv-notice dv-notice--bad" role="alert"><AlertCircle aria-hidden="true" /><span>Create failed: {formatError(create.error)}</span></div>
          ) : null}
        </form>
      </Dialog>

      <Dialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import .ics content"
        description="Paste iCalendar text. Every event in it is added to the calendar."
        footer={(
          <>
            <Button variant="secondary" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form="calendar-import"
              disabled={importIcs.isPending || !icsContent.trim()}
              aria-busy={importIcs.isPending}
            >
              {importIcs.isPending ? 'Importing…' : 'Import'}
            </Button>
          </>
        )}
      >
        <form id="calendar-import" className="personal-form" onSubmit={submitImport}>
          <Field label="iCalendar content">
            <Textarea
              className="calendar-ics-input"
              value={icsContent}
              onChange={(event) => setIcsContent(event.target.value)}
              placeholder="BEGIN:VCALENDAR..."
              rows={8}
            />
          </Field>
          {importNote ? (
            <div className="dv-notice" role="status"><span>{importNote.title}. {importNote.description}</span></div>
          ) : importIcs.error ? (
            <div className="dv-notice dv-notice--bad" role="alert"><AlertCircle aria-hidden="true" /><span>Import failed: {formatError(importIcs.error)}</span></div>
          ) : null}
        </form>
      </Dialog>
    </ErrorBoundary>
  );
}
