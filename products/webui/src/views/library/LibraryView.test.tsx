/**
 * LibraryView: the page header, the one search field, the tab switch with the Review count,
 * and Add memory as the primary action opening a dialog that saves through memory.records.add.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { flushSync } from 'react-dom';
import { click, fakeRecord, renderInto, searchResult, waitFor } from './test-harness';

const adds: unknown[] = [];
const searches: unknown[] = [];
let memoryServed = true;

mock.module('../../lib/goodvibes', () => ({
  VIBE_PERSONA_TAG: 'vibe',
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: (method: string) => Promise.resolve(
    method === 'knowledge.candidates.list'
      ? { candidates: [{ id: 'c1', candidateType: 'promotion', status: 'pending', title: 'Candidate', score: 0.5 }] }
      : { sources: [], nodes: [], issues: [], targets: [], tasks: [] },
  ),
  sdk: {
    knowledge: { status: () => Promise.resolve({}), map: () => Promise.resolve({}) },
    operator: {
      memory: {
        search: (input: unknown) => {
          searches.push(input);
          if (!memoryServed) return Promise.reject(Object.assign(new Error('Method not found'), { status: 404, code: 'METHOD_NOT_FOUND' }));
          return Promise.resolve(searchResult([fakeRecord()]));
        },
        reviewQueue: () => Promise.resolve({ records: [fakeRecord({ id: 'r2', summary: 'Queued' })] }),
        consolidation: {
          receipts: () => Promise.resolve({
            receipts: [],
            pendingProposals: [{ kind: 'contradiction', ids: ['r2'], route: '', reason: 'Two records disagree' }],
          }),
        },
        add: (input: unknown) => { adds.push(input); return Promise.resolve({ record: fakeRecord() }); },
      },
    },
  },
}));

const { LibraryView } = await import('./LibraryView');

afterEach(() => {
  adds.length = 0;
  searches.length = 0;
  memoryServed = true;
});

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
  flushSync(() => { input.dispatchEvent(new window.Event('input', { bubbles: true })); });
}

describe('LibraryView', () => {
  test('the Review tab counts every row waiting there', async () => {
    const tabs: string[] = [];
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: (t: string) => { tabs.push(t); } }));
    await waitFor(() => (el.textContent ?? '').includes('The daemon is the single writer'));
    // One queued record, one pending proposal, one undecided candidate.
    await waitFor(() => [...el.querySelectorAll('[role="radio"]')].some((r) => r.textContent?.includes('3')));
    unmount();
  });

  test('typing in the search field searches memory with that text', async () => {
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: () => {} }));
    await waitFor(() => searches.length > 0);
    setValue(el.querySelector('input[type="search"]') as HTMLInputElement, 'daemon');
    await waitFor(() => searches.some((s) => (s as { query?: string }).query === 'daemon'));
    unmount();
  });

  test('Add memory opens a dialog and saves type, scope and summary through memory.records.add', async () => {
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: () => {} }));
    click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Add memory'));
    await waitFor(() => Boolean(document.body.querySelector('[role="dialog"]')));
    setValue(document.body.querySelector('input[aria-label="Memory summary"]') as HTMLInputElement, 'A brand new fact');
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Add memory'));
    await waitFor(() => adds.length === 1);
    expect(adds[0]).toEqual({ cls: 'fact', scope: 'project', summary: 'A brand new fact' });
    unmount();
  });

  test('a daemon that does not serve memory gets no Add memory action, since adding could only fail', async () => {
    memoryServed = false;
    const { el, unmount } = renderInto(React.createElement(LibraryView, { tab: 'memory', onTabChange: () => {} }));
    const addButton = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Add memory');
    await waitFor(() => searches.length > 0 && addButton() === undefined);
    expect(addButton()).toBeUndefined();
    unmount();
  });
});
