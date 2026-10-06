/**
 * SessionChanges.test.tsx, the session review COCKPIT end to end.
 *
 * Drives the PRIMARY source (sessions.changes.get, session-scoped) and the explicit
 * workspace-scoped fallback (checkpoints.list + checkpoints.diff): expand → the aggregate
 * diff is parsed into the multibuffer → tapping a hunk opens the action chooser →
 *   - APPROVE marks the hunk reviewed (client-side progress, reviewed/total indicator);
 *   - COMMENT & STEER hands off to the comment sheet → sends through sessions.steer /
 *     sessions.followUp PREFIXED with the structured context block;
 *   - REJECT & REVERT runs checkpoints.revertHunkPreview → confirm → checkpoints.revertHunk
 *     with the minted token, and renders the honest conflict state when the hunk is stale.
 * Also covers the honest-empty state, the METHOD_NOT_FOUND fallback, and the enabled gate.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const SESSION_UNIFIED = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -40,3 +40,4 @@ export function foo() {
 const a = 1;
+  const c = 3;
 const b = 2;
`;

const WORKSPACE_UNIFIED = `diff --git a/src/bar.ts b/src/bar.ts
index 333..444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,3 @@
 const x = 1;
+  const y = 2;
`;

let checkpoints: unknown[] = [];
let sessionChangesResult: {
  sessionId: string;
  checkpointCount: number;
  checkpointIds: string[];
  from: string;
  to: string;
  files: string[];
  unifiedDiff: string;
  stat: string;
} = {
  sessionId: 's-1', checkpointCount: 2, checkpointIds: ['cp-1', 'cp-2'],
  from: 'cp-0', to: 'cp-2', files: ['src/foo.ts'], unifiedDiff: SESSION_UNIFIED, stat: '1 file changed',
};
let sessionChangesError: unknown = null;
const steerCalls: { sessionId: string; input: { body: string } }[] = [];
const followUpCalls: { sessionId: string; input: { body: string } }[] = [];

let previewResult: unknown = {
  path: 'src/foo.ts', applies: true, conflict: null, hunkHeader: '@@ -40,3 +40,4 @@',
  addedLinesRemoved: 1, removedLinesRestored: 0, matchedAtLine: 40, token: 'tok-1', expiresAt: 9_999_999_999,
};
let revertResult: unknown = {
  receipt: {
    reverted: true, path: 'src/foo.ts', hunkHeader: '@@ -40,3 +40,4 @@',
    addedLinesRemoved: 1, removedLinesRestored: 0, safetyCheckpointId: 'wcp-safety',
    undo: { restoreCheckpointId: 'wcp-safety' },
  },
  refused: false, refusal: null,
};
let revertError: unknown = null;
const previewCalls: { path: string; hunk: string; sessionId?: string }[] = [];
const revertCalls: { path: string; hunk: string; confirmToken?: string; sessionId?: string }[] = [];

mock.module('../../lib/goodvibes', () => ({
  GOODVIBES_BASE_URL: 'http://localhost:3000',
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      invoke: (method: string) => {
        if (method === 'workLedger.turn.session') return Promise.resolve({ kind: 'legacy' });
        return Promise.reject(new Error(`Unexpected method ${method}`));
      },
      checkpoints: {
        list: () => Promise.resolve({ checkpoints }),
        diff: (_input: { a: string }) => Promise.resolve({
          diff: { from: 'cp-1', to: 'working-tree', files: ['src/bar.ts'], unifiedDiff: WORKSPACE_UNIFIED, stat: '1 file changed' },
        }),
        revertHunkPreview: (input: { path: string; hunk: string; sessionId?: string }) => {
          previewCalls.push(input);
          return Promise.resolve(previewResult);
        },
        revertHunk: (input: { path: string; hunk: string; confirmToken?: string; sessionId?: string }) => {
          revertCalls.push(input);
          return revertError ? Promise.reject(revertError) : Promise.resolve(revertResult);
        },
      },
      sessions: {
        steer: (sessionId: string, input: { body: string }) => { steerCalls.push({ sessionId, input }); return Promise.resolve({}); },
        followUp: (sessionId: string, input: { body: string }) => { followUpCalls.push({ sessionId, input }); return Promise.resolve({}); },
        changes: {
          get: (_sessionId: string) => (
            sessionChangesError ? Promise.reject(sessionChangesError) : Promise.resolve(sessionChangesResult)
          ),
        },
      },
    },
  },
}));

const { SessionChanges } = await import('./SessionChanges');
const { queryKeys } = await import('../../lib/queries');

function render(props: { canSteer: boolean; closed: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SessionChanges, { sessionId: 's-1', ...props }),
    ));
  });
  return {
    // document.body: the kit Dialog portals there.
    container: document.body as HTMLElement,
    client,
    unmount: () => { flushSync(() => root.unmount()); container.remove(); },
  };
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

/** Tap the first hunk, then click a named action button in the action chooser sheet. */
function openHunkAction(container: HTMLElement, which: 'approve' | 'comment' | 'reject') {
  click(container.querySelector('.diff-mb__hunk'));
  const selector = which === 'approve'
    ? '.hunk-actions__btn--approve'
    : which === 'reject'
      ? '.hunk-actions__btn--reject'
      : '.hunk-actions__btn:not(.hunk-actions__btn--approve):not(.hunk-actions__btn--reject)';
  click(container.querySelector(selector));
}

