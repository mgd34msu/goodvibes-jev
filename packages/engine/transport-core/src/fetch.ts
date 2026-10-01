/**
 * The portable fetch call contract used by HTTP and relay transports.
 * Host-specific static helpers (such as Bun's preconnect) are not required
 * from a wrapped or injected implementation.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
