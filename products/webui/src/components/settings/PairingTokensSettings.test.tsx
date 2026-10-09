/**
 * PairingTokensSettings, list/rename/revoke per-device tokens, plus the
 * migrate-this-browser and revoke-shared-token affordances, each gated by the
 * real ConfirmSheet (never a bare click-to-destroy).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { ToastViewport } from '../toast/ToastViewport';

const listCalls: unknown[] = [];
const renameCalls: unknown[] = [];
const deleteCalls: unknown[] = [];
const migrateCalls: unknown[] = [];
const revokeSharedCalls: unknown[] = [];
const setExplicitAuthTokenCalls: string[] = [];

let listData: { tokens: { id: string; name: string; createdAt: number; lastSeenAt?: number }[]; legacySharedRevoked: boolean } = {
  tokens: [
    { id: 'tok-1', name: 'Phone', createdAt: 1_700_000_000_000, lastSeenAt: 1_700_100_000_000 },
    { id: 'tok-2', name: 'Laptop', createdAt: 1_700_000_500_000 },
  ],
  legacySharedRevoked: false,
};

mock.module('../../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  setExplicitAuthToken: (token: string) => {
    setExplicitAuthTokenCalls.push(token);
    return Promise.resolve({ authenticated: true });
  },
  sdk: {
    operator: {
      pairing: {
        tokens: {
          list: () => {
            listCalls.push(null);
            return Promise.resolve(listData);
          },
          rename: (id: string, name: string) => {
            renameCalls.push({ id, name });
            return Promise.resolve({ id, renamed: true });
          },
          delete: (id: string) => {
            deleteCalls.push(id);
            return Promise.resolve({ id, revoked: true });
          },
          migrate: (name: string) => {
            migrateCalls.push(name);
            return Promise.resolve({ token: { id: 'tok-new', name, token: 'raw-new-token', createdAt: Date.now() } });
          },
          revokeShared: () => {
            revokeSharedCalls.push(null);
            return Promise.resolve({ legacySharedRevoked: true });
          },
        },
      },
    },
  },
}));

const { PairingTokensSettings } = await import('./PairingTokensSettings');

function render(): { el: HTMLElement; unmount: () => void } {
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
          React.createElement(PairingTokensSettings),
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

function click(el: Element | null | undefined): void {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

/** The Revoke action on the paired-device row named `device`, found by its name, not its styling. */
function revokeActionFor(el: HTMLElement, device: string): HTMLButtonElement | undefined {
  const row = [...el.querySelectorAll('ul[aria-label="Paired devices"] li')].find((r) => r.textContent?.includes(device));
  return [...(row?.querySelectorAll('button') ?? [])].find((b) => {
    const name = `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`;
    return /revoke/i.test(name);
  });
}

afterEach(() => {
  listCalls.length = 0;
  renameCalls.length = 0;
  deleteCalls.length = 0;
  migrateCalls.length = 0;
  revokeSharedCalls.length = 0;
  setExplicitAuthTokenCalls.length = 0;
  listData = {
    tokens: [
      { id: 'tok-1', name: 'Phone', createdAt: 1_700_000_000_000, lastSeenAt: 1_700_100_000_000 },
      { id: 'tok-2', name: 'Laptop', createdAt: 1_700_000_500_000 },
    ],
    legacySharedRevoked: false,
  };
});

describe('PairingTokensSettings rendering', () => {
  test('lists every device by name, never a secret', async () => {
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Phone'));
    const text = el.textContent ?? '';
    expect(text).toContain('Phone');
    expect(text).toContain('Laptop');
    expect(text).not.toContain('raw-new-token');
    unmount();
  });

  test('legacySharedRevoked hides the migrate/revoke-shared affordances', async () => {
    listData = { ...listData, legacySharedRevoked: true };
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Phone'));
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(buttons.some((t) => t.includes('Give this browser its own token'))).toBe(false);
    expect(buttons.some((t) => t.includes('Revoke the shared token'))).toBe(false);
    unmount();
  });
});

describe('PairingTokensSettings rename', () => {
  test('renames a device inline', async () => {
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Phone'));
    click(el.querySelector('[aria-label="Rename Phone"]'));
    const input = el.querySelector('input#pairing-token-rename-tok-1') as HTMLInputElement;
    expect(input).not.toBeNull();
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'My Phone');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const form = input.closest('form');
    flushSync(() => {
      form?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => renameCalls.length > 0);
    expect(renameCalls[0]).toEqual({ id: 'tok-1', name: 'My Phone' });
    unmount();
  });
});

describe('PairingTokensSettings revoke: confirm gate', () => {
  test('cancelling the confirm sheet does not revoke', async () => {
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Phone'));
    click(revokeActionFor(el, 'Phone'));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    // The dialog names the device and says what revoking does, before anything happens.
    expect(el.querySelector('.gv-confirm')?.textContent).toContain('Phone');
    click(el.querySelector('.gv-confirm__cancel'));
    // The sheet closes as ask() resolves false. The handler resumes after that
    // await on a microtask, and a revoke mutation would reach the SDK on further
    // microtasks, so one real event-loop turn after the close lets all of it run.
    await waitFor(() => !el.querySelector('.gv-confirm'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deleteCalls).toHaveLength(0);
    unmount();
  });

  test('confirming revokes exactly the clicked device', async () => {
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Phone'));
    click(revokeActionFor(el, 'Phone'));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    click(el.querySelector('.gv-confirm__confirm'));
    await waitFor(() => deleteCalls.length > 0);
    expect(deleteCalls).toEqual(['tok-1']);
    unmount();
  });
});

describe('PairingTokensSettings migrate + revoke-shared', () => {
  test('migrate mints a token for this browser and swaps the stored auth token', async () => {
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Give this browser its own token'));
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Give this browser its own token')));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    click(el.querySelector('.gv-confirm__confirm'));
    await waitFor(() => migrateCalls.length > 0);
    expect(migrateCalls[0]).toBe('This browser');
    await waitFor(() => setExplicitAuthTokenCalls.length > 0);
    expect(setExplicitAuthTokenCalls[0]).toBe('raw-new-token');
    unmount();
  });

  test('revoke-shared asks first, warning what it does, and only then calls revokeShared', async () => {
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Revoke the shared token'));
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Revoke the shared token')));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    expect(revokeSharedCalls).toHaveLength(0);
    // Destructive: focus starts on Cancel, so a stray Enter cannot revoke.
    expect(document.activeElement?.textContent).toBe('Cancel');
    click(el.querySelector('.gv-confirm__confirm'));
    await waitFor(() => revokeSharedCalls.length > 0);
    unmount();
  });
});
