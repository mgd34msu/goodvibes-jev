/**
 * Turning a CONFIGURED host value into an address this process can dial.
 *
 * `controlPlane.host` (and `httpListener.host`) hold a BIND address, the
 * interface the daemon listens on. `0.0.0.0` and `::` are wildcards: they mean
 * "every interface", and they are legitimate, common values to bind to. They
 * are not addresses anything can connect TO. Handing `http://0.0.0.0:3421` to
 * fetch() is how the profile calls came back refused: the wildcard was copied
 * straight out of config into a dial URL.
 *
 * A wildcard bind is not a dial target; loopback is the interface it answers
 * on. Every client-side base URL built from configured host values goes through
 * here so that mapping exists in one place instead of being re-derived, and
 * re-forgotten, per call site.
 *
 * NOT for advertised addresses. A URL handed to ANOTHER machine, a pairing QR
 * code, a phone-facing web link, must resolve a wildcard to this host's LAN
 * address, never to loopback, because loopback on the phone is the phone. Those
 * sites keep their own `urlHostForBindHost` helpers, which resolve through
 * getLocalNetworkIp() on purpose. This module is client-dial-side only, and it
 * never rewrites the bind config itself.
 */

/** The interface a wildcard-bound listener answers on locally. */
export const LOOPBACK_DIAL_HOST = '127.0.0.1';

/** The connected host's port when config carries no usable one. */
export const DEFAULT_CONNECTED_HOST_PORT = 3421;

/** Bind addresses that name every interface rather than a reachable one. */
const WILDCARD_BIND_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]']);

/**
 * The host this process should dial for a given configured bind host.
 *
 * Wildcards and blank/absent values both resolve to loopback, a missing host
 * means the local daemon, which is the same place a wildcard answers.
 */
export function dialHostForConfiguredHost(host: unknown): string {
  const trimmed = typeof host === 'string' ? host.trim() : '';
  if (trimmed.length === 0) return LOOPBACK_DIAL_HOST;
  if (WILDCARD_BIND_HOSTS.has(trimmed)) return LOOPBACK_DIAL_HOST;
  return trimmed;
}

/**
 * The same dial host, in the form a URL authority needs: a bare IPv6 literal
 * gets its brackets, so `::1` becomes `[::1]` and the URL stays parseable.
 */
export function urlHostForConfiguredHost(host: unknown): string {
  const dialHost = dialHostForConfiguredHost(host);
  return dialHost.includes(':') && !dialHost.startsWith('[') ? `[${dialHost}]` : dialHost;
}

/** The connected host's port, defaulting when config carries no finite number. */
export function connectedHostPort(port: unknown, fallback = DEFAULT_CONNECTED_HOST_PORT): number {
  const value = typeof port === 'number' ? port : Number(port);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The connected host's base URL: the one construction every client-side dial
 * site shares. Takes the raw config values so no caller has to remember either
 * the wildcard mapping or the IPv6 bracketing.
 */
export function connectedHostBaseUrl(
  host: unknown,
  port: unknown,
  portFallback = DEFAULT_CONNECTED_HOST_PORT,
): string {
  return `http://${urlHostForConfiguredHost(host)}:${connectedHostPort(port, portFallback)}`;
}

/**
 * Read `controlPlane.host`/`controlPlane.port` off a config reader and resolve
 * them to a dial address in one step, what most call sites actually want.
 */
export function resolveConnectedHostBaseUrl(
  configManager: { get(key: 'controlPlane.host' | 'controlPlane.port'): unknown },
): string {
  return connectedHostBaseUrl(
    configManager.get('controlPlane.host'),
    configManager.get('controlPlane.port'),
  );
}
