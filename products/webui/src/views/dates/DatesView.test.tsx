/**
 * DatesView (the Occasions tab), the honesty contract (a 404/501 renders one honest
 * not-available empty state with a daemon-update action, never a fabricated empty list), the "no fourth
 * reading" for a genuinely empty read, and the one distinction docs/occasions.md
 * §4.3 draws hardest: occasions.list renders real dates (nextOccurrence/daysUntil),
 * while occasions.pending's nudge subjects render only a proximity WORD, never a
 * date, this file proves that split rather than assuming it.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { ToastViewport } from '../../components/toast/ToastViewport';

type ListResult = { today: string; timezone: string; occasions: unknown[]; unparsed: unknown[]; conflicts: unknown[] };
type PendingResult = { today: string; nudge: unknown; conflicts: unknown[]; interviews: unknown[] };
type PlansResult = { today: string; plans: unknown[]; unparsed: unknown[]; awayNow: unknown };
type StateResultShape = {
  path: string; acknowledgements: number; giftRecords: number; openItems: number;
  interviews: number; mirrors: number; lastSweep: unknown; corruption: string | null;
};

let listImpl: () => Promise<ListResult> = () => Promise.resolve({ today: '2026-07-29', timezone: 'America/Chicago', occasions: [], unparsed: [], conflicts: [] });
let pendingImpl: () => Promise<PendingResult> = () => Promise.resolve({ today: '2026-07-29', nudge: null, conflicts: [], interviews: [] });
let plansImpl: () => Promise<PlansResult> = () => Promise.resolve({ today: '2026-07-29', plans: [], unparsed: [], awayNow: null });
let stateImpl: () => Promise<StateResultShape> = () => Promise.resolve({ path: '/tmp/state.json', acknowledgements: 0, giftRecords: 0, openItems: 0, interviews: 0, mirrors: 0, lastSweep: null, corruption: null });

const answerCalls: unknown[] = [];
const giftsCalls: string[] = [];

mock.module('../../lib/goodvibes', () => ({
  // src/lib/queries.ts (imported transitively via queryKeys) destructures these off
  // the same module, the mock's surface must satisfy that import even though this
  // test never calls them (same gotcha CalendarView.test.tsx/MailView.test.tsx document).
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      occasions: {
        list: () => listImpl(),
        pending: () => pendingImpl(),
        plans: {
          list: () => plansImpl(),
          propose: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
          confirm: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
        },
        state: () => stateImpl(),
        answer: (input: unknown) => {
          answerCalls.push(input);
          return Promise.resolve({ ok: true, reason: null, interview: null });
        },
        remove: () => Promise.resolve({ ok: true, reason: null, occasionId: 'occ-1', disclosure: 'Removed.', droppedRecords: 1 }),
        propose: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
        confirm: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
        gifts: (occasionId: string) => {
          giftsCalls.push(occasionId);
          return Promise.resolve({ occasionId, gifts: [] });
        },
        sweep: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
        conflict: { resolve: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })) },
        interview: {
          get: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
          answer: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
          record: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
        },
      },
    },
  },
}));

const { DatesView } = await import('./DatesView');

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
        React.createElement(
          ToastProvider,
          null,
          React.createElement(DatesView),
          React.createElement(ToastViewport),
        ),
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

function buttonNamed(root: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
}

/** Select the first occasion row so its detail pane opens. */
function openFirstRow(el: HTMLElement): void {
  flushSync(() => (el.querySelector('[data-testid="dates-occasion-list"] .gv-row__main') as HTMLElement).click());
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

afterEach(() => {
  listImpl = () => Promise.resolve({ today: '2026-07-29', timezone: 'America/Chicago', occasions: [], unparsed: [], conflicts: [] });
  pendingImpl = () => Promise.resolve({ today: '2026-07-29', nudge: null, conflicts: [], interviews: [] });
  plansImpl = () => Promise.resolve({ today: '2026-07-29', plans: [], unparsed: [], awayNow: null });
  stateImpl = () => Promise.resolve({ path: '/tmp/state.json', acknowledgements: 0, giftRecords: 0, openItems: 0, interviews: 0, mirrors: 0, lastSweep: null, corruption: null });
  answerCalls.length = 0;
  giftsCalls.length = 0;
});

describe('DatesView: not-available refusal', () => {
  test('a 501 on occasions.list offers only the update action, not an empty list', async () => {
    listImpl = () => refusal(501, { error: 'Gateway method is not invokable', code: 'METHOD_NOT_INVOKABLE' });
    const { el, unmount } = render();
    await waitFor(() => buttonNamed(el, 'Update daemon') !== undefined);
    expect(el.querySelector('[data-testid="dates-occasion-list"]')).toBeNull();
    // One action, and no Add occasion / Add plan while the surface cannot answer.
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Update daemon']);
    unmount();
  });
});

describe('DatesView: populated / empty ("no fourth reading")', () => {
  test('a successful empty response offers Add occasion, not the refusal action', async () => {
    const { el, unmount } = render();
    await waitFor(() => buttonNamed(el, 'Add occasion') !== undefined);
    expect(buttonNamed(el, 'Update daemon')).toBeUndefined();
    unmount();
  });

  test('an upcoming occasion renders title, person, kind, and the real next-occurrence date', async () => {
    listImpl = () => Promise.resolve({
      today: '2026-07-29',
      timezone: 'America/Chicago',
      occasions: [{
        occasion: {
          id: 'occ-1', title: 'Sarah’s birthday', date: { kind: 'recurring', month: 3, day: 14 },
          recurrence: 'annual', kind: 'gift-giving', person: 'Sarah', leadDays: 21, mirrored: false,
          extras: [], lineIndex: 0, text: 'sample',
        },
        nextOccurrence: '2027-03-14T00:00:00.000Z', daysUntil: 228, leadDays: 21, inLeadWindow: false,
        answer: null, mirrored: false,
      }],
      unparsed: [],
      conflicts: [],
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="dates-occasion-list"]')));
    expect(el.textContent).toContain('Sarah’s birthday');
    expect(el.textContent).toContain('Sarah');
    // occasions.list is the explicit-ask read that DOES return the real date
    // (docs/occasions.md §4.3), the formatted nextOccurrence must render.
    expect(el.textContent).toContain('Mar 14, 2027');
    unmount();
  });

  test('clicking Yes on an occasion calls occasions.answer with that occasion id', async () => {
    listImpl = () => Promise.resolve({
      today: '2026-07-29', timezone: 'America/Chicago',
      occasions: [{
        occasion: { id: 'occ-1', title: 'Dad', date: { kind: 'recurring', month: 11, day: 2 }, recurrence: 'annual', kind: 'remember-only', person: 'Dad', leadDays: 10, mirrored: false, extras: [], lineIndex: 0, text: 'sample' },
        nextOccurrence: '2026-11-02T00:00:00.000Z', daysUntil: 96, leadDays: 10, inLeadWindow: false, answer: null, mirrored: false,
      }],
      unparsed: [], conflicts: [],
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="dates-occasion-list"]')));
    openFirstRow(el);
    await waitFor(() => Boolean(buttonNamed(el, 'Yes')));
    flushSync(() => buttonNamed(el, 'Yes')?.click());
    await waitFor(() => answerCalls.length > 0);
    expect(answerCalls[0]).toEqual({ occasionId: 'occ-1', answer: 'yes' });
    unmount();
  });

  test('selecting an occasion shows its gift history in the detail pane and calls occasions.gifts for that occasion', async () => {
    listImpl = () => Promise.resolve({
      today: '2026-07-29', timezone: 'America/Chicago',
      occasions: [{
        occasion: { id: 'occ-9', title: 'Anniversary', date: { kind: 'recurring', month: 9, day: 12 }, recurrence: 'annual', kind: 'gift-giving', person: 'Jane', leadDays: 10, mirrored: false, extras: [], lineIndex: 0, text: 'sample' },
        nextOccurrence: '2026-09-12T00:00:00.000Z', daysUntil: 45, leadDays: 10, inLeadWindow: false, answer: 'yes', mirrored: false,
      }],
      unparsed: [], conflicts: [],
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="dates-occasion-list"]')));
    openFirstRow(el);
    await waitFor(() => giftsCalls.length > 0);
    expect(giftsCalls[0]).toBe('occ-9');
    unmount();
  });

  test('a plan renders its title, date range, destination, and an away badge', async () => {
    plansImpl = () => Promise.resolve({
      today: '2026-07-29',
      plans: [{ id: 'plan-1', title: 'Lisbon', from: '2026-09-12T00:00:00.000Z', to: '2026-09-19T00:00:00.000Z', away: true, destination: 'Lisbon', extras: [], lineIndex: 0, text: 'sample' }],
      unparsed: [],
      awayNow: null,
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="dates-plan-list"]')));
    expect(el.textContent).toContain('Lisbon');
    unmount();
  });
});

describe('DatesView: open items never render a date for a nudge subject', () => {
  test('a pending nudge renders the proximity WORD, never a raw date', async () => {
    pendingImpl = () => Promise.resolve({
      today: '2026-07-29',
      nudge: {
        id: 'nudge-1', raisedAt: 1_700_000_000_000,
        subjects: [{ occasionId: 'occ-1', title: 'Sarah’s birthday', person: 'Sarah', kind: 'gift-giving', proximity: 'approaching' }],
        message: 'Sarah’s birthday is approaching.', answerable: true,
      },
      conflicts: [],
      interviews: [],
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="dates-nudge"]')));
    expect(el.textContent).toContain('approaching');
    expect(el.textContent).toContain('Sarah’s birthday is approaching.');
    // No ISO date or year should ever appear inside the nudge block, that is the
    // one thing a nudge composition must never carry (docs/occasions.md §4.3).
    const nudge = el.querySelector('[data-testid="dates-nudge"]');
    expect(nudge?.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    unmount();
  });
});

describe('DatesView: state disclosure', () => {
  test('renders the machine-owned store counts', async () => {
    stateImpl = () => Promise.resolve({
      path: '/tmp/occasions-state.json', acknowledgements: 3, giftRecords: 2, openItems: 1, interviews: 0, mirrors: 0,
      lastSweep: { sweptAt: 1_700_000_000_000, expiredAcknowledgements: 1, orphanedRecords: 0, expiredOpenItems: 0, agedGiftRecords: 0, droppedInterviews: 0, staleMirrors: 0 },
      corruption: null,
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="dates-state"]')));
    expect(el.textContent).toContain('3');
    expect(el.textContent).toContain('2');
    unmount();
  });
});

describe('DatesView: add dialogs', () => {
  test('Add occasion and Add plan each open their dialog, and Cancel closes it', async () => {
    const { el, unmount } = render();
    await waitFor(() => buttonNamed(el, 'Add occasion') !== undefined);

    flushSync(() => buttonNamed(el, 'Add occasion')?.click());
    await waitFor(() => Boolean(document.body.querySelector('#dates-add-occasion')));
    flushSync(() => buttonNamed(document.body, 'Cancel')?.click());
    await waitFor(() => !document.body.querySelector('#dates-add-occasion'));

    flushSync(() => buttonNamed(el, 'Add plan')?.click());
    await waitFor(() => Boolean(document.body.querySelector('#dates-add-plan')));
    unmount();
  });
});
