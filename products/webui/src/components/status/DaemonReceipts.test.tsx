/**
 * DaemonReceipts, the connect-time receipt notices.
 * Pins: control.status is called with { receipts: 'consume' } exactly once on
 * the attach edge (connected + signed-in), each returned receipt renders as a
 * dismissible one-line notice, a plain (disconnected / signed-out) state never
 * consumes, and a dismissed receipt is gone, the "shows once" contract.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RELAY_PAIRING_STORAGE_KEY, getStoredRelayPairing } from '../../lib/relay-pairing';

// Controllable control.status stub: records every call's input and returns the
// staged receipts on the first consume, then nothing (marked delivered).
const statusCalls: ({ receipts?: 'consume' } | undefined)[] = [];
let stagedReceipts: { id: string; text: string; at: number }[] = [];

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => null,
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      control: {
        status: (input?: { receipts?: 'consume' }) => {
          statusCalls.push(input);
          if (input?.receipts === 'consume') {
            const delivered = stagedReceipts;
            stagedReceipts = [];
            return Promise.resolve({ ok: true, status: 'running', receipts: delivered });
          }
          return Promise.resolve({ ok: true, status: 'running' });
        },
      },
    },
  },
}));

const { DaemonReceipts } = await import('./DaemonReceipts');

function render(props: { connected: boolean; signedIn: boolean }, strict = false) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const content = (next: { connected: boolean; signedIn: boolean }) => {
    const component = React.createElement(DaemonReceipts, next);
    return strict ? React.createElement(React.StrictMode, null, component) : component;
  };
  flushSync(() => {
    root.render(content(props));
  });
  return {
    el: container,
    rerender: (next: { connected: boolean; signedIn: boolean }) =>
      flushSync(() => root.render(content(next))),
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

function notices(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('[data-testid="daemon-receipt"]')];
}

afterEach(() => {
  statusCalls.length = 0;
  stagedReceipts = [];
  document.body.innerHTML = '';
  window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
});

describe('DaemonReceipts', () => {
  test('consumes once on the attach edge and renders each receipt line', async () => {
    stagedReceipts = [
      { id: 'r1', text: 'Daemon restarted after a crash at 14:03', at: 1 },
      { id: 'r2', text: 'Updated to 1.7.1', at: 2 },
    ];
    const { el, unmount } = render({ connected: true, signedIn: true });
    await settle();
    const rows = notices(el);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Daemon restarted after a crash at 14:03');
    expect(rows[1].textContent).toContain('Updated to 1.7.1');
    // Exactly one consuming status call.
    expect(statusCalls.filter((c) => c?.receipts === 'consume')).toHaveLength(1);
    unmount();
  });

  test('a disconnected or signed-out surface never consumes', async () => {
    stagedReceipts = [{ id: 'r1', text: 'Updated to 1.7.1', at: 1 }];
    const { el, unmount } = render({ connected: false, signedIn: true });
    await settle();
    expect(notices(el)).toHaveLength(0);
    const signedOut = render({ connected: true, signedIn: false });
    await settle();
    expect(notices(signedOut.el)).toHaveLength(0);
    expect(statusCalls.filter((c) => c?.receipts === 'consume')).toHaveLength(0);
    signedOut.unmount();
    unmount();
  });

  test('consuming only fires on the transition into attached, not on every render', async () => {
    stagedReceipts = [{ id: 'r1', text: 'Migration applied: sessions v3', at: 1 }];
    const { el, rerender, unmount } = render({ connected: true, signedIn: true });
    await settle();
    expect(notices(el)).toHaveLength(1);
    // Re-render with the same attached props, no second consume.
    rerender({ connected: true, signedIn: true });
    await settle();
    expect(statusCalls.filter((c) => c?.receipts === 'consume')).toHaveLength(1);
    // Still exactly the one receipt (a re-consume would have returned none anyway).
    expect(notices(el)).toHaveLength(1);
    unmount();
  });

  test('a feature announcement rides the same queue and linkifies its URL', async () => {
    // Announcements arrive through the SAME receipts=consume read, same shape,
    // same show-once semantics, the web-surface URL line becomes a real link.
    stagedReceipts = [
      { id: 'ann-web', text: 'Reach this session from your phone: https://gv.example/s/abc123', at: 1 },
    ];
    const { el, unmount } = render({ connected: true, signedIn: true });
    await settle();
    const rows = notices(el);
    expect(rows).toHaveLength(1);
    const link = rows[0].querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://gv.example/s/abc123');
    // The surrounding prose still renders.
    expect(rows[0].textContent).toContain('Reach this session from your phone');
    unmount();
  });

  test('a pending relay-pairing corruption notice rides the same queue, independent of connection state', async () => {
    // Simulate an earlier code path (routedFetch's own getStoredRelayPairing read,
    // in real use) discovering and discarding a corrupt stored record BEFORE this
    // component ever mounts.
    window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, '{not json');
    getStoredRelayPairing();

    const { el, unmount } = render({ connected: false, signedIn: false });
    await settle();
    const rows = notices(el);
    expect(rows).toHaveLength(1);
    // Never re-consumed daemon-side (this surface never attached).
    expect(statusCalls.filter((c) => c?.receipts === 'consume')).toHaveLength(0);
    unmount();
  });

  test('dismissing a receipt removes it and it does not come back', async () => {
    stagedReceipts = [{ id: 'r1', text: 'Updated to 1.7.1', at: 1 }];
    const { el, rerender, unmount } = render({ connected: true, signedIn: true });
    await settle();
    expect(notices(el)).toHaveLength(1);
    flushSync(() => {
      el.querySelector<HTMLButtonElement>('.daemon-receipt__dismiss')?.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true }),
      );
    });
    await settle();
    expect(notices(el)).toHaveLength(0);
    // A reconnect re-consumes (the daemon already delivered r1, so it returns
    // none) and the dismissed id never resurfaces.
    rerender({ connected: false, signedIn: true });
    await settle();
    rerender({ connected: true, signedIn: true });
    await settle();
    expect(notices(el)).toHaveLength(0);
    unmount();
  });
});


describe('receipt replay and repeated attachment', () => {
  test('StrictMode attaches once and retains consumed host receipts', async () => {
    stagedReceipts = [{ id: 'strict-r1', text: 'Host completion receipt', at: 1 }];
    const { el, unmount } = render({ connected: true, signedIn: true }, true);
    await settle();
    expect(statusCalls.filter((call) => call?.receipts === 'consume')).toHaveLength(1);
    expect(notices(el)).toHaveLength(1);
    expect(el.textContent).toContain('Host completion receipt');
    unmount();
  });

  test('sign-out and reattachment deduplicate replayed stable host IDs', async () => {
    stagedReceipts = [{ id: 'replayed-r1', text: 'Completed once', at: 1 }];
    const { el, rerender, unmount } = render({ connected: true, signedIn: true });
    await settle();
    flushSync(() => el.querySelector<HTMLButtonElement>('.daemon-receipt__dismiss')?.click());
    rerender({ connected: true, signedIn: false });
    await settle();
    stagedReceipts = [
      { id: 'replayed-r1', text: 'Completed once', at: 1 },
      { id: 'fresh-r2', text: 'Another completion', at: 2 },
    ];
    rerender({ connected: true, signedIn: true });
    await settle();
    expect(statusCalls.filter((call) => call?.receipts === 'consume')).toHaveLength(2);
    expect(notices(el)).toHaveLength(1);
    expect(el.textContent).toContain('Another completion');
    expect(el.textContent).not.toContain('Completed once');
    unmount();
  });
});
