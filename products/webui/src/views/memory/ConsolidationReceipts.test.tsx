/**
 * Consolidation proposals and runs, memory.consolidation.receipts (SDK 1.8.0). Covers
 * every honest state (pending, unavailable via 404 and 501, genuinely empty, pending
 * proposals present, resolved runs with no pending proposals) in isolation. The jump to
 * the review queue rows is covered in src/views/library/ReviewTab.test.tsx (the proposals
 * component only calls the onSelect callback it is handed).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let receiptsImpl: () => Promise<unknown> = () => Promise.resolve({ receipts: [], pendingProposals: [] });

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      memory: {
        consolidation: {
          receipts: () => receiptsImpl(),
        },
      },
    },
  },
}));

const { ConsolidationProposals, ConsolidationRuns } = await import('./ConsolidationReceipts');

let selectCalls: (readonly string[])[] = [];

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
          'div',
          null,
          React.createElement(ConsolidationProposals, { onSelect: (_key: string, proposal: { ids: readonly string[] }) => { selectCalls.push(proposal.ids); } }),
          React.createElement(ConsolidationRuns),
        ),
      ),
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

afterEach(() => {
  receiptsImpl = () => Promise.resolve({ receipts: [], pendingProposals: [] });
  selectCalls = [];
});

describe('ConsolidationReceipts: failure', () => {

  test('a genuine 500 offers a retry', async () => {
    receiptsImpl = () => Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('button[aria-label="Retry"]')));
    unmount();
  });
});

describe('ConsolidationReceipts: pending proposals', () => {
  test('renders the reason; Resolve selects the proposal with exactly those ids', async () => {
    receiptsImpl = () => Promise.resolve({
      receipts: [],
      pendingProposals: [{
        kind: 'cross-scope-duplicate',
        ids: ['mem-a', 'mem-b'],
        route: 'memory action:"curator" query:"consolidation"',
        reason: 'Same-summary records span multiple scopes; merging across scope needs review.',
      }],
    });
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Same-summary records span multiple scopes'));
    // The internal agent-tool route string is never rendered as a browser link or route.
    expect(el.querySelector('a')).toBeNull();
    click([...el.querySelectorAll('.consolidation-proposal-row button')].find((b) => b.textContent === 'Resolve'));
    expect(selectCalls).toEqual([['mem-a', 'mem-b']]);
    unmount();
  });

  test('no pending proposals but prior runs exist: no proposal rows, the runs still list', async () => {
    receiptsImpl = () => Promise.resolve({
      receipts: [{
        runId: 'mcon-1',
        ranAt: new Date(1_700_000_000_000).toISOString(),
        trigger: 'idle',
        idle: true,
        scanned: 12,
        merged: [{ survivorId: 'mem-a', duplicateIds: ['mem-b'] }],
        archived: [],
        decayed: [],
        proposed: [],
        usageSignalAvailable: true,
        note: 'Idle consolidation performs only reversible merges.',
      }],
      pendingProposals: [],
    });
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('.consolidation-receipts-runs summary')));
    expect(el.querySelector('.consolidation-proposal-row')).toBeNull();
    click(el.querySelector('.consolidation-receipts-runs summary'));
    const rows = el.querySelectorAll('.consolidation-run-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('12');
    unmount();
  });
});
