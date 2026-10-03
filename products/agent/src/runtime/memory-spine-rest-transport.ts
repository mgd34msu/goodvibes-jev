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

import { createMemorySpineRestTransport as createSdkMemorySpineRestTransport } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import type { MemoryTransport } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
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
      return await fetch(input, { ...init, signal: controller.signal });
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

  const build = (): MemoryTransport => {
    const connection = options.resolveConnection();
    requireToken(connection);
    return createSdkMemorySpineRestTransport({
      baseUrl: connection.baseUrl,
      authToken: connection.token,
      fetchImpl,
    });
  };

  return new Proxy({} as MemoryTransport, {
    get(_target, prop, _receiver) {
      // Async wrapper: every MemoryTransport method is async, and `build()`
      // (which asserts a token is present) must throw as a REJECTED PROMISE,
      // not a synchronous exception, a synchronous throw here would escape
      // before the caller's own `await`/`.rejects` ever sees a promise, per
      // the honest-failure contract every caller of this transport relies on.
      return async (...args: unknown[]) => {
        const transport = build() as unknown as Record<PropertyKey, unknown>;
        const method = transport[prop];
        if (typeof method !== 'function') return method;
        return (method as (...a: unknown[]) => unknown).apply(transport, args);
      };
    },
  });
}
