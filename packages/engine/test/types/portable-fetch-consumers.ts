/** Public transport consumers accept a wrapped fetch under the actual Bun ambient types. */
import type {} from 'bun';
import type { FetchLike } from '@goodvibes-jev/engine/transport-core';
import { createFetch, createHttpTransport, openRawServerSentEventStream, requestJsonRaw } from '@goodvibes-jev/engine/transport-http';
import { createEventSourceConnector, type RelayClient } from '@goodvibes-jev/engine/transport-realtime';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createPeerSdk } from '@goodvibes-jev/engine/peer-sdk';
import { createGoodVibesSdk } from '@goodvibes-jev/engine/sdk';
import { createBrowserGoodVibesSdk } from '@goodvibes-jev/engine/sdk/browser';
import { createBrowserKnowledgeSdk } from '@goodvibes-jev/engine/sdk/browser/knowledge';
import { createHttpTransport as createRuntimeHttpTransport, createRealtimeTransport } from '@goodvibes-jev/engine/sdk/platform/runtime/transport';

const callable: FetchLike = async (_input, _init) => new Response('fixture');
const hostFetch: FetchLike = globalThis.fetch;
// This assertion pins Bun's actual static-member distinction. Portable fetch
// does not pretend that an injected function has the host's preconnect helper.
// @ts-expect-error a callable-only fetch does not provide Bun's static preconnect
const hostWithStatics: typeof fetch = callable;
// @ts-expect-error fetch implementations return a Promise<Response>
const synchronous: FetchLike = () => new Response('fixture');

/** Compiled only: the type gate never creates clients or opens a network request. */
export function verifyPortableFetchConsumers(relay: RelayClient): void {
  const baseUrl = 'https://fixture.invalid';
  const implementations: FetchLike[] = [callable, hostFetch, relay.fetch];
  for (const fetchImpl of implementations) {
    createOperatorSdk({ baseUrl, fetchImpl });
    createPeerSdk({ baseUrl, fetchImpl });
    createGoodVibesSdk({ baseUrl, fetch: fetchImpl });
    createBrowserGoodVibesSdk({ baseUrl, fetch: fetchImpl });
    createBrowserKnowledgeSdk({ baseUrl, fetch: fetchImpl });
    createHttpTransport({ baseUrl, fetchImpl, fetch: fetchImpl });
    createRuntimeHttpTransport({ baseUrl, fetchImpl });
    createRealtimeTransport({ baseUrl, fetchImpl });
    createEventSourceConnector(baseUrl, null, fetchImpl);
    createFetch(fetchImpl, hostFetch);
    void requestJsonRaw(fetchImpl, baseUrl);
    void openRawServerSentEventStream(fetchImpl, baseUrl, {});
    void fetchImpl(baseUrl);
    void fetchImpl(new URL(baseUrl), { method: 'GET' });
    void fetchImpl(new Request(baseUrl), { signal: new AbortController().signal });
    // @ts-expect-error request input remains constrained to the standard fetch inputs
    void fetchImpl(42);
  }
}

void hostWithStatics;
void synchronous;
