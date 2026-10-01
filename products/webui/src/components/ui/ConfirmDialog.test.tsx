/**
 * ConfirmDialog + useConfirm: ask() opens one 420-wide alertdialog with the title,
 * one sentence and Cancel / action buttons; it resolves true on the action and
 * false on Cancel, Escape or the scrim; a destructive confirm starts on Cancel; a
 * second ask() resolves the first as false and never stacks two dialogs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useConfirm, type ConfirmRequest } from './ConfirmDialog';

let askRef: ((r: ConfirmRequest) => Promise<boolean>) | null = null;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let opener: HTMLButtonElement;

function Harness() {
  const confirm = useConfirm();
  askRef = confirm.ask;
  return React.createElement(React.Fragment, null, confirm.element);
}

function ask(request: ConfirmRequest): Promise<boolean> {
  let answer: Promise<boolean> | undefined;
  flushSync(() => {
    answer = askRef!(request);
  });
  return answer!;
}

const dialog = () => document.querySelector('.gv-confirm');

function key(target: Element, k: string): void {
  flushSync(() => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
}

beforeEach(() => {
  opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(React.createElement(Harness)));
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  opener.remove();
  askRef = null;
});

describe('useConfirm', () => {
  test('renders nothing until ask() is called', () => {
    expect(dialog()).toBeNull();
  });

  test('opens with the given title, sentence, target and two buttons', () => {
    void ask({ title: 'Restore this checkpoint?', description: 'The working tree goes back to it.', target: 'nightly-42', confirmLabel: 'Restore' });
    const el = dialog()!;
    expect(document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent).toBe('Restore this checkpoint?');
    expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).toBe('The working tree goes back to it.');
    expect(el.textContent).toContain('nightly-42');
    const buttons = [...el.querySelectorAll('.gv-dialog__footer button')].map((b) => b.textContent);
    expect(buttons).toHaveLength(2);
    expect(buttons).toContain('Restore');
    // Ordinary confirm: focus starts on the action.
    expect(document.activeElement?.textContent).toBe('Restore');
  });

  test('the action resolves true and closes; focus returns to the opener', async () => {
    const answer = ask({ title: 'Go?', confirmLabel: 'Go' });
    flushSync(() => (document.querySelector('.gv-confirm__confirm') as HTMLButtonElement).click());
    expect(await answer).toBe(true);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('Cancel, Escape and the scrim each resolve false', async () => {
    const a = ask({ title: 'One?' });
    flushSync(() => (document.querySelector('.gv-confirm__cancel') as HTMLButtonElement).click());
    expect(await a).toBe(false);

    const b = ask({ title: 'Two?' });
    key(document.querySelector('.gv-confirm__cancel')!, 'Escape');
    expect(await b).toBe(false);

    const c = ask({ title: 'Three?' });
    flushSync(() => (document.querySelector('.gv-overlay > .scrim') as HTMLElement).click());
    expect(await c).toBe(false);
    expect(dialog()).toBeNull();
  });

  test('a destructive confirm starts focus on Cancel, so Enter never destroys by default', () => {
    void ask({ title: 'Delete this chat?', tone: 'danger', confirmLabel: 'Delete chat' });
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(dialog()!.textContent).toContain('Delete chat');
  });

  test('a second ask() resolves the first as false and shows only the second', async () => {
    const first = ask({ title: 'First?' });
    void ask({ title: 'Second?' });
    expect(await first).toBe(false);
    expect(document.querySelectorAll('.gv-confirm').length).toBe(1);
    expect(dialog()!.textContent).toContain('Second?');
  });
});
