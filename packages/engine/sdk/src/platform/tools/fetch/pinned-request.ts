import { assertDeliveryCurrent } from '../../utils/delivery-lifetime.js';
/**
 * Resolve, check and pin one fetch hop.
 *
 * The trust-tier check (trust-tiers.ts) sees only the host as written, so a
 * name whose DNS answer is a loopback, private, link-local or metadata address
 * passed it. Before every request, the first and each redirect hop, the host is
 * resolved (every A and AAAA answer), each answer is compared with the declared
 * address ranges (classifyResolvedAddress, arithmetic on the address), and the
 * request is sent to an address that was checked: the URL names that address,
 * while the Host header, TLS SNI and certificate check keep the written name.
 * A second lookup therefore cannot rebind the connection to another address.
 * When the first checked address refuses the connection, the next checked
 * answer is tried, as the system would across a name's answers.
 *
 * Loopback answers are allowed only for a hop whose written host is itself a
 * plain loopback target (localhost, 127.x, ::1) that the project approved; a
 * name that merely resolves to loopback is refused. A host that does not
 * resolve is refused, since nothing was checked.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { classifyHostTrustTier, classifyResolvedAddress, emitSsrfDeny, type TrustTierConfig } from './trust-tiers.js';

/** One DNS answer. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Resolves a host name to every A and AAAA answer. */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** The system resolver: every answer, in the order the resolver gives them. */
export const systemResolver: HostResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

/** A hop's host as the URL grammar gives it, without IPv6 brackets. */
const bareHost = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

/**
 * Resolves the URL's host and checks every answer. Returns the checked
 * addresses the request may use, in resolver order; throws
 * `Request blocked: ...` when any answer is in a refused range or the host
 * does not resolve.
 */
export async function resolveCheckedAddresses(
  url: string,
  options: {
    readonly trustTierConfig: TrustTierConfig;
    readonly localhostApproved: boolean;
    readonly resolveHost?: HostResolver | undefined;
    /** Diagnostic projection only; every address is still checked unchanged. */
    readonly diagnosticMode?: 'default' | 'opaque-url';
  },
): Promise<readonly ResolvedAddress[]> {
  const parsed = new URL(url);
  const host = bareHost(parsed);
  const writtenLoopback = classifyHostTrustTier(host, options.trustTierConfig).tier === 'localhost';
  let answers: readonly ResolvedAddress[];
  if (isIP(host)) {
    answers = [{ address: host, family: isIP(host) }];
  } else {
    try {
      answers = await (options.resolveHost ?? systemResolver)(host);
    } catch (error) {
      throw new Error(`Request blocked: host "${host}" did not resolve, so its address could not be checked (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (answers.length === 0) throw new Error(`Request blocked: host "${host}" resolved to no address`);
  for (const answer of answers) {
    const range = classifyResolvedAddress(answer.address);
    if (range === null) continue;
    if (range === 'loopback' && writtenLoopback && options.localhostApproved) continue;
    const reason = `host "${host}" resolves to ${answer.address}, a ${range} address, SSRF risk`;
    if (options.diagnosticMode === 'opaque-url') {
      emitSsrfDeny('[redacted-host]', '[redacted-url]', 'Resolved address is not allowed');
    } else {
      emitSsrfDeny(host, url, reason);
    }
    throw new Error(`Request blocked: ${reason}`);
  }
  return answers;
}

/**
 * Sends the request to a checked address, trying the next one when a
 * connection cannot be made (an HTTP response of any status is final). The URL carries the address; the
 * Host header carries the written host and port; for https the TLS server name
 * and the certificate check use the written host, so the certificate must be
 * valid for the name the caller asked for.
 */
export async function pinnedFetch(
  url: string,
  init: RequestInit,
  addresses: readonly ResolvedAddress[],
  diagnosticMode: 'default' | 'opaque-url' = 'default',
  assertCurrent?: () => void,
): Promise<Response> {
  const host = bareHost(new URL(url));
  const lifetime = { signal: init.signal ?? undefined, assertCurrent };
  assertDeliveryCurrent(lifetime);
  if (isIP(host)) return instrumentedFetch(url, init, diagnosticMode);
  let lastError: unknown;
  for (const address of addresses) {
    assertDeliveryCurrent(lifetime);
    try {
      return await fetchAddress(url, init, host, address, diagnosticMode);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchAddress(url: string, init: RequestInit, host: string, address: ResolvedAddress, diagnosticMode: 'default' | 'opaque-url'): Promise<Response> {
  const parsed = new URL(url);
  const pinned = new URL(url);
  pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  const headers = new Headers(init.headers);
  headers.set('host', parsed.host);
  const tls = parsed.protocol === 'https:'
    ? { tls: { serverName: host, checkServerIdentity: (_name: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(host, cert) } }
    : {};
  return instrumentedFetch(pinned.toString(), { ...init, headers, ...tls } as RequestInit, diagnosticMode);
}
