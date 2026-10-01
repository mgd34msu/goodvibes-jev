/**
 * relay-connection.ts, the transport ROUTE the SDK client dispatches requests over.
 *
 * Two transports can answer a request:
 *   - direct: an ordinary `fetch` against GOODVIBES_BASE_URL (the LAN/co-located path,
 *     unchanged from before this file existed).
 *   - relay: `createRelayClient` (@goodvibes-jev/engine/transport-realtime) tunnels unary
 *     request/response calls, end-to-end encrypted, through a relay server, for when
 *     this device cannot reach the daemon directly. It requires a stored pairing (see
 *     relay-pairing.ts).
 *
 * STREAMING OVER RELAY: the relay tunnel now carries live event streams. A request whose
 * `Accept` is `text/event-stream` (the SSE opener's header, see
 * @goodvibes-jev/engine/transport-http's sse-stream.js) is opened by the relay client as a
 * tunnelled stream: the returned `Response` carries a `ReadableStream` body fed by the
 * tunnel's `stream-data` frames, and a dropped-chunk overflow surfaces as a visible
 * `relay-overflow` SSE event (never a silent gap). So `routedFetch` no longer rejects SSE
 * over relay, it hands the request straight to the relay client like any other, and the
 * webui's stream consumers render the `relay-overflow` notice honestly (see
 * relay-stream-overflow.ts).
 *
 * STEP-UP ON MUTATING RELAY CALLS: the daemon gates state-changing relay calls behind a
 * WebAuthn step-up assertion. A mutating call over the relay with no fresh assertion is
 * answered `401` with `www-authenticate: WebAuthn` and body `{ error: 'step-up-required' }`.
 * `routedFetch` intercepts exactly that response, asks the registered UI prompter to run the
 * passkey ceremony (stepup-prompter.ts), and retries the original call ONCE with the
 * assertion header attached. If no prompter is registered, or the operator cancels, or the
 * server reports no verifier is available, the original 401 surfaces honestly, never a
 * silent skip of verification.
 *
 * `routedFetch` is the one `fetch` implementation the SDK client is built with
 * (lib/goodvibes.ts). It always exists and behaves exactly like the plain global fetch
 * when no relay pairing is stored, this file changes nothing for the common LAN/
 * co-located case.
 */

import { createRelayClient, type RelayClient } from '@goodvibes-jev/engine/transport-realtime';
import { getStoredRelayPairing, type RelayPairingPayload } from './relay-pairing';
import { STEP_UP_ASSERTION_HEADER } from './stepup';
import { resolveStepUp } from './stepup-prompter';
import { invalidateClientLifetime } from './client-lifetime';

export type ConnectionRoute = 'direct' | 'relay';

// ---------------------------------------------------------------------------
// Route store, a tiny module-level pub/sub. Plain (non-React) code, like
// routedFetch below, reads the snapshot directly; React reads it reactively via
// useSyncExternalStore in useDaemonHealth.
// ---------------------------------------------------------------------------

let activeRoute: ConnectionRoute = 'direct';
const listeners = new Set<() => void>();

/** Current active route. Defaults to 'direct'; relay is opt-in and probe-driven. */
export function getActiveRoute(): ConnectionRoute {
  return activeRoute;
}

/** Switch the active route. A no-op notify-wise if unchanged (avoids extra renders). */
export function setActiveRoute(route: ConnectionRoute): void {
  if (activeRoute === route) return;
  activeRoute = route;
  invalidateClientLifetime();
  for (const listener of listeners) listener();
}

export function subscribeActiveRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Relay client, lazy singleton over the stored pairing. Rebuilt if the stored
// pairing changes (e.g. a fresh scan replacing an old one).
// ---------------------------------------------------------------------------

let client: RelayClient | null = null;
let clientForPairingKey: string | null = null;

function pairingKey(pairing: RelayPairingPayload): string {
  return `${pairing.relayUrl}|${pairing.rid}|${pairing.daemonPublicKey}`;
}

/** Get (creating if needed) the relay client for the currently-stored pairing, or null if none is stored. */
export function getRelayClient(): RelayClient | null {
  const pairing = getStoredRelayPairing();
  if (!pairing) {
    client = null;
    clientForPairingKey = null;
    return null;
  }
  const key = pairingKey(pairing);
  if (client && clientForPairingKey === key) return client;
  if (client) client.close();
  client = createRelayClient({ pairing });
  clientForPairingKey = key;
  return client;
}

