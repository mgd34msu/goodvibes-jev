/** Real host/wrapper/browser encoding; finite synthetic I/O, never authenticator or relay-auth proof. */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { RelayClient } from '@goodvibes-jev/engine/transport-realtime';
import type { StepUpMintChallengeResult } from '../../lib/goodvibes';
import { nativeRequestPrimitives } from '../../test-setup';

interface Attempt {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly headers: Headers;
  readonly signal: AbortSignal;
}
const attempts: Attempt[] = [];
const relayReplies: Response[] = [];
const mintSignals: (AbortSignal | undefined)[] = [];
const mintReplies: Promise<StepUpMintChallengeResult>[] = [];
const credentialRequests: (CredentialRequestOptions | undefined)[] = [];
const credentialReplies: Promise<Credential | null>[] = [];
const unmounts: (() => void)[] = [];
const restoreProperties: (() => void)[] = [];
const drainReplies: (() => void)[] = [];
const pendingOutcomes: Promise<Outcome>[] = [];

const relayClient: RelayClient = {
  ready: true,
  connect: () => Promise.resolve(),
  close: () => {},
  async fetch(input, init) {
    const request = new Request(input, init);
    const body = await request.text();
    attempts.push({ method: request.method, url: request.url, body,
      headers: new Headers(request.headers), signal: request.signal });
    const reply = relayReplies.shift();
    if (!reply) throw new Error('Unexpected synthetic relay attempt');
    return reply;
  },
};
mock.module('@goodvibes-jev/engine/transport-realtime', () => ({ createRelayClient: () => relayClient }));
mock.module('../../lib/goodvibes', () => ({ sdk: { operator: { stepup: {
  mintChallenge: (_input: unknown, signal?: AbortSignal) => {
    mintSignals.push(signal);
    const reply = mintReplies.shift();
    if (!reply) return Promise.reject(new Error('Unexpected synthetic challenge request'));
    return reply;
  },
} } } }));

const { StepUpHost } = await import('./StepUpHost');
const { routedFetch, closeRelayClient, setActiveRoute } = await import('../../lib/relay-connection');
const { registerStepUpPrompter } = await import('../../lib/stepup-prompter');
const { storeRelayPairing, RELAY_PAIRING_STORAGE_KEY } = await import('../../lib/relay-pairing');
const { STEP_UP_ASSERTION_HEADER, base64UrlToBytes, bytesToBase64Url } = await import('../../lib/stepup');

const firstUrl = 'http://localhost/api/owned-stepup-mutation';
const replacementUrl = 'http://localhost/api/owned-stepup-replacement';
const challenge: StepUpMintChallengeResult = {
  challengeId: 'owned-synthetic-challenge', challenge: 'b3duZWQtY2hhbGxlbmdl', expiresAt: Date.now() + 60_000,
};
function required(): Response {
  return Response.json({ error: 'step-up-required' }, { status: 401, headers: { 'www-authenticate': 'WebAuthn' } });
}
function credential(id: string): PublicKeyCredential {
  const bytes = new TextEncoder().encode(id);
  const rawId = new Uint8Array(bytes).buffer;
  const response: AuthenticatorAssertionResponse = {
    authenticatorData: new Uint8Array([1, 2]).buffer,
    clientDataJSON: new Uint8Array([3, 4]).buffer,
    signature: new Uint8Array([5, 6]).buffer,
    userHandle: null,
  };
  return { id, type: 'public-key', rawId, response, authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    toJSON: () => ({ id, rawId: bytesToBase64Url(rawId), type: 'public-key', clientExtensionResults: {},
      response: { authenticatorData: bytesToBase64Url(response.authenticatorData),
        clientDataJSON: bytesToBase64Url(response.clientDataJSON), signature: bytesToBase64Url(response.signature) } }),
  };
}
function deferred<T>(drainValue: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  drainReplies.push(() => resolve(drainValue));
  return { promise, resolve };
}
function property(object: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(object, key);
  restoreProperties.push(() => {
    if (original) Object.defineProperty(object, key, original);
    else Reflect.deleteProperty(object, key);
  });
  Object.defineProperty(object, key, { value, configurable: true });
}
async function nextFrame(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync(() => {});
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Owned StepUp control did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
    flushSync(() => {});
  }
}
function renderHost(): void {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  flushSync(() => root.render(<StepUpHost />));
  unmounts.push(() => { flushSync(() => root.unmount()); element.remove(); });
}
function dialog(): Element | null { return document.body.querySelector('[role="dialog"]'); }
function click(label: string): void {
  const button = Array.from(document.body.querySelectorAll('button')).find(value => value.textContent === label);
  if (!button) throw new Error('Missing owned StepUp button');
  flushSync(() => button.click());
}
type Outcome = { readonly kind: 'response'; readonly response: Response } | { readonly kind: 'failure'; readonly reason: unknown };
function outcome(pending: Promise<Response>): Promise<Outcome> {
  const settled = pending.then<Outcome, Outcome>(
    response => ({ kind: 'response', response }),
    reason => ({ kind: 'failure', reason }),
  );
  pendingOutcomes.push(settled);
  return settled;
}
function response(result: Outcome): Response {
  if (result.kind === 'failure') throw result.reason;
  return result.response;
}
function expectCallerAbort(result: Outcome, signal: AbortSignal): void {
  if (result.kind !== 'failure') throw new Error('Caller cancellation returned a response');
  expect(result.reason).toBe(signal.reason);
  expect(result.reason).toMatchObject({ name: 'AbortError' });
}