afterEach(() => {
  checkpoints = [];
  sessionChangesResult = {
    sessionId: 's-1', checkpointCount: 2, checkpointIds: ['cp-1', 'cp-2'],
    from: 'cp-0', to: 'cp-2', files: ['src/foo.ts'], unifiedDiff: SESSION_UNIFIED, stat: '1 file changed',
  };
  sessionChangesError = null;
  steerCalls.length = 0;
  followUpCalls.length = 0;
  previewResult = {
    path: 'src/foo.ts', applies: true, conflict: null, hunkHeader: '@@ -40,3 +40,4 @@',
    addedLinesRemoved: 1, removedLinesRestored: 0, matchedAtLine: 40, token: 'tok-1', expiresAt: 9_999_999_999,
  };
  revertResult = {
    receipt: {
      reverted: true, path: 'src/foo.ts', hunkHeader: '@@ -40,3 +40,4 @@',
      addedLinesRemoved: 1, removedLinesRestored: 0, safetyCheckpointId: 'wcp-safety',
      undo: { restoreCheckpointId: 'wcp-safety' },
    },
    refused: false, refusal: null,
  };
  revertError = null;
  previewCalls.length = 0;
  revertCalls.length = 0;
});

const ONE_CHECKPOINT = [{
  id: 'cp-1', kind: 'turn', label: 'turn one', createdAt: Date.now() - 120_000,
  parentId: null, retentionClass: 'standard', commit: 'abcdef123456', sizeBytes: 1024,
}];