/** Tear down the relay client (e.g. after clearing the stored pairing). */
export function closeRelayClient(): void {
  invalidateClientLifetime();
  if (client) client.close();
  client = null;
  clientForPairingKey = null;
}

/**
 * Attempt to reach the daemon over the relay: connect the client (idempotent) and
 * confirm the end-to-end channel is ready. Returns false, never throws, on any
 * failure (no pairing stored, handshake failure, relay unreachable, timeout).
 */
export async function probeRelayReachability(): Promise<boolean> {
  const relayClient = getRelayClient();
  if (!relayClient) return false;
  try {
    await relayClient.connect();
    return relayClient.ready;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// routedFetch, the fetch the SDK client is built with.
// ---------------------------------------------------------------------------

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The HTTP method a fetch call carries, uppercased. Mirrors the relay gate's own view. */
function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
}

/** The request path (no host) a fetch call targets, what the step-up ceremony binds against. */
function requestPath(input: RequestInfo | URL): string {
  try {
    const href = input instanceof Request ? input.url : String(input);
    return new URL(href, globalThis.location?.origin ?? 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}

/** True when a fetch response is the daemon's "this call needs a fresh step-up assertion". */
async function isStepUpRequired(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  if (!/WebAuthn/i.test(response.headers.get('www-authenticate') ?? '')) return false;
  // Distinguish 'step-up-required' (retry with an assertion helps) from
  // 'step-up-verifier-unavailable' (retrying cannot help, surface it). Peek a clone so
  // the caller's response body stays intact when we decide not to retry.
  try {
    const body = (await response.clone().json()) as { error?: string };
    return body?.error === 'step-up-required';
  } catch {
    return false;
  }
}

/** Re-issue a relay fetch with the step-up assertion header attached, preserving body/method. */
function withAssertion(
  relayClient: RelayClient,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  retryRequest: Request | null,
  assertion: string,
): Promise<Response> {
  if (retryRequest) {
    const headers = new Headers(retryRequest.headers);
    headers.set(STEP_UP_ASSERTION_HEADER, assertion);
    return relayClient.fetch(new Request(retryRequest, { headers }));
  }
  const headers = new Headers(init?.headers ?? undefined);
  headers.set(STEP_UP_ASSERTION_HEADER, assertion);
  return relayClient.fetch(input, { ...init, headers });
}

/**
 * Dispatch one relay fetch, transparently satisfying a step-up challenge on a mutating call.
 * On a `401 step-up-required`, runs the UI ceremony and retries ONCE with the assertion
 * header. Every non-step-up response (including a 401 with no verifier, or a cancelled
 * ceremony) is returned unchanged so the caller sees the honest outcome.
 */
async function relayFetchWithStepUp(relayClient: RelayClient, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const mutating = !READ_METHODS.has(requestMethod(input, init));
  // Only mutating calls can be gated; clone a Request body up front so a retry is possible
  // (a Request's body is single-use). Reads never need a retry path.
  const retryRequest = mutating && input instanceof Request ? input.clone() : null;

  const first = await relayClient.fetch(input, init);
  if (!mutating || !(await isStepUpRequired(first))) return first;

  const assertion = await resolveStepUp({ method: requestMethod(input, init), path: requestPath(input) });
  if (!assertion) return first; // no prompter / cancelled / unsupported, surface the 401 honestly
  return withAssertion(relayClient, input, init, retryRequest, assertion);
}

/**
 * The fetch implementation the SDK client dispatches every call through. Routes to
 * the relay's tunneled fetch when the active route is 'relay'; otherwise behaves
 * exactly like the platform's native fetch (the pre-relay default).
 */
function routedFetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (activeRoute !== 'relay') return globalThis.fetch(input, init);

  const relayClient = getRelayClient();
  if (!relayClient) return globalThis.fetch(input, init);
  return relayFetchWithStepUp(relayClient, input, init);
}

// The runtime's `fetch` carries a `preconnect` static (a Bun extension the SDK's
// `typeof fetch` option type inherits from this project's global types) that a plain
// function value structurally lacks. Delegate it straight to the real fetch's own
// implementation so routedFetch is a genuine drop-in, not just a same-shaped cast.
export const routedFetch: typeof fetch = Object.assign(routedFetchImpl, {
  preconnect: (...args: Parameters<typeof fetch.preconnect>) => globalThis.fetch.preconnect(...args),
});
