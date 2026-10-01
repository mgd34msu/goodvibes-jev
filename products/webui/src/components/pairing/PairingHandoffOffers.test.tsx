/**
 * PairingHandoffOffers, per-offer accept/decline, then pairing.handoff.complete,
 * with honest outcomes: a genuinely declined offer never touches the ceremony or
 * the daemon; a ceremony that fails locally (permission denied, cancelled
 * passkey) renders as 'failed' with the client's own reason, never silently
 * downgraded to 'declined'.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const completeCalls: unknown[] = [];
let completeImpl: (input: unknown) => Promise<{ results: { kind: string; status: string; detail?: string }[] }> = () =>
  Promise.resolve({
    results: [
      { kind: 'notifications', status: 'declined' },
      { kind: 'relay', status: 'declined' },
      { kind: 'passkey', status: 'declined' },
    ],
  });

mock.module('../../lib/goodvibes', () => ({
  sdk: {
    operator: {
      pairing: {
        handoff: {
          complete: (input: unknown) => {
            completeCalls.push(input);
            return completeImpl(input);
          },
        },
      },
    },
  },
}));

let ensureBrowserPushSubscriptionImpl: () => Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> = () =>
  Promise.resolve({ endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' } });

mock.module('../../lib/push/push-client', () => ({
  ensureBrowserPushSubscription: () => ensureBrowserPushSubscriptionImpl(),
  ensureDeviceId: () => 'device-1',
  describePushSubscribeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

let registerPasskeyImpl: () => Promise<{ rpId: string; origin: string; credentialId: string; publicKeyCose: string; signCount: number }> = () =>
  Promise.resolve({ rpId: 'app.example', origin: 'https://app.example', credentialId: 'cred-1', publicKeyCose: 'cose-1', signCount: 0 });

mock.module('../../lib/stepup', () => ({
  registerPasskey: () => registerPasskeyImpl(),
  describeStepUpError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  stepUpAvailability: () => ({ supported: true }),
}));

const { PairingHandoffOffers } = await import('./PairingHandoffOffers');

function render(
  offers: ('notifications' | 'relay' | 'passkey')[],
  postureNotice?: string | null,
): { el: HTMLElement; unmount: () => void; onDoneCalls: number[] } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onDoneCalls: number[] = [];
  flushSync(() => {
    root.render(
      React.createElement(PairingHandoffOffers, {
        offers,
        onDone: () => onDoneCalls.push(Date.now()),
        ...(postureNotice !== undefined ? { postureNotice } : {}),
      }),
    );
  });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
    onDoneCalls,
  };
}

function click(el: Element | null | undefined): void {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

afterEach(() => {
  completeCalls.length = 0;
  completeImpl = () =>
    Promise.resolve({
      results: [
        { kind: 'notifications', status: 'declined' },
        { kind: 'relay', status: 'declined' },
        { kind: 'passkey', status: 'declined' },
      ],
    });
  ensureBrowserPushSubscriptionImpl = () => Promise.resolve({ endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' } });
  registerPasskeyImpl = () =>
    Promise.resolve({ rpId: 'app.example', origin: 'https://app.example', credentialId: 'cred-1', publicKeyCose: 'cose-1', signCount: 0 });
});

describe('PairingHandoffOffers rendering', () => {
  test('renders one row per offered kind, all accepted by default', () => {
    const { el, unmount } = render(['notifications', 'relay']);
    const checkboxes = [...el.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((c) => c.checked)).toBe(true);
    unmount();
  });

  test('renders the daemon\'s posture notice line, verbatim, when present', () => {
    const { el, unmount } = render(['notifications'], 'Connection is unencrypted on your LAN. Everything works except browser-gated features; Tailscale gives encrypted access with the full app.');
    expect(el.textContent).toContain('Connection is unencrypted on your LAN.');
    unmount();
  });

  test('renders no notice when the origin is already a secure context (posture carried none)', () => {
    const { el, unmount } = render(['notifications'], null);
    expect(el.querySelector('.pairing-handoff-posture-notice')).toBeNull();
    unmount();
  });
});

describe('PairingHandoffOffers: accept path', () => {
  test('accepting notifications gathers the real subscription and sends it to handoff.complete', async () => {
    completeImpl = () => Promise.resolve({ results: [{ kind: 'notifications', status: 'completed' }] });
    const { el, unmount } = render(['notifications']);
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue')));
    await waitFor(() => completeCalls.length > 0);
    expect(completeCalls[0]).toEqual({
      accept: { notifications: { endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' }, deviceId: 'device-1' } },
    });
    unmount();
  });

  test('relay acceptance sends a plain acknowledgement, no client-side gathering', async () => {
    completeImpl = () => Promise.resolve({ results: [{ kind: 'relay', status: 'completed' }] });
    const { el, unmount } = render(['relay']);
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue')));
    await waitFor(() => completeCalls.length > 0);
    expect(completeCalls[0]).toEqual({ accept: { relay: true } });
    unmount();
  });
});

describe('PairingHandoffOffers: decline path', () => {
  test('unchecking an offer declines it locally, never reaches the ceremony or the daemon payload', async () => {
    completeImpl = () => Promise.resolve({ results: [{ kind: 'relay', status: 'declined' }] });
    const { el, unmount } = render(['notifications', 'relay']);
    const checkboxes = [...el.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    // Uncheck the FIRST offer (notifications).
    flushSync(() => {
      checkboxes[0].click();
    });
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue')));
    await waitFor(() => completeCalls.length > 0);
    expect(completeCalls[0]).toEqual({ accept: { relay: true } });
    unmount();
  });

  test('onDone fires when the operator continues past the results screen', async () => {
    completeImpl = () => Promise.resolve({ results: [{ kind: 'relay', status: 'completed' }] });
    const { el, unmount, onDoneCalls } = render(['relay']);
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue')));
    await waitFor(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Continue to the app')));
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue to the app')));
    expect(onDoneCalls.length).toBeGreaterThan(0);
    unmount();
  });
});

describe('PairingHandoffOffers: ceremony failures are never silently declined', () => {
  test('a passkey ceremony that fails locally shows the real reason, and is never sent to the daemon', async () => {
    registerPasskeyImpl = () => Promise.reject(new Error('The authenticator was not available.'));
    completeImpl = () => Promise.resolve({ results: [] });
    const { el, unmount } = render(['passkey']);
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue')));
    await waitFor(() => completeCalls.length > 0);
    expect(completeCalls[0]).toEqual({ accept: {} });
    await waitFor(() => (el.textContent ?? '').includes('The authenticator was not available.'));
    unmount();
  });

  test('a notifications ceremony that fails locally is never sent to the daemon', async () => {
    ensureBrowserPushSubscriptionImpl = () => Promise.reject(new Error('Notifications are blocked for this site.'));
    completeImpl = () => Promise.resolve({ results: [] });
    const { el, unmount } = render(['notifications']);
    click([...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Continue')));
    await waitFor(() => completeCalls.length > 0);
    expect(completeCalls[0]).toEqual({ accept: {} });
    unmount();
  });
});
