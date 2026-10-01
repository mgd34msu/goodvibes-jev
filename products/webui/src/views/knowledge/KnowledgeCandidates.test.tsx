/**
 * Knowledge candidates (knowledge.candidates.list / .candidate.decide): undecided ones
 * are rows, a selected one opens a pane with accept, reject and supersede. Proves the
 * error and populated states render honestly and that a decision sends the right call.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let listImpl: () => Promise<unknown> = () => Promise.resolve({ candidates: [] });
let decideImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ candidate: {} });
const decideCalls: unknown[] = [];

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: (method: string, input?: unknown) => {
    if (method === 'knowledge.candidates.list') return listImpl();
    if (method === 'knowledge.candidate.decide') {
      decideCalls.push(input);
      return decideImpl(input);
    }
    return Promise.resolve({});
  },
  sdk: { operator: { calendar: { events: {}, ics: {} } } },
}));

const { KnowledgeCandidateRows, KnowledgeCandidatePane, parseCandidate } = await import('./KnowledgeCandidates');
const { useKnowledgeCandidates, candidateItems } = await import('../library/library-data');

/** The Review tab's wiring in miniature: rows, and the pane for the selected row. */
function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  const candidates = useKnowledgeCandidates();
  const current = candidateItems(candidates.data).map(parseCandidate).find((c) => c.id === selected);
  return (
    <div>
      <KnowledgeCandidateRows selectedId={selected} onSelect={setSelected} />
      {current && <KnowledgeCandidatePane candidate={current} onClose={() => setSelected(null)} />}
    </div>
  );
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Harness)));
  });
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

afterEach(() => {
  listImpl = () => Promise.resolve({ candidates: [] });
  decideImpl = () => Promise.resolve({ candidate: {} });
  decideCalls.length = 0;
});

test('an empty candidate list renders no rows', async () => {
  const { el, unmount } = render();
  await new Promise((resolve) => setTimeout(resolve, 50));
  flushSync(() => {});
  expect(el.querySelector('.knowledge-candidate-row')).toBeNull();
  unmount();
});

test('a query failure offers a retry', async () => {
  listImpl = () => Promise.reject(new Error('boom'));
  const { el, unmount } = render();
  await waitFor(() => Boolean(el.querySelector('button[aria-label="Retry"]')));
  unmount();
});

function clickRow(el: HTMLElement, text: string) {
  const row = [...el.querySelectorAll('button.gv-row__main')].find((b) => b.textContent?.includes(text));
  expect(row).toBeTruthy();
  flushSync(() => row?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

test('a pending candidate is a row with its score; its pane offers accept, reject and supersede', async () => {
  listImpl = () => Promise.resolve({
    candidates: [{
      id: 'cand-1',
      candidateType: 'promotion',
      status: 'pending',
      title: 'Promote the session-spine decision',
      summary: 'Recorded three times across sessions.',
      score: 0.82,
    }],
  });
  const { el, unmount } = render();
  await waitFor(() => (el.textContent ?? '').includes('Promote the session-spine decision'));
  expect(el.querySelector('.knowledge-candidate-row')?.textContent).toContain('0.82');
  clickRow(el, 'Promote the session-spine decision');
  expect(el.textContent).toContain('Recorded three times across sessions.');
  const labels = [...el.querySelectorAll('button')].map((b) => b.textContent);
  expect(labels).toContain('Accept');
  expect(labels).toContain('Reject');
  expect(labels).toContain('Supersede');
  unmount();
});

test('accepting a candidate sends {id, decision: "accept"}', async () => {
  listImpl = () => Promise.resolve({
    candidates: [{ id: 'cand-1', status: 'pending', title: 'Candidate one', score: 0.5 }],
  });
  decideImpl = () => Promise.resolve({ candidate: { id: 'cand-1', status: 'accepted' } });
  const { el, unmount } = render();
  await waitFor(() => (el.textContent ?? '').includes('Candidate one'));
  clickRow(el, 'Candidate one');

  const acceptButton = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Accept');
  expect(acceptButton).toBeTruthy();
  flushSync(() => acceptButton?.click());

  await waitFor(() => decideCalls.length > 0);
  expect(decideCalls[0]).toEqual({ id: 'cand-1', decision: 'accept' });
  unmount();
});

test('an already-decided candidate (status !== pending) offers no decision buttons', async () => {
  listImpl = () => Promise.resolve({
    candidates: [{ id: 'cand-2', status: 'accepted', title: 'Already decided', score: 0.9 }],
  });
  const { el, unmount } = render();
  await waitFor(() => (el.textContent ?? '').includes('Already decided'));
  // Decided candidates sit behind a disclosure, still selectable.
  clickRow(el, 'Already decided');
  const labels = [...el.querySelectorAll('button')].map((b) => b.textContent);
  expect(labels).not.toContain('Accept');
  expect(labels).not.toContain('Reject');
  unmount();
});
