/**
 * useCompactionReceipts, scoped-to-one-session compaction stream.
 *
 * Mirrors useSessionRealtime.test.tsx's harness (mock sdk.streams.open, capture
 * the registered handlers, drive them by hand) since this hook follows the same
 * raw-stream-escape-hatch pattern rather than the invalidate-only viaSse facade.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ServerSentEventHandlers } from '@goodvibes-jev/engine/transport-http';

let capturedHandlers: ServerSentEventHandlers | null = null;
const openCalls: string[] = [];

mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, backoffFactor: 2, maxAttempts: 3 },
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

const { useCompactionReceipts } = await import('./useCompactionReceipts');

let latestState: ReturnType<typeof useCompactionReceipts> | null = null;

function renderHook(sessionId: string, enabled = true): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness({ id, on }: { id: string; on: boolean }) {
    latestState = useCompactionReceipts(id, on);
    return null;
  }

  flushSync(() => {
    root.render(React.createElement(Harness, { id: sessionId, on: enabled }));
  });

  return {
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

/** Fire a frame and flush the resulting setState synchronously so latestState
 *  reflects it before the assertion, onEvent() is called directly from test
 *  code, outside React's own event system, so automatic batching would
 *  otherwise defer the re-render past this function's return. */
function fireEvent(eventName: string, payload: unknown): void {
  flushSync(() => {
    capturedHandlers?.onEvent?.(eventName, payload);
  });
}

afterEach(() => {
  capturedHandlers = null;
  openCalls.length = 0;
  latestState = null;
});

describe('useCompactionReceipts', () => {
  test('opens the raw control-plane stream scoped to the compaction domain', () => {
    const { unmount } = renderHook('s-1');
    expect(openCalls.length).toBe(1);
    expect(openCalls[0]).toContain('/api/control-plane/events');
    expect(openCalls[0]).toContain('domains=compaction');
    unmount();
  });

  test('does not open a stream when disabled or sessionId is empty', () => {
    const { unmount } = renderHook('', true);
    expect(openCalls.length).toBe(0);
    unmount();
  });

  test('a COMPACTION_RECEIPT frame for this session is captured', () => {
    const { unmount } = renderHook('s-1');
    fireEvent('compaction', {
      type: 'COMPACTION_RECEIPT',
      sessionId: 's-1',
      trigger: 'auto',
      strategy: 'summarize-oldest',
      tokensBefore: 100,
      tokensAfter: 20,
      messagesBefore: 10,
      messagesAfter: 2,
      qualityScore: 0.9,
      qualityGrade: 'A',
      lowQuality: false,
      instructionsReinjected: true,
      validationPassed: true,
      outcome: 'applied',
    });
    expect(latestState?.receipts.length).toBe(1);
    expect(latestState?.receipts[0]?.sessionId).toBe('s-1');
    unmount();
  });

  test('a receipt for a DIFFERENT session is ignored; the domain is daemon-wide', () => {
    const { unmount } = renderHook('s-1');
    fireEvent('compaction', {
      type: 'COMPACTION_RECEIPT',
      sessionId: 's-OTHER',
      trigger: 'auto',
      strategy: 'x',
      tokensBefore: 1,
      tokensAfter: 1,
      messagesBefore: 1,
      messagesAfter: 1,
      qualityScore: 1,
      qualityGrade: 'A',
      lowQuality: false,
      instructionsReinjected: false,
      validationPassed: true,
      outcome: 'applied',
    });
    expect(latestState?.receipts.length).toBe(0);
    unmount();
  });

  test('a COMPACTION_CHECK frame for this session updates latestCheck', () => {
    const { unmount } = renderHook('s-1');
    fireEvent('compaction', { type: 'COMPACTION_CHECK', sessionId: 's-1', tokenCount: 50, threshold: 100 });
    expect(latestState?.latestCheck?.tokenCount).toBe(50);
    expect(latestState?.latestCheck?.threshold).toBe(100);
    unmount();
  });

  test('a frame on a non-compaction event name is ignored', () => {
    const { unmount } = renderHook('s-1');
    fireEvent('permissions', { type: 'COMPACTION_RECEIPT', sessionId: 's-1' });
    expect(latestState?.receipts.length).toBe(0);
    unmount();
  });

  test('receipts are capped at 20. An honest live log, not an unbounded leak', () => {
    const { unmount } = renderHook('s-1');
    for (let i = 0; i < 25; i += 1) {
      fireEvent('compaction', {
        type: 'COMPACTION_RECEIPT',
        sessionId: 's-1',
        trigger: 'auto',
        strategy: `strategy-${i}`,
        tokensBefore: 1,
        tokensAfter: 1,
        messagesBefore: 1,
        messagesAfter: 1,
        qualityScore: 1,
        qualityGrade: 'A',
        lowQuality: false,
        instructionsReinjected: false,
        validationPassed: true,
        outcome: 'applied',
      });
    }
    expect(latestState?.receipts.length).toBe(20);
    expect(latestState?.receipts.at(-1)?.strategy).toBe('strategy-24');
    unmount();
  });
});
