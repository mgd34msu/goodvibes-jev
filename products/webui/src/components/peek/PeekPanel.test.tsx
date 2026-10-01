/**
 * PeekProvider / usePeek on the kit Drawer: the peek opens as a labelled glass
 * drawer, closes from its button and from Escape (inside it or on the page beside
 * it), never lets Escape reach listeners underneath, leaves Escape alone while a
 * dialog sits above it, and moves focus in on open and back to the opener on close.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Dialog } from '../ui/Dialog';
import { PeekProvider, usePeek } from './PeekPanel';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let api: ReturnType<typeof usePeek> | null = null;
let opener: HTMLButtonElement;

function Grab({ withDialog }: { withDialog: boolean }) {
  api = usePeek();
  return withDialog ? <Dialog open onClose={() => undefined} title="Above"><button type="button">Inside dialog</button></Dialog> : null;
}

function render(withDialog = false): void {
  flushSync(() => {
    root.render(
      <PeekProvider>
        <Grab withDialog={withDialog} />
      </PeekProvider>,
    );
  });
}

function openPeek(title = 'Message'): void {
  flushSync(() => {
    api!.open({ title, content: <p><button type="button" className="peek-action">Reply</button> Body text</p> });
  });
}

function key(target: EventTarget, k: string, shiftKey = false): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true });
  flushSync(() => { target.dispatchEvent(event); });
  return event;
}

const drawer = () => document.querySelector('[data-testid="peek-drawer"]');

beforeEach(() => {
  api = null;
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

describe('Peek drawer', () => {
  test('nothing renders until a peek is opened', () => {
    render();
    expect(drawer()).toBeNull();
    expect(api!.isOpen).toBe(false);
  });

  test('opens as a labelled drawer with the title and content', () => {
    render();
    openPeek('Design review');
    const panel = drawer()!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('aria-label')).toBe('Design review');
    expect(panel.querySelector('.gv-drawer__title')?.textContent).toBe('Design review');
    expect(panel.textContent).toContain('Body text');
    expect(api!.isOpen).toBe(true);
  });

  test('focus moves into the drawer on open and returns to the opener on close', () => {
    render();
    openPeek();
    expect(drawer()!.contains(document.activeElement)).toBe(true);
    flushSync(() => api!.close());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('the close button closes it', () => {
    render();
    openPeek();
    const close = drawer()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    flushSync(() => close.click());
    expect(drawer()).toBeNull();
  });

  test('Escape inside the drawer closes it and never reaches window listeners', () => {
    render();
    openPeek();
    let windowSaw = false;
    const onWindow = (e: KeyboardEvent) => { if (e.key === 'Escape') windowSaw = true; };
    window.addEventListener('keydown', onWindow);
    key(drawer()!.querySelector('.peek-action')!, 'Escape');
    window.removeEventListener('keydown', onWindow);
    expect(drawer()).toBeNull();
    expect(windowSaw).toBe(false);
  });

  test('Escape pressed on the page beside the non-modal drawer closes it', () => {
    render();
    openPeek();
    key(opener, 'Escape');
    expect(drawer()).toBeNull();
  });

  test('with a dialog above it, Escape on the page leaves the peek open (only the top overlay closes)', () => {
    render();
    openPeek();
    render(true);
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    key(opener, 'Escape');
    expect(drawer()).not.toBeNull();
  });

  test('Tab wraps inside the drawer', () => {
    render();
    openPeek();
    const buttons = [...drawer()!.querySelectorAll('button')] as HTMLButtonElement[];
    const last = buttons[buttons.length - 1];
    last.focus();
    const event = key(last, 'Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
  });

  test('opening a second peek replaces the content in place', () => {
    render();
    openPeek('First');
    openPeek('Second');
    expect(document.querySelectorAll('[data-testid="peek-drawer"]').length).toBe(1);
    expect(drawer()!.getAttribute('aria-label')).toBe('Second');
  });

});
