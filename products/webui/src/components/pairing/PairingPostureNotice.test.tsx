/**
 * PairingPostureNotice, the standalone one-shot banner for a plain #pair=<token>
 * hand-off (no offer set) that lands on a plain-http-on-LAN origin.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PairingPostureNotice } from './PairingPostureNotice';

function render(onDismiss: () => void): { el: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(PairingPostureNotice, { notice: 'lan notice text', onDismiss }));
  });
  return { el: container, unmount: () => { flushSync(() => root.unmount()); container.remove(); } };
}

function click(el: Element | null): void {
  flushSync(() => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}

describe('PairingPostureNotice', () => {
  test('renders the notice text verbatim', () => {
    const { el, unmount } = render(() => {});
    expect(el.textContent).toContain('lan notice text');
    unmount();
  });

  test('Dismiss calls onDismiss exactly once', () => {
    let calls = 0;
    const { el, unmount } = render(() => { calls += 1; });
    click(el.querySelector('.pairing-posture-notice__dismiss'));
    expect(calls).toBe(1);
    unmount();
  });
});
