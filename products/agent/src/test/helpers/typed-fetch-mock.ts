/**
 * typed-fetch-mock.ts
 *
 * Returns a correctly-typed `typeof fetch` mock that includes Bun's
 * `preconnect` namespace property so tests can safely assign to
 * `globalThis.fetch` or pass the result as `typeof fetch` without
 * TypeScript complaining about the missing `preconnect` member.
 *
 * Usage:
 *
 *   const mockFn = mockFetch(async (input, init) => new Response('ok'));
 *   globalThis.fetch = mockFn;
 *   // ... test ...
 *   globalThis.fetch = originalFetch;
 */

/**
 * Wrap an async handler function so that the resulting value satisfies
 * `typeof fetch` (including Bun's `fetch.preconnect` extension).
 */
export function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    handler(input, init);

  // Attach Bun's preconnect namespace so the type is fully satisfied.
  (fn as unknown as { preconnect: typeof fetch['preconnect'] }).preconnect =
    fetch.preconnect;

  return fn as unknown as typeof fetch;
}
