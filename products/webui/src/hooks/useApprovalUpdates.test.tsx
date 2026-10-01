/**
 * useApprovalUpdates, the browser-side `control.approval_update` push consumer
 * (see the hook's own header comment for the wire-shape rationale). This test
 * proves the stream is opened at the right path/domain, that an
 * `approval-update` frame invalidates the approvals + permission-rules caches,
 * and that the connected/error state tracks onReady/onTerminate honestly.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

let capturedHandlers: ServerSentEventHandlers | null = null;
const openCalls: string[] = [];

mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
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

const { useApprovalUpdates } = await import('./useApprovalUpdates');

function renderHook(enabled = true): { invalidate: ReturnType<typeof mock>; state: () => { connected: boolean; error: string | null }; unmount: () => void } {
  const client = new QueryClient();
  const invalidate = mock(() => Promise.resolve());
  (client as unknown as { invalidateQueries: unknown }).invalidateQueries = invalidate;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  let latest: { connected: boolean; error: string | null } = { connected: false, error: null };
  function Harness() {
    latest = useApprovalUpdates(enabled);
    return null;
  }

  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Harness)));
  });

  return {
    invalidate,
    state: () => latest,
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

describe('useApprovalUpdates', () => {
  test('opens the control-plane events stream narrowed to the permissions domain', () => {
    const { unmount } = renderHook();
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toBe('/api/control-plane/events?domains=gate');
    unmount();
  });

  test('an approval-update frame invalidates approvals and permission rules', () => {
    const { invalidate, unmount } = renderHook();
    expect(capturedHandlers).not.toBeNull();

    capturedHandlers?.onEvent?.('approval-update', { approval: { id: 'appr-1', status: 'approved' }, createdAt: 1 });

    expect(invalidate.mock.calls.length).toBe(2);
    const keys = invalidate.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(['approvals']);
    expect(keys).toContainEqual(['permissions', 'rules']);
    unmount();
  });

  test('a non-approval-update event name is ignored', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('heartbeat', {});
    capturedHandlers?.onEvent?.('gate', { type: 'PERMISSION_MODE_CHANGED' });
    expect(invalidate).not.toHaveBeenCalled();
    unmount();
  });

  test('onReady flips connected true; onTerminate flips it back false with an error note', () => {
    const { state, unmount } = renderHook();
    expect(state().connected).toBe(false);

    flushSync(() => capturedHandlers?.onReady?.(undefined));
    expect(state().connected).toBe(true);
    expect(state().error).toBeNull();

    flushSync(() => capturedHandlers?.onTerminate?.({ error: null, reconnectAttempts: 0 }));
    expect(state().connected).toBe(false);
    expect(state().error).not.toBeNull();
    unmount();
  });

  test('disabled: never opens a stream', () => {
    const { unmount } = renderHook(false);
    expect(openCalls.length).toBe(0);
    unmount();
  });
});