beforeEach(() => {
  // The transport uses platform Fetch semantics while the host still renders in Happy DOM.
  for (const [name, value] of Object.entries(nativeRequestPrimitives)) property(globalThis, name, value);
  property(window, 'PublicKeyCredential', class SyntheticPublicKeyCredential {});
  property(window, 'isSecureContext', true);
  property(navigator, 'credentials', {
    create: () => Promise.resolve(null),
    get(options?: CredentialRequestOptions): Promise<Credential | null> {
      credentialRequests.push(options);
      const reply = credentialReplies.shift();
      if (!reply) return Promise.reject(new Error('Unexpected synthetic credential request'));
      return reply;
    },
  });
  storeRelayPairing({ protocol: 1, relayUrl: 'wss://owned-relay.invalid', rid: 'owned-stepup-fixture',
    daemonPublicKey: 'owned-synthetic-public-key', label: 'Owned StepUp fixture' });
  setActiveRoute('relay');
});
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) unmount();
  for (const drain of drainReplies.splice(0)) drain();
  await Promise.all(pendingOutcomes.splice(0));
  await nextFrame();
  registerStepUpPrompter(null);
  closeRelayClient();
  setActiveRoute('direct');
  localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
  for (const restore of restoreProperties.splice(0).reverse()) restore();
  attempts.length = relayReplies.length = mintSignals.length = mintReplies.length = 0;
  credentialRequests.length = credentialReplies.length = 0;
});

test('caller abort before Verify retires the actual prompt with its native reason and no challenge or retry', async () => {
  relayReplies.push(required());
  renderHost();
  const caller = new AbortController();
  const pending = outcome(routedFetch(firstUrl, { method: 'POST', body: 'owned request', signal: caller.signal }));
  await waitFor(() => Boolean(dialog()));
  flushSync(() => caller.abort());
  expectCallerAbort(await pending, caller.signal);
  expect(dialog()).toBeNull();
  expect(mintSignals).toHaveLength(0);
  expect(credentialRequests).toHaveLength(0);
  expect(attempts).toHaveLength(1);
});

test('a cancelled pending challenge blocks replacement until drained and cannot start a late assertion or retry', async () => {
  relayReplies.push(required(), required(), required());
  const oldMint = deferred(challenge);
  mintReplies.push(oldMint.promise);
  renderHost();
  const caller = new AbortController();
  const old = outcome(routedFetch(firstUrl, { method: 'POST', signal: caller.signal }));
  await waitFor(() => Boolean(dialog()));
  click('Verify with passkey');
  await waitFor(() => mintSignals.length === 1);
  flushSync(() => caller.abort());
  expectCallerAbort(await old, caller.signal);
  expect(mintSignals[0]?.aborted).toBe(true);
  expect(dialog()).toBeNull();
  expect(response(await outcome(routedFetch(replacementUrl, { method: 'POST' }))).status).toBe(401);
  expect(dialog()).toBeNull();
  oldMint.resolve(challenge);
  await nextFrame();
  const replacement = outcome(routedFetch(replacementUrl, { method: 'POST' }));
  await waitFor(() => Boolean(dialog()?.textContent?.includes('POST /api/owned-stepup-replacement')));
  expect(credentialRequests).toHaveLength(0);
  click('Cancel');
  expect(response(await replacement).status).toBe(401);
  expect(attempts).toHaveLength(3);
  expect(attempts.every(value => !value.headers.has(STEP_UP_ASSERTION_HEADER))).toBe(true);
});

