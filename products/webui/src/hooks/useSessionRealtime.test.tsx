/**
 * useSessionRealtime, the live-updates BLOCKER regression test.
 *
 * This is a red-if-broken test: it feeds a RAW SSE frame named `session-update` (the
 * un-domained wire event) and asserts queryKeys.sessions is invalidated. Against the
 * pre-W2B code, which bound domain('session') 'SESSION_UPDATED' through viaSse(), whose
 * per-domain filter drops the un-domained frame, this path never fired. The companion
 * negative test documents the dead path: a frame named 'session' carrying a payload
 * `{type:'SESSION_UPDATED'}` must NOT be relied on to invalidate.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

// Capture what the hook opens and the handlers it registers.
let capturedHandlers: ServerSentEventHandlers | null = null;
const openCalls: string[] = [];

mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
  // queries.ts (transitively imported) binds these named exports at load time, so the
  // mock must provide them even though this test never invokes them.
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    streams: {
      open: (pathOrUrl: string, handlers: ServerSentEventHandlers) => {
        openCalls.push(pathOrUrl);
        capturedHandlers = handlers;
        return Promise.resolve(() => {});
      },
    },
  },
}));

const { useSessionRealtime, sessionIdFromUpdateFrame, updateEventName } = await import('./useSessionRealtime');

function renderHook(): { client: QueryClient; invalidate: ReturnType<typeof mock>; unmount: () => void } {
  const client = new QueryClient();
  const invalidate = mock(() => Promise.resolve());
  // Spy on invalidation without triggering real refetches.
  (client as unknown as { invalidateQueries: unknown }).invalidateQueries = invalidate;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    useSessionRealtime(true);
    return null;
  }

  flushSync(() => {
    root.render(
      React.createElement(QueryClientProvider, { client }, React.createElement(Harness)),
    );
  });

  return {
    client,
    invalidate,
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

afterEach(() => {
  capturedHandlers = null;
  openCalls.length = 0;
});

describe('useSessionRealtime', () => {
  test('opens the un-domained control-plane events stream, not a per-domain viaSse feed', () => {
    const { unmount } = renderHook();
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toContain('/api/control-plane/events');
    expect(openCalls[0]).toContain('domains=session');
    unmount();
  });

  test('a raw `session-update` frame INVALIDATES queryKeys.sessions (the fix)', () => {
    const { invalidate, unmount } = renderHook();
    expect(capturedHandlers).not.toBeNull();

    capturedHandlers?.onEvent?.('session-update', { event: 'session-created', payload: { sessionId: 's1' } });

    expect(invalidate).toHaveBeenCalled();
    const arg = invalidate.mock.calls[0][0] as { queryKey: unknown };
    expect(arg.queryKey).toEqual(['sessions']);
    unmount();
  });

  test('every lifecycle intent (created/updated/steered/closed) invalidates', () => {
    const { invalidate, unmount } = renderHook();
    for (const event of ['session-created', 'session-message-appended', 'session-input-delivered', 'session-closed']) {
      capturedHandlers?.onEvent?.('session-update', { event, payload: { sessionId: 's1' } });
    }
    expect(invalidate.mock.calls.length).toBe(4);
    unmount();
  });

  test('an UNKNOWN future wire event still invalidates defensively (never dropped)', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('session-update', { event: 'session-teleported', payload: {} });
    expect(invalidate).toHaveBeenCalled();
    unmount();
  });

  test('NEGATIVE: a frame named "session" (the dead viaSse path) is NOT relied on', () => {
    const { invalidate, unmount } = renderHook();
    // This is exactly what the old domain('session') binding assumed, a 'session'
    // event carrying a 'SESSION_UPDATED' type. The raw stream must ignore it.
    capturedHandlers?.onEvent?.('session', { type: 'SESSION_UPDATED', payload: { sessionId: 's1' } });
    expect(invalidate).not.toHaveBeenCalled();
    unmount();
  });

  test('non-session event names are ignored', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('heartbeat', {});
    capturedHandlers?.onEvent?.('turn-started', {});
    expect(invalidate).not.toHaveBeenCalled();
    unmount();
  });

  test('sessionIdFromUpdateFrame reads the id off the inner payload', () => {
    expect(sessionIdFromUpdateFrame({ event: 'session-created', payload: { sessionId: 's9' } })).toBe('s9');
    expect(sessionIdFromUpdateFrame({ payload: { session: { id: 's7' } } })).toBe('s7');
    expect(sessionIdFromUpdateFrame({})).toBe('');
  });

  test('updateEventName reads the discriminant', () => {
    expect(updateEventName({ event: 'session-closed' })).toBe('session-closed');
    expect(updateEventName({})).toBe('');
  });
});
