/**
 * usePairingHandoff, fragment consumption + history cleanup + status flow.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const tokenCalls: string[] = [];
let tokenShouldReject = false;
let postureResult: unknown = { posture: { origin: 'http://localhost', scheme: 'http', privateNetwork: true, secureContext: true, capabilities: [] } };
let postureRejects = false;
const postureCalls: (string | undefined)[] = [];
/** Posture reads that have answered (resolved or rejected). */
let postureAnswered = 0;

mock.module('../lib/goodvibes', () => ({
  setExplicitAuthToken: (raw: string) => {
    tokenCalls.push(raw);
    return tokenShouldReject
      ? Promise.reject(Object.assign(new Error('rejected'), { status: 401 }))
      : Promise.resolve({ authenticated: true });
  },
  sdk: {
    operator: {
      pairing: {
        posture: {
          get: (origin?: string) => {
            postureCalls.push(origin);
            const answer = postureRejects ? Promise.reject(new Error('posture read failed')) : Promise.resolve(postureResult);
            return answer.finally(() => { postureAnswered += 1; });
          },
        },
      },
    },
  },
}));

const { usePairingHandoff, resetPairingCaptureForTest } = await import('./usePairingHandoff');

let lastStatus = '';
let lastError: unknown = null;
let lastOffers: readonly string[] = [];
let dismiss: (() => void) | null = null;
let lastPostureNotice: string | null = null;
let dismissPosture: (() => void) | null = null;

function Probe() {
  const { status, error, offers, dismissOffers, postureNotice, dismissPostureNotice } = usePairingHandoff();
  lastStatus = status;
  lastError = error;
  lastOffers = offers;
  dismiss = dismissOffers;
  lastPostureNotice = postureNotice;
  dismissPosture = dismissPostureNotice;
  return null;
}

