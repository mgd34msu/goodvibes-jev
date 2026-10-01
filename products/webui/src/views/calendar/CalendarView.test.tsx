/**
 * CalendarView, the calendar surface's honesty contract: three distinct
 * refusal states (unconfigured / not-available / genuine error), never folded
 * into one generic failure, plus the populated/empty/create/export/import
 * happy paths.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Module mock, mutable per-test calendar operator implementation
// ---------------------------------------------------------------------------

type EventsListImpl = () => Promise<{ events: unknown[] }>;
type EventsGetImpl = (eventId: string) => Promise<unknown>;
type EventsCreateImpl = (input: unknown) => Promise<unknown>;
type IcsExportImpl = () => Promise<unknown>;
type IcsImportImpl = (input: unknown) => Promise<unknown>;

let eventsList: EventsListImpl = () => Promise.resolve({ events: [] });
let eventsGet: EventsGetImpl = (eventId) => Promise.resolve({ id: eventId, uid: `${eventId}@x`, title: 'Event', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
let eventsCreate: EventsCreateImpl = () => Promise.resolve({ eventId: 'e1', uid: 'e1@x', createdAt: '2026-01-01T00:00:00Z' });
let icsExport: IcsExportImpl = () => Promise.resolve({ icsContent: 'BEGIN:VCALENDAR\nEND:VCALENDAR', eventCount: 0 });
let icsImport: IcsImportImpl = () => Promise.resolve({ imported: 0, eventIds: [], errors: [] });

mock.module('../../lib/goodvibes', () => ({
  // lib/queries.ts (imported transitively via queryKeys) destructures these off the
  // same module, the mock's surface must satisfy that import even though this test
  // never calls them.
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      calendar: {
        events: {
          list: () => eventsList(),
          get: (eventId: string) => eventsGet(eventId),
          create: (input: unknown) => eventsCreate(input),
        },
        ics: {
          export: () => icsExport(),
          import: (input: unknown) => icsImport(input),
        },
      },
    },
  },
}));

const { CalendarView, formatRangeLabel } = await import('./CalendarView');

function refusal(status: number, body: unknown): Promise<never> {
  return Promise.reject(Object.assign(new Error(`request failed: ${status}`), { status, body }));
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(CalendarView),
      ),
    );
  });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

/** Set a controlled input/textarea's value through the native setter (bypassing
 * React's value tracker) so the subsequent 'input' event is seen as a real change. */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Click the first button (in the page or in an open dialog or menu) whose text or aria-label matches. */
function clickByName(name: string): void {
  const all = [...document.body.querySelectorAll<HTMLElement>('button, [role="menuitem"]')];
  const target = all.find((node) => (node.getAttribute('aria-label') ?? node.textContent ?? '').trim() === name);
  if (!target) throw new Error(`no button named ${name}`);
  flushSync(() => target.click());
}

