/**
 * MailAccountSettings, a read-only status probe, quiet by construction like
 * TailscaleSettings (renders nothing while its two probes are pending, rather than
 * flashing a state it is about to correct), and NEVER a credential form: editing
 * lives in the schema-driven settings modal, which writes through the daemon.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type MailProbeImpl = () => Promise<{ messages: unknown[]; total: number }>;
type CalendarProbeImpl = () => Promise<{ events: unknown[] }>;

let mailProbe: MailProbeImpl = () => Promise.resolve({ messages: [], total: 0 });
let calendarProbe: CalendarProbeImpl = () => Promise.resolve({ events: [] });

mock.module('../../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      email: {
        inbox: {
          list: () => mailProbe(),
        },
      },
      calendar: {
        events: {
          list: () => calendarProbe(),
        },
      },
    },
  },
}));

const { MailAccountSettings } = await import('./MailAccountSettings');

function refusal(status: number, body: unknown): Promise<never> {
  return Promise.reject(Object.assign(new Error(`request failed: ${status}`), { status, body }));
}

function render(): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(QueryClientProvider, { client }, React.createElement(MailAccountSettings)),
    );
  });
  return {
    el: container,
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
  mailProbe = () => Promise.resolve({ messages: [], total: 0 });
  calendarProbe = () => Promise.resolve({ events: [] });
});

describe('MailAccountSettings: quiet by construction', () => {
  test('renders nothing at all while the probes are pending', () => {
    mailProbe = () => new Promise(() => {}); // never resolves within this test
    calendarProbe = () => new Promise(() => {});
    const { el, unmount } = render();
    expect(el.querySelector('[data-testid="mail-account-settings"]')).toBeNull();
    expect(el.textContent).toBe('');
    unmount();
  });
});

describe('MailAccountSettings: status pills', () => {
  test('a surface whose probe resolves reports the ready state', async () => {
    mailProbe = () => Promise.resolve({ messages: [], total: 0 });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-account-settings"]')));
    const row = el.querySelector('[data-testid="mail-surface-status"]');
    expect(row?.getAttribute('data-state')).toBe('ready');
    unmount();
  });

  test('a 501 probe reports the not-available state', async () => {
    mailProbe = () => refusal(501, { error: 'Gateway method is not invokable', code: 'METHOD_NOT_INVOKABLE' });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-account-settings"]')));
    const row = el.querySelector('[data-testid="mail-surface-status"]');
    expect(row?.getAttribute('data-state')).toBe('not-available');
    unmount();
  });
});

describe('MailAccountSettings: credential isolation', () => {
  test('the panel contains no secret input fields: editing lives in the schema-driven settings modal', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[data-testid="mail-account-settings"]')));
    expect(el.querySelector('input[type="password"]')).toBeNull();
    unmount();
  });
});
