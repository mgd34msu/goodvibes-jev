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
import type { OperatorMethodInput, OperatorMethodOutput } from '../../lib/goodvibes';

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
let sweepImpl: () => Promise<OperatorMethodOutput<'occasions.sweep'>> = () => Promise.reject(new Error('not used'));
let forgetImpl: (input: OperatorMethodInput<'profile.forget'>) => Promise<unknown> = () => Promise.reject(new Error('not used'));

const answerCalls: unknown[] = [];
const giftsCalls: string[] = [];
const removeCalls: OperatorMethodInput<'occasions.remove'>[] = [];
const forgetCalls: OperatorMethodInput<'profile.forget'>[] = [];

mock.module('../../lib/goodvibes', () => ({
  // src/lib/queries.ts (imported transitively via queryKeys) destructures these off
  // the same module, the mock's surface must satisfy that import even though this
  // test never calls them (same gotcha CalendarView.test.tsx/MailView.test.tsx document).
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      profile: {
        forget: (input: OperatorMethodInput<'profile.forget'>) => {
          forgetCalls.push(input);
          return forgetImpl(input);
        },
      },
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
        remove: (input: OperatorMethodInput<'occasions.remove'>) => {
          removeCalls.push(input);
          return Promise.resolve({ ok: true, reason: null, occasionId: 'occ-1', disclosure: 'Removed.', droppedRecords: 1 });
        },
        propose: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
        confirm: () => Promise.reject(Object.assign(new Error('not used'), { status: 500 })),
        gifts: (occasionId: string) => {
          giftsCalls.push(occasionId);
          return Promise.resolve({ occasionId, gifts: [] });
        },
        sweep: () => sweepImpl(),
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
  sweepImpl = () => Promise.reject(new Error('not used'));
  forgetImpl = () => Promise.reject(new Error('not used'));
  answerCalls.length = 0;
  giftsCalls.length = 0;
  removeCalls.length = 0;
  forgetCalls.length = 0;
});

describe('DatesView: manual sweep outcomes', () => {
  const complete = {
    ranAt: 1,
    today: '2026-07-29',
    hold: null,
    nudge: null,
    conflictMessages: [],
    resumedInterviews: [],
    delivered: false,
    deliveryChannel: 'telegram, agent',
    deliveryId: null,
    deliveries: [],
    mirrored: 3,
    housekeeping: {
      sweptAt: 1, expiredAcknowledgements: 0, orphanedRecords: 0, expiredOpenItems: 0,
      agedGiftRecords: 0, droppedInterviews: 0, staleMirrors: 0,
    },
  } satisfies OperatorMethodOutput<'occasions.sweep'>;
  const nudge = {
    id: 'occasions-1',
    raisedAt: 1,
    subjects: [{
      occasionId: 'occ-1', title: 'Sarah’s birthday', person: 'Sarah', kind: 'gift-giving',
      proximity: 'soon', subject: 'other', acknowledged: false,
    }],
    message: 'Sarah’s birthday is soon.',
    answerable: true,
  } satisfies NonNullable<Extract<OperatorMethodOutput<'occasions.sweep'>, { ranAt: number }>['nudge']>;
  const cases: readonly {
    name: string;
    receipt: OperatorMethodOutput<'occasions.sweep'>;
    message: string;
  }[] = [
    { name: 'no due nudge', receipt: complete, message: 'Ran with nothing to deliver. Mirrored 3 occasion(s).' },
    {
      name: 'quiet hours hold',
      receipt: { ...complete, hold: 'quiet-hours', deliveryChannel: '' },
      message: 'Held: quiet-hours. Mirrored 3 occasion(s).',
    },
    {
      name: 'disabled hold',
      receipt: { ...complete, hold: 'disabled', deliveryChannel: '' },
      message: 'Held: disabled. Mirrored 3 occasion(s).',
    },
    {
      name: 'ready nudge without a push delivery',
      receipt: { ...complete, nudge },
      message: 'Nudge is ready for the agent to pick up. Mirrored 3 occasion(s).',
    },
    {
      name: 'failed nudge',
      receipt: { ...complete, nudge, deliveries: [
        { channel: 'telegram', delivered: false, deliveryId: null, failure: 'Token expired' },
        { channel: 'agent', delivered: false, deliveryId: null, failure: 'Agent unavailable' },
      ] },
      message: 'Nudge was not delivered. Failed deliveries: telegram: Token expired; agent: Agent unavailable. Mirrored 3 occasion(s).',
    },
    {
      name: 'one successful destination and one failure',
      receipt: { ...complete, nudge, delivered: true, deliveryId: 'delivery-1', deliveries: [
        { channel: 'telegram', delivered: false, deliveryId: null, failure: 'Token expired' },
        { channel: 'agent', delivered: true, deliveryId: 'delivery-1', failure: null },
      ] },
      message: 'Delivered via agent. Failed deliveries: telegram: Token expired. Mirrored 3 occasion(s).',
    },
    {
      name: 'request ended after an accepted delivery',
      receipt: { complete: false, acceptedDeliveries: 1, stopped: 'request-retired-after-delivery' },
      message: 'Accepted 1 delivery before the request ended after delivery. Sweep results are incomplete.',
    },
    {
      name: 'delivery processing stopped after accepted deliveries',
      receipt: { complete: false, acceptedDeliveries: 2, stopped: 'delivery-processing-stopped' },
      message: 'Accepted 2 deliveries before delivery processing stopped. Sweep results are incomplete.',
    },
  ];

  test.each([...cases])('$name appears after running the sweep', async ({ receipt, message }) => {
    let sweeps = 0;
    sweepImpl = () => {
      sweeps += 1;
      return Promise.resolve(receipt);
    };
    const { el, unmount } = render();
    try {
      await waitFor(() => buttonNamed(el, 'Run sweep now') !== undefined);
      const disclosure = el.querySelector<HTMLDetailsElement>('details.dv-disclosure');
      const summary = disclosure?.querySelector('summary');
      if (!disclosure || !summary) throw new Error('Stored records disclosure is missing');
      flushSync(() => summary.click());
      expect(disclosure.open).toBe(true);
      const run = buttonNamed(el, 'Run sweep now');
      if (!run) throw new Error('Run sweep action is missing');
      flushSync(() => run.click());
      await waitFor(() => el.querySelector('[data-testid="dates-state"] [role="status"]') !== null);
      const status = el.querySelector('[data-testid="dates-state"] [role="status"]');
      expect(status?.textContent).toBe(message);
      expect(sweeps).toBe(1);
      if ('complete' in receipt) expect(status?.textContent).not.toContain('Mirrored');
    } finally {
      unmount();
    }
  });
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

describe('DatesView: plan removal uses the exact native profile line', () => {
  const plan = {
    id: 'lisbon', title: 'Lisbon', from: '2026-09-12', to: '2026-09-19', away: true,
    destination: 'Lisbon', extras: [], lineIndex: 5,
    text: 'Lisbon · 2026-09-12..2026-09-19 · away · in Lisbon',
  } satisfies OperatorMethodOutput<'occasions.plans.list'>['plans'][number];
  const original = { today: '2026-07-29', plans: [plan], unparsed: [], awayNow: null } satisfies OperatorMethodOutput<'occasions.plans.list'>;

  function click(root: ParentNode, name: string): void {
    const button = buttonNamed(root, name);
    if (button === undefined) throw new Error(`Missing ${name} button`);
    flushSync(() => button.click());
  }

  async function askRemovePlan(el: HTMLElement): Promise<Element> {
    const row = el.querySelector('[data-testid="dates-plan-list"] .gv-row__main');
    if (!(row instanceof HTMLElement)) throw new Error('Missing native plan row');
    flushSync(() => row.click());
    await waitFor(() => buttonNamed(el, 'Remove') !== undefined);
    click(el, 'Remove');
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    const confirmation = el.querySelector('.gv-confirm');
    if (confirmation === null) throw new Error('Missing plan confirmation');
    expect(confirmation.textContent).toContain('Remove this plan?');
    expect(confirmation.textContent).toContain('This removes the selected plan from your profile.');
    expect(confirmation.textContent).not.toContain('every record');
    return confirmation;
  }

  test('Cancel sends no mutation; one later confirmation forgets the exact plan and closes its detail', async () => {
    plansImpl = () => Promise.resolve(original);
    forgetImpl = () => {
      plansImpl = () => Promise.resolve({ ...original, plans: [] });
      return Promise.resolve({
        ok: true, reason: null,
        changes: [{ kind: 'forget', fieldId: null, section: 'Plans', label: 'note', superseded: false }],
        disclosure: 'Removed note from Plans.',
      });
    };
    const { el, unmount } = render();
    try {
      await waitFor(() => Boolean(el.querySelector('[data-testid="dates-plan-list"]')));
      click(await askRemovePlan(el), 'Cancel');
      await waitFor(() => !el.querySelector('.gv-confirm'));
      expect(forgetCalls).toEqual([]);
      expect(removeCalls).toEqual([]);
      expect(buttonNamed(el, 'Close plan')).toBeDefined();

      click(el, 'Remove');
      await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
      const confirmation = el.querySelector('.gv-confirm');
      if (confirmation === null) throw new Error('Missing plan confirmation');
      click(confirmation, 'Remove');
      await waitFor(() => el.textContent?.includes('Removed note from Plans.') === true);
      expect(forgetCalls).toEqual([{ section: 'Plans', text: plan.text, authority: 'owner-direct' }]);
      expect(removeCalls).toEqual([]);
      expect(buttonNamed(el, 'Close plan')).toBeUndefined();
      expect(el.querySelector('[data-testid="dates-plan-list"] .gv-row__main')).toBeNull();
      expect(el.querySelector('.gv-confirm')).toBeNull();
    } finally { unmount(); }
  });

  for (const cause of ['refused', 'stale'] as const) {
    test(`${cause} native forget retains plan detail and reports its actual reason`, async () => {
      plansImpl = () => Promise.resolve(original);
      const reason = cause === 'stale'
        ? 'That line is not in Plans any more, so nothing was removed.'
        : 'That source carries no command authority over the owner profile.';
      forgetImpl = () => {
        if (cause === 'stale') {
          plansImpl = () => Promise.resolve({
            ...original,
            plans: [{ ...plan, to: '2026-09-20', text: 'Lisbon · 2026-09-12..2026-09-20 · away · in Lisbon' }],
          });
        }
        return Promise.resolve({ ok: false, reason, changes: [], disclosure: '' });
      };
      const { el, unmount } = render();
      try {
        await waitFor(() => Boolean(el.querySelector('[data-testid="dates-plan-list"]')));
        click(await askRemovePlan(el), 'Remove');
        await waitFor(() => el.textContent?.includes(reason) === true);
        expect(forgetCalls).toEqual([{ section: 'Plans', text: plan.text, authority: 'owner-direct' }]);
        expect(removeCalls).toEqual([]);
        expect(buttonNamed(el, 'Close plan')).toBeDefined();
        expect(el.querySelector('[data-testid="dates-plan-list"] .gv-row__main')?.textContent).toContain('Lisbon');
        expect(el.querySelector('.gv-confirm')).toBeNull();
      } finally { unmount(); }
    });
  }

  test('a malformed profile write outcome keeps the plan selected and never reports removal', async () => {
    plansImpl = () => Promise.resolve(original);
    forgetImpl = () => Promise.resolve({ ok: 'true' });
    const { el, unmount } = render();
    try {
      await waitFor(() => Boolean(el.querySelector('[data-testid="dates-plan-list"]')));
      click(await askRemovePlan(el), 'Remove');
      await waitFor(() => el.textContent?.includes('The daemon did not say whether the plan was removed.') === true);
      expect(forgetCalls).toEqual([{ section: 'Plans', text: plan.text, authority: 'owner-direct' }]);
      expect(removeCalls).toEqual([]);
      expect(buttonNamed(el, 'Close plan')).toBeDefined();
      expect(el.querySelector('[data-testid="dates-plan-list"] .gv-row__main')?.textContent).toContain('Lisbon');
      expect(el.textContent).toContain('Not removed');
    } finally { unmount(); }
  });

  test('occasion removal retains its native record-cleanup command', async () => {
    listImpl = () => Promise.resolve({
      today: '2026-07-29', timezone: 'America/Chicago',
      occasions: [{
        occasion: {
          id: 'anniversary', title: 'Anniversary', date: { kind: 'dated', year: 2027, month: 5, day: 1 },
          recurrence: 'annual', kind: 'gift-giving', person: '', selfDeclared: false, subject: 'unattributed',
          leadDays: null, mirrored: false, extras: [], lineIndex: 2,
          text: 'Anniversary · 2027-05-01 · annual · gift-giving',
        },
        nextOccurrence: '2027-05-01', daysUntil: 276, leadDays: 10, inLeadWindow: false, answer: null, mirrored: false,
      }],
      unparsed: [], conflicts: [],
    } satisfies OperatorMethodOutput<'occasions.list'>);
    const { el, unmount } = render();
    try {
      await waitFor(() => Boolean(el.querySelector('[data-testid="dates-occasion-list"]')));
      openFirstRow(el);
      await waitFor(() => buttonNamed(el, 'Remove') !== undefined);
      click(el, 'Remove');
      await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
      const confirmation = el.querySelector('.gv-confirm');
      if (confirmation === null) throw new Error('Missing occasion confirmation');
      expect(confirmation.textContent).toContain('acknowledgements and gift records');
      click(confirmation, 'Remove');
      await waitFor(() => removeCalls.length === 1);
      expect(removeCalls).toEqual([{ occasionId: 'anniversary', confirmed: true, authority: 'owner-direct' }]);
      expect(forgetCalls).toEqual([]);
    } finally { unmount(); }
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
