/**
 * KnowledgeJobsPeek, the "View jobs" detail behind the W8 activity states.
 * Covers the previously-never-called knowledge.jobs.list / job-runs.list.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let invokeImpl: (method: string, input?: unknown) => Promise<unknown> = () => Promise.resolve({});

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: (method: string, input?: unknown) => invokeImpl(method, input),
  sdk: {},
}));

const { KnowledgeJobsPeekBody } = await import('./KnowledgeJobsPeek');

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(QueryClientProvider, { client }, React.createElement(KnowledgeJobsPeekBody)),
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

afterEach(() => {
  invokeImpl = () => Promise.resolve({});
});

describe('KnowledgeJobsPeekBody', () => {

  test('renders run rows with job title, status, and newest-first order', async () => {
    invokeImpl = (method) => Promise.resolve(
      method === 'knowledge.jobs.list'
        ? { jobs: [{ id: 'reindex', kind: 'reindex', title: 'Reindex sources', description: '', defaultMode: 'background', metadata: {} }] }
        : {
          runs: [
            { id: 'run-1', jobId: 'reindex', status: 'completed', mode: 'background', requestedAt: 100, result: {}, metadata: {}, createdAt: 100, updatedAt: 100 },
            { id: 'run-2', jobId: 'reindex', status: 'failed', mode: 'background', requestedAt: 200, error: 'timed out', result: {}, metadata: {}, createdAt: 200, updatedAt: 200 },
          ],
        },
    );
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('Reindex sources'));
    const rows = [...el.querySelectorAll('.knowledge-jobs-peek__row')];
    expect(rows).toHaveLength(2);
    // Newest (requestedAt: 200, failed) sorts first.
    expect(rows[0].textContent).toContain('failed');
    expect(rows[0].textContent).toContain('timed out');
    unmount();
  });

  test('a query failure offers a retry, not a dead click', async () => {
    invokeImpl = () => Promise.reject(Object.assign(new Error('route not found'), { status: 404 }));
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('button[aria-label="Retry"]')));
    unmount();
  });
});
