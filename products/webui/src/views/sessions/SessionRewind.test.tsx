/**
 * SessionRewind.test.tsx, the session-detail rewind surface end to end.
 *
 * Expand → turn anchors are derived from the session's messages → Preview rewind runs
 * rewind.plan and renders exactly what would change (files + conversation, honest about a
 * part the runtime reports unavailable) → the confirm sheet → rewind.apply consumes the
 * minted token and renders the receipt with its undo point → undoing the file restore runs
 * checkpoints.restore against the recorded safety checkpoint.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let planResult: unknown = {
  sessionId: 's-1', turnId: 't-2', scope: 'both', token: 'rw-tok-1', expiresAt: 9_999_999_999,
  files: { available: true, checkpointId: 'wcp-9', checkpointLabel: 'before turn 2', affectedFileCount: 3 },
  conversation: { available: true, messagesToDrop: 4, messagesRemaining: 6 },
  warnings: [],
};
let applyResult: unknown = {
  receipt: {
    sessionId: 's-1', turnId: 't-2', scope: 'both', appliedAt: 1,
    files: { restored: true, checkpointId: 'wcp-9', safetyCheckpointId: 'wcp-safety', restoredFileCount: 3, removedFileCount: 0 },
    conversation: { rewound: true, droppedMessages: 4, undoSnapshotId: 'snap-1' },
    undo: { files: { restoreCheckpointId: 'wcp-safety' }, conversation: { undoSnapshotId: 'snap-1' } },
    warnings: [],
  },
  refused: false, refusal: null,
};

const planCalls: unknown[] = [];
const applyCalls: unknown[] = [];
const restoreCalls: unknown[] = [];

const MESSAGES = {
  messages: [
    { id: 'm1', turnId: 't-1', role: 'user', body: 'first ask' },
    { id: 'm2', turnId: 't-1', role: 'assistant', body: 'ok' },
    { id: 'm3', turnId: 't-2', role: 'user', body: 'second ask' },
    { id: 'm4', turnId: 't-2', role: 'assistant', body: 'done' },
  ],
};

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      sessions: { messages: { list: (_id: string) => Promise.resolve(MESSAGES) } },
      rewind: {
        plan: (input: unknown) => { planCalls.push(input); return Promise.resolve(planResult); },
        apply: (input: unknown) => { applyCalls.push(input); return Promise.resolve(applyResult); },
      },
      checkpoints: {
        restore: (input: unknown) => { restoreCalls.push(input); return Promise.resolve({ result: { checkpointId: 'wcp-safety', safetyCheckpointId: null, restoredFiles: [], removedFiles: [] }, refused: false, refusal: null }); },
      },
    },
  },
}));

const { SessionRewind } = await import('./SessionRewind');

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SessionRewind, { sessionId: 's-1', closed: false }),
    ));
  });
  // document.body: kit Dialogs portal there.
  return { container: document.body as HTMLElement, unmount: () => { flushSync(() => root.unmount()); container.remove(); } };
}

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => {});
  }
}

function click(el: Element | null) {
  flushSync(() => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

afterEach(() => {
  planResult = {
    sessionId: 's-1', turnId: 't-2', scope: 'both', token: 'rw-tok-1', expiresAt: 9_999_999_999,
    files: { available: true, checkpointId: 'wcp-9', checkpointLabel: 'before turn 2', affectedFileCount: 3 },
    conversation: { available: true, messagesToDrop: 4, messagesRemaining: 6 },
    warnings: [],
  };
  applyResult = {
    receipt: {
      sessionId: 's-1', turnId: 't-2', scope: 'both', appliedAt: 1,
      files: { restored: true, checkpointId: 'wcp-9', safetyCheckpointId: 'wcp-safety', restoredFileCount: 3, removedFileCount: 0 },
      conversation: { rewound: true, droppedMessages: 4, undoSnapshotId: 'snap-1' },
      undo: { files: { restoreCheckpointId: 'wcp-safety' }, conversation: { undoSnapshotId: 'snap-1' } },
      warnings: [],
    },
    refused: false, refusal: null,
  };
  planCalls.length = 0;
  applyCalls.length = 0;
  restoreCalls.length = 0;
});

describe('SessionRewind', () => {
  test('expands, derives turn anchors, and previews the plan with both scopes', async () => {
    const { container, unmount } = render();
    await settle();

    // the most recent turn anchor leads the list
    const anchorSelect = container.querySelector('button[aria-label="Rewind turn anchor"]') as HTMLButtonElement;
    expect(anchorSelect).not.toBeNull();
    click(anchorSelect);
    const anchorOptions = [...document.querySelectorAll('[role="listbox"][aria-label="Rewind turn anchor"] [role="option"]')].map((o) => o.textContent);
    expect(anchorOptions.join(' | ')).toContain('second ask');
    click(anchorSelect);

    click(container.querySelector('.session-rewind__preview-btn'));
    await settle(3);

    expect(planCalls).toHaveLength(1);
    expect(container.querySelector('.session-rewind__apply-btn')).not.toBeNull();
    unmount();
  });

  test('relays the daemon warning for an unavailable conversation scope', async () => {
    planResult = {
      sessionId: 's-1', turnId: 't-2', scope: 'both', token: 'rw-tok-1', expiresAt: 9_999_999_999,
      files: { available: true, checkpointId: 'wcp-9', checkpointLabel: 'before turn 2', affectedFileCount: 3 },
      conversation: null,
      warnings: ['Conversation rewind is unavailable: no conversation store is wired on this runtime.'],
    };
    const { container, unmount } = render();
    await settle();
    click(container.querySelector('.session-rewind__preview-btn'));
    await settle(3);

    expect(container.textContent).toContain('no conversation store is wired');
    unmount();
  });

  test('confirming the rewind applies with the minted token and offers the undo', async () => {
    const { container, unmount } = render();
    await settle();
    click(container.querySelector('.session-rewind__preview-btn'));
    await settle(3);

    click(container.querySelector('.session-rewind__apply-btn'));
    await settle(2);
    // confirm sheet → confirm
    click(container.querySelector('.gv-confirm__confirm'));
    await settle(3);

    expect(applyCalls).toHaveLength(1);
    expect((applyCalls[0] as { confirmToken?: string }).confirmToken).toBe('rw-tok-1');
    expect(container.querySelector('.session-rewind__undo-btn')).not.toBeNull();
    unmount();
  });

  test('undoing the file restore runs checkpoints.restore against the recorded safety checkpoint', async () => {
    const { container, unmount } = render();
    await settle();
    click(container.querySelector('.session-rewind__preview-btn'));
    await settle(3);
    click(container.querySelector('.session-rewind__apply-btn'));
    await settle(2);
    click(container.querySelector('.gv-confirm__confirm'));
    await settle(3);

    click(container.querySelector('.session-rewind__undo-btn'));
    await settle(2);
    click(container.querySelector('.gv-confirm__confirm'));
    await settle(3);

    expect(restoreCalls).toHaveLength(1);
    expect((restoreCalls[0] as { id?: string }).id).toBe('wcp-safety');
    unmount();
  });
});
