/**
 * MailView, the honesty contract mail-refusal.ts documents: not-available renders
 * an honest note (not a fake-empty inbox), a genuinely empty inbox renders the empty
 * state (never a refusal, "no fourth reading"), and a refusing surface renders one
 * empty state with no compose form and no Compose button, so nothing invites an action
 * that cannot land.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { ToastViewport } from '../../components/toast/ToastViewport';

type InboxListImpl = () => Promise<{ messages: unknown[]; total: number; unreadable?: { uid?: number; detail: string }[] }>;

let inboxList: InboxListImpl = () => Promise.resolve({ messages: [], total: 0 });
let inboxRead: (uid: number) => Promise<unknown> = () => Promise.reject(Object.assign(new Error('not used'), { status: 500 }));

mock.module('../../lib/goodvibes', () => ({
  // src/lib/queries.ts (imported transitively via queryKeys) destructures these off
  // the same module, the mock's surface must satisfy that import even though this
  // test never calls them (same gotcha CalendarView.test.tsx documents).
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      email: {
        inbox: {
          list: () => inboxList(),
          read: (uid: number) => inboxRead(uid),
        },
        send: () => Promise.resolve({ messageId: '<x@example.com>', sentAt: '2026-01-01T00:00:00Z' }),
        draft: {
          create: () => Promise.resolve({ uid: 1, draftId: 'd1' }),
        },
      },
    },
  },
}));

const { MailView } = await import('./MailView');

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
          React.createElement(MailView),
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

afterEach(() => {
  inboxList = () => Promise.resolve({ messages: [], total: 0 });
  inboxRead = () => Promise.reject(Object.assign(new Error('not used'), { status: 500 }));
});

function buttonNamed(root: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
}

describe('MailView: not-available refusal', () => {
  test('a 501 renders the not-available note and no inbox list', async () => {
    inboxList = () => refusal(501, { error: 'Gateway method is not invokable', code: 'METHOD_NOT_INVOKABLE' });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-note-not-available"]')));
    expect(el.querySelector('[data-testid="mail-list"]')).toBeNull();
    unmount();
  });

  test('while refusing there is no compose form, no Compose button and exactly one action', async () => {
    inboxList = () => refusal(501, { error: 'Gateway method is not invokable', code: 'METHOD_NOT_INVOKABLE' });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-note-not-available"]')));

    expect(buttonNamed(el, 'Compose')).toBeUndefined();
    expect(el.querySelector('textarea')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
    const note = el.querySelector('[data-testid="mail-note-not-available"]') as HTMLElement;
    expect(note.querySelectorAll('button')).toHaveLength(1);
    expect(buttonNamed(note, 'Update daemon')).toBeDefined();
    unmount();
  });

  test('a 412 needs-setup refusal is its own empty state with an Open settings action', async () => {
    inboxList = () => refusal(412, { error: 'Mail account is not configured.', code: 'EMAIL_NOT_CONFIGURED' });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-note-needs-setup"]')));
    expect(buttonNamed(el, 'Open settings')).toBeDefined();
    expect(buttonNamed(el, 'Compose')).toBeUndefined();
    unmount();
  });
});

describe('MailView: populated / empty ("no fourth reading")', () => {
  test('a successful response renders one row per message', async () => {
    inboxList = () => Promise.resolve({
      messages: [
        { uid: 1, from: 'a@example.com', subject: 'Read one', date: '2026-01-01T09:00:00Z', unread: false, bodyPreview: 'preview a', messageId: '<a@x>' },
        { uid: 2, from: 'b@example.com', subject: 'Unread one', date: '2026-01-02T09:00:00Z', unread: true, bodyPreview: 'preview b', messageId: '<b@x>' },
      ],
      total: 2,
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-list"]')));

    const rows = [...el.querySelectorAll('.mail-row')];
    expect(rows).toHaveLength(2);
    expect(el.textContent).toContain('Unread one');
    expect(el.textContent).toContain('Read one');
    unmount();
  });

  test('opening a row shows the message in the right pane, and Reply opens the compose panel prefilled', async () => {
    inboxList = () => Promise.resolve({
      messages: [
        { uid: 5, from: 'a@example.com', subject: 'Lunch?', date: '2026-01-01T09:00:00Z', unread: true, bodyPreview: 'p', messageId: '<lunch@x>' },
      ],
      total: 1,
    });
    inboxRead = () => Promise.resolve({
      uid: 5, from: 'a@example.com', subject: 'Lunch?', date: '2026-01-01T09:00:00Z', messageId: '<lunch@x>', bodyText: 'Noon works?',
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-list"]')));
    flushSync(() => (el.querySelector('.mail-row .gv-row__main') as HTMLElement).click());
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-message-detail"]')));
    expect(el.textContent).toContain('Noon works?');

    flushSync(() => buttonNamed(el, 'Reply')?.click());
    await waitFor(() => Boolean(document.body.querySelector('[data-testid="mail-compose"]')));
    const compose = document.body.querySelector('[data-testid="mail-compose"]') as HTMLElement;
    const inputs = [...compose.querySelectorAll('input')];
    expect(inputs[0]?.value).toBe('a@example.com');
    expect(inputs[1]?.value).toBe('Re: Lunch?');
    // Nothing typed yet, so Send stays disabled.
    expect(buttonNamed(compose, 'Send')?.hasAttribute('disabled')).toBe(true);
    unmount();
  });

  test('Compose opens a panel that Escape closes', async () => {
    inboxList = () => Promise.resolve({ messages: [], total: 0 });
    const { el, unmount } = render();
    await waitFor(() => buttonNamed(el, 'Compose') !== undefined);
    flushSync(() => buttonNamed(el, 'Compose')?.click());
    const compose = el.querySelector('[data-testid="mail-compose"]') as HTMLElement;
    expect(compose).not.toBeNull();
    flushSync(() => {
      compose.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(el.querySelector('[data-testid="mail-compose"]')).toBeNull();
    unmount();
  });

  test('a successful response with messages: [] renders the empty state, NOT a refusal note', async () => {
    inboxList = () => Promise.resolve({ messages: [], total: 0 });
    const { el, unmount } = render();
    await waitFor(() => buttonNamed(el, 'Compose') !== undefined);
    expect(el.querySelector('.mail-row')).toBeNull();
    expect(el.querySelector('[data-testid="mail-note-not-available"]')).toBeNull();
    expect(el.querySelector('[data-testid="mail-note-needs-setup"]')).toBeNull();
    unmount();
  });
});

describe('MailView: inbox order is sender-proof (uid, never date)', () => {
  test('a spoofed far-future Date: header does not pin a message to the top when its uid is lowest', async () => {
    inboxList = () => Promise.resolve({
      messages: [
        // Lowest uid (oldest arrival) but a `Date:` header far in the future, this is
        // exactly the attacker move: the sender writes any date it wants, so if the
        // view sorted on `date` this message would render first. It must not.
        { uid: 1, from: 'attacker@example.com', subject: 'Spoofed future date', date: '2099-01-01T00:00:00Z', unread: false, bodyPreview: 'p1', messageId: '<attacker@x>' },
        { uid: 2, from: 'a@example.com', subject: 'Real, older uid', date: '2026-01-01T09:00:00Z', unread: false, bodyPreview: 'p2', messageId: '<a@x>' },
        { uid: 3, from: 'b@example.com', subject: 'Real, newest uid', date: '2026-01-02T09:00:00Z', unread: false, bodyPreview: 'p3', messageId: '<b@x>' },
      ],
      total: 3,
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-list"]')));

    const subjects = [...el.querySelectorAll('.mail-row .gv-row__title')].map((node) => node.textContent);
    // Newest-first by uid: 3, 2, 1, the spoofed-date message (uid 1) is last, not first.
    expect(subjects[0]).toContain('Real, newest uid');
    expect(subjects[1]).toContain('Real, older uid');
    expect(subjects[2]).toContain('Spoofed future date');
    unmount();
  });

  test('ordering is stable and correct when two messages carry identical date values', async () => {
    const sameDate = '2026-01-01T00:00:00Z';
    inboxList = () => Promise.resolve({
      messages: [
        { uid: 10, from: 'a@example.com', subject: 'ten', date: sameDate, unread: false, bodyPreview: 'p', messageId: '<10@x>' },
        { uid: 30, from: 'b@example.com', subject: 'thirty', date: sameDate, unread: false, bodyPreview: 'p', messageId: '<30@x>' },
        { uid: 20, from: 'c@example.com', subject: 'twenty', date: sameDate, unread: false, bodyPreview: 'p', messageId: '<20@x>' },
      ],
      total: 3,
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-list"]')));

    const subjects = [...el.querySelectorAll('.mail-row .gv-row__title')].map((node) => node.textContent);
    expect(subjects[0]).toContain('thirty');
    expect(subjects[1]).toContain('twenty');
    expect(subjects[2]).toContain('ten');
    unmount();
  });
});

describe('MailView: messages the daemon could not read', () => {
  test('an inbox where every message failed to parse does NOT render as a normal empty inbox', async () => {
    // The state this exists to catch. Before the 1.19.1 re-pin the inbox-list result
    // type omitted `unreadable` entirely, so this response reached the view as
    // "messages: [], total: 0" and rendered "The account answered normally with no
    // messages in this window", a sentence that is false in exactly the situation
    // an operator most needs the truth.
    inboxList = () =>
      Promise.resolve({
        messages: [],
        total: 0,
        unreadable: [
          { uid: 41, detail: 'unsupported transfer encoding' },
          { detail: 'malformed header, uid unknown' },
        ],
      });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-unreadable"]')));

    // The per-message reason, not just a count, a count tells an operator nothing
    // about whether it is one broken sender or a misconfigured account.
    expect(el.textContent).toContain('41');
    expect(el.textContent).toContain('unsupported transfer encoding');
    // A failure with no uid renders its reason alone, never "uid undefined".
    expect(el.textContent).toContain('malformed header, uid unknown');
    expect(el.textContent).not.toContain('undefined');
    unmount();
  });

  test('unreadable messages are reported alongside a list that DID load', async () => {
    inboxList = () =>
      Promise.resolve({
        messages: [
          {
            uid: 7,
            from: 'a@example.com',
            subject: 'Readable',
            date: '2026-01-01T00:00:00Z',
            unread: false,
            bodyPreview: 'hi',
            messageId: '<a@example.com>',
          },
        ],
        total: 2,
        unreadable: [{ uid: 8, detail: 'attachment decode failed' }],
      });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-list"]')));

    expect(el.querySelector('[data-testid="mail-unreadable"]')).not.toBeNull();
    expect(el.textContent).toContain('attachment decode failed');
    unmount();
  });

  test('a clean inbox renders no unreadable note at all', async () => {
    // The negative case: without this, the two assertions above would pass against a
    // note that is always present.
    inboxList = () =>
      Promise.resolve({
        messages: [
          {
            uid: 7,
            from: 'a@example.com',
            subject: 'Readable',
            date: '2026-01-01T00:00:00Z',
            unread: false,
            bodyPreview: 'hi',
            messageId: '<a@example.com>',
          },
        ],
        total: 1,
      });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-list"]')));

    expect(el.querySelector('[data-testid="mail-unreadable"]')).toBeNull();
    unmount();
  });
});
