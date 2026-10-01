/**
 * HunkCommentSheet.test.tsx, the hunk comment composer sheet.
 *
 * Verifies it shows exactly which change is being commented on (file path, both line
 * ranges, the captured-at label, the excerpt), that a comment submits trimmed via the
 * button and via plain Enter (the phone-critical soft-keyboard path), that an empty
 * comment cannot submit, and that Cancel is wired.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { HunkCommentSheet } from './HunkCommentSheet';
import { parseUnifiedDiff } from '../../lib/unified-diff';

const HUNK = parseUnifiedDiff(`diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -40,3 +40,4 @@
 const a = 1;
+const c = 3;
 const b = 2;
`)[0].hunks[0];

let submitted: string[] = [];
let cancelled = 0;

function render(overrides: Partial<React.ComponentProps<typeof HunkCommentSheet>> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props: React.ComponentProps<typeof HunkCommentSheet> = {
    open: true,
    filePath: 'src/foo.ts',
    hunk: HUNK,
    capturedLabel: 'checkpoint "turn abc" · 2 minutes ago',
    mode: 'steer',
    pending: false,
    error: null,
    onSubmit: (c: string) => submitted.push(c),
    onCancel: () => { cancelled += 1; },
    ...overrides,
  };
  flushSync(() => root.render(React.createElement(HunkCommentSheet, props)));
  return {
    // document.body: the kit Dialog portals there.
    container: document.body as HTMLElement,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function setValue(textarea: HTMLTextAreaElement, value: string) {
  flushSync(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  submitted = [];
  cancelled = 0;
});

describe('HunkCommentSheet', () => {
  test('shows the file, both line ranges, the captured label, and the excerpt', () => {
    const { container, unmount } = render();
    const text = container.textContent ?? '';
    expect(text).toContain('src/foo.ts');
    expect(text).toContain('checkpoint "turn abc" · 2 minutes ago');
    // excerpt reconstructs the added line with its marker
    expect(container.querySelector('.hunk-sheet__excerpt')?.textContent).toContain('+const c = 3;');
    unmount();
  });

  test('submitting via the button passes the trimmed comment', () => {
    const { container, unmount } = render();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    setValue(textarea, '  rename c to total  ');
    const form = container.querySelector('form') as HTMLFormElement;
    flushSync(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(submitted).toEqual(['rename c to total']);
    unmount();
  });

  test('plain Enter submits (soft-keyboard path)', () => {
    const { container, unmount } = render();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    setValue(textarea, 'inline it');
    flushSync(() => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(submitted).toEqual(['inline it']);
    unmount();
  });

  test('an empty comment cannot submit and the send button is disabled', () => {
    const { container, unmount } = render();
    const send = container.querySelector('.hunk-sheet__send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const form = container.querySelector('form') as HTMLFormElement;
    flushSync(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(submitted).toEqual([]);
    unmount();
  });

  test('Cancel fires onCancel', () => {
    const { container, unmount } = render();
    const cancel = container.querySelector('.hunk-sheet__cancel') as HTMLButtonElement;
    flushSync(() => cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(cancelled).toBe(1);
    unmount();
  });
});
