import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Dialog } from './Dialog';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let closes = 0;
let opener: HTMLButtonElement;

function renderDialog(open: boolean): void {
  flushSync(() => {
    root.render(
      <Dialog
        open={open}
        onClose={() => { closes += 1; }}
        title="Revoke token"
        description="The device signs out at once."
        size="confirm"
        hideClose
        footer={(
          <>
            <button type="button">Cancel</button>
            <button type="button">Revoke</button>
          </>
        )}
      />,
    );
  });
}

function key(target: Element, k: string, shiftKey = false): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true });
  flushSync(() => { target.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  closes = 0;
  opener = document.createElement('button');
  opener.textContent = 'Open';
  document.body.appendChild(opener);
  opener.focus();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  opener.remove();
});

describe('Dialog: modal, labelled, focus-trapped', () => {
  test('carries the given title and description, with focus moved inside', () => {
    renderDialog(true);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Revoke token');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('signs out');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test('Tab wraps from the last control to the first, Shift+Tab the other way', () => {
    renderDialog(true);
    const buttons = [...document.querySelectorAll('[role="dialog"] button')] as HTMLButtonElement[];
    buttons[buttons.length - 1].focus();
    const forward = key(buttons[buttons.length - 1], 'Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0], 'Tab', true);
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  test('Escape closes it and does not reach window listeners underneath', () => {
    renderDialog(true);
    let windowSawEscape = false;
    const onWindow = (e: KeyboardEvent) => { if (e.key === 'Escape') windowSawEscape = true; };
    window.addEventListener('keydown', onWindow);
    key(document.activeElement ?? document.body, 'Escape');
    window.removeEventListener('keydown', onWindow);
    expect(closes).toBe(1);
    expect(windowSawEscape).toBe(false);
  });

  test('Escape with focus lost to the page still closes the dialog on top', () => {
    renderDialog(true);
    (document.activeElement as HTMLElement | null)?.blur();
    key(document.body, 'Escape');
    expect(closes).toBe(1);
  });

  test('closing returns focus to what opened it', () => {
    renderDialog(true);
    renderDialog(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Dialog: bare layout and nested dialogs', () => {
  function renderBare(nested: boolean): void {
    flushSync(() => {
      root.render(
        <Dialog open bare size="large" title="Settings" className="settings-dialog" onClose={() => { closes += 1; }}>
          <div className="two-columns"><button type="button">Close</button></div>
          {nested && (
            <div role="alertdialog" aria-label="Confirm">
              <button type="button">Confirm</button>
            </div>
          )}
        </Dialog>,
      );
    });
  }

  test('Escape inside a nested dialog is left to that dialog, the parent stays open', () => {
    renderBare(true);
    const confirm = document.querySelector('[role="alertdialog"] button') as HTMLButtonElement;
    const event = key(confirm, 'Escape');
    expect(closes).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    // Escape anywhere else in the dialog still closes it.
    key(document.querySelector('.two-columns button')!, 'Escape');
    expect(closes).toBe(1);
  });
});
