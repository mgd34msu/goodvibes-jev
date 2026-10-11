import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useUrlState } from './useUrlState';
import { resetRelayPairingCaptureForTest, useRelayPairingHandoff } from './useRelayPairingHandoff';
import {
  encodeRelayPairingString, getStoredRelayPairing, RELAY_PAIRING_STORAGE_KEY,
  type RelayPairingPayload,
} from '../lib/relay-pairing';
import { subscribeClientLifetime, WEBUI_TOKEN_STORE_KEY } from '../lib/client-lifetime';

const payload: RelayPairingPayload = {
  protocol: 1, relayUrl: 'wss://relay.example.test', rid: 'synthetic-rid',
  daemonPublicKey: 'synthetic-daemon-public-key', label: 'Synthetic daemon',
};
const code = encodeRelayPairingString(payload);
const cleanups: (() => void)[] = [];

function Probe() {
  const url = useUrlState();
  const relay = useRelayPairingHandoff();
  return <output data-status={relay.status} data-error={relay.error === null ? 'absent' : 'present'}>{url.view}</output>;
}

function render(strict = false) {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const refresh = () => flushSync(() => root.render(strict ? <StrictMode><Probe /></StrictMode> : <Probe />));
  refresh();
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
  return { container, refresh };
}

async function untilStatus(container: HTMLElement, status: 'stored' | 'error') {
  const deadline = Date.now() + 2000;
  while (container.querySelector('output')?.getAttribute('data-status') !== status) {
    if (Date.now() > deadline) throw new Error('Relay handoff render did not reach ' + status);
    await new Promise<void>(resolve => setImmediate(resolve));
    flushSync(() => {});
  }
}

beforeEach(() => {
  resetRelayPairingCaptureForTest();
  window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
  window.localStorage.removeItem(WEBUI_TOKEN_STORE_KEY);
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
  window.localStorage.removeItem(WEBUI_TOKEN_STORE_KEY);
  window.history.replaceState(null, '', '/');
});

describe('relay handoff alongside the actual URL hook', () => {
  for (const strict of [false, true]) {
    test(`bare-origin relay is captured before router normalization and stored once (StrictMode=${String(strict)})`, async () => {
      window.history.replaceState(null, '', '/#relay=' + encodeURIComponent(code));
      let identityChanges = 0;
      cleanups.push(subscribeClientLifetime(() => { identityChanges++; }));
      const { container, refresh } = render(strict);
      expect(getStoredRelayPairing()).toEqual(payload);
      expect(identityChanges).toBe(1);
      await untilStatus(container, 'stored');
      expect(container.querySelector('output')?.getAttribute('data-status')).toBe('stored');
      expect(window.location.search).toBe('?view=chat');
      expect(window.location.hash).toBe('');
      expect(window.localStorage.getItem(WEBUI_TOKEN_STORE_KEY)).toBeNull();
      expect(identityChanges).toBe(1);
      const replacement = encodeRelayPairingString({ ...payload, rid: 'later-synthetic-rid' });
      window.history.replaceState(null, '', '/?view=chat#relay=' + encodeURIComponent(replacement));
      refresh();
      expect(getStoredRelayPairing()).toEqual(payload);
      expect(window.location.hash).toBe('#relay=' + encodeURIComponent(replacement));
      expect(identityChanges).toBe(1);
    });
  }

  test('explicit app query and unrelated fragment remain owned by their original readers', () => {
    window.history.replaceState(null, '', '/?view=personal&tab=calendar#fleet-node=n1&relay=' + encodeURIComponent(code));
    const { container } = render();
    expect(container.querySelector('output')?.textContent).toBe('personal');
    expect(window.location.search).toBe('?view=personal&tab=calendar');
    expect(window.location.hash).toBe('#fleet-node=n1');
    expect(getStoredRelayPairing()).toEqual(payload);
    expect(window.localStorage.getItem(WEBUI_TOKEN_STORE_KEY)).toBeNull();
  });

  test('malformed bare-origin code is refused without storing relay or identity', async () => {
    window.history.replaceState(null, '', '/#relay=gvrelay1.invalid');
    const { container } = render();
    await untilStatus(container, 'error');
    expect(container.querySelector('output')?.getAttribute('data-status')).toBe('error');
    expect(container.querySelector('output')?.getAttribute('data-error')).toBe('present');
    expect(getStoredRelayPairing()).toBeNull();
    expect(window.localStorage.getItem(WEBUI_TOKEN_STORE_KEY)).toBeNull();
    expect(window.location.search).toBe('?view=chat');
    expect(window.location.hash).toBe('');
  });

  test('ordinary bare origin remains idle and does not create a transport pairing', () => {
    const { container } = render();
    expect(container.querySelector('output')?.getAttribute('data-status')).toBe('idle');
    expect(getStoredRelayPairing()).toBeNull();
    expect(window.localStorage.getItem(WEBUI_TOKEN_STORE_KEY)).toBeNull();
    expect(window.location.search).toBe('?view=chat');
  });
});
