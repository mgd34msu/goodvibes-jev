/**
 * web-origin.ts, the web-app origin a pairing deep link points at, and the
 * one-time write of `web.publicBaseUrl` from the stable-name resolution.
 *
 * An explicit public URL is authoritative. The bundled WebUI shares the
 * control-plane listener: its fallback must use that binding, not the declared
 * web port, which has no separate bundle listener. Other web surfaces retain
 * their declared endpoint fallback. The bundled case treats the exact shipped
 * public URL placeholder like an empty value, as the daemon webui command does.
 */
import type { ConfigManager } from '../config/manager.js';
import { resolveHostBinding, resolveWebPort } from '../daemon/host-resolver.js';
import { isLoopbackHost } from './origin-posture.js';
import { stableUrlHostForBindHost, type ResolvedStableHost, type StableHostInputs } from './stable-host.js';

export interface PairingWebOrigin {
  readonly origin: string;
  readonly resolvedHost: ResolvedStableHost;
  /** True when the origin is http:// on a non-loopback host, the honest LAN-posture case. */
  readonly httpOnLan: boolean;
  /** True when the origin came verbatim from a user-set web.publicBaseUrl. */
  readonly fromPublicBaseUrl: boolean;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Format a bind host and port as HTTP authority, retaining IPv6 brackets. */
export function formatHttpOrigin(host: string, port: number): string {
  const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authorityHost}:${port}`;
}

/** http:// on anything other than loopback is served in the clear on the LAN. */
export function isHttpOnLan(origin: string): boolean {
  if (!origin.startsWith('http://')) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  // `URL.hostname` keeps the brackets on an IPv6 host (`[::1]`), so the old
  // `!== '::1'` never matched; the shared rule strips them.
  return !isLoopbackHost(host);
}

/**
 * The bind host the web endpoint is configured for, from `web.hostMode` and
 * `web.host`. A wildcard bind ('network') is what sends the caller through the
 * stable-name ladder; every other mode names its own host, and an unrecognized
 * mode falls back to loopback rather than guessing something routable.
 */
function webBindHost(config: Pick<ConfigManager, 'get'>): string {
  const hostMode = String(config.get('web.hostMode') ?? 'local');
  const configuredHost = String(config.get('web.host') ?? '127.0.0.1');
  if (hostMode === 'network') return '0.0.0.0';
  if (hostMode === 'custom') return configuredHost || '127.0.0.1';
  return '127.0.0.1';
}

export function resolvePairingWebOrigin(
  configManager: Pick<ConfigManager, 'get'>,
  probe?: () => StableHostInputs,
  /** Settled listener observation, only used for bundled serving fallback. */
  boundControlPlane?: { readonly host: string; readonly port: number; readonly scheme?: 'http' | 'https' },
): PairingWebOrigin {
  const publicBaseUrl = trimTrailingSlash(String(configManager.get('web.publicBaseUrl') ?? '').trim());
  const bundled = configManager.get('controlPlane.webui.serve') === true;
  if (publicBaseUrl && !(bundled && publicBaseUrl === 'http://127.0.0.1:3423')) {
    return {
      origin: publicBaseUrl,
      resolvedHost: { host: hostnameOf(publicBaseUrl), kind: 'gateway-interface', stable: true },
      httpOnLan: isHttpOnLan(publicBaseUrl),
      fromPublicBaseUrl: true,
    };
  }
  const binding = bundled ? boundControlPlane ?? resolveHostBinding(
    String(configManager.get('controlPlane.hostMode') ?? 'local'),
    String(configManager.get('controlPlane.host') ?? '127.0.0.1'),
    Number(configManager.get('controlPlane.port')), 'controlPlane',
  ) : { host: webBindHost(configManager), port: resolveWebPort(configManager.get('web.port')) };
  const resolvedHost = stableUrlHostForBindHost(binding.host, probe);
  const httpOrigin = formatHttpOrigin(resolvedHost.host, binding.port);
  // Only direct mode passes TLS material to the bound listener. Proxy mode's
  // external HTTPS endpoint must be supplied as an explicit public URL.
  const scheme = boundControlPlane?.scheme ?? (configManager.get('controlPlane.tls.mode') === 'direct' ? 'https' : 'http');
  const origin = bundled && scheme === 'https'
    ? httpOrigin.replace('http://', 'https://') : httpOrigin;
  return { origin, resolvedHost, httpOnLan: isHttpOnLan(origin), fromPublicBaseUrl: false };
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Persist web.publicBaseUrl once, from the stable-name resolution, and only when
 * it is empty AND the resolution produced a stable name (a DHCP-bound address is
 * not worth freezing into config). Returns the resolved origin either way. Never
 * overwrites a user-set value.
 */
export function ensurePublicBaseUrl(
  configManager: Pick<ConfigManager, 'get' | 'setDynamic'>,
  probe?: () => StableHostInputs,
  boundControlPlane?: { readonly host: string; readonly port: number; readonly scheme?: 'http' | 'https' },
): PairingWebOrigin {
  const resolved = resolvePairingWebOrigin(configManager, probe, boundControlPlane);
  if (!String(configManager.get('web.publicBaseUrl') ?? '').trim() && !resolved.fromPublicBaseUrl && resolved.resolvedHost.stable) {
    configManager.setDynamic('web.publicBaseUrl', resolved.origin);
    return { ...resolved, fromPublicBaseUrl: true };
  }
  return resolved;
}
