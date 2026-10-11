/**
 * memory-spine-rest-transport.ts
 *
 * Thin adapter over the SDK's own memory-spine REST transport
 * (`@goodvibes-jev/engine/sdk/platform/runtime/memory-spine`), which implements
 * the full CORE + EXTENDED verb catalog directly on the platform's own
 * transport-http primitives. The hand-rolled `wireFetch`/per-verb JSON
 * parsing is retired in favor of that shared implementation (see the SDK
 * module's own "Hoist provenance" doc comment: the TUI's version was adopted
 * as the superset, unchanged behavior-wise from the agent's for every verb
 * this agent calls).
 *
 * What stays agent-local, because the SDK's transport takes a fixed
 * `{baseUrl, authToken}` at construction rather than a resolver:
 *  - Re-resolving the connection (and therefore the bearer token) on EVERY
 *    call, not just once at construction, a token that appears on disk
 *    after boot must be picked up without re-constructing this transport.
 *    Achieved by building a fresh SDK transport instance per call rather than
 *    caching one.
 *  - The "no connected-host operator token found" honest-rejection message
 *    this surface's callers and tests depend on. The SDK transport has no
 *    such pre-flight check (it would simply omit the Authorization header and
 *    let the daemon's own 401 propagate), so it is reproduced here as a guard
 *    that runs before every delegated call.
 *  - A bounded per-call timeout via an AbortController-wrapped `fetchImpl`,
 *    matching this surface's prior default (2s), the SDK transport accepts
 *    an injectable `fetchImpl` for exactly this kind of consumer policy.
 */

import { createMemorySpineRestTransport as createSdkMemorySpineRestTransport, captureMemoryOperation, assertMemoryOperationCurrent, awaitMemoryOperation, memoryVerbUnavailableError } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import type { MemoryTransport, MemoryOperationOptions } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import type { SessionRegistrationConnection } from './session-spine-rest-transport.ts';

const DEFAULT_MEMORY_WIRE_TIMEOUT_MS = 2_000;

export interface MemorySpineRestTransportOptions {
  readonly resolveConnection: () => SessionRegistrationConnection;
  readonly timeoutMs?: number;
}

/** Wraps global fetch with a per-call AbortController timeout. */
function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
      return await awaitMemoryOperation(() => fetch(input, { ...init, signal }), { signal });
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

function requireToken(connection: SessionRegistrationConnection): void {
  if (connection.token) return;
  throw new Error(connection.tokenPath
    ? `memory spine: no connected-host operator token found at ${connection.tokenPath}`
    : 'memory spine: no connected-host operator token found');
}

/**
 * Builds the wire `MemoryTransport` the agent injects into `MemorySpineClient`
 * once it has confirmed a daemon is adopted. Every method resolves the
 * connection fresh, asserts a token is present (the honest-failure contract),
 * and delegates to a freshly built SDK transport, cheap, since the SDK
 * transport is a plain object of closures over its construction options.
 */
export function createMemorySpineRestTransport(options: MemorySpineRestTransportOptions): MemoryTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEMORY_WIRE_TIMEOUT_MS;
  const fetchImpl = createTimeoutFetch(timeoutMs);
  const optionsResolver = options.resolveConnection;
  const captureOperationScope = () => {
    const connection = optionsResolver();
    const baseUrl = connection.baseUrl, token = connection.token, tokenPath = connection.tokenPath;
    return () => {
      if (options.resolveConnection !== optionsResolver) throw new Error('Memory spine connection resolver changed');
      const current = optionsResolver();
      if (current.baseUrl !== baseUrl || current.token !== token || current.tokenPath !== tokenPath) {
        throw new Error('Memory spine connection changed');
      }
    };
  };

  const call = async <T>(verb: string, lifecycle: MemoryOperationOptions | undefined,
    invoke: (transport: MemoryTransport, operation: MemoryOperationOptions) => Promise<T> | undefined): Promise<T> => {
    const caller = captureMemoryOperation(lifecycle);
    assertMemoryOperationCurrent(caller);
    const scope = captureOperationScope();
    const operation = captureMemoryOperation({ signal: caller.signal, assertCurrent: () => {
      assertMemoryOperationCurrent(caller); scope();
    } });
    return awaitMemoryOperation(() => {
      assertMemoryOperationCurrent(operation);
      if (options.resolveConnection !== optionsResolver) throw new Error('Memory spine connection resolver changed');
      const connection = optionsResolver();
      requireToken(connection);
      assertMemoryOperationCurrent(operation);
      const transport = createSdkMemorySpineRestTransport({
        baseUrl: connection.baseUrl, authToken: connection.token, fetchImpl,
      });
      const result = invoke(transport, operation);
      if (!result) throw memoryVerbUnavailableError(verb);
      return result;
    }, operation);
  };
  return {
    captureOperationScope,
    add: (opts, operation) => call('add', operation, (transport, owned) => transport.add(opts, owned)),
    honestSearch: (filter, searchOptions, operation) => call('honestSearch', operation, (transport, owned) => transport.honestSearch(filter, searchOptions, owned)),
    get: (id, operation) => call('get', operation, (transport, owned) => transport.get(id, owned)),
    updateReview: (id, patch, operation) => call('updateReview', operation, (transport, owned) => transport.updateReview(id, patch, owned)),
    delete: (id, operation) => call('delete', operation, (transport, owned) => transport.delete(id, owned)),
    list: (filter, operation) => call('list', operation, (transport, owned) => transport.list?.(filter, owned)),
    searchSemantic: (filter, operation) => call('searchSemantic', operation, (transport, owned) => transport.searchSemantic?.(filter, owned)),
    update: (id, patch, operation) => call('update', operation, (transport, owned) => transport.update?.(id, patch, owned)),
    link: (fromId, toId, relation, operation) => call('link', operation, (transport, owned) => transport.link?.(fromId, toId, relation, owned)),
    linksFor: (id, operation) => call('linksFor', operation, (transport, owned) => transport.linksFor?.(id, owned)),
    reviewQueue: (limit, scope, operation) => call('reviewQueue', operation, (transport, owned) => transport.reviewQueue?.(limit, scope, owned)),
    exportBundle: (filter, operation) => call('exportBundle', operation, (transport, owned) => transport.exportBundle?.(filter, owned)),
    importBundle: (bundle, operation) => call('importBundle', operation, (transport, owned) => transport.importBundle?.(bundle, owned)),
    vectorStats: (operation) => call('vectorStats', operation, (transport, owned) => transport.vectorStats?.(owned)),
    doctor: (operation) => call('doctor', operation, (transport, owned) => transport.doctor?.(owned)),
  };
}
