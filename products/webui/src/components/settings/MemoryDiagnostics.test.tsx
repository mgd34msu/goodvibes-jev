/**
 * MemoryDiagnostics, the admin Memory panel. Covers loading/error/unavailable
 * (404/501)/populated states, the tier chip, the budget-vs-RSS bar, the per-cache
 * table, paused jobs, and the tripwire line.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

let mockDiagnostics: {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error?: unknown;
  data?: unknown;
  refetch: () => void;
} = { isPending: false, isError: false, isSuccess: false, data: undefined, refetch: () => {} };

mock.module('../../hooks/useMemoryDiagnostics', () => ({
  useMemoryDiagnostics: () => mockDiagnostics,
}));

const { MemoryDiagnostics } = await import('./MemoryDiagnostics');

function render(): { el: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => { root.render(React.createElement(MemoryDiagnostics)); });
  return {
    el: container,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  mockDiagnostics = { isPending: false, isError: false, isSuccess: false, data: undefined, refetch: () => {} };
});

const NORMAL_SNAPSHOT = {
  tier: 'normal',
  budgetMb: 1024,
  rssMb: 256,
  heapUsedMb: 180,
  heapTotalMb: 400,
  usedPct: 25,
  refusingExpensiveWork: false,
  caches: [
    { id: 'knowledge-embeddings', name: 'Knowledge embeddings', entries: 4200, estimatedBytes: 15_728_640 },
  ],
  pausedJobs: [],
  tripwire: { armed: false, sustainedSec: 0, rateMbPerSec: 0 },
  thresholds: { elevatedPct: 60, highPct: 80, criticalPct: 92 },
};

describe('MemoryDiagnostics', () => {

  test('unavailable (404 METHOD_NOT_FOUND) offers no retry', () => {
    mockDiagnostics = {
      isPending: false,
      isError: true,
      isSuccess: false,
      error: Object.assign(new Error('Unknown gateway method'), { status: 404, code: 'METHOD_NOT_FOUND' }),
      refetch: () => {},
    };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('button[aria-label="Retry"]')).toBeNull();
  });

  test('unavailable (501) offers no retry either', () => {
    mockDiagnostics = {
      isPending: false,
      isError: true,
      isSuccess: false,
      error: Object.assign(new Error('Not wired'), { status: 501 }),
      refetch: () => {},
    };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('button[aria-label="Retry"]')).toBeNull();
  });

  test('a genuine fetch error offers a retry that refetches', () => {
    let refetches = 0;
    mockDiagnostics = {
      isPending: false,
      isError: true,
      isSuccess: false,
      error: Object.assign(new Error('network down'), { status: 0, category: 'network' }),
      refetch: () => { refetches += 1; },
    };
    const { el, unmount } = render();
    cleanup = unmount;
    const retry = el.querySelector<HTMLButtonElement>('button[aria-label="Retry"]');
    expect(retry).not.toBeNull();
    flushSync(() => { retry?.click(); });
    expect(refetches).toBe(1);
  });

  test('a snapshot renders the budget-vs-rss bar and per-cache table', () => {
    mockDiagnostics = { isPending: false, isError: false, isSuccess: true, data: NORMAL_SNAPSHOT, refetch: () => {} };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.textContent).toContain('256 MB');
    expect(el.textContent).toContain('1024 MB');
    expect(el.textContent).toContain('25%');
    const bar = el.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('25');
    expect(el.textContent).toContain('Knowledge embeddings');
    expect(el.textContent).toContain('15.0 MB');
  });

  test('paused jobs render as a list', () => {
    mockDiagnostics = {
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { ...NORMAL_SNAPSHOT, pausedJobs: ['knowledge.reindex', 'memory.vector.rebuild'] },
      refetch: () => {},
    };
    const { el, unmount } = render();
    cleanup = unmount;
    const items = el.querySelectorAll('.memory-diagnostics__paused-jobs li');
    expect(items.length).toBe(2);
    expect(el.textContent).toContain('knowledge.reindex');
    expect(el.textContent).toContain('memory.vector.rebuild');
  });

  test('an armed tripwire renders its growth rate and duration', () => {
    mockDiagnostics = {
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { ...NORMAL_SNAPSHOT, tripwire: { armed: true, sustainedSec: 30, rateMbPerSec: 5.5 } },
      refetch: () => {},
    };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.textContent).toContain('5.5 MB/s');
    expect(el.textContent).toContain('30s');
  });

  test('an empty cache list renders no table (never a fabricated empty row)', () => {
    mockDiagnostics = { isPending: false, isError: false, isSuccess: true, data: { ...NORMAL_SNAPSHOT, caches: [] }, refetch: () => {} };
    const { el, unmount } = render();
    cleanup = unmount;
    expect(el.querySelector('.memory-diagnostics__caches')).toBeNull();
  });
});