function render(): () => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  return () => {
    flushSync(() => root.unmount());
    container.remove();
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

/**
 * The hand-off's last step, the posture read, has answered, and one more turn has
 * let the hook act on the answer and commit it.
 */
async function postureDone(): Promise<void> {
  await until(() => postureAnswered > 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  flushSync(() => {});
}

beforeEach(() => {
  tokenCalls.length = 0;
  tokenShouldReject = false;
  postureCalls.length = 0;
  postureAnswered = 0;
  postureRejects = false;
  postureResult = { posture: { origin: 'http://localhost', scheme: 'http', privateNetwork: true, secureContext: true, capabilities: [] } };
  lastStatus = '';
  lastError = null;
  lastOffers = [];
  dismiss = null;
  lastPostureNotice = null;
  dismissPosture = null;
  // The token is captured once at module scope, reset it, and set the URL, BEFORE
  // each render so every case starts from a clean, un-captured state.
  resetPairingCaptureForTest();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('usePairingHandoff', () => {
  test('idle when there is no pairing fragment', async () => {
    window.history.replaceState(null, '', '/?view=chat');
    const unmount = render();
    expect(lastStatus).toBe('idle');
    // With a token the effect calls setExplicitAuthToken synchronously, before its
    // first await, and render() has already flushed the effect: none was called.
    expect(tokenCalls).toHaveLength(0);
    expect(postureCalls).toHaveLength(0);
    unmount();
  });

  test('consumes the token, strips the fragment immediately, and lands signed in', async () => {
    window.history.replaceState(null, '', '/?view=chat#pair=tok_live');
    const unmount = render();
    // First paint already knows a pairing is in flight.
    expect(lastStatus).toBe('pending');
    // The secret is stripped from the URL synchronously, before validation resolves.
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?view=chat');
    await until(() => lastStatus !== 'pending');
    expect(tokenCalls).toEqual(['tok_live']);
    expect(lastStatus).toBe('idle');
    unmount();
  });

  test('a rejected token surfaces as error status and the fragment is still stripped', async () => {
    tokenShouldReject = true;
    window.history.replaceState(null, '', '/#pair=bad');
    const unmount = render();
    expect(window.location.hash).toBe('');
    await until(() => lastStatus !== 'pending');
    expect(tokenCalls).toEqual(['bad']);
    expect(lastStatus).toBe('error');
    expect(lastError).toBeInstanceOf(Error);
    unmount();
  });

  test('a plain token link (no offers key) never populates offers', async () => {
    window.history.replaceState(null, '', '/#pair=tok_live');
    const unmount = render();
    // Status and offers are set together; the posture read after them is the end.
    await postureDone();
    expect(lastStatus).toBe('idle');
    expect(lastOffers).toEqual([]);
    unmount();
  });

  test('a hand-off bundle publishes its offer set once the token validates', async () => {
    window.history.replaceState(null, '', '/#pair=tok_live&offers=passkey,notifications');
    const unmount = render();
    expect(lastStatus).toBe('pending');
    // The offers key is stripped alongside pair, synchronously.
    expect(window.location.hash).toBe('');
    await until(() => lastStatus !== 'pending');
    expect(lastStatus).toBe('idle');
    expect(lastOffers).toEqual(['notifications', 'passkey']);
    unmount();
  });

  test('dismissOffers clears the offer set once the decision UI is done', async () => {
    window.history.replaceState(null, '', '/#pair=tok_live&offers=relay');
    const unmount = render();
    await until(() => lastOffers.length > 0);
    expect(lastOffers).toEqual(['relay']);
    flushSync(() => dismiss?.());
    expect(lastOffers).toEqual([]);
    unmount();
  });

  test('a rejected token never publishes offers', async () => {
    tokenShouldReject = true;
    window.history.replaceState(null, '', '/#pair=bad&offers=relay');
    const unmount = render();
    // The error path ends the hand-off: nothing runs after it.
    await until(() => lastStatus !== 'pending');
    expect(lastStatus).toBe('error');
    expect(lastOffers).toEqual([]);
    unmount();
  });

  test('a plain-http-on-LAN posture publishes the daemon\'s exact notice line once, for this device\'s own origin', async () => {
    postureResult = {
      posture: {
        origin: 'http://192.168.0.131:3423', scheme: 'http', privateNetwork: true, secureContext: false,
        notice: 'Connection is unencrypted on your LAN. Everything works except browser-gated features; Tailscale gives encrypted access with the full app.',
        capabilities: [],
      },
    };
    window.history.replaceState(null, '', '/#pair=tok_live');
    const unmount = render();
    await postureDone();
    expect(postureCalls).toHaveLength(1);
    expect(lastPostureNotice).toBe(
      'Connection is unencrypted on your LAN. Everything works except browser-gated features; Tailscale gives encrypted access with the full app.',
    );
    unmount();
  });

  test('a secure-context posture (nothing to say) never publishes a notice', async () => {
    window.history.replaceState(null, '', '/#pair=tok_live');
    const unmount = render();
    await postureDone();
    expect(postureCalls).toHaveLength(1);
    expect(lastPostureNotice).toBeNull();
    unmount();
  });

  test('dismissPostureNotice clears the notice', async () => {
    postureResult = {
      posture: {
        origin: 'http://192.168.0.131:3423', scheme: 'http', privateNetwork: true, secureContext: false,
        notice: 'lan notice', capabilities: [],
      },
    };
    window.history.replaceState(null, '', '/#pair=tok_live');
    const unmount = render();
    await until(() => lastPostureNotice !== null);
    expect(lastPostureNotice).toBe('lan notice');
    flushSync(() => dismissPosture?.());
    expect(lastPostureNotice).toBeNull();
    unmount();
  });

  test('a posture-read failure never blocks the pairing itself, and publishes no notice', async () => {
    postureRejects = true;
    window.history.replaceState(null, '', '/#pair=tok_live');
    const unmount = render();
    await postureDone();
    expect(lastStatus).toBe('idle');
    expect(lastPostureNotice).toBeNull();
    unmount();
  });

  test('a rejected token never reads posture at all', async () => {
    tokenShouldReject = true;
    window.history.replaceState(null, '', '/#pair=bad');
    const unmount = render();
    // A success would issue the posture read in the same turn it sets 'idle', so
    // once the status settles the read has either happened or never will.
    await until(() => lastStatus !== 'pending');
    expect(lastStatus).toBe('error');
    expect(postureCalls).toHaveLength(0);
    unmount();
  });
});
