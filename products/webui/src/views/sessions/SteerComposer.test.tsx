/**
 * SteerComposer, SESSION_CLOSED honesty.
 *
 * Before this fix, a steer/follow-up that raced a session close got a 409
 * SESSION_CLOSED reply that only marked the local dispatch entry "failed", the
 * sessions query was never invalidated, so the chrome (status badge, composer
 * enablement) kept reading the session as live and the user could keep firing 409s.
 * This test drives the mutation to reject with the daemon's real wire shape
 * (`code: 'SESSION_CLOSED'`, matching runtime-session-routes.ts / session-broker.ts)
 * and asserts: (1) queryKeys.sessions gets invalidated, and (2) the rendered error is
 * plain wording, not the raw formatError dump (which may embed a session id).
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let rejectNextSteerAsClosed = false;
let rejectNextSteerAsOtherError = false;

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      sessions: {
        steer: (id: string) => {
          if (rejectNextSteerAsClosed) {
            rejectNextSteerAsClosed = false;
            // The real wire shape (session-broker.ts / runtime-session-routes.ts):
            // `Object.assign(new Error('Session is closed: ' + id), { code: 'SESSION_CLOSED', status: 409 })`.
            return Promise.reject(Object.assign(new Error(`Session is closed: ${id}`), {
              code: 'SESSION_CLOSED',
              status: 409,
            }));
          }
          if (rejectNextSteerAsOtherError) {
            rejectNextSteerAsOtherError = false;
            return Promise.reject(Object.assign(new Error('Rate limited'), { code: 'RATE_LIMITED', status: 429 }));
          }
          return Promise.resolve({});
        },
        followUp: () => Promise.resolve({}),
      },
    },
  },
}));

const { SteerComposer } = await import('./SteerComposer');
const { queryKeys } = await import('../../lib/queries');

function render(): { container: HTMLElement; client: QueryClient; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the sessions query so we can observe whether it gets invalidated
  // (an active query with data refetches on invalidateQueries).
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SteerComposer, { sessionId: 's-agent', canSteer: true, closed: false }),
    ));
  });
  return {
    container,
    client,
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

async function typeAndSubmit(container: HTMLElement, value: string) {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  const form = container.querySelector('form') as HTMLFormElement;
  flushSync(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  flushSync(() => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  rejectNextSteerAsClosed = false;
  rejectNextSteerAsOtherError = false;
});

describe('SteerComposer: SESSION_CLOSED honesty', () => {
  test('a 409 SESSION_CLOSED reply invalidates queryKeys.sessions', async () => {
    rejectNextSteerAsClosed = true;
    const { container, client, unmount } = render();
    client.setQueryData(queryKeys.sessions, { totals: { sessions: 1 }, sessions: [] });

    await typeAndSubmit(container, 'Focus on the failing test');

    const state = client.getQueryState(queryKeys.sessions);
    expect(state?.isInvalidated).toBe(true);
    unmount();
  });

  test('a 409 SESSION_CLOSED reply never leaks the raw daemon message', async () => {
    rejectNextSteerAsClosed = true;
    const { container, unmount } = render();

    await typeAndSubmit(container, 'Focus on the failing test');

    // The raw daemon message embeds the session id, must not leak into the UI copy.
    expect(container.textContent).not.toContain('Session is closed: s-agent');
    expect(container.textContent).not.toContain('HTTP 409');
    unmount();
  });

  test('a non-SESSION_CLOSED error keeps the existing raw formatError behavior', async () => {
    rejectNextSteerAsOtherError = true;
    const { container, client, unmount } = render();
    client.setQueryData(queryKeys.sessions, { totals: { sessions: 1 }, sessions: [] });

    await typeAndSubmit(container, 'Focus on the failing test');

    expect(container.textContent).toContain('Rate limited');
    const state = client.getQueryState(queryKeys.sessions);
    expect(state?.isInvalidated).toBe(false);
    unmount();
  });
});
