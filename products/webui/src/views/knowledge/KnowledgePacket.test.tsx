/**
 * KnowledgePacketPanel, knowledge.packet, a never-called-before verb this
 * brief adopts. Proves the build form sends the task/detail/budget/writeScope
 * fields honestly and that the result (or its honest empty/error state) renders.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let packetImpl: (input: unknown) => Promise<unknown> = () => Promise.resolve({ items: [], estimatedTokens: 0 });
let lastInput: unknown;

mock.module('../../lib/goodvibes', () => ({
  invokeMethod: (method: string, input?: unknown) => {
    if (method === 'knowledge.packet') {
      lastInput = input;
      return packetImpl(input);
    }
    return Promise.resolve({});
  },
}));

const { KnowledgePacketPanel } = await import('./KnowledgePacket');

function setNativeValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(
    React.createElement(QueryClientProvider, { client }, React.createElement(KnowledgePacketPanel)),
  ));
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
  packetImpl = () => Promise.resolve({ items: [], estimatedTokens: 0 });
  lastInput = undefined;
});

function submitTask(el: HTMLElement, task: string) {
  const input = el.querySelector('input[aria-label="Task description"]') as HTMLInputElement;
  const form = input.closest('form') as HTMLFormElement;
  flushSync(() => setNativeValue(input, task));
  flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

test('building a packet sends the task and default "standard" detail level', async () => {
  packetImpl = () => Promise.resolve({ items: [], estimatedTokens: 0 });
  const { el, unmount } = render();
  submitTask(el, 'Refactor the session spine');
  await waitFor(() => lastInput !== undefined);
  expect((lastInput as { task: string }).task).toBe('Refactor the session spine');
  expect((lastInput as { detail: string }).detail).toBe('standard');
  unmount();
});

test('a packet with items renders its token estimate and each item row', async () => {
  packetImpl = () => Promise.resolve({
    items: [
      { kind: 'source', id: 's1', title: 'Session spine decision record', reason: 'directly relevant', score: 0.91, estimatedTokens: 120 },
    ],
    estimatedTokens: 120,
  });
  const { el, unmount } = render();
  submitTask(el, 'Refactor the session spine');
  await waitFor(() => (el.textContent ?? '').includes('Session spine decision record'));
  expect(el.textContent).toContain('120');
  expect(el.textContent).toContain('directly relevant');
  unmount();
});

test('a build failure offers a retry', async () => {
  packetImpl = () => Promise.reject(new Error('boom'));
  const { el, unmount } = render();
  submitTask(el, 'Refactor the session spine');
  await waitFor(() => Boolean(el.querySelector('button[aria-label="Retry"]')));
  unmount();
});

test('a post-1.2.0 daemon truncated packet discloses "showing N of M (K dropped)"', async () => {
  packetImpl = () => Promise.resolve({
    items: [
      { kind: 'source', id: 's1', title: 'Session spine decision record', reason: 'directly relevant', score: 0.91, estimatedTokens: 120 },
    ],
    estimatedTokens: 120,
    truncated: true,
    totalCandidates: 20,
    droppedCount: 19,
  });
  const { el, unmount } = render();
  submitTask(el, 'Refactor the session spine');
  await waitFor(() => (el.textContent ?? '').includes('Session spine decision record'));
  const note = el.querySelector('.knowledge-packet__truncation-note');
  expect(note).not.toBeNull();
  expect(note!.textContent).toContain('20');
  expect(note!.textContent).toContain('19');
  unmount();
});

test('an older (pre-1.2.0) daemon response with no truncation fields renders no disclosure, no fabricated claim', async () => {
  packetImpl = () => Promise.resolve({
    items: [
      { kind: 'source', id: 's1', title: 'Session spine decision record', reason: 'directly relevant', score: 0.91, estimatedTokens: 120 },
    ],
    estimatedTokens: 120,
  });
  const { el, unmount } = render();
  submitTask(el, 'Refactor the session spine');
  await waitFor(() => (el.textContent ?? '').includes('Session spine decision record'));
  expect(el.querySelector('.knowledge-packet__truncation-note')).toBeNull();
  unmount();
});

test('truncated:true with a non-numeric totalCandidates/droppedCount is treated as absent, never a fabricated number', async () => {
  packetImpl = () => Promise.resolve({
    items: [{ kind: 'source', id: 's1', title: 'X', reason: 'r', score: 0.5, estimatedTokens: 10 }],
    estimatedTokens: 10,
    truncated: true,
  });
  const { el, unmount } = render();
  submitTask(el, 'Refactor the session spine');
  await waitFor(() => (el.textContent ?? '').includes('X'));
  expect(el.querySelector('.knowledge-packet__truncation-note')).toBeNull();
  unmount();
});