test('caller abort cancels native assertion work and its late result cannot retry or settle the replacement', async () => {
  relayReplies.push(required(), required(), required(), new Response('owned replacement result'));
  mintReplies.push(Promise.resolve(challenge), Promise.resolve(challenge));
  const oldCredential = deferred<Credential | null>(null), newCredential = deferred<Credential | null>(null);
  credentialReplies.push(oldCredential.promise, newCredential.promise);
  renderHost();
  const caller = new AbortController();
  const old = outcome(routedFetch(firstUrl, { method: 'POST', signal: caller.signal }));
  await waitFor(() => Boolean(dialog()));
  click('Verify with passkey');
  await waitFor(() => credentialRequests.length === 1);
  flushSync(() => caller.abort());
  expectCallerAbort(await old, caller.signal);
  expect(credentialRequests[0]?.signal?.aborted).toBe(true);
  expect(dialog()).toBeNull();
  expect(response(await outcome(routedFetch(replacementUrl, { method: 'POST' }))).status).toBe(401);
  oldCredential.resolve(credential('old-credential'));
  await nextFrame();
  expect(attempts).toHaveLength(2);
  const replacement = outcome(routedFetch(replacementUrl, { method: 'POST' }));
  await waitFor(() => Boolean(dialog()?.textContent?.includes('/api/owned-stepup-replacement')));
  click('Verify with passkey');
  await waitFor(() => credentialRequests.length === 2);
  expect(dialog()?.textContent).toContain('Waiting for passkey');
  newCredential.resolve(credential('replacement-credential'));
  expect(await response(await replacement).text()).toBe('owned replacement result');
  await waitFor(() => dialog() === null);
  expect(dialog()).toBeNull();
  expect(attempts).toHaveLength(4);
  const retry = attempts[3];
  if (!retry) throw new Error('Missing replacement retry');
  const assertion = retry.headers.get(STEP_UP_ASSERTION_HEADER);
  if (!assertion) throw new Error('Missing replacement assertion');
  expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(assertion))))
    .toMatchObject({ credentialId: bytesToBase64Url(new TextEncoder().encode('replacement-credential')) });
  expect(attempts.slice(0, 3).every(value => !value.headers.has(STEP_UP_ASSERTION_HEADER))).toBe(true);
});

test('explicit UI Cancel retains the exact original 401 while cancelling only its pending native ceremony', async () => {
  const first = required();
  relayReplies.push(first);
  mintReplies.push(Promise.resolve(challenge));
  const nativeCredential = deferred<Credential | null>(null);
  credentialReplies.push(nativeCredential.promise);
  renderHost();
  const caller = new AbortController();
  const pending = outcome(routedFetch(firstUrl, { method: 'POST', signal: caller.signal }));
  await waitFor(() => Boolean(dialog()));
  click('Verify with passkey');
  await waitFor(() => credentialRequests.length === 1);
  click('Cancel');
  expect(response(await pending)).toBe(first);
  expect(caller.signal.aborted).toBe(false);
  expect(credentialRequests[0]?.signal?.aborted).toBe(true);
  nativeCredential.resolve(credential('cancelled-native-result'));
  await nextFrame();
  expect(dialog()).toBeNull();
  expect(attempts).toHaveLength(1);
});

test('native Request plus init retries the same effective method body headers and signal, adding only the assertion', async () => {
  relayReplies.push(required(), new Response('owned effective request result'));
  mintReplies.push(Promise.resolve(challenge));
  credentialReplies.push(Promise.resolve(credential('effective-credential')));
  renderHost();
  const original = new AbortController(), selected = new AbortController();
  const input = new Request(firstUrl, { method: 'POST', body: 'original body',
    headers: { 'x-original': 'discarded' }, signal: original.signal });
  original.abort();
  const pending = outcome(routedFetch(input, { method: 'PATCH', body: 'selected body',
    headers: { 'x-selected': 'retained' }, signal: selected.signal }));
  await waitFor(() => Boolean(dialog()?.textContent?.includes('PATCH /api/owned-stepup-mutation')));
  click('Verify with passkey');
  expect(await response(await pending).text()).toBe('owned effective request result');
  expect(attempts).toHaveLength(2);
  const first = attempts[0], retry = attempts[1];
  if (!first || !retry) throw new Error('Missing effective Request attempts');
  for (const value of attempts) {
    expect(value.method).toBe('PATCH');
    expect(value.url).toBe(firstUrl);
    expect(value.body).toBe('selected body');
    expect(value.headers.get('x-selected')).toBe('retained');
    expect(value.headers.has('x-original')).toBe(false);
    expect(value.signal.aborted).toBe(false);
  }
  expect(first.headers.has(STEP_UP_ASSERTION_HEADER)).toBe(false);
  expect(retry.headers.has(STEP_UP_ASSERTION_HEADER)).toBe(true);
  const retryHeaders = new Headers(retry.headers);
  retryHeaders.delete(STEP_UP_ASSERTION_HEADER);
  expect(Array.from(retryHeaders)).toEqual(Array.from(first.headers));
  selected.abort();
  expect(first.signal.aborted).toBe(true);
  expect(retry.signal.aborted).toBe(true);
});

test('explicit init null detaches the input Request signal throughout the live prompt and retry', async () => {
  relayReplies.push(required(), new Response('owned null override result'));
  mintReplies.push(Promise.resolve(challenge));
  credentialReplies.push(Promise.resolve(credential('null-override-credential')));
  renderHost();
  const original = new AbortController();
  const input = new Request(firstUrl, { method: 'POST', body: 'retained body', signal: original.signal });
  const pending = outcome(routedFetch(input, { signal: null }));
  await waitFor(() => Boolean(dialog()));
  flushSync(() => original.abort());
  expect(dialog()?.textContent).toContain('POST /api/owned-stepup-mutation');
  click('Verify with passkey');
  expect(await response(await pending).text()).toBe('owned null override result');
  expect(original.signal.aborted).toBe(true);
  expect(attempts).toHaveLength(2);
  expect(attempts.every(value => !value.signal.aborted && value.body === 'retained body')).toBe(true);
});
