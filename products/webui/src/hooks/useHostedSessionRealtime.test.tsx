/**
 * useHostedSessionRealtime, one raw stream for hosted-session list liveness
 * (`hosted-session-update`, invalidates the list unconditionally) and, when
 * attached, the LIVE `turn`/`tools` output filtered to that session's id.
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

const { useHostedSessionRealtime } = await import('./useHostedSessionRealtime');
type StreamFrame = import('../lib/hosted-session-stream').HostedStreamFrame;

function renderHook(attachedSessionId: string | null = null): {
  invalidate: ReturnType<typeof mock>;
  frames: StreamFrame[];
  lifecycleUpdates: unknown[];
  unmount: () => void;
} {
  const client = new QueryClient();
  const invalidate = mock(() => Promise.resolve());
  (client as unknown as { invalidateQueries: unknown }).invalidateQueries = invalidate;

  const frames: StreamFrame[] = [];
  const lifecycleUpdates: unknown[] = [];

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    useHostedSessionRealtime({
      enabled: true,
      attachedSessionId,
      onStreamFrame: (frame) => frames.push(frame),
      onLifecycleUpdate: (payload) => lifecycleUpdates.push(payload),
    });
    return null;
  }

  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Harness)));
  });

  return {
    invalidate,
    frames,
    lifecycleUpdates,
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

describe('useHostedSessionRealtime', () => {
  test('opens one stream narrowed to session, turn and tools', () => {
    const { unmount } = renderHook();
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toBe('/api/control-plane/events?domains=session,turn,tools');
    unmount();
  });

  test('a hosted-session-update frame always invalidates the hosted sessions list', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('hosted-session-update', {
      event: 'hosted-session-created',
      session: { id: 'hosted-1' },
      createdAt: 1,
    });
    expect(invalidate).toHaveBeenCalled();
    const arg = invalidate.mock.calls[0][0] as { queryKey: unknown };
    expect(arg.queryKey).toEqual(['hosted-sessions']);
    unmount();
  });

  test('a hosted-session-update for the attached session also calls onLifecycleUpdate', () => {
    const { lifecycleUpdates, unmount } = renderHook('hosted-1');
    const payload = { event: 'hosted-session-turn-ended', session: { id: 'hosted-1' }, createdAt: 1 };
    capturedHandlers?.onEvent?.('hosted-session-update', payload);
    expect(lifecycleUpdates).toEqual([payload]);
    unmount();
  });

  test('a hosted-session-update for a DIFFERENT session does not call onLifecycleUpdate', () => {
    const { lifecycleUpdates, unmount } = renderHook('hosted-1');
    capturedHandlers?.onEvent?.('hosted-session-update', { event: 'hosted-session-terminated', session: { id: 'hosted-other' }, createdAt: 1 });
    expect(lifecycleUpdates).toEqual([]);
    unmount();
  });

  test('turn/tools frames are forwarded only when attached and the sessionId matches', () => {
    const { frames, unmount } = renderHook('hosted-1');
    // Matching session: forwarded.
    capturedHandlers?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: { accumulated: 'hi' } });
    // Different session: dropped.
    capturedHandlers?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-other', payload: { accumulated: 'nope' } });
    expect(frames.length).toBe(1);
    expect(frames[0].sessionId).toBe('hosted-1');
    unmount();
  });

  test('turn/tools frames are dropped entirely when nothing is attached', () => {
    const { frames, unmount } = renderHook(null);
    capturedHandlers?.onEvent?.('turn', { type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: { accumulated: 'hi' } });
    expect(frames.length).toBe(0);
    unmount();
  });
});
