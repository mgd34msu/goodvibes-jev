/** Shared helpers for the Library view tests (render, click, waitFor, record fixtures). */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export interface FakeRecord {
  id: string;
  scope: string;
  cls: string;
  summary: string;
  detail?: string;
  tags: string[];
  provenance: { kind: string; ref: string; label?: string }[];
  reviewState: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export function fakeRecord(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    id: 'r1',
    scope: 'project',
    cls: 'fact',
    summary: 'The daemon is the single writer for the memory store',
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 82,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function searchResult(records: FakeRecord[] = []) {
  return {
    records,
    mode: 'literal' as const,
    requestedSemantic: false,
    indexUnavailableReason: null,
    caveat: null,
    recallFiltered: false,
    excludedFlaggedCount: 0,
    excludedBelowFloorCount: 0,
    totalBeforeRecallFilter: records.length,
    recallFloor: 60,
  };
}

export function renderInto(element: React.ReactElement): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, element));
  });
  return {
    // document.body: detail peeks are kit Drawers portaled there.
    el: document.body,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

export function click(el: Element | null | undefined): void {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => { /* flush the renders the tick scheduled */ });
  }
}