describe('SessionChanges', () => {
  test('expands and renders the session-scoped diff in the multibuffer by default', async () => {
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();

    expect(container.textContent).toContain('src/foo.ts');
    const hunk = container.querySelector('.diff-mb__hunk');
    expect(hunk).not.toBeNull();
    expect(hunk?.textContent).toContain('const c = 3;');
    unmount();
  });

  test('APPROVE marks a hunk reviewed and advances the reviewed/total indicator', async () => {
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();

    const progress = () => container.querySelector('[role="status"][aria-label="Review progress"]')?.textContent;
    const before = progress();
    expect(before).toBeDefined();

    openHunkAction(container, 'approve');
    await settle(2);

    expect(progress()).not.toBe(before);
    // no wire calls for a purely client-side approve
    expect(steerCalls).toHaveLength(0);
    expect(revertCalls).toHaveLength(0);
    unmount();
  });

  test('COMMENT & STEER steers the session with the file, the hunk and the comment', async () => {
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();

    openHunkAction(container, 'comment');
    await settle(2);

    const textarea = container.querySelector('.hunk-sheet__input') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'use a named constant');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const form = container.querySelector('.hunk-sheet__form') as HTMLFormElement;
    flushSync(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await settle();

    expect(steerCalls).toHaveLength(1);
    expect(followUpCalls).toHaveLength(0);
    const body = steerCalls[0].input.body;
    expect(steerCalls[0].sessionId).toBe('s-1');
    expect(body).toContain('src/foo.ts');
    expect(body).toContain('+  const c = 3;');
    expect(body).toContain('use a named constant');
    unmount();
  });

  test('with no bound agent COMMENT queues a follow-up instead of steering', async () => {
    const { container, unmount } = render({ canSteer: false, closed: false });
    await settle();
    openHunkAction(container, 'comment');
    await settle(2);

    const textarea = container.querySelector('.hunk-sheet__input') as HTMLTextAreaElement;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'reconsider this');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const form = container.querySelector('.hunk-sheet__form') as HTMLFormElement;
    flushSync(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await settle();

    expect(followUpCalls).toHaveLength(1);
    expect(steerCalls).toHaveLength(0);
    unmount();
  });

  test('REJECT & REVERT previews then reverts the exact hunk with the minted confirm token', async () => {
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();

    openHunkAction(container, 'reject');
    await settle(3);

    // preview ran against the exact hunk patch (header + body), attributed to the session
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0].path).toBe('src/foo.ts');
    expect(previewCalls[0].hunk).toContain('@@ -40,3 +40,4 @@');
    expect(previewCalls[0].hunk).toContain('+  const c = 3;');
    expect(previewCalls[0].sessionId).toBe('s-1');
    // ready state names the consequence

    click(container.querySelector('.hunk-sheet__send--danger'));
    await settle(3);

    expect(revertCalls).toHaveLength(1);
    expect(revertCalls[0].path).toBe('src/foo.ts');
    expect(revertCalls[0].confirmToken).toBe('tok-1');
    expect(revertCalls[0].hunk).toContain('+  const c = 3;');
    unmount();
  });

  test('a stale hunk (preview applies:false) renders the honest conflict state, never a partial apply', async () => {
    previewResult = {
      path: 'src/foo.ts', applies: false, conflict: 'the file changed since the diff was taken',
      hunkHeader: '@@ -40,3 +40,4 @@', addedLinesRemoved: 0, removedLinesRestored: 0, matchedAtLine: null,
      token: null, expiresAt: null,
    };
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();

    openHunkAction(container, 'reject');
    await settle(3);

    expect(container.textContent).toContain('the file changed since the diff was taken');
    // the confirm/revert path never ran
    expect(revertCalls).toHaveLength(0);
    // a Refresh affordance is offered
    const refresh = Array.from(container.querySelectorAll('.hunk-sheet__send')).find((b) => b.textContent?.includes('Refresh'));
    expect(refresh).not.toBeUndefined();
    unmount();
  });

  test('a 409 conflict on apply (hunk went stale between preview and confirm) shows the conflict state, not a partial write', async () => {
    revertError = { status: 409, code: 'CONFLICT', message: 'hunk no longer applies' };
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();

    openHunkAction(container, 'reject');
    await settle(3);
    click(container.querySelector('.hunk-sheet__send--danger'));
    await settle(3);

    expect(revertCalls).toHaveLength(1);
    const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Refresh'));
    expect(refresh).not.toBeUndefined();
    unmount();
  });

  test('a session with no stamped checkpoints shows no hunks and its fallback opens the workspace-wide changes', async () => {
    sessionChangesResult = {
      sessionId: 's-1', checkpointCount: 0, checkpointIds: [], from: 'EMPTY', to: 'EMPTY',
      files: [], unifiedDiff: '', stat: '',
    };
    checkpoints = ONE_CHECKPOINT;
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();

    expect(container.querySelector('.diff-mb__hunk')).toBeNull();
    expect(container.textContent).not.toContain('src/bar.ts');
    click(container.querySelector('.session-changes__inline-link'));
    await settle();
    expect(container.textContent).toContain('src/bar.ts');
    unmount();
  });

  test('the workspace-scoped toggle switches away from session changes', async () => {
    checkpoints = ONE_CHECKPOINT;
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();
    expect(container.textContent).toContain('src/foo.ts');

    click(container.querySelector('.session-changes__mode-toggle'));
    await settle();

    expect(container.textContent).toContain('src/bar.ts');
    expect(container.textContent).not.toContain('src/foo.ts');
    unmount();
  });

  test('a daemon that has never heard of sessions.changes.get offers the workspace-scoped fallback', async () => {
    sessionChangesError = { status: 404, code: 'METHOD_NOT_FOUND', message: 'Unknown gateway method' };
    checkpoints = ONE_CHECKPOINT;
    const { container, unmount } = render({ canSteer: true, closed: false });
    await settle();

    expect(container.textContent).not.toContain('src/bar.ts');
    click(container.querySelector('.session-changes__inline-link'));
    await settle();
    expect(container.textContent).toContain('src/bar.ts');
    unmount();
  });

  test('the session-changes query fires when the Changes tab mounts the section', async () => {
    const { client, unmount } = render({ canSteer: true, closed: false });
    await settle();
    expect(client.getQueryState(queryKeys.sessionChanges('s-1'))?.data).toBeDefined();
    unmount();
  });

});
