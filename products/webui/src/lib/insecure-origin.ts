/**
 * insecure-origin.ts, the entry guard for the plain-http-on-a-genuinely-PUBLIC-origin
 * white screen.
 *
 * THE FAILURE THIS CATCHES: the SDK transport refuses an insecure PUBLIC baseUrl by
 * THROWING at module evaluation (`SDK_TRANSPORT_INSECURE_BASE_URL` in
 * @goodvibes-jev/engine/transport-http). That throw fires the instant `src/lib/goodvibes.ts`
 * is imported, before React mounts, so an operator who opens the daemon over a plain
 * `http://` public hostname used to get a silent blank `#root` with only a console
 * pageerror. The guard itself is correct (a genuinely public origin is meant to run over
 * HTTPS); the gap was purely the SILENT failure mode.
 *
 * PRIVATE-NETWORK LAN POSTURE (SDK 1.8.0): plain http on a private-network origin,
 * loopback, an RFC 1918 range (10/8, 172.16/12, 192.168/16), or an mDNS `.local` name,
 * is a DELIBERATE, SUPPORTED posture (a phone on the same LAN talking to the daemon), not
 * a mistake to wall off: TLS on a home network is the user's own responsibility and the
 * daemon never mints certificates, so the transport WORKS over http there and no longer
 * throws. This wall now fires ONLY for a genuinely public http/ws origin, the browser-
 * gated capabilities (service worker/PWA install, push, microphone) on a private-network
 * http origin instead render as labeled degradation from `pairing.posture.get`
 * (src/hooks/useOriginPosture.ts), never a dead button and never this wall.
 *
 * So this module re-derives the SAME public/private-network boundary the transport uses
 * (`isPrivateNetworkHost`, packages/transport-http/src/paths.ts) WITHOUT importing
 * lib/goodvibes (importing it would re-trigger the very throw we are trying to get ahead
 * of, and pulling in the SDK package here at all would be pointless weight for a guard
 * that must run before anything else). main.tsx checks `isInsecureTransportOrigin()`
 * FIRST and, when true, renders the honest HTTPS message instead of importing App at all.
 */

export const INSECURE_ORIGIN_TITLE = 'This page needs HTTPS';

export const INSECURE_ORIGIN_BODY =
  'GoodVibes needs a secure (HTTPS) connection over the public internet; open it over '
  + 'HTTPS instead of plain http. The daemon refuses to talk to an insecure public '
  + 'origin, so the app cannot start here. Plain http is supported on your own LAN '
  + '(localhost, a private network address, or a .local name), this page would work '
  + 'there.';

/**
 * The baseUrl the SDK transport would be handed, identical source to
 * `GOODVIBES_BASE_URL` in lib/goodvibes.ts, re-derived here so we never import that
 * (throwing) module. `VITE_GOODVIBES_BASE_URL` wins if set; otherwise the page origin.
 */
function effectiveBaseUrl(): string {
  const configured = import.meta.env?.VITE_GOODVIBES_BASE_URL as string | undefined;
  if (configured) return configured;
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/**
 * Mirror of `isPrivateNetworkHost` (packages/transport-http/src/paths.ts, SDK 1.8.0):
 * loopback, an RFC 1918 range, or an mDNS `.local` name. Kept as a local, dependency-free
 * duplicate rather than an import for the reason in the file header, this predicate must
 * stay correct even if the SDK package can't be loaded at all.
 */
function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true; // mDNS
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return false;
}

/**
 * Mirror of the transport guard's insecure predicate: an http/ws baseUrl on a genuinely
 * PUBLIC host (never a private-network one), unless GOODVIBES_ALLOW_INSECURE_TRANSPORT=true
 * opts out. Returns true exactly when the SDK would throw SDK_TRANSPORT_INSECURE_BASE_URL,
 * so the honest message shows in precisely the cases the app would otherwise blank-screen,
 * and never otherwise. A private-network http origin (LAN IP, .local, localhost) is a
 * supported posture and never trips this wall, see the file header.
 */
export function isInsecureTransportOrigin(): boolean {
  // Honor the same explicit override the SDK guard honors, so an intentional insecure
  // deployment does not get the message.
  const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (runtimeProcess?.env?.GOODVIBES_ALLOW_INSECURE_TRANSPORT === 'true') return false;

  const base = effectiveBaseUrl();
  if (!base) return false;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  const protocol = url.protocol;
  if (protocol !== 'http:' && protocol !== 'ws:') return false;
  return !isPrivateNetworkHost(url.hostname);
}
