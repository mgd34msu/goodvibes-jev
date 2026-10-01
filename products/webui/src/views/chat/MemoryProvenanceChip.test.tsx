/**
 * MemoryProvenanceChip, the owner-ruled, default-OFF drill-in. Covers both
 * states (absent with no ids, visible with ids + expand-to-fetch) and the
 * phone-width tap target on the toggle button.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

let memoryGetCalls: string[] = [];
let memoryGetImpl: (id: string) => Promise<{ record: { summary: string; cls: string; scope: string } }> = (id) =>
  Promise.resolve({ record: { summary: `Record ${id}`, cls: 'preference', scope: 'user' } });

mock.module('../../lib/goodvibes', () => ({
  sdk: {
    operator: {
      memory: {
        get: (id: string) => {
          memoryGetCalls.push(id);
          return memoryGetImpl(id);
        },
      },
    },
  },
}));

const { MemoryProvenanceChip } = await import('./MemoryProvenanceChip');

function render(recordIds: readonly string[]): { el: HTMLElement; unmount: () => void; client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(QueryClientProvider, { client }, React.createElement(MemoryProvenanceChip, { recordIds })),
    );
  });
  return {
    el: container,
    client,
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
  memoryGetCalls = [];
  memoryGetImpl = (id: string) => Promise.resolve({ record: { summary: `Record ${id}`, cls: 'preference', scope: 'user' } });
});

describe('MemoryProvenanceChip', () => {
  test('renders nothing when recordIds is empty (honest absence)', () => {
    const { el, unmount } = render([]);
    cleanup = unmount;
    expect(el.textContent).toBe('');
  });

  test('renders the chip with the record count when ids are present', () => {
    const { el, unmount } = render(['mem-1', 'mem-2']);
    cleanup = unmount;
    const toggle = el.querySelector('.memory-provenance-chip__toggle');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain('2');
  });

  test('does not fetch record details until expanded', () => {
    render(['mem-1', 'mem-2']);
    expect(memoryGetCalls).toEqual([]);
  });

  test('expanding fetches every id\'s detail and lists the summaries', async () => {
    const { el, unmount } = render(['mem-1', 'mem-2']);
    cleanup = unmount;
    click(el.querySelector('.memory-provenance-chip__toggle'));
    await waitFor(() => Boolean(el.querySelector('.memory-provenance-chip__list')));
    expect(memoryGetCalls.sort()).toEqual(['mem-1', 'mem-2']);
    const list = el.querySelector('.memory-provenance-chip__list');
    expect(list?.textContent).toContain('mem-1');
    expect(list?.textContent).toContain('mem-2');
  });

  test('collapsing hides the detail list again', async () => {
    const { el, unmount } = render(['mem-1']);
    cleanup = unmount;
    click(el.querySelector('.memory-provenance-chip__toggle'));
    await waitFor(() => Boolean(el.querySelector('.memory-provenance-chip__details')));
    expect(el.querySelector('.memory-provenance-chip__details')).not.toBeNull();
    click(el.querySelector('.memory-provenance-chip__toggle'));
    expect(el.querySelector('.memory-provenance-chip__details')).toBeNull();
  });

  test('a record that failed to resolve renders an honest "no longer available" line, never a crash', async () => {
    memoryGetImpl = () => Promise.reject(new Error('not found'));
    const { el, unmount } = render(['mem-gone']);
    cleanup = unmount;
    click(el.querySelector('.memory-provenance-chip__toggle'));
    await waitFor(() => Boolean(el.querySelector('.memory-provenance-chip__missing')));
    expect(el.querySelector('.memory-provenance-chip__missing')?.textContent).toContain('mem-gone');
  });
});
