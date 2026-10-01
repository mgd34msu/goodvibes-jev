/**
 * SignedOutGate, the signed-out first paint and paste-token flow.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const tokenCalls: string[] = [];
const loginCalls: { username: string; password: string }[] = [];
let tokenShouldReject = false;

mock.module('../../lib/goodvibes', () => ({
  // The gate compares a scanned QR's daemon address against the origin serving
  // this page, so the stub has to carry one.
  GOODVIBES_BASE_URL: 'http://localhost',
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  setExplicitAuthToken: (raw: string) => {
    tokenCalls.push(raw);
    return tokenShouldReject
      ? Promise.reject(Object.assign(new Error('rejected'), { status: 401 }))
      : Promise.resolve({ authenticated: true });
  },
  login: (username: string, password: string) => {
    loginCalls.push({ username, password });
    return Promise.resolve({});
  },
  sdk: {},
}));

// The scanner's own camera lifecycle is covered in
// components/pairing/PairingQrScanner.test.tsx. What matters HERE is only where
// a completed scan goes, so this stub skips the camera and offers one button per
// payload kind that hands the gate a already-parsed result.
mock.module('../pairing/PairingQrScanner', () => ({
  PairingQrScanner: ({ onScanned, onCancel }: {
    onScanned: (scanned: unknown) => void;
    onCancel: () => void;
  }) =>
    React.createElement('div', null, [
      React.createElement(
        'button',
        {
          key: 'token',
          type: 'button',
          onClick: () => onScanned({ kind: 'token', token: 'scanned-token', url: 'http://localhost' }),
        },
        'stub scan token',
      ),
      React.createElement(
        'button',
        {
          key: 'elsewhere',
          type: 'button',
          onClick: () => onScanned({ kind: 'token', token: 'scanned-token', url: 'http://192.168.1.9:3421' }),
        },
        'stub scan other daemon',
      ),
      React.createElement(
        'button',
        {
          key: 'password',
          type: 'button',
          onClick: () => onScanned({ kind: 'password', username: 'ada', password: 'lovelace' }),
        },
        'stub scan password',
      ),
      React.createElement('button', { key: 'cancel', type: 'button', onClick: onCancel }, 'stub cancel'),
    ]),
}));

const { SignedOutGate } = await import('./SignedOutGate');

function buttonLabelled(el: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(label),
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

function render(): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(SignedOutGate)));
  });
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

/** Poll (committing between checks) until `predicate` holds, or fail after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  flushSync(() => {});
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: condition never held');
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
  }
}

afterEach(() => {
  tokenCalls.length = 0;
  loginCalls.length = 0;
  tokenShouldReject = false;
});

describe('SignedOutGate first paint', () => {
  test('renders a token field', () => {
    const { el, unmount } = render();
    expect(el.querySelector('input[type="password"]')).not.toBeNull();
    unmount();
  });

  test('password login is NOT presented co-equal, hidden behind a secondary toggle', () => {
    const { el, unmount } = render();
    // Username field is not present until the secondary path is expanded.
    expect(el.querySelector('input[autocomplete="username"]')).toBeNull();
    const toggle = buttonLabelled(el, 'Use a username');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    flushSync(() => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('input[autocomplete="username"]')).not.toBeNull();
    unmount();
  });
});

describe('SignedOutGate camera scan flow', () => {
  test('the camera is not opened until the scan dialog is asked for', () => {
    const { el, unmount } = render();
    // The stub scanner only exists inside the dialog; nothing of it is on the
    // page until the trigger is pressed, which is what keeps the camera off.
    expect(el.textContent).not.toContain('stub scan token');
    flushSync(() => { buttonLabelled(el, 'Scan with this device').click(); });
    expect(document.body.textContent).toContain('stub scan token');
    unmount();
  });

  test('a scanned token goes through the SAME setExplicitAuthToken call a pasted one does', async () => {
    const { el, unmount } = render();
    flushSync(() => { buttonLabelled(el, 'Scan with this device').click(); });
    flushSync(() => { buttonLabelled(document.body, 'stub scan token').click(); });
    await until(() => tokenCalls.length > 0);

    expect(tokenCalls).toContain('scanned-token');
    unmount();
  });

  test('a successful scan closes the dialog and never renders the token', async () => {
    const { el, unmount } = render();
    flushSync(() => { buttonLabelled(el, 'Scan with this device').click(); });
    flushSync(() => { buttonLabelled(document.body, 'stub scan token').click(); });
    await until(() => tokenCalls.length > 0);
    flushSync(() => {});

    expect(document.body.textContent).not.toContain('stub scan token');
    expect(document.body.textContent).not.toContain('scanned-token');
    unmount();
  });

  test('scanned username and password credentials go through the same login call', async () => {
    const { el, unmount } = render();
    flushSync(() => { buttonLabelled(el, 'Scan with this device').click(); });
    flushSync(() => { buttonLabelled(document.body, 'stub scan password').click(); });
    await until(() => loginCalls.length > 0);

    expect(loginCalls).toEqual([{ username: 'ada', password: 'lovelace' }]);
    expect(el.textContent).not.toContain('lovelace');
    unmount();
  });

  test('a QR naming a different daemon still signs in, with a note about the mismatch', async () => {
    const { el, unmount } = render();
    flushSync(() => { buttonLabelled(el, 'Scan with this device').click(); });
    flushSync(() => { buttonLabelled(document.body, 'stub scan other daemon').click(); });
    await until(() => (el.textContent ?? '').includes('192.168.1.9:3421'));

    // Not a block: the same daemon is routinely reachable at more than one
    // address, so the token is still tried.
    expect(tokenCalls).toContain('scanned-token');
    expect(el.textContent).toContain('192.168.1.9:3421');
    unmount();
  });

  test('cancelling the dialog closes it without signing anyone in', () => {
    const { el, unmount } = render();
    flushSync(() => { buttonLabelled(el, 'Scan with this device').click(); });
    flushSync(() => { buttonLabelled(document.body, 'stub cancel').click(); });

    expect(document.body.textContent).not.toContain('stub scan token');
    expect(tokenCalls).toHaveLength(0);
    unmount();
  });
});

describe('SignedOutGate token flow', () => {
  test('submitting a token calls setExplicitAuthToken with the trimmed value', async () => {
    const { el, unmount } = render();
    const input = el.querySelector('input[type="password"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '  paste-me  ');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    flushSync(() => {});

    const form = el.querySelector('form') as HTMLFormElement;
    flushSync(() => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await until(() => tokenCalls.length > 0);

    expect(tokenCalls).toContain('paste-me');
    unmount();
  });

  test('a rejected token surfaces an alert', async () => {
    tokenShouldReject = true;
    const { el, unmount } = render();
    const input = el.querySelector('input[type="password"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'bad-token');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    flushSync(() => {});

    const form = el.querySelector('form') as HTMLFormElement;
    flushSync(() => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    await until(() => el.querySelector('[role="alert"]') !== null);

    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    unmount();
  });
});
