/**
 * useRealtimeInvalidation, the connection-budget regression test.
 *
 * The bug this pins: the hook used to open ONE SSE connection PER domain (five of them)
 * via sdk.realtime.viaSse(). Together with useSessionRealtime's own stream that reached
 * six long-lived connections and saturated the browser's per-origin socket pool, so the
 * next fetch (SessionsView's sessions.list) hung forever and the Sessions view rendered
 * zero rows. The fix opens a SINGLE multiplexed raw stream (?domains=a,b,c) and routes by
 * the frame's event name (the domain). These tests assert exactly ONE stream is opened,
 * that it carries every invalidated domain, and that each domain frame invalidates the
 * right query keys.
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

const { useRealtimeInvalidation } = await import('./useRealtimeInvalidation');

interface HookHandle {
  invalidate: ReturnType<typeof mock>;
  unmount: () => void;
  rerender: (enabled: boolean) => void;
  getError: () => string | null;
}

function renderHook(initialEnabled = true): HookHandle {
  const client = new QueryClient();
  const invalidate = mock(() => Promise.resolve());
  (client as unknown as { invalidateQueries: unknown }).invalidateQueries = invalidate;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  let latestError: string | null = null;
  function Harness({ enabled }: { enabled: boolean }) {
    latestError = useRealtimeInvalidation(enabled);
    return null;
  }

  const doRender = (enabled: boolean) => {
    flushSync(() => {
      root.render(
        React.createElement(QueryClientProvider, { client }, React.createElement(Harness, { enabled })),
      );
    });
  };

  doRender(initialEnabled);

  return {
    invalidate,
    getError: () => latestError,
    rerender: (enabled: boolean) => doRender(enabled),
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

function invalidatedKeys(invalidate: ReturnType<typeof mock>): unknown[] {
  return invalidate.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey);
}

afterEach(() => {
  capturedHandlers = null;
  openCalls.length = 0;
});

describe('useRealtimeInvalidation', () => {
  test('opens EXACTLY ONE multiplexed control-plane stream, not one per domain', () => {
    const { unmount } = renderHook();
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toContain('/api/control-plane/events');
    // Every invalidated domain rides the single stream.
    for (const domain of ['tasks', 'gate', 'providers', 'knowledge', 'control-plane', 'fleet', 'contracts']) {
      expect(openCalls[0]).toContain(domain);
    }
    unmount();
  });

  test('a contracts frame invalidates the scoped list and detail prefix', async () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('contracts', { type: 'CONTRACT_PASSED', contractId: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invalidatedKeys(invalidate)).toEqual([['contracts']]);
    unmount();
  });

  test('a `tasks` domain frame invalidates the tasks query', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('tasks', { payload: { type: 'TASK_UPDATED' } });
    expect(invalidatedKeys(invalidate)).toEqual([['tasks']]);
    unmount();
  });

  test('a `permissions` frame invalidates approvals, the sessions prefix, AND durable rules; `providers` invalidates providers', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('gate', {});
    capturedHandlers?.onEvent?.('providers', {});
    // The broad 'sessions' prefix is included (not 'config') because
    // PERMISSION_MODE_CHANGED rides the same 'gate' domain, carries no
    // sessionId, and the session-scoped permission-mode/context-usage queries are
    // prefixed with 'sessions' (queries.ts), see useRealtimeInvalidation.ts's
    // DOMAIN_INVALIDATIONS comment.
    expect(invalidatedKeys(invalidate)).toEqual([['approvals'], ['sessions'], ['permissions', 'rules'], ['providers']]);
    unmount();
  });

  test('a `knowledge` frame invalidates all three knowledge query keys', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('knowledge', {});
    expect(invalidatedKeys(invalidate)).toEqual([
      ['knowledge', 'status'],
      ['knowledge', 'sources'],
      ['knowledge', 'refinement'],
    ]);
    unmount();
  });

  test('a `control-plane` frame invalidates the control snapshot', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('control-plane', {});
    expect(invalidatedKeys(invalidate)).toEqual([['control', 'snapshot']]);
    unmount();
  });

  test('a `fleet` frame (a FLEET_NODE_* delta) invalidates the live snapshot AND the archive', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('fleet', { payload: { type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'agent-7' } });
    expect(invalidatedKeys(invalidate)).toEqual([['fleet'], ['fleet', 'archived']]);
    unmount();
  });

  test('an `ops` frame (OPS_POWER_STATE_CHANGED) invalidates the power AND memory-diagnostics queries', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('ops', { payload: { type: 'OPS_POWER_STATE_CHANGED', inhibited: true, keepAwake: true, workReasons: [] } });
    expect(invalidatedKeys(invalidate)).toEqual([['power', 'status'], ['ops', 'memory']]);
    unmount();
  });

  test('an `ops` frame (OPS_MEMORY_PRESSURE) invalidates the SAME two queries, one domain, no separate event feed', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('ops', { payload: { type: 'OPS_MEMORY_PRESSURE', tier: 'high', previousTier: 'elevated', rssMb: 900, heapMb: 400, budgetMb: 1024, usedPct: 88 } });
    expect(invalidatedKeys(invalidate)).toEqual([['power', 'status'], ['ops', 'memory']]);
    unmount();
  });

  test('an unknown domain frame is ignored (no invalidation)', () => {
    const { invalidate, unmount } = renderHook();
    capturedHandlers?.onEvent?.('session', {});
    capturedHandlers?.onEvent?.('heartbeat', {});
    expect(invalidate).not.toHaveBeenCalled();
    unmount();
  });

  // ---- Finding 1 (HIGH): auth-gated open, re-open on login, no raw JSON in the banner.

  test('does NOT open the stream when disabled (signed-out: enabled=false)', () => {
    const { unmount } = renderHook(false);
    // Pre-auth the app mounts signed-out; opening the stream with no token just 401s.
    // Gating on auth means no open happens at all until authenticated.
    expect(openCalls.length).toBe(0);
    unmount();
  });

  test('re-opens the stream when enabled flips false → true (sign-in transition)', () => {
    const handle = renderHook(false);
    expect(openCalls.length).toBe(0);
    // The paste-token sign-in flips the auth gate to true; the effect must re-run and
    // open the stream, the exact recovery the old unconditional-enable code never did.
    handle.rerender(true);
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toContain('/api/control-plane/events');
    handle.unmount();
  });

  test('a transport error body (raw 401 JSON) NEVER reaches the returned banner string', () => {
    const handle = renderHook(true);
    // The SSE transport sets err.message to the daemon's RAW response body on a pre-auth
    // open. Feed exactly that blob and assert the hook does not surface it.
    const rawBody =
      '{"error":"Authentication required","hint":"Authenticate first.","code":"AUTH_REQUIRED",'
      + '"category":"authentication","source":"runtime","recoverable":false,"status":401}';
    flushSync(() => {
      capturedHandlers?.onError?.(new Error(rawBody));
    });
    const banner = handle.getError();
    expect(banner).not.toBeNull();
    expect(banner).not.toContain('AUTH_REQUIRED');
    expect(banner).not.toContain('{');
    handle.unmount();
  });
});