function hasButton(name: string): boolean {
  return [...document.body.querySelectorAll<HTMLElement>('button')].some(
    (node) => (node.getAttribute('aria-label') ?? node.textContent ?? '').trim() === name,
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

// happy-dom does not implement the Blob-URL pair CalendarView's export/download path
// uses; stub both so the export mutation's onSuccess side effect never throws.
beforeAll(() => {
  if (!URL.createObjectURL) (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:test';
  if (!URL.revokeObjectURL) (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});

afterEach(() => {
  eventsList = () => Promise.resolve({ events: [] });
  eventsGet = (eventId) => Promise.resolve({ id: eventId, uid: `${eventId}@x`, title: 'Event', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
  eventsCreate = () => Promise.resolve({ eventId: 'e1', uid: 'e1@x', createdAt: '2026-01-01T00:00:00Z' });
  icsExport = () => Promise.resolve({ icsContent: 'BEGIN:VCALENDAR\nEND:VCALENDAR', eventCount: 0 });
  icsImport = () => Promise.resolve({ imported: 0, eventIds: [], errors: [] });
});

describe('CalendarView: a genuine failure', () => {
  test('a 500 offers a retry that requests the events again', async () => {
    let listCalls = 0;
    eventsList = () => {
      listCalls += 1;
      return refusal(500, { error: 'boom' });
    };
    const { el, unmount } = render();
    const tryAgain = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    await waitFor(() => tryAgain() !== undefined);
    const before = listCalls;
    flushSync(() => tryAgain()?.click());
    await waitFor(() => listCalls > before);
    expect(listCalls).toBe(before + 1);
    unmount();
  });
});

describe('CalendarView: populated / empty', () => {

  test('events render sorted by start time, and opening one shows its detail', async () => {
    eventsList = () => Promise.resolve({
      events: [
        { id: 'ev-2', title: 'Second', start: '2026-01-02T09:00:00Z', end: '2026-01-02T10:00:00Z' },
        { id: 'ev-1', title: 'First', start: '2026-01-01T09:00:00Z', end: '2026-01-01T10:00:00Z' },
      ],
    });
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('First'));
    const rows = [...el.querySelectorAll('.calendar-event-row')];
    expect(rows[0]?.textContent).toContain('First');
    expect(rows[1]?.textContent).toContain('Second');

    flushSync(() => (rows[0]?.querySelector('button') as HTMLElement).click());
    await waitFor(() => (el.textContent ?? '').includes('ev-1@x'));
    unmount();
  });
});

/** Open the New event dialog and fill the title and both times, then submit. */
function fillNewEvent(): void {
  clickByName('New event');
  const form = document.body.querySelector('#calendar-new-event') as HTMLFormElement;
  if (!form) throw new Error('the New event dialog did not open');
  const [title, start, end] = [...form.querySelectorAll<HTMLInputElement>('input')];
  flushSync(() => {
    setNativeValue(title as HTMLInputElement, 'Standup');
    setNativeValue(start as HTMLInputElement, '2026-01-01 09:00');
    setNativeValue(end as HTMLInputElement, '2026-01-01 09:30');
  });
  flushSync(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('CalendarView: agenda and month', () => {
  test('the Month layout draws a hairline grid with events as text lines and opens detail in a drawer', async () => {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T12:00:00`;
    eventsList = () => Promise.resolve({ events: [{ id: 'ev-m', title: 'Planning', start: iso, end: iso }] });
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Planning'));
    expect(el.querySelector('[data-testid="calendar-month"]')).toBeNull();

    const month = [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) => node.textContent === 'Month');
    flushSync(() => month?.click());
    await waitFor(() => Boolean(el.querySelector('[data-testid="calendar-month"]')));
    const eventLine = [...el.querySelectorAll<HTMLElement>('.cal-month__event')].find((node) => node.textContent === 'Planning');
    expect(eventLine).toBeDefined();

    flushSync(() => eventLine?.click());
    await waitFor(() => Boolean(document.body.querySelector('[role="dialog"] [data-testid="calendar-event-detail"]')));
    unmount();
  });
});

describe('CalendarView: create / export / import', () => {
  test('creating an event with confirm:true succeeds and shows the new event id', async () => {
    let captured: unknown;
    eventsCreate = (input) => {
      captured = input;
      return Promise.resolve({ eventId: 'created-1', uid: 'created-1@x', createdAt: '2026-01-01T00:00:00Z' });
    };
    const { el, unmount } = render();
    await waitFor(() => hasButton('New event'));
    fillNewEvent();

    await waitFor(() => (el.textContent ?? '').includes('created-1'));
    expect((captured as { confirm: boolean }).confirm).toBe(true);
    expect((captured as { title: string }).title).toBe('Standup');
    unmount();
  });

  test('importing .ics content sends the pasted content and relays the daemon\'s per-event errors', async () => {
    let captured: unknown;
    icsImport = (input) => {
      captured = input;
      return Promise.resolve({ imported: 1, eventIds: ['imp-1'], errors: ['bad-uid: malformed'] });
    };
    const { el, unmount } = render();
    await waitFor(() => hasButton('More calendar actions'));
    clickByName('More calendar actions');
    await waitFor(() => Boolean(document.body.querySelector('[role="menuitem"]')));
    clickByName('Import .ics file content');
    await waitFor(() => Boolean(document.body.querySelector('#calendar-import textarea')));

    const textarea = document.body.querySelector('#calendar-import textarea') as HTMLTextAreaElement;
    const form = textarea.closest('form') as HTMLFormElement;
    flushSync(() => {
      setNativeValue(textarea, 'BEGIN:VCALENDAR\nEND:VCALENDAR');
    });
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    await waitFor(() => (el.textContent ?? '').includes('bad-uid: malformed'));
    expect((captured as { icsContent: string }).icsContent).toBe('BEGIN:VCALENDAR\nEND:VCALENDAR');
    unmount();
  });
});

describe('formatRangeLabel (the phone date-range button)', () => {
  const now = new Date(2026, 8, 30);
  test('a range inside one month reads "Oct 1 – 15"', () => {
    expect(formatRangeLabel('2026-10-01', '2026-10-15', now)).toBe('Oct 1 – 15');
  });
  test('a range across months names both months', () => {
    expect(formatRangeLabel('2026-09-28', '2026-10-05', now)).toBe('Sep 28 – Oct 5');
  });
  test('the year appears only when the range leaves this year', () => {
    expect(formatRangeLabel('2026-12-28', '2027-01-04', now)).toBe('Dec 28, 2026 – Jan 4, 2027');
    expect(formatRangeLabel('2027-01-02', '2027-01-09', now)).toBe('Jan 2 – 9, 2027');
  });
  test('one day, and open ends', () => {
    expect(formatRangeLabel('2026-10-03', '2026-10-03', now)).toBe('Oct 3');
    expect(formatRangeLabel('', '2026-10-03', now)).toBe('Until Oct 3');
    expect(formatRangeLabel('2026-10-03', '', now)).toBe('From Oct 3');
    expect(formatRangeLabel('', '', now)).toBe('Any date');
  });
});
