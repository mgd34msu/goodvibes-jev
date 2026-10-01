/**
 * ReviewTab: consolidation proposals, the memory review queue and knowledge candidates in
 * one list. A proposal's "Resolve" highlights exactly the queue rows it points at (never
 * filters the rest away) and opens its detail; queue rows open the record pane.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { click, fakeRecord, renderInto, waitFor, type FakeRecord } from './test-harness';

let queue: FakeRecord[] = [];
let receipts: () => Promise<unknown> = () => Promise.resolve({ receipts: [], pendingProposals: [] });
let candidates: unknown[] = [];
const saves: { id: string; input: unknown }[] = [];

mock.module('../../lib/goodvibes', () => ({
  VIBE_PERSONA_TAG: 'vibe',
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: (method: string) => Promise.resolve(method === 'knowledge.candidates.list' ? { candidates } : {}),
  sdk: {
    operator: {
      memory: {
        reviewQueue: () => Promise.resolve({ records: queue }),
        consolidation: { receipts: () => receipts() },
        updateReview: (id: string, input: unknown) => { saves.push({ id, input }); return Promise.resolve({ record: fakeRecord() }); },
        delete: (id: string) => Promise.resolve({ id, deleted: true }),
      },
    },
  },
}));

const { ReviewTab } = await import('./ReviewTab');

afterEach(() => {
  queue = [];
  receipts = () => Promise.resolve({ receipts: [], pendingProposals: [] });
  candidates = [];
  saves.length = 0;
});

describe('ReviewTab', () => {

  test('"Resolve" on a proposal opens its detail and keeps the whole queue', async () => {
    receipts = () => Promise.resolve({
      receipts: [],
      pendingProposals: [{
        kind: 'contradiction',
        ids: ['r1'],
        route: 'memory action:"curator" query:"consolidation"',
        reason: 'Same-summary records disagree and neither is a clearly-newer verified winner.',
      }],
    });
    queue = [fakeRecord({ id: 'r1', summary: 'First record' }), fakeRecord({ id: 'r2', summary: 'Second record' })];
    const { el, unmount } = renderInto(React.createElement(ReviewTab, {}));
    await waitFor(() => (el.textContent ?? '').includes('Same-summary records disagree'));
    click([...el.querySelectorAll('.consolidation-proposal-row button')].find((b) => b.textContent === 'Resolve'));
    await waitFor(() => Boolean(el.querySelector('[aria-label="Review item"]')));
    // A jump never filters: both queued records are still listed.
    expect([...el.querySelectorAll('ul[aria-label="Review queue"] li')]).toHaveLength(2);
    expect(el.querySelector('[aria-label="Review item"]')?.textContent).toContain('Same-summary records disagree');
    unmount();
  });

  test('a queued record opens its pane, and saving a review sends state and confidence', async () => {
    queue = [fakeRecord({ id: 'r1', summary: 'First record', confidence: 55 })];
    const { el, unmount } = renderInto(React.createElement(ReviewTab, {}));
    await waitFor(() => (el.textContent ?? '').includes('First record'));
    click(el.querySelector('ul[aria-label="Review queue"] button.gv-row__main'));
    await waitFor(() => Boolean(el.querySelector('[aria-label="Review item"]')));
    click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Save review'));
    await waitFor(() => saves.length === 1);
    expect(saves[0]).toEqual({ id: 'r1', input: { state: 'fresh', confidence: 55 } });
    unmount();
  });

  test('the search text narrows the queue rows', async () => {
    queue = [fakeRecord({ id: 'r1', summary: 'Alpha thing' }), fakeRecord({ id: 'r2', summary: 'Beta thing' })];
    const { el, unmount } = renderInto(React.createElement(ReviewTab, { query: 'beta' }));
    await waitFor(() => (el.textContent ?? '').includes('Beta thing'));
    expect(el.textContent).not.toContain('Alpha thing');
    unmount();
  });

  test('an undecided knowledge candidate is a row in the same list', async () => {
    candidates = [{ id: 'c1', candidateType: 'promotion', status: 'pending', title: 'Promote the keepalive decision', score: 0.86 }];
    const { el, unmount } = renderInto(React.createElement(ReviewTab, {}));
    await waitFor(() => (el.textContent ?? '').includes('Promote the keepalive decision'));
    expect(el.textContent).toContain('0.86');
    unmount();
  });
});
