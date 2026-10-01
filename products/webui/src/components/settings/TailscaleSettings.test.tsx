/**
 * TailscaleSettings, the one confirmed "Serve over tailscale" action behind a
 * "needs https, available via tailscale" label. Absent stays quiet (renders
 * nothing); present offers the action behind ConfirmSheet and renders the
 * resulting receipt.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { ToastViewport } from '../toast/ToastViewport';

const serveRunCalls: unknown[] = [];

let getData: {
  available: boolean;
  loggedIn: boolean;
  magicDnsName?: string;
  httpsUrl?: string;
  detail: string;
  lastServe?: { at: number; command: string; ok: boolean; url?: string; detail: string };
} = { available: false, loggedIn: false, detail: 'tailscale binary not found' };

let serveRunResult: { receipt: { at: number; command: string; ok: boolean; url?: string; detail: string }; publicBaseUrlUpdated: boolean } = {
  receipt: { at: 1_700_000_000_000, command: 'tailscale serve --bg 3421', ok: true, url: 'https://my-host.ts.net', detail: 'tailscale serve is fronting port 3421 at https://my-host.ts.net' },
  publicBaseUrlUpdated: true,
};

mock.module('../../lib/goodvibes', () => ({
  // Not called by anything TailscaleSettings renders, but src/lib/queries.ts (imported
  // for queryKeys) statically imports these two names from this module, they must
  // resolve or the import itself fails before any test runs (same gotcha
  // MemoryView.test.tsx documents).
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      tailscale: {
        get: () => Promise.resolve(getData),
        serveRun: () => {
          serveRunCalls.push(null);
          return Promise.resolve(serveRunResult);
        },
      },
    },
  },
}));

const { TailscaleSettings } = await import('./TailscaleSettings');

function render(): { el: HTMLElement; client: QueryClient; unmount: () => void } {
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
          React.createElement(TailscaleSettings),
          React.createElement(ToastViewport),
        ),
      ),
    );
  });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
    client,
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

/** The tailscale status query has answered and nothing is still in flight. */
function statusAnswered(client: QueryClient): boolean {
  return client.getQueryCache().getAll().some((query) => query.state.status === 'success') && client.isFetching() === 0;
}

afterEach(() => {
  serveRunCalls.length = 0;
  getData = { available: false, loggedIn: false, detail: 'tailscale binary not found' };
  serveRunResult = {
    receipt: { at: 1_700_000_000_000, command: 'tailscale serve --bg 3421', ok: true, url: 'https://my-host.ts.net', detail: 'tailscale serve is fronting port 3421 at https://my-host.ts.net' },
    publicBaseUrlUpdated: true,
  };
});

describe('TailscaleSettings: quiet when absent', () => {
  test('renders nothing while pending', () => {
    const { el, unmount } = render();
    // Synchronous first paint: the query is still pending.
    expect(el.querySelector('[data-testid="tailscale-settings"]')).toBeNull();
    unmount();
  });

  test('tailscale not found: renders nothing, no nag, no dead button', async () => {
    getData = { available: false, loggedIn: false, detail: 'tailscale binary not found' };
    const { el, client, unmount } = render();
    await waitFor(() => statusAnswered(client));
    flushSync(() => {});
    expect(el.querySelector('[data-testid="tailscale-settings"]')).toBeNull();
    unmount();
  });

  test('installed but not logged in: still renders nothing', async () => {
    getData = { available: true, loggedIn: false, detail: 'tailscale is installed but not connected (state: Stopped)' };
    const { el, client, unmount } = render();
    await waitFor(() => statusAnswered(client));
    flushSync(() => {});
    expect(el.querySelector('[data-testid="tailscale-settings"]')).toBeNull();
    unmount();
  });
});

describe('TailscaleSettings: usable environment', () => {
  test('renders the panel with the MagicDNS name and the one action', async () => {
    getData = { available: true, loggedIn: true, magicDnsName: 'my-host.tailnet.ts.net', httpsUrl: 'https://my-host.tailnet.ts.net', detail: 'tailscale is connected as my-host.tailnet.ts.net' };
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="tailscale-settings"]')));
    expect(el.textContent).toContain('my-host.tailnet.ts.net');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Serve over tailscale'))).toBe(true);
    unmount();
  });

  test('confirming the action calls serveRun and renders the success receipt', async () => {
    getData = { available: true, loggedIn: true, magicDnsName: 'my-host.tailnet.ts.net', httpsUrl: 'https://my-host.tailnet.ts.net', detail: 'connected' };
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="tailscale-settings"]')));
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Serve over tailscale')));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    click(el.querySelector('.gv-confirm__confirm'));
    await waitFor(() => serveRunCalls.length > 0);
    await waitFor(() => (el.textContent ?? '').includes('https://my-host.ts.net'));
    unmount();
  });

  test('cancelling the confirm sheet never calls serveRun', async () => {
    getData = { available: true, loggedIn: true, magicDnsName: 'my-host.tailnet.ts.net', httpsUrl: 'https://my-host.tailnet.ts.net', detail: 'connected' };
    const { el, client, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="tailscale-settings"]')));
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Serve over tailscale')));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    click(el.querySelector('.gv-confirm__cancel'));
    // The sheet closes as ask() resolves false. The handler resumes after that
    // await on a microtask, and a serve mutation would reach the SDK on further
    // microtasks, so one real event-loop turn after the close lets all of it run.
    await waitFor(() => !el.querySelector('.gv-confirm'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(serveRunCalls).toHaveLength(0);
    unmount();
  });

  test('a failed serve renders the daemon\'s own receipt detail, not a generic error', async () => {
    getData = { available: true, loggedIn: true, magicDnsName: 'my-host.tailnet.ts.net', httpsUrl: 'https://my-host.tailnet.ts.net', detail: 'connected' };
    serveRunResult = {
      receipt: { at: 1_700_000_000_000, command: 'tailscale serve --bg 3421', ok: false, detail: 'tailscale serve failed: permission denied' },
      publicBaseUrlUpdated: false,
    };
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="tailscale-settings"]')));
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Serve over tailscale')));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    click(el.querySelector('.gv-confirm__confirm'));
    await waitFor(() => (el.textContent ?? '').includes('permission denied'));
    unmount();
  });

  test('a prior receipt (lastServe) renders on load, and the action stays offered', async () => {
    getData = {
      available: true,
      loggedIn: true,
      magicDnsName: 'my-host.tailnet.ts.net',
      httpsUrl: 'https://my-host.tailnet.ts.net',
      detail: 'connected',
      lastServe: { at: 1_700_000_000_000, command: 'tailscale serve --bg 3421', ok: true, url: 'https://served.example.ts.net', detail: 'serving' },
    };
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('a[href="https://served.example.ts.net"]')));
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Serve over tailscale'))).toBe(true);
    unmount();
  });
});
