import { assertDeliveryCurrent } from './delivery-lifetime.js';
/**
 * Public webhook URLs: the checks every webhook callback and delivery target
 * passes, and the delivery request itself.
 *
 * - validatePublicWebhookUrl (at intake): https only, no credentials in the
 *   URL, and a host that is not a loopback name (`localhost`, `*.localhost`,
 *   RFC 6761) or an address in a refused range as written. The ranges are the
 *   fetch tool's (tools/fetch/trust-tiers.ts classifyResolvedAddress), one
 *   declaration for the engine; a name is not judged by its spelling.
 * - postToPublicWebhook (at delivery): the same validation, then the host is
 *   resolved (every A and AAAA answer), every answer is checked against those
 *   ranges, and the request is sent pinned to a checked address with the
 *   written name kept for the Host header, TLS SNI and the certificate check
 *   (tools/fetch/pinned-request.ts), so a name that resolves to a private,
 *   loopback, link-local or metadata address, or is rebound between the check
 *   and the connection, is refused. Redirects are not followed: the delivery
 *   goes to the address that was checked.
 */

import { isIP } from 'node:net';
import { classifyResolvedAddress } from '../tools/fetch/trust-tiers.js';
import { pinnedFetch, resolveCheckedAddresses, type HostResolver } from '../tools/fetch/pinned-request.js';

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host)) return classifyResolvedAddress(host) !== null;
  return false;
}

export function validatePublicWebhookUrl(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid webhook URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Webhook URL must use https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Webhook URL must not include credentials' };
  }
  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, error: 'Webhook URL host is not allowed' };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Sends a webhook delivery to a public URL: validated, resolved, every answer
 * checked, and pinned to a checked address; redirects are returned, not
 * followed. Throws when the URL or any resolved address is refused.
 */
export async function postToPublicWebhook(
  rawUrl: string,
  init: RequestInit,
  options: { readonly resolveHost?: HostResolver | undefined; readonly assertCurrent?: (() => void) | undefined } = {},
): Promise<Response> {
  const lifetime = { signal: init.signal ?? undefined, assertCurrent: options.assertCurrent };
  assertDeliveryCurrent(lifetime);
  const validation = validatePublicWebhookUrl(rawUrl);
  if (!validation.ok) throw new Error(validation.error);
  const addresses = await resolveCheckedAddresses(validation.url, {
    trustTierConfig: {},
    localhostApproved: false,
    resolveHost: options.resolveHost,
    diagnosticMode: 'opaque-url',
  });
  assertDeliveryCurrent(lifetime);
  return pinnedFetch(validation.url, { ...init, redirect: 'manual' }, addresses, 'opaque-url', options.assertCurrent);
}
